import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../src/runtime/agent.js";
import { createInMemoryArtifactStore } from "../../src/runtime/artifacts.js";
import { textBlock, thinkingBlock, toolCallBlock, toolResultBlock } from "../../src/runtime/messages.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../../src/runtime/model-client.js";
import type { CommandHost } from "../../src/command/index.js";
import { ShellCommandHost } from "../../src/command/shell/index.js";
import type { AgentEventMap } from "../../src/runtime/events.js";
import type { RuntimeSessionStore } from "../../src/runtime/session.js";

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
      onThinkingDelta: expect.any(Function),
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

  it("continues automatically after max_tokens", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(response([textBlock("Hel")], "max_tokens"))
      .mockResolvedValueOnce(response([textBlock("lo")], "end"));
    const agent = new AgentRuntime({ modelClient: createModelClient(complete) });

    const result = await agent.run("hello");

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0]?.messages.slice(0, 3)).toEqual([
      { role: "user", content: [textBlock("hello")] },
      { role: "assistant", content: [textBlock("Hel")] },
      { role: "user", content: [textBlock(
        "Continue from where the previous response stopped. Do not repeat content.",
      )] },
    ]);
    expect(result.stopReason).toBe("end");
    expect(result.content).toEqual([textBlock("Hello")]);
    expect(agent.messages).toHaveLength(4);
  });

  it("executes wrapped tools and continues the modelClient loop", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(response([
        toolCallBlock("call-1", "command", { command: "pwd" }),
      ], "tool_call", { inputTokens: 10, outputTokens: 2, totalTokens: 12 }))
      .mockResolvedValueOnce(response(
        [textBlock("finished")],
        "end",
        { inputTokens: 25, outputTokens: 4, cacheReadInputTokens: 5 },
      ));
    const handler = vi.fn(async () => ({ stdout: "/home/dev/myloop" }));
    const wrapToolCall = vi.fn(() => handler);
    const agent = new AgentRuntime({
      modelClient: createModelClient(complete),
      extensions: [{ name: "test", wrapToolCall }],
      commandHost: new ShellCommandHost(),
    });
    const events: Array<keyof AgentEventMap> = [];
    agent.on("message", () => events.push("message"));
    const responseEvents: Array<AgentEventMap["model_response"]> = [];
    agent.on("model_response", (event) => responseEvents.push(event));
    agent.on("tool_start", () => events.push("tool_start"));
    agent.on("tool_end", () => events.push("tool_end"));

    await agent.run("run command");

    expect(wrapToolCall).toHaveBeenCalledWith({
      name: "command",
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
        content: { stdout: "/home/dev/myloop" },
        isError: false,
      }],
    });
    expect(events).toEqual(["message", "message", "tool_start", "tool_end", "message", "message"]);
    expect(responseEvents[1]?.response.usage).toEqual({
      inputTokens: 25,
      outputTokens: 4,
      cacheReadInputTokens: 5,
    });
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

  it("routes invocations through an injected command host", async () => {
    const browserHost: CommandHost = {
      id: "browser",
      toolName: "browser",
      description: "Run browser commands",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string" } },
        required: ["action"],
      },
      run: async (input, context) => ({
        action: input.action,
        aborted: context.signal?.aborted ?? false,
      }),
    };
    const complete = vi.fn()
      .mockResolvedValueOnce(response([
        toolCallBlock("call-1", "browser", { action: "open" }),
      ], "tool_call"))
      .mockResolvedValueOnce(response([textBlock("opened")]));
    const agent = new AgentRuntime({
      modelClient: createModelClient(complete),
      commandHost: browserHost,
    });

    await agent.run("open browser");

    expect(agent.tools).toEqual([{
      name: "browser",
      description: "Run browser commands",
      parameters: browserHost.inputSchema,
    }]);
    expect(agent.messages[2]?.content[0]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      content: { action: "open", aborted: false },
      isError: false,
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

  it("snapshots and restores resumable history", async () => {
    const firstClient = createModelClient(async () => response([textBlock("done")]));
    const firstAgent = new AgentRuntime({ modelClient: firstClient });
    await firstAgent.run("hello");

    const snapshot = firstAgent.snapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.messages).toHaveLength(2);

    const mutatedSnapshot = structuredClone(snapshot);
    mutatedSnapshot.messages[0]!.content[0] = textBlock("mutated");
    expect(firstAgent.messages[0]?.content[0]).toEqual(textBlock("hello"));

    let restoredRequestMessages: ModelRequest["messages"] = [];
    const restoredClient = createModelClient(async (request) => {
      restoredRequestMessages = structuredClone(request.messages);
      return response([textBlock("continued")]);
    });
    const restoredAgent = new AgentRuntime({ modelClient: restoredClient });
    restoredAgent.restore(snapshot);

    await restoredAgent.run("continue");

    expect(restoredRequestMessages).toHaveLength(3);
    expect(restoredRequestMessages[0]?.content[0]).toEqual(textBlock("hello"));
  });

  it("rejects invalid or unpaired session snapshots", () => {
    const agent = new AgentRuntime({ modelClient: createModelClient(async () => response([])) });

    expect(() => agent.restore({
      version: 2,
      messages: [],
    })).toThrow("unsupported session snapshot version");
    expect(() => agent.restore({
      version: 1,
      messages: [{
        role: "assistant",
        content: [toolCallBlock("call-1", "bash", { command: "pwd" })],
      }],
    })).toThrow("session snapshot has a tool call without a tool result");
    expect(() => agent.restore({
      version: 1,
      messages: [{
        role: "tool",
        content: [toolResultBlock("call-1", "done")],
      }],
    })).toThrow("session snapshot has a tool result without a tool call");
  });

  it("saves and loads sessions through an injected store", async () => {
    const firstClient = createModelClient(async () => response([textBlock("done")]));
    const savedSnapshots: Array<Parameters<RuntimeSessionStore["save"]>[1]> = [];
    const sessionStore: RuntimeSessionStore = {
      save: async (_sessionId, snapshot) => {
        savedSnapshots.push(snapshot);
      },
      load: async () => savedSnapshots[0],
    };
    const firstAgent = new AgentRuntime({
      modelClient: firstClient,
      sessionId: "session-1",
      sessionStore,
    });
    await firstAgent.run("hello");
    await firstAgent.saveSession();

    expect(savedSnapshots[0]?.messages).toHaveLength(2);

    const secondAgent = new AgentRuntime({
      modelClient: createModelClient(async () => response([textBlock("next")])),
      sessionId: "session-1",
      sessionStore,
    });
    await expect(secondAgent.loadSession()).resolves.toBe(true);
    expect(secondAgent.messages).toEqual(firstAgent.snapshot().messages);
  });

  it("switches the current session when loading an explicit id", async () => {
    const saved: Array<{ sessionId: string; messageCount: number }> = [];
    const snapshots = new Map<string, Parameters<RuntimeSessionStore["save"]>[1]>();
    const sessionStore: RuntimeSessionStore = {
      save: async (sessionId, snapshot) => {
        saved.push({ sessionId, messageCount: snapshot.messages.length });
        snapshots.set(sessionId, snapshot);
      },
      load: async (sessionId) => snapshots.get(sessionId),
    };
    const agent = new AgentRuntime({
      modelClient: createModelClient(async () => response([textBlock("first")])),
      sessionId: "session-1",
      sessionStore,
    });

    await agent.run("first");
    await agent.saveSession();
    await expect(agent.loadSession("session-2")).resolves.toBe(false);
    expect(agent.sessionId).toBe("session-2");

    await agent.run("second");
    await agent.saveSession();

    expect(saved).toEqual([
      { sessionId: "session-1", messageCount: 2 },
      { sessionId: "session-2", messageCount: 2 },
    ]);
  });
});
