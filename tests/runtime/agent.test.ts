import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../src/runtime/agent.js";
import { createInMemoryArtifactStore } from "../../src/runtime/artifacts.js";
import { textBlock, toolCallBlock } from "../../src/runtime/messages.js";
import type { ModelClient, ModelResponse } from "../../src/runtime/model-client.js";
import type { AgentEventMap } from "../../src/runtime/events.js";

function response(
  content: ModelResponse["content"],
  stopReason: ModelResponse["stopReason"] = "end",
  usage?: ModelResponse["usage"],
): ModelResponse {
  return { stopReason, content, usage };
}

function createModelClient(complete: ModelClient["complete"]): ModelClient {
  return { complete };
}

describe("Agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a modelClient and sends system, messages and tools", async () => {
    const complete = vi.fn().mockResolvedValue(response([textBlock("done")]));
    const modelClient = createModelClient(complete);

    expect(() => new AgentRuntime({ modelClient: undefined as unknown as ModelClient })).toThrow("modelClient is required");

    const agent = new AgentRuntime({ modelClient, system: "test system" });
    const result = await agent.run("hello");

    expect(complete).toHaveBeenCalledWith({
      system: "test system",
      messages: [
        { role: "user", content: [textBlock("hello")] },
        { role: "assistant", content: [textBlock("done")] },
      ],
      tools: agent.tools,
      onTextDelta: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual(response([textBlock("done")]));
    expect(agent.messages).toHaveLength(2);
    expect(agent.running).toBe(false);
  });

  it("emits text deltas during model calls", async () => {
    const modelClient = createModelClient(async ({ onTextDelta }) => {
      onTextDelta?.("Hel");
      onTextDelta?.("lo");
      return response([textBlock("Hello")]);
    });
    const agent = new AgentRuntime({ modelClient });
    const deltas: Array<string> = [];
    agent.on("text_delta", ({ delta }) => deltas.push(delta));

    await agent.run("hello");

    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("executes wrapped tools and continues the modelClient loop", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(response([
        toolCallBlock("call-1", "bash", { command: "pwd" }),
      ], "tool_call", { inputTokens: 10, outputTokens: 2, totalTokens: 12 }))
      .mockResolvedValueOnce(response(
        [textBlock("finished")],
        "end",
        { inputTokens: 20, outputTokens: 4, cacheReadInputTokens: 5 },
      ));
    const handler = vi.fn(async () => ({ stdout: "/home/dev/mycoder" }));
    const wrapToolCall = vi.fn(() => handler);
    const agent = new AgentRuntime({
      modelClient: createModelClient(complete),
      extensions: [{ name: "test", wrapToolCall }],
    });
    const events: Array<keyof AgentEventMap> = [];
    agent.on("message", () => events.push("message"));
    const usageEvents: Array<AgentEventMap["model_usage"]> = [];
    agent.on("model_usage", (event) => usageEvents.push(event));
    agent.on("tool_start", () => events.push("tool_start"));
    agent.on("tool_end", () => events.push("tool_end"));

    await agent.run("run command");

    expect(wrapToolCall).toHaveBeenCalledWith({
      name: "bash",
      definition: agent.tools[0],
      handler: expect.any(Function),
    });
    expect(handler).toHaveBeenCalledWith(
      { command: "pwd" },
      { signal: expect.any(AbortSignal) },
    );
    expect(agent.messages[2]).toEqual({
      role: "tool",
      content: [{
        type: "tool_result",
        toolCallId: "call-1",
        content: { stdout: "/home/dev/mycoder" },
        isError: false,
      }],
    });
    expect(events).toEqual(["message", "message", "tool_start", "tool_end", "message", "message"]);
    expect(usageEvents[1]?.totalUsage).toEqual({
      requests: 2,
      inputTokens: 30,
      outputTokens: 6,
      totalTokens: 36,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    });
    expect(agent.usage).toEqual(usageEvents[1]?.totalUsage);
  });

  it("returns an error result for unknown tools", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(response([
        toolCallBlock("call-1", "missing"),
      ], "tool_call"))
      .mockResolvedValueOnce(response([textBlock("recovered")]));
    const agent = new AgentRuntime({ modelClient: createModelClient(complete) });

    await agent.run("use missing tool");

    expect(agent.messages[2]?.content[0]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      content: "未知工具: missing",
      isError: true,
    });
  });

  it("applies request and response extensions", async () => {
    const complete = vi.fn().mockImplementation(async (request) => {
      return response([textBlock(`${request.system}:${request.messages.length}`)]);
    });
    const agent = new AgentRuntime({
      modelClient: createModelClient(complete),
      extensions: [{
        name: "transform",
        beforeModelCall: (request) => ({ ...request, system: "updated" }),
        afterModelResponse: ({ response }) => ({
          ...response,
          content: [textBlock("transformed")],
        }),
      }],
    });

    const result = await agent.run("hello");

    expect(result.content).toEqual([textBlock("transformed")]);
    expect(agent.messages[1]?.content).toEqual([textBlock("transformed")]);
  });

  it("reset clears history and rejects while running", async () => {
    let release!: (response: ModelResponse) => void;
    const modelClient = createModelClient(() => new Promise<ModelResponse>((resolve) => {
      release = resolve;
    }));
    const agent = new AgentRuntime({ modelClient });
    const pending = agent.run("hello");

    expect(() => agent.reset()).toThrow("cannot reset while agent is running");
    expect(agent.running).toBe(true);
    await expect(agent.run("again")).rejects.toThrow("agent is already running");

    release(response([textBlock("done")]));
    await pending;
    agent.reset();

    expect(agent.messages).toEqual([]);
    expect(agent.running).toBe(false);
  });
});
