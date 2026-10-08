import { describe, expect, it } from "vitest";
import { Anthropic } from "myloop/clients/anthropic";
import type { HttpTransport } from "myloop/clients/http";
import { OpenAIChat } from "myloop/clients/openai-chat";
import { OpenAIResponses } from "myloop/clients/openai-responses";
import { createAppModelClient } from "../src/model.js";

function jsonResponse(body: unknown) {
  return {
    status: 200,
    ok: true,
    headers: new Headers(),
    text: JSON.stringify(body),
  };
}

function transportCapturingBody(
  respond: () => ReturnType<typeof jsonResponse>,
): { transport: HttpTransport; bodies: Array<Record<string, unknown>>; urls: Array<string> } {
  const bodies: Array<Record<string, unknown>> = [];
  const urls: Array<string> = [];
  const transport: HttpTransport = async (request) => {
    urls.push(request.url);
    bodies.push(JSON.parse(request.body));
    return respond();
  };
  return { transport, bodies, urls };
}

function modelRequest() {
  return {
    system: "system",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
  } as const;
}

describe("createAppModelClient", () => {
  it("creates an Anthropic client with context and thinking options", () => {
    const client = createAppModelClient({
      protocol: "anthropic",
      model: "claude-x",
      apiKey: "key",
      maxTokens: 1_024,
      contextWindowTokens: 32_000,
      thinking: true,
    });

    expect(client).toBeInstanceOf(Anthropic);
    expect(client.context?.contextWindowTokens).toBe(32_000);
    expect(client.context?.reservedOutputTokens).toBe(1_024);
  });

  it("applies the default Anthropic thinking budget of 4096", () => {
    const client = createAppModelClient({
      protocol: "anthropic",
      model: "claude-x",
      thinking: true,
    });

    expect((client as Anthropic).maxTokens).toBe(8192);
    expect(client.context?.reservedOutputTokens).toBe(8192);
  });

  it("creates an OpenAI Chat client with defaults", () => {
    const client = createAppModelClient({
      protocol: "openai-chat",
      model: "gpt-x",
    });

    expect(client).toBeInstanceOf(OpenAIChat);
    expect(client.context?.contextWindowTokens).toBe(128_000);
  });

  it("creates an OpenAI Responses client with defaults", () => {
    const client = createAppModelClient({
      protocol: "openai-responses",
      model: "gpt-x",
      maxTokens: 2_048,
    });

    expect(client).toBeInstanceOf(OpenAIResponses);
    expect(client.context?.contextWindowTokens).toBe(128_000);
    expect(client.context?.reservedOutputTokens).toBe(2_048);
  });

  it("propagates contextWindowTokens overrides for openai protocols", () => {
    const client = createAppModelClient({
      protocol: "openai-chat",
      model: "gpt-x",
      contextWindowTokens: 32_000,
    });

    expect(client.context?.contextWindowTokens).toBe(32_000);
  });

  it("propagates the transport hook so requests stay in-process", async () => {
    const { transport, bodies, urls } = transportCapturingBody(() => jsonResponse({
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const client = createAppModelClient({
      protocol: "anthropic",
      model: "claude-x",
      transport,
    });

    const response = await client.complete(modelRequest());

    expect(urls).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(bodies[0]?.model).toBe("claude-x");
    expect(response.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("propagates the transport hook for openai-chat requests", async () => {
    const { transport, bodies, urls } = transportCapturingBody(() => jsonResponse({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const client = createAppModelClient({
      protocol: "openai-chat",
      model: "gpt-x",
      transport,
    });

    const response = await client.complete(modelRequest());

    expect(urls).toEqual(["https://api.openai.com/v1/chat/completions"]);
    expect(bodies[0]?.model).toBe("gpt-x");
    expect(response.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("propagates the transport hook and reasoning for openai-responses", async () => {
    const { transport, bodies, urls } = transportCapturingBody(() => jsonResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const client = createAppModelClient({
      protocol: "openai-responses",
      model: "gpt-x",
      thinking: true,
      transport,
    });

    const response = await client.complete(modelRequest());

    expect(urls).toEqual(["https://api.openai.com/v1/responses"]);
    expect(bodies[0]?.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(response.content).toEqual([{ type: "text", text: "hi" }]);
  });
});
