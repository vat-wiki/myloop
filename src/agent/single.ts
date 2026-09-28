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
  type ToolDefinition,
  type ToolHandlers,
} from "../runtime/index.js";
import type { UserInput } from "../runtime/user-input.js";
import type { Agent, AgentResult } from "./types.js";

export type SingleAgentOptions = AgentRuntimeOptions & {
  name: string;
};

export class SingleAgent implements Agent {
  readonly name: string;
  readonly runtime: AgentRuntime;

  constructor({ name, ...runtimeOptions }: SingleAgentOptions) {
    if (!name.trim()) {
      throw new Error("single agent name is required");
    }

    this.name = name;
    this.runtime = new AgentRuntime(runtimeOptions);
  }

  get input() {
    return this.runtime.input;
  }

  get modelClient(): ModelClient {
    return this.runtime.modelClient;
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

  get sessionId(): string | undefined {
    return this.runtime.sessionId;
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

  async run(input: UserInput): Promise<AgentResult> {
    const response = await this.runtime.run(input);
    const answer = responseText(response.content);
    if (!answer && response.stopReason === "max_tokens") {
      throw new Error("model reached max_tokens before producing a text answer");
    }
    return {
      answer,
      response,
    };
  }

  abort(reason?: unknown): void {
    this.runtime.abort(reason);
  }

  reset(): void {
    this.runtime.reset();
  }

  snapshot(): ReturnType<AgentRuntime["snapshot"]> {
    return this.runtime.snapshot();
  }

  restore(snapshot: Parameters<AgentRuntime["restore"]>[0]): void {
    this.runtime.restore(snapshot);
  }

  async saveSession(sessionId?: string): Promise<void> {
    await this.runtime.saveSession(sessionId);
  }

  async loadSession(sessionId?: string): Promise<boolean> {
    return this.runtime.loadSession(sessionId);
  }
}

function responseText(content: Array<AgentContentBlock>): string {
  return content
    .filter((block): block is Extract<AgentContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
