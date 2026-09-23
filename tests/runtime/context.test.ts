import { describe, expect, it } from "vitest";
import {
  compactFallback,
  estimateMessagesTokens,
  measureContextPressure,
} from "../../src/runtime/context.js";
import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  textBlock,
  toolCallBlock,
  toolResultBlock,
} from "../../src/runtime/messages.js";
import type { AgentMessage } from "../../src/runtime/messages.js";

const estimate = (messages: ReadonlyArray<AgentMessage>) =>
  Math.ceil(JSON.stringify(messages).length / 4);

function pressureFor(availableInputTokens: number) {
  return measureContextPressure({
    usedTokens: availableInputTokens + 1,
    limitTokens: availableInputTokens,
    safetyTokens: 0,
  });
}

describe("measureContextPressure", () => {
  it("reports usage without a context limit", () => {
    expect(measureContextPressure({ usedTokens: 42 })).toEqual({ usedTokens: 42 });
  });

  it("applies reserved and default safety tokens", () => {
    const pressure = measureContextPressure({
      usedTokens: 65_000,
      limitTokens: 100_000,
      reservedOutputTokens: 8_000,
    });

    expect(pressure).toEqual({
      usedTokens: 65_000,
      limitTokens: 100_000,
      safetyTokens: 10_000,
      availableInputTokens: 82_000,
      ratio: 0.65,
      needsCompaction: false,
    });
  });

  it("marks pressure when available input tokens are reached", () => {
    const pressure = measureContextPressure({
      usedTokens: 9_000,
      limitTokens: 10_000,
    });

    expect(pressure.availableInputTokens).toBe(9_000);
    expect(pressure.needsCompaction).toBe(true);
  });
});

describe("estimateMessagesTokens", () => {
  it("estimates four characters per token", () => {
    const messages = [createUserMessage([textBlock("x".repeat(100))])];
    expect(estimateMessagesTokens(messages)).toBe(Math.ceil(JSON.stringify(messages).length / 4));
  });
});

describe("compactFallback", () => {
  it("truncates oversized tool results while keeping all messages", () => {
    const message = createToolMessage([
      toolResultBlock("call-1", { output: "x".repeat(5_000) }),
    ]);

    const result = compactFallback({
      messages: [message],
      pressure: pressureFor(2_000),
      estimateRequestTokens: estimate,
    });

    const block = result.messages[0]?.content[0];
    expect(result.droppedMessageCount).toBe(0);
    if (block?.type !== "tool_result") throw new Error("expected a tool result");
    expect(block.content).toBe(`${JSON.stringify({ output: "x".repeat(5_000) }).slice(0, 4_000)}\n[truncated]`);
  });

  it("drops earlier completed exchanges and inserts a boundary", () => {
    const messages = [
      createUserMessage([textBlock("x".repeat(2_000))]),
      createAssistantMessage([toolCallBlock("call-1", "bash", { command: "old" })]),
      createToolMessage([toolResultBlock("call-1", "old output")]),
      createUserMessage([textBlock("latest")]),
    ];

    const result = compactFallback({
      messages,
      pressure: pressureFor(60),
      estimateRequestTokens: estimate,
    });

    expect(result.droppedMessageCount).toBe(3);
    expect(result.messages[0]).toEqual({
      role: "user",
      content: [textBlock("[Context fallback] 3 earlier messages were removed to fit the model context window.")],
    });
    expect(result.messages.slice(1)).toEqual(messages.slice(3));
  });

  it("trims large blocks when no completed exchange can be dropped", () => {
    const messages = [
      createAssistantMessage([toolCallBlock("call-1", "bash", { command: "x".repeat(2_000) })]),
      createToolMessage([toolResultBlock("call-1", "y".repeat(2_000))]),
    ];

    const result = compactFallback({
      messages,
      pressure: pressureFor(1_000),
      estimateRequestTokens: estimate,
    });

    expect(result.droppedMessageCount).toBe(0);
    expect(result.messages[0]?.content[0]).toMatchObject({ type: "tool_call" });
    const block = result.messages[1]?.content[0];
    expect(block?.type).toBe("tool_result");
    const content = (block as { content: string }).content;
    expect(content).toContain("[truncated]");
    expect(content.length).toBeLessThan(JSON.stringify("y".repeat(2_000)).length);
  });

  it("throws when compaction cannot fit the context", () => {
    const messages = [createUserMessage([textBlock("x".repeat(2_000))])];

    expect(() => compactFallback({
      messages,
      pressure: pressureFor(10),
      estimateRequestTokens: estimate,
    })).toThrow("context exhausted: messages cannot be compacted below the modelClient limit");
  });
});
