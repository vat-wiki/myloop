import type { AgentMessage } from "./messages.js";
import type { ModelResponse, ModelUsage } from "./model-client.js";
import type { ContextPressure } from "./context.js";

export type ContextCompactionReason = "automatic" | "manual";

export type EventListener<T> = (event: T) => void;

export type AgentEventMap = {
  message: { message: AgentMessage };
  user_message: { message: AgentMessage };
  assistant_message: { message: AgentMessage };
  tool_message: { message: AgentMessage };
  model_response: { response: ModelResponse };
  text: { text: string };
  text_delta: { delta: string };
  thinking_delta: { delta: string };
  tool_start: { id: string; name: string; input: Record<string, unknown> };
  tool_end: { id: string; name: string; input: Record<string, unknown>; output: unknown };
  context_pressure: { pressure: ContextPressure };
  context_compaction_start: {
    reason: ContextCompactionReason;
    pressure?: ContextPressure;
    messageCount: number;
  };
  context_compaction_thinking_delta: { delta: string };
  context_compaction_summary_delta: { delta: string };
  context_compacted: {
    before: Array<AgentMessage>;
    after: Array<AgentMessage>;
    reason: ContextCompactionReason;
    pressure?: ContextPressure;
    beforeMessageCount: number;
    afterMessageCount: number;
    droppedMessageCount: number;
    durationMs: number;
    summary: string;
    usage?: ModelUsage;
  };
  heartbeat: { tick: number; at: number; running: boolean };
  end: { response: ModelResponse };
  error: { error: unknown };
};

type AnyListener<TEvents extends object> = EventListener<TEvents[keyof TEvents]>;

export class EventBus<TEvents extends object> {
  #listeners = new Map<keyof TEvents, Set<AnyListener<TEvents>>>();

  on<K extends keyof TEvents>(type: K, listener: EventListener<TEvents[K]>): () => void {
    this.#add(type, listener as AnyListener<TEvents>);
    return () => this.off(type, listener);
  }

  once<K extends keyof TEvents>(type: K, listener: EventListener<TEvents[K]>): () => void {
    const wrapped = (event: TEvents[K]) => {
      this.off(type, wrapped);
      listener(event);
    };
    return this.on(type, wrapped);
  }

  off<K extends keyof TEvents>(type: K, listener: EventListener<TEvents[K]>): void {
    const listeners = this.#listeners.get(type);
    if (!listeners) return;

    listeners.delete(listener as AnyListener<TEvents>);
    if (listeners.size === 0) {
      this.#listeners.delete(type);
    }
  }

  emit<K extends keyof TEvents>(type: K, event: TEvents[K]): void {
    const listeners = this.#listeners.get(type);
    if (!listeners) return;

    for (const listener of [...listeners]) {
      (listener as EventListener<TEvents[K]>)(event);
    }
  }

  #add<K extends keyof TEvents>(type: K, listener: EventListener<TEvents[K]>): void {
    if (!this.#listeners.has(type)) {
      this.#listeners.set(type, new Set());
    }
    this.#listeners.get(type)?.add(listener as AnyListener<TEvents>);
  }
}
