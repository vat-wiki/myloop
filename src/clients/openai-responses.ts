import type {
  AgentContentBlock,
  AgentMessage,
  StopReason,
  ToolDefinition,
} from "../runtime/messages.js";
import type {
  ModelContextInfo,
  ModelRequest,
  ModelResponse,
} from "../runtime/model-client.js";
import {
  type OpenAIClientOptions,
  parseOpenAIToolArguments,
  postOpenAIRequest,
  toOpenAIHttpRequest,
  toOpenAIMediaReference,
  toOpenAIToolResultText,
} from "./openai-common.js";
import { postSse } from "./http.js";

type OpenAIResponseItem = Record<string, unknown>;
type OpenAIResponseContentPart = Record<string, unknown>;

type OpenAIResponsesResponse = {
  output?: Array<{
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
};

type OpenAIResponsesOptions = OpenAIClientOptions;

type OpenAIResponsesSseEvent = {
  type?: string;
  delta?: string;
  response?: OpenAIResponsesResponse;
  error?: {
    message?: string;
  };
};

class OpenAIResponses {
  readonly model: string;
  readonly maxTokens: number;
  readonly context: ModelContextInfo;
  readonly #options: OpenAIResponsesOptions;

  constructor(options: OpenAIResponsesOptions) {
    if (!options.model) {
      throw new Error("model is required");
    }

    this.#options = options;
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 4_096;
    this.context = {
      contextWindowTokens: 128_000,
      reservedOutputTokens: this.maxTokens,
      safetyTokens: 20_000,
      estimateRequestTokens(request: ModelRequest): number {
        return Math.ceil(JSON.stringify(request).length / 4);
      },
    };
  }

  async complete({ system, messages, tools, signal, onTextDelta }: ModelRequest): Promise<ModelResponse> {
    const body = {
        model: this.model,
        instructions: system,
        max_output_tokens: this.maxTokens,
        input: await Promise.all(messages.map((message) => toOpenAIResponseItems(message, this.#options.artifactStore))).then((items) => items.flat()),
        ...(tools.length === 0 ? {} : {
          tools: tools.map(toOpenAIResponseTool),
          tool_choice: "auto",
        }),
      ...(onTextDelta && !this.#options.transport ? { stream: true } : {}),
    };

    const response = onTextDelta && !this.#options.transport
      ? await this.#completeStream(body, signal, onTextDelta)
      : await postOpenAIRequest<OpenAIResponsesResponse>(
      this.#options,
      "/responses",
      body,
      signal,
    );

    const content: Array<AgentContentBlock> = [];
    let hasToolCall = false;
    for (const item of response.output ?? []) {
      if (item.type === "function_call") {
        hasToolCall = true;
        content.push({
          type: "tool_call",
          id: item.call_id ?? item.id ?? crypto.randomUUID(),
          name: item.name ?? "",
          arguments: parseOpenAIToolArguments(item.arguments ?? "{}"),
        });
        continue;
      }
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part.type === "output_text" || part.text !== undefined) {
          content.push({ type: "text", text: part.text ?? "" });
        }
      }
    }

    const stopReason: StopReason = hasToolCall ? "tool_call" : "end";
    return {
      stopReason,
      content,
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        totalTokens: response.usage?.total_tokens,
        cacheReadInputTokens: response.usage?.input_tokens_details?.cached_tokens,
        reasoningOutputTokens: response.usage?.output_tokens_details?.reasoning_tokens,
      },
    };
  }

  async #completeStream(
    body: unknown,
    signal: AbortSignal | undefined,
    onTextDelta: (delta: string) => void,
  ): Promise<OpenAIResponsesResponse> {
    const { url, headers } = toOpenAIHttpRequest(this.#options, "/responses");
    let finalResponse: OpenAIResponsesResponse | undefined;
    let streamedText: string | undefined;

    await postSse({
      url,
      headers,
      body,
      signal,
      timeoutMs: this.#options.timeoutMs,
      retry: this.#options.retry,
      fetch: this.#options.fetch,
      errorName: "OpenAIHttpError",
      onEvent: (event) => {
        if (event.data === "[DONE]") return;
        const parsed = JSON.parse(event.data) as OpenAIResponsesSseEvent;
        if (parsed.type === "response.output_text.delta") {
          const delta = parsed.delta ?? "";
          streamedText = (streamedText ?? "") + delta;
          onTextDelta(delta);
          return;
        }
        if (parsed.type === "response.completed" || parsed.type === "response.incomplete") {
          finalResponse = parsed.response;
          return;
        }
        if (parsed.type === "response.failed" || parsed.type === "error") {
          throw new Error(parsed.error?.message ?? "OpenAI Responses stream failed");
        }
      },
    });

    return finalResponse ?? {
      output: streamedText === undefined ? [] : [{
        type: "message",
        content: [{ type: "output_text", text: streamedText }],
      }],
    };
  }
}

function toOpenAIResponseTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

async function toOpenAIResponseItems(
  message: AgentMessage,
  artifactStore?: OpenAIResponsesOptions["artifactStore"],
): Promise<Array<OpenAIResponseItem>> {
  if (message.role === "assistant") {
    const items: Array<OpenAIResponseItem> = [];
    const text = message.content
      .filter((block): block is Extract<AgentContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text.length > 0) {
      items.push({
        role: "assistant",
        content: [{ type: "output_text", text }],
      });
    }
    for (const block of message.content) {
      if (block.type === "tool_call") {
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.arguments),
        });
      }
    }
    return items;
  }

  if (message.role === "tool") {
    return message.content.map((block) => ({
      type: "function_call_output",
      call_id: block.type === "tool_result" ? block.toolCallId : "",
      output: block.type === "tool_result" ? toOpenAIToolResultText(block.content) : "",
    }));
  }

  return [{
    role: message.role,
    content: await Promise.all(message.content.map((block) => toOpenAIResponseContentPart(block, artifactStore))),
  }];
}

async function toOpenAIResponseContentPart(
  block: AgentContentBlock,
  artifactStore?: OpenAIResponsesOptions["artifactStore"],
): Promise<OpenAIResponseContentPart> {
  if (block.type === "text") {
    return { type: "input_text", text: block.text };
  }
  if (block.type === "image") {
    return {
      type: "input_image",
      image_url: await toOpenAIMediaReference(block.mediaType, block.source, artifactStore),
    };
  }
  if (block.type === "document") {
    return {
      type: "input_file",
      filename: block.title ?? "document.pdf",
      file_data: await toOpenAIMediaReference(block.mediaType, block.source, artifactStore),
    };
  }
  if (block.type === "tool_result") {
    throw new Error("tool results must appear in tool messages");
  }
  throw new Error("OpenAI Responses does not support video input");
}

export { OpenAIResponses, type OpenAIResponsesOptions };
