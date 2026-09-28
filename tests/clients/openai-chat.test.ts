import { describe, expect, it, vi } from "vitest";
import { OpenAIChat } from "../../src/clients/openai-chat.js";
import { createInMemoryArtifactStore } from "../../src/runtime/artifacts.js";
import {
  documentBlock,
  imageBlock,
  textBlock,
  thinkingBlock,
  toolCallBlock,
  toolResultBlock,
} from "../../src/runtime/messages.js";

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

describe("OpenAIChat", () => {
  it("maps internal messages to Chat Completions request and response shapes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          reasoning_content: "internal reasoning",
          content: "Using a tool",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "bash", arguments: "{\"command\":\"pwd\"}" },
          }],
        },
      }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    }), { status: 200 }));
    const modelClient = new OpenAIChat({ apiKey: "test-key", model: "gpt-test", maxTokens: 4_096, fetch: fetchMock });
    const signal = new AbortController().signal;

    const result = await modelClient.complete({
      system: "system prompt",
      signal,
      tools: [{ name: "bash", description: "Run bash", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: [
          textBlock("hello"),
          imageBlock("image/png", { type: "base64", data: "png" }),
          documentBlock({ type: "base64", data: "pdf" }, "Spec"),
        ] },
        { role: "assistant", content: [
          textBlock("Calling bash"),
          toolCallBlock("call-0", "bash", { command: "ls" }),
        ] },
        { role: "tool", content: [toolResultBlock("call-0", "files", true)] },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request).toEqual({
      model: "gpt-test",
      max_completion_tokens: 4_096,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: [
          { type: "text", text: "hello" },
          { type: "image_url", image_url: { url: "data:image/png;base64,png" } },
          { type: "file", file: { filename: "Spec", file_data: "data:application/pdf;base64,pdf" } },
        ] },
        { role: "assistant", content: "Calling bash", tool_calls: [{
          id: "call-0",
          type: "function",
          function: { name: "bash", arguments: "{\"command\":\"ls\"}" },
        }] },
        { role: "tool", tool_call_id: "call-0", content: "files" },
      ],
      tools: [{
        type: "function",
        function: { name: "bash", description: "Run bash", parameters: { type: "object" } },
      }],
      tool_choice: "auto",
    });
    expect(result).toEqual({
      stopReason: "tool_call",
      content: [
        thinkingBlock("internal reasoning"),
        textBlock("Using a tool"),
        toolCallBlock("call-1", "bash", { command: "pwd" }),
      ],
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        cacheReadInputTokens: 4,
        reasoningOutputTokens: 3,
      },
    });
  });

  it("streams text deltas and assembles tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"bash","arguments":"{\\"command\\":\\"p"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"wd\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":7,"total_tokens":10}}\n\n',
      "data: [DONE]\n\n",
    ]));
    const modelClient = new OpenAIChat({ apiKey: "test-key", model: "gpt-test", fetch: fetchMock });
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
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 7, totalTokens: 10 });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.stream).toBe(true);
  });

  it("maps length finish reason to max_tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "partial" } }],
    }), { status: 200 }));
    const modelClient = new OpenAIChat({ apiKey: "test-key", model: "gpt-test", fetch: fetchMock });

    const result = await modelClient.complete({
      system: "system",
      tools: [],
      messages: [{ role: "user", content: [textBlock("hello")] }],
    });

    expect(result.stopReason).toBe("max_tokens");
  });

  it("lets the provider choose output tokens by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
    }), { status: 200 }));
    const modelClient = new OpenAIChat({ apiKey: "test-key", model: "gpt-test", fetch: fetchMock });

    await modelClient.complete({
      system: "system",
      tools: [],
      messages: [{ role: "user", content: [textBlock("hello")] }],
    });

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect("max_completion_tokens" in request).toBe(false);
  });

  it("resolves artifact references during OpenAI mapping", async () => {
    const artifactStore = createInMemoryArtifactStore();
    const artifactId = await artifactStore.put({
      mediaType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
    }), { status: 200 }));
    const modelClient = new OpenAIChat({ apiKey: "test-key", model: "gpt-test", artifactStore, fetch: fetchMock });

    await modelClient.complete({
      system: "system",
      tools: [],
      messages: [{
        role: "user",
        content: [imageBlock("image/png", { type: "artifact", artifactId })],
      }],
    });

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.messages[1]?.content).toEqual([{
      type: "image_url",
      image_url: { url: "data:image/png;base64,AQID" },
    }]);
  });
});
