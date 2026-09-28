import type { AgentMessage, StopReason, ToolDefinition } from "./messages.js";

export type ModelRequest = {
  system: string;
  messages: Array<AgentMessage>;
  tools: Array<ToolDefinition>;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
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
