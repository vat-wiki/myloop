import type { AgentMessage } from "./messages.js";

export type RuntimeSessionSnapshot = {
  version: 1;
  messages: Array<AgentMessage>;
};

export interface RuntimeSessionStore {
  save(sessionId: string, snapshot: RuntimeSessionSnapshot): Promise<void>;
  load(sessionId: string): Promise<RuntimeSessionSnapshot | undefined>;
  list?(): Promise<Array<string>>;
}

export function cloneSessionMessages(messages: ReadonlyArray<AgentMessage>): Array<AgentMessage> {
  try {
    return JSON.parse(JSON.stringify(messages, (_key, value: unknown) => {
      return value === undefined ? null : value;
    })) as Array<AgentMessage>;
  } catch {
    throw new Error("session history must be JSON-serializable");
  }
}

export function assertRuntimeSessionSnapshot(value: unknown): asserts value is RuntimeSessionSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("session snapshot must be an object");
  }

  const snapshot = value as RuntimeSessionSnapshot;
  if (snapshot.version !== 1) {
    throw new Error("unsupported session snapshot version");
  }
  if (!Array.isArray(snapshot.messages)) {
    throw new Error("session snapshot messages must be an array");
  }

  snapshot.messages.forEach(assertSessionMessage);
  assertPairedToolCalls(snapshot.messages);
}

function assertSessionMessage(message: unknown): asserts message is AgentMessage {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw new Error("session snapshot message must be an object");
  }

  const candidate = message as AgentMessage;
  if (candidate.role !== "user" && candidate.role !== "assistant" && candidate.role !== "tool") {
    throw new Error("session snapshot message has an invalid role");
  }
  if (!Array.isArray(candidate.content)) {
    throw new Error("session snapshot message content must be an array");
  }
  candidate.content.forEach((block) => {
    if (typeof block !== "object" || block === null || typeof block.type !== "string") {
      throw new Error("session snapshot content block is invalid");
    }
  });
}

function assertPairedToolCalls(messages: ReadonlyArray<AgentMessage>): void {
  const pendingToolCalls = new Set<string>();

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call") {
        if (pendingToolCalls.has(block.id)) {
          throw new Error("session snapshot has duplicate tool calls");
        }
        pendingToolCalls.add(block.id);
      }

      if (block.type === "tool_result") {
        if (!pendingToolCalls.delete(block.toolCallId)) {
          throw new Error("session snapshot has a tool result without a tool call");
        }
      }
    }
  }

  if (pendingToolCalls.size > 0) {
    throw new Error("session snapshot has a tool call without a tool result");
  }
}
