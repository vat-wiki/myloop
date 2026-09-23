import {
  AgentRuntime,
  type AgentEventMap,
  type AgentExtension,
  type AgentMessage,
  type AgentRuntimeOptions,
  type AgentContentBlock,
  type CompactionResult,
  type EventListener,
  type ModelClient,
  type ModelUsageSummary,
  type RunInput,
  type ToolDefinition,
  type ToolHandlers,
} from "../runtime/index.js";
import {
  createUserInputAdapter,
  type AgentUserInputResolver,
  type UserInputAdapterOptions,
} from "./user-input.js";
import type { Agent, AgentResult, AgentRunInput } from "./types.js";

export type SingleAgentOptions = AgentRuntimeOptions & {
  name: string;
  input?: AgentUserInputResolver | UserInputAdapterOptions;
};

export class SingleAgent implements Agent {
  readonly name: string;
  readonly runtime: AgentRuntime;
  readonly input: AgentUserInputResolver;

  constructor({ name, input, ...runtimeOptions }: SingleAgentOptions) {
    if (!name.trim()) {
      throw new Error("single agent name is required");
    }

    this.name = name;
    this.input = isUserInputAdapter(input) ? input : createUserInputAdapter(input);
    this.runtime = new AgentRuntime(runtimeOptions);
  }

  get modelClient(): ModelClient {
    return this.runtime.modelClient;
  }

  get usage(): ModelUsageSummary {
    return this.runtime.usage;
  }

  get system(): string {
    return this.runtime.system;
  }

  get extensions(): ReadonlyArray<AgentExtension> {
    return this.runtime.extensions;
  }

  get tools(): Array<ToolDefinition> {
    return this.runtime.tools;
  }

  get toolHandlers(): ToolHandlers {
    return this.runtime.toolHandlers;
  }

  get messages(): Array<AgentMessage> {
    return this.runtime.messages;
  }

  get running(): boolean {
    return this.runtime.running;
  }

  on<K extends keyof AgentEventMap>(
    type: K,
    listener: EventListener<AgentEventMap[K]>,
  ): () => void {
    return this.runtime.on(type, listener);
  }

  once<K extends keyof AgentEventMap>(
    type: K,
    listener: EventListener<AgentEventMap[K]>,
  ): () => void {
    return this.runtime.once(type, listener);
  }

  off<K extends keyof AgentEventMap>(
    type: K,
    listener: EventListener<AgentEventMap[K]>,
  ): void {
    this.runtime.off(type, listener);
  }

  async compact(): Promise<CompactionResult> {
    return this.runtime.compact();
  }

  async run(input: AgentRunInput): Promise<AgentResult> {
    const runtimeInput: RunInput = await this.input.resolve(input);
    const response = await this.runtime.run(runtimeInput);
    return {
      answer: responseText(response.content),
      response,
    };
  }

  abort(reason?: unknown): void {
    this.runtime.abort(reason);
  }

  reset(): void {
    this.runtime.reset();
  }
}

function isUserInputAdapter(
  value: AgentUserInputResolver | UserInputAdapterOptions | undefined,
): value is AgentUserInputResolver {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return "resolve" in value && typeof value.resolve === "function";
}

function responseText(content: Array<AgentContentBlock>): string {
  return content
    .filter((block): block is Extract<AgentContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
