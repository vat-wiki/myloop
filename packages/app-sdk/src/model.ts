import { Anthropic } from "mycoder/clients/anthropic";
import { OpenAIChat } from "mycoder/clients/openai-chat";
import { OpenAIResponses } from "mycoder/clients/openai-responses";
import type { ArtifactStore, ModelClient } from "mycoder/runtime";

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
};

export function createAppModelClient(options: CreateAppModelClientOptions): ModelClient {
  const httpOptions = {
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    artifactStore: options.artifactStore,
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
  });
}
