import type { AgentMessage } from "./messages.js";

export type ContextPressure = {
  usedTokens: number;
  limitTokens?: number;
  availableInputTokens?: number;
  ratio?: number;
  needsCompaction?: boolean;
};

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
  compactionThreshold = 0.8,
}: {
  usedTokens: number;
  limitTokens?: number;
  reservedOutputTokens?: number;
  compactionThreshold?: number;
}): ContextPressure {
  if (limitTokens === undefined) {
    return { usedTokens };
  }

  return {
    usedTokens,
    limitTokens,
    availableInputTokens: Math.max(0, limitTokens - reservedOutputTokens),
    ratio: limitTokens === 0 ? 1 : usedTokens / limitTokens,
    needsCompaction: usedTokens >= limitTokens * compactionThreshold,
  };
}
