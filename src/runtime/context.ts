import type { AgentMessage } from "./messages.js";

export type ContextPressure = {
  usedTokens: number;
  limitTokens?: number;
  safetyTokens?: number;
  availableInputTokens?: number;
  ratio?: number;
  needsCompaction?: boolean;
};

export type CompactionReason = "automatic" | "manual";

export type CompactionResult = {
  messages: Array<AgentMessage>;
  droppedMessageCount: number;
};

export function estimateMessagesTokens(messages: ReadonlyArray<AgentMessage>): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function measureContextPressure({
  usedTokens,
  limitTokens,
  reservedOutputTokens = 0,
  safetyTokens,
}: {
  usedTokens: number;
  limitTokens?: number;
  reservedOutputTokens?: number;
  safetyTokens?: number;
}): ContextPressure {
  if (limitTokens === undefined) {
    return { usedTokens };
  }

  const resolvedSafetyTokens = safetyTokens ?? Math.floor(limitTokens * 0.1);
  const availableInputTokens = Math.max(
    0,
    limitTokens - reservedOutputTokens - resolvedSafetyTokens,
  );
  return {
    usedTokens,
    limitTokens,
    safetyTokens: resolvedSafetyTokens,
    availableInputTokens,
    ratio: limitTokens === 0 ? 1 : usedTokens / limitTokens,
    needsCompaction: usedTokens >= availableInputTokens,
  };
}

const TOOL_OUTPUT_LIMIT = 4_000;
const BLOCK_LIMIT = 1_000;

export type FallbackCompactionInput = {
  messages: ReadonlyArray<AgentMessage>;
  pressure: ContextPressure;
  estimateRequestTokens: (messages: ReadonlyArray<AgentMessage>) => number;
};

export function compactFallback({
  messages,
  pressure,
  estimateRequestTokens,
}: FallbackCompactionInput): CompactionResult {
  const compactedToolOutputs = compactToolOutputs(messages);
  if (fits(compactedToolOutputs)) {
    return {
      messages: compactedToolOutputs,
      droppedMessageCount: 0,
    };
  }

  const startIndex = findFittingStart(
    compactedToolOutputs,
    estimateRequestTokens,
    pressure.availableInputTokens,
  );
  if (startIndex > 0) {
    const retainedMessages = [
      contextBoundaryMessage(startIndex),
      ...compactedToolOutputs.slice(startIndex),
    ];
    if (fits(retainedMessages)) {
      return {
        messages: retainedMessages,
        droppedMessageCount: startIndex,
      };
    }
  }

  const trimmedMessages = trimLargeBlocks(compactedToolOutputs);
  if (fits(trimmedMessages)) {
    return {
      messages: trimmedMessages,
      droppedMessageCount: 0,
    };
  }

  throw new Error("context exhausted: messages cannot be compacted below the modelClient limit");

  function fits(candidate: ReadonlyArray<AgentMessage>): boolean {
    return estimateRequestTokens(candidate) <= (pressure.availableInputTokens ?? Number.POSITIVE_INFINITY);
  }
}

function contextBoundaryMessage(startIndex: number) {
  return {
    role: "user" as const,
    content: [{
      type: "text" as const,
      text: `[Context fallback] ${startIndex} earlier messages were removed to fit the model context window.`,
    }],
  };
}

function findFittingStart(
  messages: ReadonlyArray<AgentMessage>,
  estimateRequestTokens: (messages: ReadonlyArray<AgentMessage>) => number,
  availableInputTokens?: number,
): number {
  const pendingToolCalls = new Set<string>();
  const safeStarts = new Set<number>([0]);

  for (let index = 0; index < messages.length; index += 1) {
    for (const block of messages[index]?.content ?? []) {
      if (block.type === "tool_call") {
        pendingToolCalls.add(block.id);
      }
      if (block.type === "tool_result") {
        pendingToolCalls.delete(block.toolCallId);
      }
    }
    if (pendingToolCalls.size === 0) {
      safeStarts.add(index + 1);
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!safeStarts.has(index)) continue;
    if (estimateRequestTokens(messages.slice(index)) <= (availableInputTokens ?? Number.POSITIVE_INFINITY)) {
      return index;
    }
  }

  return 0;
}

function compactToolOutputs(messages: ReadonlyArray<AgentMessage>): Array<AgentMessage> {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) => {
      if (block.type !== "tool_result") {
        return block;
      }

      return {
        ...block,
        content: truncateText(JSON.stringify(block.content), TOOL_OUTPUT_LIMIT),
      };
    }),
  }));
}

function trimLargeBlocks(messages: ReadonlyArray<AgentMessage>): Array<AgentMessage> {
  return messages.map((message) => ({
    ...message,
    content: message.content.map(trimBlock),
  }));
}

function trimBlock(block: AgentMessage["content"][number]): AgentMessage["content"][number] {
  if (block.type === "text") {
    return {
      ...block,
      text: truncateText(block.text, BLOCK_LIMIT),
    };
  }

  if (block.type === "tool_result") {
    return {
      ...block,
      content: truncateText(JSON.stringify(block.content), BLOCK_LIMIT),
    };
  }

  return block;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n[truncated]`;
}
