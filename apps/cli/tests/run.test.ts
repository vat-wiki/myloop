import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatEventDivider,
  formatToolOutput,
  formatTimestamp,
  printAgentPrompts,
  runTask,
} from "../src/run.js";
import type { RunTaskOptions } from "../src/run.js";

function createFakeOutput(): { stream: NodeJS.WriteStream; text: string } {
  const state = { text: "" };
  const stream = {
    write: (value: string) => {
      state.text += value;
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return {
    stream,
    get text() {
      return state.text;
    },
  };
}

describe("CLI task runner", () => {
  it("prints system and tool declarations without writing stdout", async () => {
    const statusMessages: Array<string> = [];
    const traceText: Array<string> = [];
    const output = createFakeOutput();

    await runTask({
      agent: {
        system: "terminal system",
        tools: [{ name: "command", description: "Run command", parameters: { type: "object" } }],
        on: () => () => {},
        abort() {},
        reset() {},
        run: async () => ({ answer: "done", response: { stopReason: "end" } }),
      },
      input: "run tests",
      saveSession: async () => {},
      output: output.stream,
      status: (message) => statusMessages.push(message),
      trace: (text) => traceText.push(text),
      printPrompts: true,
    });

    expect(statusMessages.join("\n")).toMatch(/──── system ─+/);
    expect(statusMessages.join("\n")).toMatch(/──── tools ─+/);
    expect(traceText.join("")).toContain("terminal system");
    expect(traceText.join("")).toContain("\"name\": \"command\"");
    expect(output.text).toBe("done\n");
  });

  it("formats agent prompts", () => {
    const statusMessages: Array<string> = [];
    const traceText: Array<string> = [];

    printAgentPrompts({
      agent: {
        system: "terminal system",
        tools: [{ name: "command", description: "Run command", parameters: { type: "object" } }],
      },
      status: (message) => statusMessages.push(message),
      trace: (text) => traceText.push(text),
    });

    expect(statusMessages).toHaveLength(2);
    expect(traceText.join("")).toContain("terminal system");
    expect(traceText.join("")).toContain("\"description\": \"Run command\"");
  });

  it("prints status to stderr and the answer to stdout", async () => {
    const statusMessages: Array<string> = [];
    const output = createFakeOutput();
    const options: RunTaskOptions = {
      agent: {
        on() {
          return () => {};
        },
        abort() {},
        reset() {},
        run: async () => ({ answer: "all tests pass", response: { stopReason: "end" } }),
      },
      input: "run tests",
      saveSession: async () => {},
      output: output.stream,
      status: (message) => statusMessages.push(message),
      trace: () => {},
    };

    const exitCode = await runTask(options);

    expect(exitCode).toBe(0);
    expect(statusMessages[0]).toMatch(/^✓ \d+\.\d+s · \d{2}:\d{2}:\d{2}$/);
    expect(output.text).toBe("all tests pass\n");
  });

  it("returns an error status without throwing", async () => {
    const statusMessages: Array<string> = [];
    const traceText: Array<string> = [];
    const output = createFakeOutput();
    let saved = false;

    const exitCode = await runTask({
      agent: {
        on: () => () => {},
        abort() {},
        reset() {},
        run: async () => {
          throw new Error("model failed");
        },
      },
      input: "run tests",
      saveSession: async () => {
        saved = true;
      },
      output: output.stream,
      status: (message) => statusMessages.push(message),
      trace: () => {},
    });

    expect(exitCode).toBe(1);
    expect(statusMessages.join("\n")).toContain("model failed");
    expect(saved).toBe(true);
  });

  it("streams thinking, model output, commands, and tool results", async () => {
    const statusMessages: Array<string> = [];
    const traceText: Array<string> = [];
    const output = createFakeOutput();
    const listeners = new Map<string, (event?: unknown) => void>();
    const emit = (event: string, eventPayload?: unknown): void => {
      listeners.get(event)?.(eventPayload);
    };

    const exitCode = await runTask({
      agent: {
        on(event, listener) {
          listeners.set(event, listener as (event?: unknown) => void);
          return () => {};
        },
        abort() {},
        reset() {},
        run: async () => {
          emit("thinking_delta", { delta: "I should run tests." });
          emit("tool_start", { name: "bash", input: { command: "npm test" } });
          emit("tool_end", { name: "bash", output: "exit:0\nstdout:\nall tests pass" });
          emit("text_delta", { delta: "All tests pass." });
          emit("assistant_message");
          return { answer: "All tests pass.", response: { stopReason: "end" } };
        },
      },
      input: "run tests",
      saveSession: async () => {},
      output: output.stream,
      status: (message) => statusMessages.push(message),
      trace: (text) => traceText.push(text),
    });

    expect(exitCode).toBe(0);
    expect(statusMessages.join("\n")).toMatch(/──── thinking ─+ \d{2}:\d{2}:\d{2}/);
    expect(statusMessages.join("\n")).toMatch(/──── tool\.start · bash ─+ \d{2}:\d{2}:\d{2}/);
    expect(statusMessages.join("\n")).toContain("$ npm test");
    expect(statusMessages.join("\n")).toMatch(/──── tool\.end · bash · \d+\.\d+s ─+ \d{2}:\d{2}:\d{2}/);
    expect(statusMessages.join("\n")).toMatch(/──── assistant ─+ \d{2}:\d{2}:\d{2}/);
    expect(traceText.join("")).toContain("I should run tests.\n");
    expect(output.text).toBe("All tests pass.\n");
  });

  it("colors stream sections and tool results when enabled", async () => {
    const statusMessages: Array<string> = [];
    const traceText: Array<string> = [];
    const output = createFakeOutput();
    const listeners = new Map<string, (event?: unknown) => void>();
    const emit = (event: string, eventPayload?: unknown): void => {
      listeners.get(event)?.(eventPayload);
    };

    await runTask({
      agent: {
        on(event, listener) {
          listeners.set(event, listener as (event?: unknown) => void);
          return () => {};
        },
        abort() {},
        reset() {},
        run: async () => {
          emit("thinking_delta", { delta: "thinking" });
          emit("tool_start", { name: "bash", input: { command: "npm test" } });
          emit("tool_end", { output: "exit:0\nstdout:\nok" });
          emit("text_delta", { delta: "done" });
          return { answer: "done", response: { stopReason: "end" } };
        },
      },
      input: "run tests",
      saveSession: async () => {},
      output: output.stream,
      status: (message) => statusMessages.push(message),
      trace: (text) => traceText.push(text),
      color: true,
    });

    expect(statusMessages.join("\n")).toContain("\x1b[2m");
    expect(traceText.join("")).toContain("\x1b[35mthinking\x1b[0m");
    expect(statusMessages.join("\n")).toContain("\x1b[36m$ npm test\x1b[0m");
    expect(output.text).toContain("done");
    expect(statusMessages.join("\n")).toContain("\x1b[32m");
  });

  it("warns when a partial answer is truncated by max_tokens", async () => {
    const statusMessages: Array<string> = [];
    const output = createFakeOutput();

    const exitCode = await runTask({
      agent: {
        on: () => () => {},
        abort() {},
        reset() {},
        run: async () => ({
          answer: "partial",
          response: { stopReason: "max_tokens" },
        }),
      },
      input: "write a long report",
      saveSession: async () => {},
      output: output.stream,
      status: (message) => statusMessages.push(message),
      trace: () => {},
    });

    expect(exitCode).toBe(0);
    expect(statusMessages).toContain("⚠ model output truncated at max_tokens");
    expect(output.text).toBe("partial\n");
  });

  it("formats and truncates tool output", () => {
    expect(formatToolOutput("exit:0\nstdout:\nok")).toContain("  ok");
    expect(formatToolOutput("x".repeat(4_100), 10)).toContain("... output truncated ...");
  });

  it("formats durations", () => {
    expect(formatDuration(500)).toBe("0.5s");
    expect(formatDuration(65_000)).toBe("1m 5s");
  });

  it("formats dividers", () => {
    const divider = formatEventDivider("tool.end", {
      target: "bash",
      durationMs: 3_200,
      timestamp: new Date(2026, 0, 1, 12, 34, 56),
    });
    expect(divider).toContain("tool.end · bash · 3.2s");
    expect(divider.endsWith("12:34:56")).toBe(true);
    expect(divider.startsWith("──── ")).toBe(true);
    expect(formatTimestamp(new Date(2026, 0, 1, 9, 8, 7))).toBe("09:08:07");
  });
});
