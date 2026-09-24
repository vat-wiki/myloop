import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { CapturedSpan } from "@opentui/core";
import { afterEach, describe, expect, it } from "vitest";
import { TuiApp } from "../src/ui.js";
import type { SingleAgent } from "mycoder/agent";

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

    const spans = collectSpans(setup.captureSpans());

    expect(findSpan(spans, { text: "list files", fg: "#22d3ee" })).toBeDefined();
    expect(findSpan(spans, { text: "ls src/", fg: "#facc15" })).toBeDefined();
    expect(findSpan(spans, { text: "step 1", fg: "#facc15" })).toBeDefined();

    resolveRun?.();
    await setup.flush();
  });

  it("done: markdown heading is cyan bold, bold text has BOLD attribute, inline code is yellow", async () => {
    const agent = createAgentStub(async (emit) => {
      emit("model_usage", {
        totalUsage: { requests: 1, inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0 },
      });
      emit("assistant_message", {
        message: {
          content: [{ type: "text", text: "## Summary\n\n**3 files** changed with `npm test` passing." }],
        },
      });
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

    expect(findSpan(spans, { text: "Summary", fg: "#22d3ee", bold: true })).toBeDefined();
    expect(findSpan(spans, { text: "3 files", bold: true })).toBeDefined();
    expect(findSpan(spans, { text: "npm test", fg: "#facc15" })).toBeDefined();
    expect(findSpan(spans, { text: "changed with", fg: "#e2e8f0" })).toBeDefined();
    expect(findSpan(spans, { text: "─", fg: "#334155" })).toBeDefined();
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

  it("input cleared after submission", async () => {
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
    expect(frame).not.toContain("│ hello");
    expect(frame).toContain("done");
  });
});
