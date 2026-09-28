import { describe, expect, it, vi } from "vitest";
import { OpenAIResponses } from "../../src/clients/openai-responses.js";
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

describe("OpenAIResponses", () => {
  it("maps internal messages to Responses request and response shapes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "internal reasoning" }] },
        { type: "message", content: [{ type: "output_text", text: "Using a tool" }] },
        {
          type: "function_call",
          call_id: "call-1",
          name: "bash",
          arguments: "{\"command\":\"pwd\"}",
        },
      ],
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens_details: { reasoning_tokens: 3 },
      },
    }), { status: 200 }));
    const modelClient = new OpenAIResponses({ apiKey: "test-key", model: "gpt-test", maxTokens: 4_096, fetch: fetchMock });

    const result = await modelClient.complete({
      system: "system prompt",
      tools: [{ name: "bash", description: "Run bash", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: [
          textBlock("hello"),
          imageBlock("image/png", { type: "url", url: "https://example.test/image.png" }),
          documentBlock({ type: "base64", data: "pdf" }, "Spec"),
        ] },
        { role: "assistant", content: [toolCallBlock("call-0", "bash", { command: "ls" })] },
        { role: "tool", content: [toolResultBlock("call-0", "files", true)] },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({ method: "POST" }),
    );
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request).toEqual({
      model: "gpt-test",
      instructions: "system prompt",
      max_output_tokens: 4_096,
      input: [
        { role: "user", content: [
          { type: "input_text", text: "hello" },
          { type: "input_image", image_url: "https://example.test/image.png" },
          { type: "input_file", filename: "Spec", file_data: "data:application/pdf;base64,pdf" },
        ] },
        { type: "function_call", call_id: "call-0", name: "bash", arguments: "{\"command\":\"ls\"}" },
        { type: "function_call_output", call_id: "call-0", output: "files" },
      ],
      tools: [{
        type: "function",
        name: "bash",
        description: "Run bash",
        parameters: { type: "object" },
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

  it("maps incomplete output to max_tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "partial reasoning" }] },
      ],
    }), { status: 200 }));
    const modelClient = new OpenAIResponses({ apiKey: "test-key", model: "gpt-test", fetch: fetchMock });

    const result = await modelClient.complete({
      system: "system",
      tools: [],
      messages: [{ role: "user", content: [textBlock("hello")] }],
    });

    expect(result.stopReason).toBe("max_tokens");
    expect(result.content).toEqual([thinkingBlock("partial reasoning")]);
  });

  it("lets the provider choose output tokens by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    }), { status: 200 }));
    const modelClient = new OpenAIResponses({ apiKey: "test-key", model: "gpt-test", fetch: fetchMock });

    await modelClient.complete({
      system: "system",
      tools: [],
      messages: [{ role: "user", content: [textBlock("hello")] }],
    });

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect("max_output_tokens" in request).toBe(false);
  });

  it("streams output text deltas and maps the completed response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"response.reasoning_summary_text.delta","delta":"reasoning"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      'data: {"type":"response.completed","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
    ]));
    const modelClient = new OpenAIResponses({ apiKey: "test-key", model: "gpt-test", fetch: fetchMock });
    const deltas: Array<string> = [];
    const thinkingDeltas: Array<string> = [];

    const result = await modelClient.complete({
      system: "system",
      tools: [],
      messages: [{ role: "user", content: [textBlock("hello")] }],
      onTextDelta: (delta) => deltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
    });

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(thinkingDeltas).toEqual(["reasoning"]);
    expect(result).toEqual({
      stopReason: "max_tokens",
      content: [textBlock("Hello")],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.stream).toBe(true);
  });
});
