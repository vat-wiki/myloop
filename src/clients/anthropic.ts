import type { ArtifactStore } from "../runtime/artifacts.js";
import type {
  AgentContentBlock,
  AgentMessage,
  BinarySource,
  DocumentBlock,
  ImageBlock,
  StopReason,
  ThinkingBlock,
  ToolDefinition,
} from "../runtime/messages.js";
import { normalizeContent, textBlock, thinkingBlock, toolCallBlock } from "../runtime/messages.js";
import {
  createFetchTransport,
  postJson,
  postSse,
  type FetchTransportOptions,
  type HttpTransport,
} from "./http.js";
import type {
  ModelContextInfo,
  ModelRequest,
  ModelResponse,
} from "../runtime/model-client.js";
import { sumTokenCounts } from "../runtime/model-client.js";
import { estimateJsonTokens } from "../runtime/context.js";

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_API_VERSION = "2023-06-01";

type AnthropicOptions = {
  apiKey?: string;
  baseURL?: string;
  model: string;
  maxTokens?: number;
  thinkingBudgetTokens?: number;
  contextWindowTokens?: number;
  artifactStore?: ArtifactStore;
  headers?: Record<string, string>;
} & Omit<FetchTransportOptions, "fetch"> & {
  fetch?: typeof fetch;
  transport?: HttpTransport;
};

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type AnthropicContentBlockParam =
  | { type: "text"; text: string }
  | {
    type: "image";
    source:
      | { type: "url"; url: string }
      | { type: "base64"; media_type: string; data: string };
  }
  | {
    type: "document";
    source:
      | { type: "url"; url: string }
      | { type: "base64"; media_type: string; data: string };
    title?: string;
  }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
    type: "tool_result";
    tool_use_id: string;
    content: unknown;
    is_error?: boolean;
  };

type AnthropicMessageParam = {
  role: "user" | "assistant";
  content: Array<AnthropicContentBlockParam>;
};

type AnthropicBinarySource =
  | { type: "url"; url: string }
  | { type: "base64"; media_type: string; data: string };

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
};

type AnthropicResponse = {
  stop_reason?: string;
  content?: Array<{
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  usage?: AnthropicUsage;
};

type AnthropicSseEvent = {
  type?: string;
  index?: number;
  message?: {
    usage?: AnthropicUsage;
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: AnthropicUsage;
  error?: {
    message?: string;
  };
};

class Anthropic {
  readonly model: string;
  readonly maxTokens: number;
  readonly #artifactStore?: ArtifactStore;
  readonly context: ModelContextInfo;

  readonly #options: AnthropicOptions;

  constructor({
    apiKey,
    baseURL,
    model,
    maxTokens = 8192,
    contextWindowTokens,
    artifactStore,
    ...httpOptions
  }: AnthropicOptions) {
    if (!model) {
      throw new Error("model is required");
    }

    this.#options = { apiKey, baseURL, model, maxTokens, artifactStore, ...httpOptions };
    this.model = model;
    this.maxTokens = maxTokens;
    this.#artifactStore = artifactStore;
    this.context = {
      contextWindowTokens: contextWindowTokens ?? 200_000,
      reservedOutputTokens: maxTokens,
      estimateRequestTokens(request: ModelRequest): number {
        return estimateJsonTokens(request);
      },
    };
  }

  async complete({
    system,
    messages,
    tools,
    signal,
    onTextDelta,
    onThinkingDelta,
  }: ModelRequest): Promise<ModelResponse> {
    const baseURL = (this.#options.baseURL ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": ANTHROPIC_API_VERSION,
      ...this.#options.headers,
    };
    if (this.#options.apiKey) {
      headers["x-api-key"] = this.#options.apiKey;
    }
    const transport = this.#options.transport ?? createFetchTransport({
      timeoutMs: this.#options.timeoutMs,
      retry: this.#options.retry,
      fetch: this.#options.fetch,
    });

    const requestBody = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      tools: tools.map(toAnthropicTool),
      messages: await Promise.all(messages.map((message) => toAnthropicMessage(message, this.#artifactStore))),
      ...(this.#options.thinkingBudgetTokens ? {
        thinking: {
          type: "enabled",
          budget_tokens: this.#options.thinkingBudgetTokens,
        },
      } : {}),
      ...(onTextDelta && !this.#options.transport ? { stream: true } : {}),
    };
    const response = onTextDelta && !this.#options.transport
      ? await this.#completeStream(requestBody, signal, onTextDelta, onThinkingDelta)
      : await postJson<AnthropicResponse>({
        transport,
        url: `${baseURL}/messages`,
        headers,
        body: requestBody,
        signal,
        retry: this.#options.retry,
        errorName: "AnthropicHttpError",
      });

    const stopReason: StopReason = response.stop_reason === "tool_use"
      ? "tool_call"
      : response.stop_reason === "max_tokens"
        ? "max_tokens"
        : "end";
    const usage = response.usage;
    const cacheCreationInputTokens = sumTokenCounts(
      usage?.cache_creation_input_tokens,
      usage?.cache_creation?.ephemeral_5m_input_tokens,
      usage?.cache_creation?.ephemeral_1h_input_tokens,
    );
    const inputTokens = sumTokenCounts(
      usage?.input_tokens,
      usage?.cache_read_input_tokens,
      cacheCreationInputTokens,
    );
    return {
      stopReason,
      content: (response.content ?? []).map(toInternalBlock),
      usage: normalizeAnthropicUsage(usage),
    };
  }

  async #completeStream(
    requestBody: unknown,
    signal: AbortSignal | undefined,
    onTextDelta: (delta: string) => void,
    onThinkingDelta?: (delta: string) => void,
  ): Promise<AnthropicResponse> {
    const baseURL = (this.#options.baseURL ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": ANTHROPIC_API_VERSION,
      ...this.#options.headers,
    };
    if (this.#options.apiKey) {
      headers["x-api-key"] = this.#options.apiKey;
    }

    const response: AnthropicResponse = {};
    const content: NonNullable<AnthropicResponse["content"]> = [];
    const toolArguments = new Map<number, string>();
    const usageFragments: Array<AnthropicUsage> = [];

    await postSse({
      url: `${baseURL}/messages`,
      headers,
      body: requestBody,
      signal,
      timeoutMs: this.#options.timeoutMs,
      retry: this.#options.retry,
      fetch: this.#options.fetch,
      errorName: "AnthropicHttpError",
      onEvent: (event) => {
        if (event.data === "[DONE]") return;
        const parsed = JSON.parse(event.data) as AnthropicSseEvent;

        if (parsed.type === "message_start") {
          usageFragments.push(parsed.message?.usage ?? {});
          return;
        }
        if (parsed.type === "content_block_start") {
          const index = parsed.index ?? 0;
          const block = parsed.content_block;
          if (block?.type === "text") {
            content[index] = { type: "text", text: "" };
          } else if (block?.type === "thinking") {
            content[index] = { type: "thinking", thinking: "" };
          } else if (block?.type === "tool_use") {
          content[index] = {
            type: "tool_use",
              id: block.id ?? crypto.randomUUID(),
              name: block.name ?? "",
              input: {},
            };
          }
          return;
        }
        if (parsed.type === "content_block_delta") {
          const index = parsed.index ?? 0;
          const block = content[index];
          if (parsed.delta?.type === "text_delta" && block?.type === "text") {
            const delta = parsed.delta.text ?? "";
            block.text += delta;
            onTextDelta(delta);
          } else if (parsed.delta?.type === "thinking_delta" && block?.type === "thinking") {
            const delta = parsed.delta.thinking ?? "";
            block.thinking += delta;
            onThinkingDelta?.(delta);
          } else if (parsed.delta?.type === "input_json_delta" && block?.type === "tool_use") {
            toolArguments.set(index, (toolArguments.get(index) ?? "") + (parsed.delta.partial_json ?? ""));
          }
          return;
        }
        if (parsed.type === "content_block_stop") {
          const index = parsed.index ?? 0;
          const block = content[index];
          if (block?.type === "tool_use") {
            block.input = parseJsonRecord(toolArguments.get(index) ?? "{}");
          }
          return;
        }
        if (parsed.type === "message_delta") {
          if (parsed.delta?.stop_reason) {
            response.stop_reason = parsed.delta.stop_reason;
          }
          usageFragments.push(parsed.usage ?? {});
          return;
        }
        if (parsed.type === "error") {
          throw new Error(parsed.error?.message ?? "Anthropic stream error");
        }
      },
    });

    response.content = content;
    response.usage = usageFragments.reduce<AnthropicUsage>((usage, fragment) => ({
      ...usage,
      ...fragment,
    }), {});
    return response;
  }
}

function normalizeAnthropicUsage(usage?: AnthropicUsage): ModelResponse["usage"] {
  const cacheCreationInputTokens = sumTokenCounts(
    usage?.cache_creation_input_tokens,
    usage?.cache_creation?.ephemeral_5m_input_tokens,
    usage?.cache_creation?.ephemeral_1h_input_tokens,
  );
  const inputTokens = sumTokenCounts(
    usage?.input_tokens,
    usage?.cache_read_input_tokens,
    cacheCreationInputTokens,
  );

  return {
    inputTokens,
    outputTokens: usage?.output_tokens,
    totalTokens: usage?.total_tokens ?? sumTokenCounts(inputTokens, usage?.output_tokens),
    cacheReadInputTokens: usage?.cache_read_input_tokens,
    cacheCreationInputTokens,
  };
}

function toAnthropicTool(tool: ToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

async function toAnthropicMessage(
  message: AgentMessage,
  artifactStore?: ArtifactStore,
): Promise<AnthropicMessageParam> {
  return {
    role: message.role === "tool" ? "user" : message.role,
    content: await Promise.all(normalizeContent(message.content)
      .filter((block): block is Exclude<AgentContentBlock, ThinkingBlock> => block.type !== "thinking")
      .map((block) => toAnthropicBlock(block, artifactStore))),
  };
}

async function toAnthropicBlock(
  block: Exclude<AgentContentBlock, ThinkingBlock>,
  artifactStore?: ArtifactStore,
): Promise<AnthropicContentBlockParam> {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }

  if (block.type === "image") {
    return {
      type: "image",
      source: await toAnthropicImageSource(block, artifactStore),
    };
  }

  if (block.type === "document") {
    return {
      type: "document",
      source: await toAnthropicDocumentSource(block, artifactStore),
      ...(block.title === undefined ? {} : { title: block.title }),
    };
  }

  if (block.type === "video") {
    throw new Error(
      "Anthropic does not support video input; use a model client that accepts video or pre-process the video into frames/transcript",
    );
  }

  if (block.type === "tool_call") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.arguments,
    };
  }

  if (block.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: block.toolCallId,
      content: block.content,
      ...(block.isError ? { is_error: true } : {}),
    };
  }

  throw new Error(`unsupported internal content block: ${JSON.stringify(block satisfies never)}`);
}

async function toAnthropicImageSource(
  block: ImageBlock,
  artifactStore?: ArtifactStore,
): Promise<AnthropicBinarySource> {
  const source: BinarySource = block.source;
  if (source.type === "artifact") {
    if (!artifactStore) {
      throw new Error("artifact input requires an artifactStore");
    }
    const artifact = await artifactStore.get(source.artifactId);
    if (!artifact) {
      throw new Error(`artifact not found: ${source.artifactId}`);
    }
    return {
      type: "base64",
      media_type: artifact.mediaType as typeof block.mediaType,
      data: Buffer.from(artifact.data).toString("base64"),
    };
  }
  if (source.type === "url") {
    return { type: "url", url: source.url };
  }
  return {
    type: "base64",
    media_type: block.mediaType,
    data: source.data,
  };
}

async function toAnthropicDocumentSource(
  block: DocumentBlock,
  artifactStore?: ArtifactStore,
): Promise<AnthropicBinarySource> {
  const source: BinarySource = block.source;
  if (source.type === "artifact") {
    if (!artifactStore) {
      throw new Error("artifact input requires an artifactStore");
    }
    const artifact = await artifactStore.get(source.artifactId);
    if (!artifact) {
      throw new Error(`artifact not found: ${source.artifactId}`);
    }
    return {
      type: "base64",
      media_type: artifact.mediaType as typeof block.mediaType,
      data: Buffer.from(artifact.data).toString("base64"),
    };
  }
  if (source.type === "url") {
    return { type: "url", url: source.url };
  }
  return {
    type: "base64",
    media_type: block.mediaType,
    data: source.data,
  };
}

function toInternalBlock(block: NonNullable<AnthropicResponse["content"]>[number]): AgentContentBlock {
  if (block.type === "text") {
    return textBlock(block.text ?? "");
  }

  if (block.type === "thinking") {
    return thinkingBlock(block.thinking ?? "");
  }

  if (block.type === "redacted_thinking") {
    return thinkingBlock("[thinking redacted by provider]");
  }

  if (block.type === "tool_use") {
    return toolCallBlock(
      block.id ?? crypto.randomUUID(),
      block.name ?? "",
      isRecord(block.input) ? block.input : {},
    );
  }

  throw new Error(`unsupported model content block: ${block.type}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> {
  if (value.trim().length === 0) return {};
  const parsed = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error("invalid JSON in Anthropic tool arguments");
  }
  return parsed;
}

export { Anthropic, type AnthropicOptions };
