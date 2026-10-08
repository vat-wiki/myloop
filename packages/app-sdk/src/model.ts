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
    return new Anthropic({
      ...httpOptions,
      model: options.model,
      maxTokens: options.maxTokens,
      contextWindowTokens: options.contextWindowTokens,
      thinkingBudgetTokens: options.thinking ? options.thinkingBudgetTokens ?? 4_096 : undefined,
    });
  }
  if (options.protocol === "openai-chat") {
    return new OpenAIChat({
      ...httpOptions,
      model: options.model,
      maxTokens: options.maxTokens,
      contextWindowTokens: options.contextWindowTokens,
      reasoning: options.thinking ? { effort: "medium", summary: "auto" } : undefined,
    });
  }
  return new OpenAIResponses({
    ...httpOptions,
    model: options.model,
    maxTokens: options.maxTokens,
    contextWindowTokens: options.contextWindowTokens,
    reasoning: options.thinking ? { effort: "medium", summary: "auto" } : undefined,
  });
}
