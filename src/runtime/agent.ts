import { createTerminalTool, runPty } from "./terminal.js";
import type {
  AgentContentBlock,
  AgentMessage,
  ToolDefinition,
  ToolResultBlock,
  UserContentBlock,
} from "./messages.js";
import { createAssistantMessage, createToolMessage, createUserMessage, toolResultBlock } from "./messages.js";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
} from "./model-client.js";
import {
  addModelUsage,
  createModelUsageSummary,
  type ModelUsageSummary,
} from "./model-client.js";
import { EventBus, type AgentEventMap, type EventListener } from "./events.js";
import type { AgentExtension } from "./extension.js";
import {
  type CompactionResult,
  type ContextPressure,
  estimateMessagesTokens,
  measureContextPressure,
  compactFallback,
} from "./context.js";

export type ToolHandler = (
  input: Record<string, unknown>,
  context: { signal?: AbortSignal },
) => unknown | Promise<unknown>;

export type ToolHandlers = Record<string, ToolHandler>;

export type AgentRuntimeOptions = {
  modelClient: ModelClient;
  system?: string;
  extensions?: ReadonlyArray<AgentExtension>;
};

export type RunInput = string | Array<UserContentBlock>;

class AgentRuntime {
  #controller: AbortController | null = null;
  #running = false;
  #events = new EventBus<AgentEventMap>();
  #usage = createModelUsageSummary();

  readonly modelClient: ModelClient;
  readonly system: string;
  readonly extensions: ReadonlyArray<AgentExtension>;
  readonly tools: Array<ToolDefinition> = [createTerminalTool()];
  readonly toolHandlers: ToolHandlers = {
    bash: (input, { signal }) => runPty({
      command: String(input.command),
      cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      timeout: typeof input.timeout === "number" ? input.timeout : undefined,
      signal,
    }),
  };
  messages: Array<AgentMessage> = [];

  get usage(): ModelUsageSummary {
    return this.#usage;
  }

  constructor({
    modelClient,
    system = "你是终端Agent,用bash工具执行命令来完成任务,用中文简洁回答。",
    extensions = [],
  }: AgentRuntimeOptions) {
    if (!modelClient) {
      throw new Error("modelClient is required");
    }

    this.modelClient = modelClient;
    this.system = system;
    this.extensions = extensions;
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

  abort(reason?: unknown): void {
    this.#controller?.abort(reason);
  }

  async run(input: RunInput): Promise<ModelResponse> {
    if (this.#running) {
      throw new Error("agent is already running");
    }

    const controller = new AbortController();
    this.#controller = controller;
    this.#running = true;

    try {
      const message = createUserMessage(input);
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
      this.#controller = null;
      this.#running = false;
    }
  }

  #runStep = async (signal: AbortSignal): Promise<ModelResponse> => {
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
          pressure,
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
      });
      const response = await this.#applyAfterModelResponseExtensions({
        request,
        response: rawResponse,
      });
      const assistantMessage = createAssistantMessage(response.content);
      this.messages.push(assistantMessage);
      this.#events.emit("model_response", { response });
      this.#usage = addModelUsage(this.#usage, response.usage);
      this.#events.emit("model_usage", {
        usage: response.usage ?? {},
        totalUsage: this.#usage,
      });
      this.#events.emit("message", { message: assistantMessage });
      this.#events.emit("assistant_message", { message: assistantMessage });

      if (response.stopReason !== "tool_call") {
        const text = response.content
          .filter((block): block is Extract<AgentContentBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        this.#events.emit("text", { text });
        return response;
      }

      const toolResults: Array<ToolResultBlock> = [];
      for (const block of response.content) {
        if (block.type !== "tool_call") continue;

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
    pressure: ContextPressure;
  }): Promise<CompactionResult> => {
    const before = this.messages;
    const result = compactFallback({
      messages: before,
      pressure: input.pressure,
      estimateRequestTokens: (messages) => this.modelClient.context?.estimateRequestTokens?.({
        system: this.system,
        tools: [...this.tools],
        messages: [...messages],
      }) ?? estimateMessagesTokens(messages),
    });

    if (result.messages !== before) {
      this.#events.emit("context_compacted", {
        before,
        after: result.messages,
      });
      this.messages = result.messages;
    }

    return result;
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
    this.#usage = createModelUsageSummary();
  }
}

function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}

export { AgentRuntime, createAgentRuntime };
