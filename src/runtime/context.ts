import type { AgentMessage } from "./messages.js";
import type { ModelUsage } from "./model-client.js";

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
  summary: string;
  usage?: ModelUsage;
};

export function estimateTextTokens(text: string): number {
  let units = 0;
  for (const char of text) {
    units += char.codePointAt(0)! > 0x2e7f ? 1 : 0.25;
  }
  return Math.ceil(units);
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value) ?? "");
}

export function estimateMessagesTokens(messages: ReadonlyArray<AgentMessage>): number {
  return estimateJsonTokens(messages);
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
