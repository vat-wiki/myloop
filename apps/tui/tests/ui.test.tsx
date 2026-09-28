import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { CapturedSpan } from "@opentui/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TuiApp } from "../src/ui.js";
import type { SingleAgent } from "mycoder/agent";
import { textBlock } from "mycoder/messages";

type AgentHandler = (event: any) => void;

type AgentStub = SingleAgent & {
  emitAgentEvent: (event: string, payload: any) => void;
};

function createAgentStub(runFn?: (emit: AgentStub["emitAgentEvent"]) => Promise<void>): AgentStub {
  const handlers = new Map<string, AgentHandler>();
  const emitAgentEvent = (event: string, payload: any): void => {
    const handler = handlers.get(event);
    if (typeof handler !== "function") return;
    handler(payload);
  };
  return {
    emitAgentEvent,
    on(event: string, handler: AgentHandler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    reset() {},
    async run() {
      await runFn?.(emitAgentEvent);
    },
  } as unknown as AgentStub;
}

type SpanQuery = {
  text: string;
  fg?: string;
  bold?: boolean;
};

function findSpan(spans: Array<CapturedSpan>, query: SpanQuery): CapturedSpan | undefined {
  return spans.find((span) => {
    if (query.text && !span.text.includes(query.text)) return false;
    if (query.fg) {
      const expected = RGBA.fromHex(query.fg);
      if (span.fg.r !== expected.r || span.fg.g !== expected.g || span.fg.b !== expected.b) return false;
    }
    if (query.bold !== undefined) {
      const isBold = (span.attributes & TextAttributes.BOLD) !== 0;
      if (isBold !== query.bold) return false;
    }
    return true;
  });
}

function collectSpans(capture: { lines: Array<{ spans: Array<CapturedSpan> }> }): Array<CapturedSpan> {
  return capture.lines.flatMap((line) => line.spans);
}

describe("TUI visual verification", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  it("idle: header colors and input placeholder", async () => {
    const agent = createAgentStub();
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 20 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    const spans = collectSpans(setup.captureSpans());

    expect(findSpan(spans, { text: "mycoder", fg: "#22d3ee", bold: true })).toBeDefined();
    expect(findSpan(spans, { text: "test-model" })).toBeDefined();
    expect(findSpan(spans, { text: "Describe" })).toBeDefined();
  });

  it("idle: shows logo and shortcuts in the empty session", async () => {
    const agent = createAgentStub();
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 24 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    const spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "Your terminal agent" })).toBeDefined();
    expect(findSpan(spans, { text: "Send message" })).toBeDefined();
    expect(findSpan(spans, { text: "Interrupt agent" })).toBeDefined();
    expect(findSpan(spans, { text: "Complete command" })).toBeDefined();
  });

  it("replays restored runtime history", async () => {
    const agent = createAgentStub();
    (agent as unknown as { messages: unknown }).messages = [
      { role: "user", content: [textBlock("first task")] },
      { role: "assistant", content: [textBlock("first answer")] },
      { role: "user", content: [textBlock("second task")] },
    ];
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("first task");
    expect(frame).toContain("first answer");
    expect(frame).toContain("second task");
    expect(frame).toContain("(no response)");
  });

  it("lists and switches sessions with /sessions", async () => {
    const restoredMessages = [
      { role: "user", content: [textBlock("other task")] },
      { role: "assistant", content: [textBlock("other answer")] },
    ];
    const baseAgent = createAgentStub();
    const loadSession = vi.fn(async (sessionId: string) => {
      if (sessionId === "work-2") {
        (agent as unknown as { messages: unknown }).messages = restoredMessages;
        return true;
      }
      return false;
    });
    const agent = {
      ...baseAgent,
      sessionId: "default",
      loadSession,
    } as unknown as SingleAgent;
    const sessionStore = {
      list: async () => ["default", "work-1", "work-2"],
    };
    let select: ((direction: 1 | -1) => boolean) | undefined;
    let submitSelected: (() => boolean) | undefined;
    const setup = await testRender(
      () => TuiApp({
        agent,
        protocol: "test",
        model: "test-model",
        sessionStore,
        onExit: () => {},
        registerSelectCommand: (handler) => {
          select = handler;
        },
        registerSubmitCommand: (handler) => {
          submitSelected = handler;
        },
      }),
      { width: 80, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    await setup.mockInput.typeText("/sessions");
    setup.mockInput.pressEnter();
    await setup.flush();

    expect(setup.captureCharFrame()).toContain("Sessions");
    expect(select?.(1)).toBe(true);
    expect(select?.(1)).toBe(true);
    expect(submitSelected?.()).toBe(true);
    await setup.flush();
    await setup.renderOnce();

    expect(loadSession).toHaveBeenCalledWith("work-2");
    const frame = setup.captureCharFrame();
    expect(frame).toContain("work-2");
    expect(frame).toContain("other task");
    expect(frame).toContain("other answer");
  });

  it("shows the latest model call usage instead of cumulative usage", async () => {
    const agent = createAgentStub(async (emit) => {
      emit("context_pressure", {
        pressure: {
          usedTokens: 32_000,
          limitTokens: 128_000,
          ratio: 0.25,
        },
      });
      emit("model_response", {
        response: { usage: { inputTokens: 12, outputTokens: 3 }, content: [] },
      });
      emit("model_response", {
        response: { usage: { inputTokens: 20, outputTokens: 4 }, content: [] },
      });
      emit("assistant_message", {
        message: { content: [{ type: "text", text: "done" }] },
      });
    });
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 20 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    setup.mockInput.pressKey("a");
    setup.mockInput.pressEnter();
    await setup.flush();
    await setup.flush();
    await setup.renderOnce();

    const spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "ctx 25% (32.0k/128k)" })).toBeDefined();
    expect(findSpan(spans, { text: "in 20" })).toBeDefined();
    expect(findSpan(spans, { text: "out 4" })).toBeDefined();
    expect(findSpan(spans, { text: "in 32" })).toBeUndefined();
    expect(findSpan(spans, { text: "req 2" })).toBeUndefined();
  });

  it("working: step counter, description, and elapsed in correct colors", async () => {
    let resolveRun: (() => void) | null = null;
    const runPromise = new Promise<void>((resolve) => { resolveRun = resolve; });
    const agent = createAgentStub(async (emit) => {
      emit("tool_start", { id: "1", name: "bash", input: { command: "ls src/" } });
      await runPromise;
    });
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    for (const char of "list files") {
      setup.mockInput.pressKey(char);
    }
    setup.mockInput.pressEnter();
    await setup.flush();
    await setup.flush();
    await setup.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const spans = collectSpans(setup.captureSpans());

    expect(findSpan(spans, { text: "list files", fg: "#22d3ee" })).toBeDefined();
    expect(findSpan(spans, { text: "ls src/", fg: "#facc15" })).toBeDefined();
    expect(findSpan(spans, { text: "step 1", fg: "#facc15" })).toBeDefined();

    resolveRun?.();
    await setup.flush();
    await setup.flush();
    await setup.renderOnce();
  });

  it("submitting keeps the task visible while the agent runs", async () => {
    let resolveRun: (() => void) | null = null;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const agent = createAgentStub(async () => {
      await runPromise;
    });
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    for (const char of "check result") {
      setup.mockInput.pressKey(char);
    }
    setup.mockInput.pressEnter();
    await setup.flush();
    const spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "check result", fg: "#22d3ee" })).toBeDefined();

    resolveRun?.();
    await setup.flush();
  });

  it("queues input while a turn is running and runs it after ESC", async () => {
    const inputs: string[] = [];
    let resolveFirst: (() => void) | null = null;
    let rejectFirst: ((error: Error) => void) | null = null;
    let resolveQueued: (() => void) | null = null;
    const agent = {
      on: () => () => {},
      reset() {},
      async run(input: string) {
        inputs.push(input);
        if (inputs.length === 1) {
          await new Promise<void>((resolve, reject) => {
            resolveFirst = resolve;
            rejectFirst = reject;
          });
          return;
        }
        await new Promise<void>((resolve) => {
          resolveQueued = resolve;
        });
      },
      abort() {
        rejectFirst?.(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      },
    } as unknown as SingleAgent;
    let interrupt: (() => void) | undefined;
    const setup = await testRender(
      () => TuiApp({
        agent,
        protocol: "test",
        model: "test-model",
        onExit: () => {},
        registerInterrupt: (handler) => {
          interrupt = handler;
        },
      }),
      { width: 80, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    for (const char of "first") setup.mockInput.pressKey(char);
    setup.mockInput.pressEnter();
    await setup.flush();

    for (const char of "second") setup.mockInput.pressKey(char);
    setup.mockInput.pressEnter();
    await setup.flush();
    for (const char of "third") setup.mockInput.pressKey(char);
    setup.mockInput.pressEnter();
    await setup.flush();
    await setup.renderOnce();

    expect(inputs).toEqual(["first"]);
    let spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "second", fg: "#94a3b8" })).toBeDefined();
    expect(findSpan(spans, { text: "third", fg: "#94a3b8" })).toBeDefined();

    interrupt?.();
    await setup.flush();
    await setup.flush();
    await setup.flush();
    resolveQueued?.();
    await setup.flush();
    await setup.flush();
    await setup.renderOnce();

    expect(inputs).toEqual(["first", "second\n\nthird"]);
    spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "(interrupted)" })).toBeDefined();
});

  it("clears the input with Ctrl+U", async () => {
    const agent = createAgentStub();
    let clearInput: (() => void) | undefined;
    const setup = await testRender(
      () => TuiApp({
        agent,
        protocol: "test",
        model: "test-model",
        onExit: () => {},
        registerClearInput: (handler) => {
          clearInput = handler;
        },
      }),
      { width: 80, height: 20 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    for (const char of "clear me") {
      setup.mockInput.pressKey(char);
    }
    await setup.renderOnce();
    expect(findSpan(collectSpans(setup.captureSpans()), { text: "clear me" })).toBeDefined();

    clearInput?.();
    await setup.flush();
    await setup.renderOnce();

    const spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "clear me" })).toBeUndefined();
    expect(findSpan(spans, { text: "Describe a task" })).toBeDefined();
  });

  it("shows filtered slash commands while typing", async () => {
    const agent = createAgentStub();
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 20 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    setup.mockInput.pressKey("/");
    await setup.renderOnce();
    const allCommands = collectSpans(setup.captureSpans());
    expect(findSpan(allCommands, { text: "/sessions", fg: "#22d3ee" })).toBeDefined();
    expect(findSpan(allCommands, { text: "/help", fg: "#94a3b8" })).toBeDefined();
    expect(findSpan(allCommands, { text: "/exit", fg: "#94a3b8" })).toBeDefined();

    setup.mockInput.pressKey("h");
    setup.mockInput.pressKey("e");
    await setup.renderOnce();
    const filteredCommands = collectSpans(setup.captureSpans());
    expect(findSpan(filteredCommands, { text: "/help", fg: "#22d3ee" })).toBeDefined();
    expect(findSpan(filteredCommands, { text: "/usage" })).toBeUndefined();
  });

  it("completes the selected slash command", async () => {
    const agent = createAgentStub();
    let complete: (() => boolean) | undefined;
    const setup = await testRender(
      () => TuiApp({
        agent,
        protocol: "test",
        model: "test-model",
        onExit: () => {},
        registerCompleteCommand: (handler) => {
          complete = handler;
        },
      }),
      { width: 80, height: 20 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    setup.mockInput.pressKey("/");
    setup.mockInput.pressKey("u");
    await setup.renderOnce();
    expect(complete?.()).toBe(true);
    await setup.renderOnce();

    const spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "/usage", fg: "#22d3ee" })).toBeDefined();
    expect(findSpan(spans, { text: "/help" })).toBeUndefined();
  });

  it("changes the selected slash command", async () => {
    const agent = createAgentStub();
    let select: ((direction: 1 | -1) => boolean) | undefined;
    const setup = await testRender(
      () => TuiApp({
        agent,
        protocol: "test",
        model: "test-model",
        onExit: () => {},
        registerSelectCommand: (handler) => {
          select = handler;
        },
      }),
      { width: 80, height: 20 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    setup.mockInput.pressKey("/");
    await setup.renderOnce();
    let spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "/sessions", fg: "#22d3ee", bold: true })).toBeDefined();
    expect(findSpan(spans, { text: "/help", fg: "#94a3b8", bold: false })).toBeDefined();

    expect(select?.(1)).toBe(true);
    await setup.renderOnce();
    spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "/help", fg: "#22d3ee", bold: true })).toBeDefined();
    expect(findSpan(spans, { text: "/usage", fg: "#94a3b8", bold: false })).toBeDefined();

    expect(select?.(1)).toBe(true);
    await setup.renderOnce();
    spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "/usage", fg: "#22d3ee", bold: true })).toBeDefined();
    expect(findSpan(spans, { text: "/help", fg: "#94a3b8", bold: false })).toBeDefined();

    expect(select?.(-1)).toBe(true);
    await setup.renderOnce();
    spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "/help", fg: "#22d3ee", bold: true })).toBeDefined();
    expect(findSpan(spans, { text: "/usage", fg: "#94a3b8", bold: false })).toBeDefined();

    expect(select?.(-1)).toBe(true);
    await setup.renderOnce();
    spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "/sessions", fg: "#22d3ee", bold: true })).toBeDefined();
    expect(findSpan(spans, { text: "/help", fg: "#94a3b8", bold: false })).toBeDefined();
  });

  it("runs the selected slash command when Enter accepts an incomplete query", async () => {
    const agent = createAgentStub();
    let submitSelected: (() => boolean) | undefined;
    const setup = await testRender(
      () => TuiApp({
        agent,
        protocol: "test",
        model: "test-model",
        onExit: () => {},
        registerSubmitCommand: (handler) => {
          submitSelected = handler;
        },
      }),
      { width: 80, height: 20 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    setup.mockInput.pressKey("/");
    setup.mockInput.pressKey("u");
    await setup.renderOnce();
    expect(submitSelected?.()).toBe(true);
    await setup.flush();

    const spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "in 0" })).toBeDefined();
  });

  it("lets Enter submit normally when input is already a complete command", async () => {
    const agent = createAgentStub();
    let submitSelected: (() => boolean) | undefined;
    const setup = await testRender(
      () => TuiApp({
        agent,
        protocol: "test",
        model: "test-model",
        onExit: () => {},
        registerSubmitCommand: (handler) => {
          submitSelected = handler;
        },
      }),
      { width: 80, height: 20 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    for (const char of "/help") setup.mockInput.pressKey(char);
    await setup.renderOnce();
    expect(submitSelected?.()).toBe(false);
  });

  it("clears the input after submitting a completed slash command", async () => {
    const agent = createAgentStub();
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 20 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    setup.mockInput.pressKey("/");
    setup.mockInput.pressKey("u");
    setup.mockInput.pressTab();
    setup.mockInput.pressEnter();
    await setup.flush();

    for (const char of "hello") setup.mockInput.pressKey(char);
    setup.mockInput.pressEnter();
    await setup.flush();

    const spans = collectSpans(setup.captureSpans());
    expect(findSpan(spans, { text: "hello", fg: "#22d3ee" })).toBeDefined();
    expect(findSpan(spans, { text: "/usagehello" })).toBeUndefined();
  });

  it("done: markdown table is aligned and separator row is hidden", async () => {
    const agent = createAgentStub(async (emit) => {
      emit("assistant_message", {
        message: {
          content: [
            {
              type: "text",
              text: "## Config\n\n| name | value |\n| --- | --- |\n| port | 8080 |",
            },
          ],
        },
      });
    });
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    for (const char of "show table") {
      setup.mockInput.pressKey(char);
    }
    setup.mockInput.pressEnter();
    await setup.flush();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("name value");
    expect(frame).toContain("port 8080");
    expect(frame).not.toContain("---");
  });

  it("logs the UI run lifecycle", async () => {
    const agent = createAgentStub(async (emit) => {
      emit("assistant_message", {
        message: { content: [{ type: "text", text: "done" }] },
      });
    });
    const log = vi.fn(async () => {});
    const logger = { log } as unknown as TuiLogger;
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", logger, onExit: () => {} }),
      { width: 80, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    for (const char of "hello") {
      setup.mockInput.pressKey(char);
    }
    setup.mockInput.pressEnter();
    await setup.flush();
    await setup.flush();
    await setup.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await setup.flush();
    await setup.renderOnce();

    expect(log).toHaveBeenCalledWith("run_start", { input: "hello" });
    expect(log).toHaveBeenCalledWith("run_end", expect.objectContaining({
      input: "hello",
      output: "done",
      ok: true,
    }));
  });

  it("error: status icon and message in red", async () => {
    const agent = createAgentStub(async () => {
      throw new Error("connection refused");
    });
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    for (const char of "fail please") {
      setup.mockInput.pressKey(char);
    }
    setup.mockInput.pressEnter();
    await setup.flush();

    const spans = collectSpans(setup.captureSpans());

    expect(findSpan(spans, { text: "connection refused", fg: "#ef4444" })).toBeDefined();
  });

  it("done: renders plain markdown text", async () => {
    const agent = createAgentStub(async (emit) => {
      emit("assistant_message", {
        message: { content: [{ type: "text", text: "plain done" }] },
      });
    });
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    for (const char of "plain output") {
      setup.mockInput.pressKey(char);
    }
    setup.mockInput.pressEnter();
    await setup.flush();

    expect(setup.captureCharFrame()).toContain("plain done");
  });

  it("multi-turn history renders numbered markdown without nested text nodes", async () => {
    let turn = 0;
    const agent = createAgentStub(async (emit) => {
      turn += 1;
      emit("assistant_message", {
        message: { content: [{ type: "text", text: turn === 1 ? "1. **`first`**" : "1. **`second`**" }] },
      });
    });
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    setup.mockInput.pressKey("a");
    setup.mockInput.pressKey("1");
    setup.mockInput.pressEnter();
    await setup.flush();

    setup.mockInput.pressKey("b");
    setup.mockInput.pressKey("2");
    setup.mockInput.pressEnter();
    await setup.flush();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("a1");
    expect(frame).toContain("b2");
    expect(frame).toContain("1. `first`");
    expect(frame).toContain("1. `second`");
  });

  it("input submits and clears the input placeholder", async () => {
    const agent = createAgentStub(async (emit) => {
      emit("assistant_message", {
        message: { content: [{ type: "text", text: "done" }] },
      });
    });
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    for (const char of "hello") {
      setup.mockInput.pressKey(char);
    }
    setup.mockInput.pressEnter();
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Describe");
    expect(frame).not.toContain("Agent is working…");
  });

  it("wraps long input before and after submission", async () => {
    let resolveRun: (() => void) | null = null;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const agent = createAgentStub(async () => {
      await runPromise;
    });
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 40, height: 20 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    await setup.mockInput.typeText("第一行内容很长会自动折行到下一行显示完毕");
    await setup.flush();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("折行");
    expect(frame).not.toContain("第一行内容很长会自动折行到下一行显示完毕");

    setup.mockInput.pressEnter();
    await setup.flush();

    frame = setup.captureCharFrame();
    expect(frame).not.toContain("第一行内容很长会自动折行到下一行显示完毕");
    expect(frame).toContain("第一行内容很长");
    expect(frame).toContain("自动折行");

    resolveRun?.();
    await setup.flush();
  });

  it("paste does not submit", async () => {
    const run = vi.fn(async () => {});
    const agent = createAgentStub(run);
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "test-model", onExit: () => {} }),
      { width: 80, height: 20 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();

    await setup.mockInput.pasteBracketedText("pasted text\nwith newline\n");
    await setup.flush();
    setup.mockInput.pressKey("\n");
    await setup.flush();

    expect(run).not.toHaveBeenCalled();
    expect(setup.captureCharFrame()).toContain("pasted text");
  });
});
