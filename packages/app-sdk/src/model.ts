import { Anthropic } from "myloop/clients/anthropic";
import { OpenAIChat } from "myloop/clients/openai-chat";
import { OpenAIResponses } from "myloop/clients/openai-responses";
import type { ArtifactStore, ModelClient } from "myloop/runtime";

export type AppProtocol = "anthropic" | "openai-chat" | "openai-responses";

export type CreateAppModelClientOptions = {
  protocol: AppProtocol;
  model: string;
  apiKey?: string;
  baseURL?: string;
  artifactStore?: ArtifactStore;
  contextWindowTokens?: number;
  maxTokens?: number;
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  reasoningSummary?: "auto" | "concise" | "detailed";
  fetch?: typeof fetch;
  transport?: import("myloop/clients/http").HttpTransport;
};

export function createAppModelClient(options: CreateAppModelClientOptions): ModelClient {
  const httpOptions = {
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    artifactStore: options.artifactStore,
    fetch: options.fetch,
    transport: options.transport,
  };

  if (options.protocol === "anthropic") {
    // 思考预算随总预算缩放：保底 4k（预算小时），否则留 8k 行动余量，剩余全给思考。
    const maxTokens = options.maxTokens ?? 131_072;
    const thinkingBudgetTokens = options.thinking
      ? options.thinkingBudgetTokens ?? Math.max(4_096, maxTokens - 8_192)
      : undefined;
    return new Anthropic({
      ...httpOptions,
      model: options.model,
      maxTokens,
      contextWindowTokens: options.contextWindowTokens,
      thinkingBudgetTokens,
    });
  }
  if (options.protocol === "openai-chat") {
    return new OpenAIChat({
      ...httpOptions,
      model: options.model,
      maxTokens: options.maxTokens,
      contextWindowTokens: options.contextWindowTokens,
      reasoningEffort: options.thinking ? options.reasoningEffort ?? "medium" : undefined,
    });
  }
  return new OpenAIResponses({
    ...httpOptions,
    model: options.model,
    maxTokens: options.maxTokens,
    contextWindowTokens: options.contextWindowTokens,
    reasoning: options.thinking
      ? {
          effort: options.reasoningEffort ?? "medium",
          summary: options.reasoningSummary ?? "auto",
        }
      : undefined,
  });
}
