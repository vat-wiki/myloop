import type { AgentMessage, StopReason, ToolDefinition } from "./messages.js";

export type ModelRequest = {
  system: string;
  messages: Array<AgentMessage>;
  tools: Array<ToolDefinition>;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
};

export type ModelResponse = {
  stopReason: StopReason;
  content: Array<import("./messages.js").AgentContentBlock>;
  usage?: ModelUsage;
};

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
};

export type ModelUsageSummary = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
};

export function createModelUsageSummary(): ModelUsageSummary {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

export function addModelUsage(
  summary: ModelUsageSummary,
  usage: ModelUsage | undefined,
): ModelUsageSummary {
  summary.requests += 1;
  summary.inputTokens += usage?.inputTokens ?? 0;
  summary.outputTokens += usage?.outputTokens ?? 0;
  summary.totalTokens += usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  summary.cacheReadInputTokens += usage?.cacheReadInputTokens ?? 0;
  summary.cacheCreationInputTokens += usage?.cacheCreationInputTokens ?? 0;
  summary.reasoningOutputTokens += usage?.reasoningOutputTokens ?? 0;
  return summary;
}

export function sumTokenCounts(...counts: Array<number | undefined>): number | undefined {
  let total = 0;
  let hasCount = false;
  for (const count of counts) {
    if (count === undefined) continue;
    total += count;
    hasCount = true;
  }
  return hasCount ? total : undefined;
}

export type ModelContextInfo = {
  contextWindowTokens?: number;
  reservedOutputTokens?: number;
  safetyTokens?: number;
  estimateRequestTokens?(request: ModelRequest): number;
};

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
  context?: ModelContextInfo;
}
