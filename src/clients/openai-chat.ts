import type {
  AgentContentBlock,
  AgentMessage,
  DocumentBlock,
  ImageBlock,
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

type OpenAIChatMessage = Record<string, unknown>;
type OpenAIChatContentPart = Record<string, unknown>;

type OpenAIChatResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: Array<{
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
};

type OpenAIChatOptions = OpenAIClientOptions;

type OpenAIChatSseChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: OpenAIChatResponse["usage"];
};

class OpenAIChat {
  readonly model: string;
  readonly maxTokens: number;
  readonly context: ModelContextInfo;
  readonly #options: OpenAIChatOptions;

  constructor({ contextWindowTokens, ...options }: OpenAIChatOptions) {
    if (!options.model) {
      throw new Error("model is required");
    }

    this.#options = options;
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 4_096;
    this.context = {
      contextWindowTokens: contextWindowTokens ?? 128_000,
      reservedOutputTokens: this.maxTokens,
      safetyTokens: 20_000,
      estimateRequestTokens(request: ModelRequest): number {
        return Math.ceil(JSON.stringify(request).length / 4);
      },
    };
  }

  async complete({ system, messages, tools, signal, onTextDelta }: ModelRequest): Promise<ModelResponse> {
    const mappedMessages = await Promise.all(messages.map((message) => toOpenAIChatMessages(message, this.#options.artifactStore)))
      .then((mapped) => [
        { role: "system", content: system },
        ...mapped.flat(),
      ]);
    const body = {
        model: this.model,
        max_completion_tokens: this.maxTokens,
        messages: mappedMessages,
        ...(tools.length === 0 ? {} : {
          tools: tools.map(toOpenAIChatTool),
          tool_choice: "auto",
        }),
      ...(onTextDelta && !this.#options.transport ? {
        stream: true,
        stream_options: { include_usage: true },
      } : {}),
    };

    const response = onTextDelta && !this.#options.transport
      ? await this.#completeStream(body, signal, onTextDelta)
      : await postOpenAIRequest<OpenAIChatResponse>(
      this.#options,
      "/chat/completions",
      body,
      signal,
    );

    const choice = response.choices?.[0];
    const message = choice?.message;
    const content: Array<AgentContentBlock> = [];
    if (typeof message?.content === "string") {
      content.push({ type: "text", text: message.content });
    } else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part.type === "text" || part.text !== undefined) {
          content.push({ type: "text", text: part.text ?? "" });
        }
      }
    }
    for (const toolCall of message?.tool_calls ?? []) {
      content.push({
        type: "tool_call",
        id: toolCall.id ?? crypto.randomUUID(),
        name: toolCall.function?.name ?? "",
        arguments: parseOpenAIToolArguments(toolCall.function?.arguments ?? "{}"),
      });
    }

    const stopReason: StopReason = choice?.finish_reason === "tool_calls" ? "tool_call" : "end";
    return {
      stopReason,
      content,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        totalTokens: response.usage?.total_tokens,
        cacheReadInputTokens: response.usage?.prompt_tokens_details?.cached_tokens,
        reasoningOutputTokens: response.usage?.completion_tokens_details?.reasoning_tokens,
      },
    };
  }

  async #completeStream(
    body: unknown,
    signal: AbortSignal | undefined,
    onTextDelta: (delta: string) => void,
  ): Promise<OpenAIChatResponse> {
    const response: OpenAIChatResponse = {};
    const { url, headers } = toOpenAIHttpRequest(this.#options, "/chat/completions");
    let text: string | undefined;
    let finishReason: string | undefined;
    const toolCalls = new Map<number, {
      id?: string;
      name?: string;
      arguments: string;
    }>();

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
        const parsed = JSON.parse(event.data) as OpenAIChatSseChunk;
        if (parsed.usage) response.usage = parsed.usage;

        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (delta?.content) {
          text = (text ?? "") + delta.content;
          onTextDelta(delta.content);
        }
        for (const toolCall of delta?.tool_calls ?? []) {
          const index = toolCall.index ?? 0;
          const current = toolCalls.get(index) ?? { arguments: "" };
          current.id ??= toolCall.id;
          current.name ??= toolCall.function?.name;
          current.arguments += toolCall.function?.arguments ?? "";
          toolCalls.set(index, current);
        }
      },
    });

    const content: Array<AgentContentBlock> = [];
    if (text !== undefined) content.push({ type: "text", text });
    for (const [index, toolCall] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
      void index;
      content.push({
        type: "tool_call",
        id: toolCall.id ?? crypto.randomUUID(),
        name: toolCall.name ?? "",
        arguments: parseOpenAIToolArguments(toolCall.arguments || "{}"),
      });
    }

    response.choices = [{
      finish_reason: finishReason,
      message: {
        content: text,
        tool_calls: [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, toolCall]) => ({
          id: toolCall.id,
          function: { name: toolCall.name, arguments: toolCall.arguments },
        })),
      },
    }];
    return response;
  }
}

function toOpenAIChatTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

async function toOpenAIChatMessages(
  message: AgentMessage,
  artifactStore?: OpenAIChatOptions["artifactStore"],
): Promise<Array<OpenAIChatMessage>> {
  if (message.role === "assistant") {
    const text = message.content
      .filter((block): block is Extract<AgentContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const toolCalls = message.content
      .filter((block): block is Extract<AgentContentBlock, { type: "tool_call" }> => block.type === "tool_call")
      .map((block) => ({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.arguments),
        },
      }));

    return [{
      role: "assistant",
      content: text.length === 0 ? null : text,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    }];
  }

  if (message.role === "tool") {
    return message.content.map((block) => ({
      role: "tool",
      tool_call_id: block.type === "tool_result" ? block.toolCallId : "",
      content: block.type === "tool_result" ? toOpenAIToolResultText(block.content) : "",
    }));
  }

  return [{
    role: message.role,
    content: await Promise.all(message.content.map((block) => toOpenAIChatContentPart(block, artifactStore))),
  }];
}

async function toOpenAIChatContentPart(
  block: AgentContentBlock,
  artifactStore?: OpenAIChatOptions["artifactStore"],
): Promise<OpenAIChatContentPart> {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "image") {
    return {
      type: "image_url",
      image_url: {
        url: await toOpenAIMediaReference(block.mediaType, block.source, artifactStore),
      },
    };
  }
  if (block.type === "document") {
    return {
      type: "file",
      file: {
        filename: block.title ?? "document.pdf",
        file_data: await toOpenAIMediaReference(block.mediaType, block.source, artifactStore),
      },
    };
  }
  if (block.type === "tool_result") {
    throw new Error("tool results must appear in tool messages");
  }
  throw new Error("OpenAI Chat does not support video input");
}

export { OpenAIChat, type OpenAIChatOptions };
