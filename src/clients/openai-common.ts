import type { BinarySource } from "../runtime/messages.js";
import type { ArtifactStore } from "../runtime/artifacts.js";
import {
  createFetchTransport,
  postJson,
  type HttpTransport,
} from "./http.js";

export type OpenAIClientOptions = {
  apiKey?: string;
  baseURL?: string;
  model: string;
  maxTokens?: number;
  contextWindowTokens?: number;
  reasoning?: {
    effort?: string;
    summary?: string;
  };
  headers?: Record<string, string>;
  artifactStore?: ArtifactStore;
  fetch?: typeof fetch;
  transport?: HttpTransport;
  timeoutMs?: number;
  retry?: import("./http.js").HttpRetryOptions;
};

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function toOpenAIHttpRequest(
  options: OpenAIClientOptions,
  path: string,
): { url: string; headers: Record<string, string> } {
  const baseURL = (options.baseURL ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  return { url: `${baseURL}${path}`, headers };
}

export async function postOpenAIRequest<TResponse>(
  options: OpenAIClientOptions,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<TResponse> {
  const transport = options.transport ?? createFetchTransport({
    timeoutMs: options.timeoutMs,
    retry: options.retry,
    fetch: options.fetch,
  });
  const baseURL = (options.baseURL ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  return postJson<TResponse>({
    transport,
    url: `${baseURL}${path}`,
    headers,
    body,
    signal,
    timeoutMs: options.timeoutMs,
    retry: options.retry,
    errorName: "OpenAIHttpError",
  });
}

export function toOpenAIDataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

export async function toOpenAIMediaReference(
  mediaType: string,
  source: BinarySource,
  artifactStore?: ArtifactStore,
): Promise<string> {
  if (source.type === "url") {
    return source.url;
  }
  if (source.type === "base64") {
    return toOpenAIDataUrl(mediaType, source.data);
  }
  if (!artifactStore) {
    throw new Error("artifact input requires an artifactStore");
  }
  const artifact = await artifactStore.get(source.artifactId);
  if (!artifact) {
    throw new Error(`artifact not found: ${source.artifactId}`);
  }
  return toOpenAIDataUrl(artifact.mediaType, Buffer.from(artifact.data).toString("base64"));
}

export function toOpenAIToolResultText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

export function parseOpenAIToolArguments(argumentsText: string): Record<string, unknown> {
  if (argumentsText.trim().length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch (error) {
    throw new Error(`invalid JSON in OpenAI tool arguments: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OpenAI tool arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
