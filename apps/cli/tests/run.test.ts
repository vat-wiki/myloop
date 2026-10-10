import { describe, expect, it } from "vitest";
import {
  formatContextUsage,
  formatDuration,
  formatEventDivider,
  formatToolOutput,
  formatModelUsage,
  formatTimestamp,
  formatTokensInK,
  printAgentPrompts,
  printSessionHistory,
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
  it("renders restored user, assistant, and tool history", () => {
    const statusMessages: Array<string> = [];
    const output = createFakeOutput();

    printSessionHistory({
      messages: [
        { role: "user", content: [{ type: "text", text: "run tests" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "tool-1", name: "bash", arguments: { command: "npm test" } },
            { type: "text", text: "tests pass" },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "tool-1", content: "exit:0\nstdout:\nok" }],
        },
      ],
      output: output.stream,
      status: (message) => statusMessages.push(message),
      trace: () => {},
    });

    expect(statusMessages.join("\n")).toMatch(/──── restored · 3 messages ─+/);
    expect(statusMessages.join("\n")).toMatch(/──── user ─+/);
    expect(output.text).toContain("run tests\ntests pass\n");
    expect(statusMessages.join("\n")).toContain("$ npm test");
    expect(statusMessages.join("\n")).toContain("ok");
  });

  it("does not render empty restored history", () => {
    const statusMessages: Array<string> = [];
    const output = createFakeOutput();

    printSessionHistory({
      messages: [],
      output: output.stream,
      status: (message) => statusMessages.push(message),
      trace: () => {},
    });

    expect(statusMessages).toEqual([]);
    expect(output.text).toBe("");
  });

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
    expect(saved).toBe(false);
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
          emit("context_pressure", {
            pressure: { usedTokens: 24_000, limitTokens: 200_000, ratio: 0.12 },
          });
          emit("model_response");
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
    expect(statusMessages.join("\n")).toMatch(/──── context\.estimate · context 24k\/200k \(12\.0%\) ─+ \d{2}:\d{2}:\d{2}/);
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

  it("streams context compaction progress and shows the compacted history", async () => {
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
          emit("context_pressure", {
            pressure: { usedTokens: 90_000, limitTokens: 100_000, ratio: 0.9 },
          });
          emit("context_compaction_start", {
            reason: "automatic",
            pressure: { usedTokens: 90_000, limitTokens: 100_000, ratio: 0.9 },
            messageCount: 12,
          });
          emit("context_compaction_thinking_delta", { delta: "checking" });
          emit("context_compaction_summary_delta", { delta: "task summary" });
          emit("context_compacted", {
            reason: "automatic",
            pressure: { usedTokens: 90_000, limitTokens: 100_000, ratio: 0.9 },
            beforeMessageCount: 12,
            afterMessageCount: 1,
            droppedMessageCount: 12,
            durationMs: 1_234,
            summary: "task summary",
            usage: { inputTokens: 1_000, outputTokens: 20, totalTokens: 1_020 },
          });
          return { answer: "done", response: { stopReason: "end" } };
        },
      },
      input: "run tests",
      saveSession: async () => {},
      output: output.stream,
      status: (message) => statusMessages.push(message),
      trace: (text) => traceText.push(text),
    });

    const log = statusMessages.join("\n");
    expect(log).toMatch(/──── context\.compaction\.start · automatic · context 90k\/100k \(90\.0%\) ─+/);
    expect(log).toContain("正在压缩 12 条历史消息");
    expect(log).toMatch(/──── context\.compacted · automatic · 1\.2s · context 90k\/100k \(90\.0%\) ─+/);
    expect(log).toContain("messages 12 → 1 · in 1k · out 20 · total 1k");
    expect(traceText.join("")).toContain("checking");
    expect(traceText.join("")).toContain("task summary");
  });

  it("shows aggregated model usage returned by the client", async () => {
    const statusMessages: Array<string> = [];
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
          emit("text_delta", { delta: "done" });
          emit("model_response");
          return {
            answer: "done",
            response: {
              stopReason: "end",
              usage: {
                inputTokens: 1_234,
                outputTokens: 56,
                totalTokens: 1_290,
                cacheReadInputTokens: 78,
                reasoningOutputTokens: 9,
              },
            },
          };
        },
      },
      input: "run tests",
      saveSession: async () => {},
      output: output.stream,
      status: (message) => statusMessages.push(message),
      trace: () => {},
    });

    expect(statusMessages.join("\n")).toMatch(/──── model\.usage · in 1\.2k · out 56 · total 1\.3k/);
    expect(statusMessages.join("\n")).toContain("cache-read 78");
    expect(statusMessages.join("\n")).toContain("reasoning 9");
  });

  it("labels model usage with the call count after multiple calls", async () => {
    const statusMessages: Array<string> = [];
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
          emit("text_delta", { delta: "done" });
          emit("model_response");
          emit("model_response");
          return {
            answer: "done",
            response: {
              stopReason: "end",
              usage: {
                inputTokens: 1_234,
                outputTokens: 56,
                totalTokens: 1_290,
              },
            },
          };
        },
      },
      input: "run tests",
      saveSession: async () => {},
      output: output.stream,
      status: (message) => statusMessages.push(message),
      trace: () => {},
    });

    expect(statusMessages.join("\n")).toMatch(/──── model\.usage · 2 calls · in 1\.2k · out 56 · total 1\.3k/);
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

  it("formats context usage in k tokens", () => {
    expect(formatContextUsage({ usedTokens: 1_500, limitTokens: 200_000, ratio: 0.0075 })).toBe(
      "context 1.5k/200k (0.8%)",
    );
    expect(formatContextUsage({ usedTokens: 500 })).toBe("context 500");
    expect(formatTokensInK(200_000)).toBe("200k");
  });

  it("formats model usage", () => {
    expect(formatModelUsage({
      inputTokens: 1_234,
      outputTokens: 56,
      totalTokens: 1_290,
      cacheReadInputTokens: 78,
      cacheCreationInputTokens: 12,
      reasoningOutputTokens: 9,
    })).toBe("in 1.2k · out 56 · total 1.3k · cache-read 78 · cache-create 12 · reasoning 9");
    expect(formatModelUsage({})).toBe("");
  });

  it("keeps small token counts unscaled", () => {
    expect(formatTokensInK(999)).toBe("999");
    expect(formatTokensInK(1_000)).toBe("1k");
  });
});
