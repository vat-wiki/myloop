import {
  createCommandHostTool,
  createCommandHostHandler,
  type CommandHost,
} from "../command/index.js";
import type {
  AgentContentBlock,
  AgentMessage,
  ToolDefinition,
  ToolResultBlock,
  UserContentBlock,
} from "./messages.js";
import { createAssistantMessage, createToolMessage, createUserMessage, textBlock, toolResultBlock } from "./messages.js";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
} from "./model-client.js";
import { sumTokenCounts } from "./model-client.js";
import { EventBus, type AgentEventMap, type EventListener } from "./events.js";
import type { AgentExtension } from "./extension.js";
import {
  type CompactionResult,
  type ContextPressure,
  estimateMessagesTokens,
  measureContextPressure,
} from "./context.js";
import {
  createUserInputAdapter,
  isUserInputAdapter,
  type UserInput,
  type UserInputAdapterOptions,
  type UserInputResolver,
} from "./user-input.js";
import {
  assertRuntimeSessionSnapshot,
  repairRuntimeSessionSnapshot,
  cloneSessionMessages,
  type RuntimeSessionSnapshot,
  type RuntimeSessionStore,
} from "./session.js";
import { Heartbeat, type HeartbeatOptions } from "./heartbeat.js";

export type ToolHandler = (
  input: Record<string, unknown>,
  context: { signal?: AbortSignal },
) => unknown | Promise<unknown>;

export type ToolHandlers = Record<string, ToolHandler>;

const MAX_OUTPUT_CONTINUATIONS = 8;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const COMPACTION_SUMMARY_REQUEST =
  "请总结以上对话，保留当前任务、已完成步骤及结果、关键决策、文件路径、未解决的问题。摘要将用于继续执行任务。只输出摘要。";

export type AgentRuntimeOptions = {
  modelClient: ModelClient;
  system?: string;
  extensions?: ReadonlyArray<AgentExtension>;
  commandHost?: CommandHost;
  commandHosts?: ReadonlyArray<CommandHost>;
  input?: UserInputResolver | UserInputAdapterOptions;
  sessionId?: string;
  sessionStore?: RuntimeSessionStore;
  compactionThreshold?: number;
  heartbeat?: HeartbeatOptions;
};

class AgentRuntime {
  #controller: AbortController | null = null;
  #running = false;
  #events = new EventBus<AgentEventMap>();
  readonly modelClient: ModelClient;
  readonly system: string;
  readonly extensions: ReadonlyArray<AgentExtension>;
  readonly input: UserInputResolver;
  #sessionId?: string;
  readonly sessionStore?: RuntimeSessionStore;
  readonly #commandHosts: ReadonlyArray<CommandHost>;
  readonly #compactionThreshold: number;
  readonly #heartbeat: Heartbeat | null;
  messages: Array<AgentMessage> = [];

  constructor({
    modelClient,
    system = "你是终端Agent,用command工具执行命令来完成任务,用中文简洁回答。",
    extensions = [],
    commandHost,
    commandHosts,
    input,
    sessionId,
    sessionStore,
    compactionThreshold = 0.8,
    heartbeat,
  }: AgentRuntimeOptions) {
    if (!modelClient) {
      throw new Error("modelClient is required");
    }

    const hosts = [...(commandHost ? [commandHost] : []), ...(commandHosts ?? [])];
    const toolNames = new Set<string>();
    const hostIds = new Set<string>();
    for (const host of hosts) {
      if (toolNames.has(host.toolName)) {
        throw new Error(`duplicate command host tool name: ${host.toolName}`);
      }
      if (hostIds.has(host.id)) {
        throw new Error(`duplicate command host id: ${host.id}`);
      }
      toolNames.add(host.toolName);
      hostIds.add(host.id);
    }

    this.modelClient = modelClient;
    this.system = system;
    this.extensions = extensions;
    this.input = isUserInputAdapter(input) ? input : createUserInputAdapter(input);
    this.#commandHosts = hosts;
    this.#compactionThreshold = compactionThreshold;
    this.#sessionId = sessionId;
    this.sessionStore = sessionStore;
    this.#heartbeat = heartbeat
      ? new Heartbeat(heartbeat, {
          isBusy: () => this.#running,
          onTick: (event) => this.#events.emit("heartbeat", event),
        })
      : null;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  on<K extends keyof AgentEventMap>(type: K, listener: EventListener<AgentEventMap[K]>): () => void {
    return this.#events.on(type, listener);
  }

  once<K extends keyof AgentEventMap>(type: K, listener: EventListener<AgentEventMap[K]>): () => void {
    return this.#events.once(type, listener);
  }

  off<K extends keyof AgentEventMap>(type: K, listener: EventListener<AgentEventMap[K]>): void {
    this.#events.off(type, listener);
  }

  get running(): boolean {
    return this.#running;
  }

  get commandHost(): CommandHost | undefined {
    return this.#commandHosts[0];
  }

  get commandHosts(): ReadonlyArray<CommandHost> {
    return this.#commandHosts;
  }

  get tools(): Array<ToolDefinition> {
    return this.#commandHosts.map(createCommandHostTool);
  }

  get toolHandlers(): ToolHandlers {
    return Object.fromEntries(
      this.#commandHosts.map((host) => [host.toolName, createCommandHostHandler(host)]),
    );
  }

  abort(reason?: unknown): void {
    this.#controller?.abort(reason);
  }

  snapshot(): RuntimeSessionSnapshot {
    this.#assertIdle("snapshot");
    return {
      version: 1,
      messages: cloneSessionMessages(this.messages),
    };
  }

  restore(snapshot: RuntimeSessionSnapshot): void {
    this.#assertIdle("restore");
    assertRuntimeSessionSnapshot(snapshot);
    this.messages = cloneSessionMessages(snapshot.messages);
  }

  async saveSession(sessionId: string = this.sessionId ?? ""): Promise<void> {
    if (!this.sessionStore) {
      throw new Error("sessionStore is required to save a session");
    }
    if (!sessionId) {
      throw new Error("sessionId is required to save a session");
    }

    await this.sessionStore.save(sessionId, this.snapshot());
  }

  async loadSession(sessionId: string = this.sessionId ?? ""): Promise<boolean> {
    if (!this.sessionStore) {
      throw new Error("sessionStore is required to load a session");
    }
    if (!sessionId) {
      throw new Error("sessionId is required to load a session");
    }

    this.#assertIdle("load");
    const snapshot = await this.sessionStore.load(sessionId);
    if (snapshot) {
      this.restore(repairRuntimeSessionSnapshot(snapshot));
    } else {
      this.messages = [];
    }
    this.#sessionId = sessionId;
    return Boolean(snapshot);
  }

  async run(input: UserInput): Promise<ModelResponse> {
    if (this.#running) {
      throw new Error("agent is already running");
    }

    const controller = new AbortController();
    this.#controller = controller;
    this.#running = true;
    this.#heartbeat?.resume();

    try {
      const runtimeInput = await this.input.resolve(input);
      const message = createUserMessage(runtimeInput);
      this.messages.push(message);
      this.#events.emit("message", { message });
      this.#events.emit("user_message", { message });
      const response = await this.#runStep(controller.signal);
      this.#events.emit("end", { response });
      return response;
    } catch (error) {
      this.#events.emit("error", { error });
      throw error;
    } finally {
      this.#heartbeat?.pause();
      this.#controller = null;
      this.#running = false;
    }
  }

  #runStep = async (signal: AbortSignal): Promise<ModelResponse> => {
    let combinedResponse: ModelResponse | undefined;
    let outputContinuations = 0;

    while (true) {
      const pressure = this.#measureContextPressure({
        system: this.system,
        tools: this.tools,
        messages: this.messages,
      });
      this.#events.emit("context_pressure", { pressure });
      if (pressure.needsCompaction) {
        await this.#compactMessages({
          reason: "automatic",
          signal,
        });
      }

      const request = await this.#applyBeforeModelCallExtensions({
        system: this.system,
        messages: this.messages,
        tools: this.tools,
        signal,
      });
      this.messages = request.messages;

      signal.throwIfAborted();
      const rawResponse = await this.modelClient.complete({
        ...request,
      onTextDelta: (delta) => {
        this.#events.emit("text_delta", { delta });
      },
      onThinkingDelta: (delta) => {
        this.#events.emit("thinking_delta", { delta });
      },
      });
      const response = await this.#applyAfterModelResponseExtensions({
        request,
        response: rawResponse,
      });
      combinedResponse = combinedResponse
        ? mergeModelResponses(combinedResponse, response)
        : response;
      const assistantMessage = createAssistantMessage(response.content);
      this.messages.push(assistantMessage);
      this.#events.emit("model_response", { response });
      this.#events.emit("message", { message: assistantMessage });
      this.#events.emit("assistant_message", { message: assistantMessage });

      if (response.stopReason === "max_tokens") {
        if (outputContinuations >= MAX_OUTPUT_CONTINUATIONS) {
          return combinedResponse;
        }

        outputContinuations += 1;
        const continuationMessage = createUserMessage([textBlock(
          "Continue from where the previous response stopped. Do not repeat content.",
        )]);
        this.messages.push(continuationMessage);
        this.#events.emit("message", { message: continuationMessage });
        continue;
      }

      if (response.stopReason !== "tool_call") {
        const text = response.content
          .filter((block): block is Extract<AgentContentBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        this.#events.emit("text", { text });
        return combinedResponse;
      }

      const toolResults: Array<ToolResultBlock> = [];
      for (const block of response.content) {
        if (block.type !== "tool_call") continue;

        try {
          const handler = this.#resolveToolHandler(block.name);
          if (!handler) {
            toolResults.push(toolResultBlock(block.id, `未知工具: ${block.name}`, true));
            continue;
          }

          signal.throwIfAborted();
          this.#events.emit("tool_start", { id: block.id, name: block.name, input: block.arguments });
          const output = await handler(block.arguments, { signal });
          this.#events.emit("tool_end", { id: block.id, name: block.name, input: block.arguments, output });
          toolResults.push(toolResultBlock(block.id, output));
        } catch (error) {
          toolResults.push(toolResultBlock(block.id, errorText(error), true));
        }
      }

      const toolMessage = createToolMessage(toolResults);
      this.messages.push(toolMessage);
      this.#events.emit("message", { message: toolMessage });
      this.#events.emit("tool_message", { message: toolMessage });
    }
  };

  #measureContextPressure(input: {
    system: string;
    tools: ReadonlyArray<ToolDefinition>;
    messages: ReadonlyArray<AgentMessage>;
  }): ContextPressure {
    const usedTokens = this.modelClient.context?.estimateRequestTokens?.({
      system: input.system,
      tools: [...input.tools],
      messages: [...input.messages],
    }) ?? estimateMessagesTokens(input.messages);

    return measureContextPressure({
      usedTokens,
      limitTokens: this.modelClient.context?.contextWindowTokens,
      reservedOutputTokens: this.modelClient.context?.reservedOutputTokens,
      compactionThreshold: this.#compactionThreshold,
    });
  }

  async compact(): Promise<CompactionResult> {
    if (this.#running) {
      throw new Error("cannot compact while agent is running");
    }

    const pressure = this.#measureContextPressure({
      system: this.system,
      tools: this.tools,
      messages: this.messages,
    });

    return await this.#compactMessages({
      reason: "manual",
    });
  }

  #compactMessages = async (input: {
    reason: "automatic" | "manual";
    signal?: AbortSignal;
  }): Promise<CompactionResult> => {
    const before = this.messages;
    const result = await this.#compactWithSummary({
      messages: before,
      signal: input.signal,
    });
    this.#events.emit("context_compacted", { before, after: result.messages });
    this.messages = result.messages;
    return result;
  };

  #compactWithSummary = async (input: {
    messages: ReadonlyArray<AgentMessage>;
    signal?: AbortSignal;
  }): Promise<CompactionResult> => {
    const summaryRequestMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: COMPACTION_SUMMARY_REQUEST }],
    };

    const response = await this.modelClient.complete({
      system: this.system,
      messages: [...input.messages, summaryRequestMessage],
      tools: [...this.tools],
      signal: input.signal,
    });

    const summaryText = response.content
      .filter((block): block is Extract<AgentContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (!summaryText.trim()) {
      throw new Error("empty compaction summary");
    }

    return {
      messages: [{
        role: "user",
        content: [{ type: "text", text: `[Context summary] ${summaryText}` }],
      }],
      droppedMessageCount: input.messages.length,
    };
  };

  #applyBeforeModelCallExtensions = async (
    request: ModelRequest,
  ): Promise<ModelRequest> => {
    let current = request;
    for (const extension of this.extensions) {
      if (!extension.beforeModelCall) continue;
      current = await extension.beforeModelCall(current);
    }
    return current;
  };

  #applyAfterModelResponseExtensions = async (input: {
    request: ModelRequest;
    response: ModelResponse;
  }): Promise<ModelResponse> => {
    let current = input.response;
    for (const extension of [...this.extensions].reverse()) {
      if (!extension.afterModelResponse) continue;
      current = await extension.afterModelResponse({
        request: input.request,
        response: current,
      });
    }
    return current;
  };

  #resolveToolHandler(name: string) {
    const definition = this.tools.find((tool) => tool.name === name);
    const baseHandler = this.toolHandlers[name];
    if (!definition || !baseHandler) return baseHandler;

    let handler = baseHandler;
    for (const extension of [...this.extensions].reverse()) {
      const wrapped = extension.wrapToolCall?.({
        name,
        definition,
        handler,
      });
      if (wrapped) handler = wrapped;
    }
    return handler;
  }

  reset(): void {
    if (this.#running) {
      throw new Error("cannot reset while agent is running");
    }
    this.messages = [];
  }

  startHeartbeat(): void {
    this.#heartbeat?.start();
  }

  stopHeartbeat(): void {
    this.#heartbeat?.stop();
  }

  #assertIdle(action: string): void {
    if (this.#running) {
      throw new Error(`cannot ${action} session while agent is running`);
    }
  }
}

function mergeModelResponses(
  left: ModelResponse,
  right: ModelResponse,
): ModelResponse {
  const content: Array<AgentContentBlock> = [];
  for (const block of [...left.content, ...right.content]) {
    const previous = content.at(-1);
    if (previous?.type === "text" && block.type === "text") {
      content[content.length - 1] = {
        type: "text",
        text: previous.text + block.text,
      };
      continue;
    }
    if (previous?.type === "thinking" && block.type === "thinking") {
      content[content.length - 1] = {
        type: "thinking",
        thinking: previous.thinking + block.thinking,
      };
      continue;
    }
    content.push(block);
  }

  return {
    stopReason: right.stopReason,
    content,
    usage: {
      inputTokens: sumTokenCounts(left.usage?.inputTokens, right.usage?.inputTokens),
      outputTokens: sumTokenCounts(left.usage?.outputTokens, right.usage?.outputTokens),
      totalTokens: sumTokenCounts(left.usage?.totalTokens, right.usage?.totalTokens),
      cacheReadInputTokens: sumTokenCounts(
        left.usage?.cacheReadInputTokens,
        right.usage?.cacheReadInputTokens,
      ),
      cacheCreationInputTokens: sumTokenCounts(
        left.usage?.cacheCreationInputTokens,
        right.usage?.cacheCreationInputTokens,
      ),
      reasoningOutputTokens: sumTokenCounts(
        left.usage?.reasoningOutputTokens,
        right.usage?.reasoningOutputTokens,
      ),
    },
  };
}

function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}

export { AgentRuntime, createAgentRuntime };
