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
  "这次对话到此为止，接下来由看不到以上历史的继任者继续工作。请写一份交接：当前任务与进展、已完成步骤及结果、关键决策及理由、文件路径、未解决的问题与下一步。继任者无需原始对话即可接手。只输出交接内容。";

const COMPACTION_FALLBACK_PREFIX = "[Context truncated]";

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
    system = "你是终端Agent,用command工具执行命令来完成任务。始终用用户消息的语言进行回复和可见thinking;代码、命令和专有名词保持原样。",
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
      const response = await this.#runStep(controller.signal, runtimeInput);
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

  #runStep = async (signal: AbortSignal, input: ReadonlyArray<UserContentBlock>): Promise<ModelResponse> => {
    let combinedResponse: ModelResponse | undefined;
    let outputContinuations = 0;
    let pendingInput: ReadonlyArray<UserContentBlock> | undefined = input;

    while (true) {
      const pressure = this.#measureContextPressure({
        system: this.system,
        tools: this.tools,
        messages: this.messages,
      });
      this.#events.emit("context_pressure", { pressure });
      if (pressure.needsCompaction) {
        try {
          await this.#compactMessages({
            reason: "automatic",
            signal,
            remainingInput: pendingInput,
          });
        } catch (error) {
          // 摘要请求失败（上下文越满越容易过载）时退化为截断：丢弃旧历史，
          // 只保留最后一条 user 消息的文本重组为干净消息，保住当前回合；
          // 只剩一条时无历史可截，原样抛出。
          if (this.messages.length <= 1) {
            throw error;
          }
          const lastUser = [...this.messages].reverse().find((message) => message.role === "user");
          const lastUserText = lastUser
            ? lastUser.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n")
            : "";
          const dropped = this.messages.length - 1;
          this.messages = lastUserText
            ? [createUserMessage(lastUserText)]
            : [createUserMessage(COMPACTION_FALLBACK_PREFIX)];
          this.#events.emit("error", { error });
          this.#events.emit("context_compacted", {
            before: [],
            after: [...this.messages],
            reason: "automatic",
            pressure,
            beforeMessageCount: dropped + 1,
            afterMessageCount: 1,
            droppedMessageCount: dropped,
            durationMs: 0,
            summary: `${COMPACTION_FALLBACK_PREFIX} ${errorText(error)}`,
          });
        }
        pendingInput = undefined;
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
        // 截断发生在思考中时，"继续写"会让模型接着滚思考；
        // 应让它收束思考、立即给出正文或工具调用。
        const truncatedMidThinking = response.content.some((block) => block.type === "thinking");
        const continuationMessage = createUserMessage([textBlock(
          truncatedMidThinking
            ? "Your thinking was cut off by the output limit. Do not continue thinking. Wrap up immediately: state your conclusion or issue a tool call now."
            : "Continue from where the previous response stopped. Do not repeat content.",
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
      pressure,
    });
  }

  #compactMessages = async (input: {
    reason: "automatic" | "manual";
    pressure?: ContextPressure;
    signal?: AbortSignal;
    remainingInput?: ReadonlyArray<UserContentBlock>;
  }): Promise<CompactionResult> => {
    const startedAt = Date.now();
    const before = this.messages;
    this.#events.emit("context_compaction_start", {
      reason: input.reason,
      pressure: input.pressure,
      messageCount: before.length,
    });
    const result = await this.#compactWithSummary({
      messages: before,
      signal: input.signal,
      remainingInput: input.remainingInput,
      onThinkingDelta: (delta) => {
        this.#events.emit("context_compaction_thinking_delta", { delta });
      },
      onSummaryDelta: (delta) => {
        this.#events.emit("context_compaction_summary_delta", { delta });
      },
    });
    this.#events.emit("context_compacted", {
      before,
      after: result.messages,
      reason: input.reason,
      pressure: input.pressure,
      beforeMessageCount: before.length,
      afterMessageCount: result.messages.length,
      droppedMessageCount: result.droppedMessageCount,
      durationMs: Date.now() - startedAt,
      summary: result.summary,
      usage: result.usage,
    });
    this.messages = result.messages;
    return result;
  };

  #compactWithSummary = async (input: {
    messages: ReadonlyArray<AgentMessage>;
    signal?: AbortSignal;
    remainingInput?: ReadonlyArray<UserContentBlock>;
    onThinkingDelta?: (delta: string) => void;
    onSummaryDelta?: (delta: string) => void;
  }): Promise<CompactionResult> => {
    const summaryRequestMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: COMPACTION_SUMMARY_REQUEST }],
    };
    // 摘要请求只带对话文本；工具 schema 与结构化块是大头，去掉可显著降低过载概率。
    const summarize = (message: AgentMessage): AgentMessage => ({
      role: message.role === "tool" ? "user" : message.role,
      content: message.content.flatMap((block) => {
        if (block.type === "text") return [textBlock(block.text)];
        if (block.type === "tool_result") {
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          return [textBlock(`[tool output] ${text}`)];
        }
        return [];
      }),
    });

    const response = await this.modelClient.complete({
      system: this.system,
      messages: [...input.messages.map(summarize), summaryRequestMessage],
      tools: [],
      signal: input.signal,
      onThinkingDelta: input.onThinkingDelta,
      onTextDelta: input.onSummaryDelta,
    });

    const summaryText = response.content
      .filter((block): block is Extract<AgentContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (!summaryText.trim()) {
      throw new Error("empty compaction summary");
    }

    const messages: Array<AgentMessage> = [{
      role: "user",
      content: [{ type: "text", text: `[Handover summary] ${summaryText}` }],
    }];
    const remainingInput = input.remainingInput?.map((block) => block.type === "text" ? block.text : "").join(" ").trim();
    if (remainingInput) {
      messages.push(createUserMessage(remainingInput));
    }

    return {
      messages,
      droppedMessageCount: input.messages.length,
      summary: summaryText,
      usage: response.usage,
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
