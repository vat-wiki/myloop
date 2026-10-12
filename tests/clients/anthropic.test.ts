import { describe, expect, it, vi } from "vitest";
import { Anthropic } from "../../src/clients/anthropic.js";
import type { HttpTransport } from "../../src/clients/http.js";
import { createInMemoryArtifactStore } from "../../src/runtime/artifacts.js";
import {
  documentBlock,
  imageBlock,
  textBlock,
  thinkingBlock,
  toolCallBlock,
  toolResultBlock,
} from "../../src/runtime/messages.js";

function httpJson(
  body: unknown,
  init: { status?: number } = {},
) {
  const status = init.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    text: JSON.stringify(body),
  };
}

function sseResponse(events: Array<string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Anthropic", () => {
  it("validates construction", () => {
    expect(() => new Anthropic({ model: "" })).toThrow("model is required");
  });

  it("maps requests and responses to the Anthropic Messages API", async () => {
    const transport = vi.fn<Parameters<HttpTransport>, ReturnType<HttpTransport>>()
      .mockResolvedValue(httpJson({
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Using a tool" },
          { type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 25,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      }));
    const modelClient = new Anthropic({
      apiKey: "test-key",
      model: "claude-test",
      maxTokens: 2_000,
      transport,
      retry: { attempts: 1 },
    });
    const signal = new AbortController().signal;

    const result = await modelClient.complete({
      system: "system prompt",
      signal,
      tools: [{ name: "bash", description: "Run bash", parameters: { type: "object" } }],
      messages: [
        { role: "tool", content: [toolResultBlock("call-0", "previous", true)] },
        {
          role: "user",
          content: [
            textBlock("hello"),
            imageBlock("image/png", { type: "url", url: "https://example.test/image.png" }),
            documentBlock({ type: "base64", data: "pdf" }, "Spec"),
          ],
        },
      ],
    });

    expect(transport).toHaveBeenCalledWith({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-key",
      }),
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 2_000,
        system: [{
          type: "text",
          text: "system prompt",
          cache_control: { type: "ephemeral" },
        }],
        tools: [{
          name: "bash",
          description: "Run bash",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        }],
        messages: [
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "call-0",
              content: "previous",
              is_error: true,
              cache_control: { type: "ephemeral" },
            }],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: "pdf" }, title: "Spec" },
            ],
          },
        ],
      }),
      signal,
    });
    expect(result).toEqual({
      stopReason: "tool_call",
      content: [
        textBlock("Using a tool"),
        toolCallBlock("call-1", "bash", { command: "pwd" }),
      ],
      usage: {
        inputTokens: 18,
        outputTokens: 7,
        totalTokens: 25,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
    });
  });

  it("rejects video blocks before calling the API", async () => {
    const transport = vi.fn();
    const modelClient = new Anthropic({ model: "claude-test", transport });

    await expect(modelClient.complete({
      system: "system",
      tools: [],
      messages: [{
        role: "user",
        content: [{
          type: "video",
          mediaType: "video/mp4",
          source: { type: "url", url: "https://example.test/video.mp4" },
        }],
      }],
    })).rejects.toThrow("Anthropic does not support video input");
    expect(transport).not.toHaveBeenCalled();
  });

  it("maps extended thinking response blocks", async () => {
    const transport = vi.fn<Parameters<HttpTransport>, ReturnType<HttpTransport>>()
      .mockResolvedValue(httpJson({
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "redacted_thinking", data: "redacted" },
          { type: "text", text: "Hello" },
        ],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }));
    const modelClient = new Anthropic({ model: "claude-test", transport });

    const result = await modelClient.complete({
      system: "system prompt",
      tools: [],
      messages: [{ role: "user", content: [textBlock("hello")] }],
    });

    expect(result.content).toEqual([
      thinkingBlock("internal reasoning"),
      thinkingBlock("[thinking redacted by provider]"),
      textBlock("Hello"),
    ]);
  });

  it("maps max_tokens stop reason", async () => {
    const transport = vi.fn<Parameters<HttpTransport>, ReturnType<HttpTransport>>()
      .mockResolvedValue(httpJson({
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "partial" }],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }));
    const modelClient = new Anthropic({ model: "claude-test", transport });

    const result = await modelClient.complete({
      system: "system",
      tools: [],
      messages: [{ role: "user", content: [textBlock("hello")] }],
    });

    expect(result.stopReason).toBe("max_tokens");
  });

  it("places cache breakpoints on system, last tool, and penultimate message", async () => {
    const transport = vi.fn<Parameters<HttpTransport>, ReturnType<HttpTransport>>()
      .mockResolvedValue(httpJson({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }));
    const modelClient = new Anthropic({ model: "claude-test", transport });

    await modelClient.complete({
      system: "system",
      tools: [
        { name: "a", description: "a", parameters: { type: "object" } },
        { name: "b", description: "b", parameters: { type: "object" } },
      ],
      messages: [
        { role: "user", content: [textBlock("old turn")] },
        { role: "assistant", content: [textBlock("old reply")] },
        { role: "tool", content: [toolResultBlock("call-9", "result")] },
        { role: "user", content: [textBlock("new input")] },
      ],
    });

    const body = JSON.parse(String(vi.mocked(transport).mock.calls[0]?.[0]?.body));
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools.map((tool: { cache_control?: unknown }) => tool.cache_control)).toEqual([
      undefined,
      { type: "ephemeral" },
    ]);
    // 断点在倒数第二个消息（上轮工具结果），新输入留在缓存外。
    expect(body.messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[3].content[0].cache_control).toBeUndefined();
  });

  it("streams Anthropic text and tool arguments", async () => {
    const fetch = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":2,"cache_creation_input_tokens":4}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"bash"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"p"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"wd\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":1}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]));
    const modelClient = new Anthropic({
      apiKey: "test-key",
      model: "claude-test",
      fetch,
      retry: { attempts: 1 },
    });
    const deltas: Array<string> = [];

    const result = await modelClient.complete({
      system: "system",
      tools: [],
      messages: [{ role: "user", content: [textBlock("hello")] }],
      onTextDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result.stopReason).toBe("tool_call");
    expect(result.content).toEqual([
      textBlock("Hello"),
      toolCallBlock("call-1", "bash", { command: "pwd" }),
    ]);
    expect(result.usage).toMatchObject({
      inputTokens: 9,
      outputTokens: 7,
      totalTokens: 16,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 4,
    });
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1]?.body)).stream).toBe(true);
  });

  it("resolves artifact references during Anthropic mapping", async () => {
    const artifactStore = createInMemoryArtifactStore();
    const artifactId = await artifactStore.put({
      mediaType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });
    const transport = vi.fn().mockResolvedValue(httpJson({
      stop_reason: "end",
      content: [{ type: "text", text: "ok" }],
    }));
    const modelClient = new Anthropic({ model: "claude-test", artifactStore, transport });

    await modelClient.complete({
      system: "system",
      tools: [],
      messages: [{
        role: "user",
        content: [imageBlock("image/png", { type: "artifact", artifactId })],
      }],
    });

    const request = transport.mock.calls[0]?.[0];
    const body = JSON.parse(request?.body ?? "{}");
    expect(body.messages[0]?.content).toEqual([{
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AQID" },
    }]);
  });
});
