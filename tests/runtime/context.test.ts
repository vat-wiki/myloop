import { describe, expect, it } from "vitest";
import {
  estimateMessagesTokens,
  measureContextPressure,
} from "../../src/runtime/context.js";
import {
  createUserMessage,
  textBlock,
} from "../../src/runtime/messages.js";
import type { AgentMessage } from "../../src/runtime/messages.js";

describe("measureContextPressure", () => {
  it("reports usage without a context limit", () => {
    expect(measureContextPressure({ usedTokens: 42 })).toEqual({ usedTokens: 42 });
  });

  it("applies reserved output tokens to available input", () => {
    const pressure = measureContextPressure({
      usedTokens: 65_000,
      limitTokens: 100_000,
      reservedOutputTokens: 8_000,
    });

    expect(pressure).toEqual({
      usedTokens: 65_000,
      limitTokens: 100_000,
      availableInputTokens: 92_000,
      ratio: 0.65,
      needsCompaction: false,
    });
  });

  it("marks compaction when usage exceeds 80% of the context window", () => {
    const below = measureContextPressure({ usedTokens: 79_000, limitTokens: 100_000 });
    const at = measureContextPressure({ usedTokens: 80_000, limitTokens: 100_000 });

    expect(below.needsCompaction).toBe(false);
    expect(at.needsCompaction).toBe(true);
  });

  it("marks pressure when context is exhausted", () => {
    const pressure = measureContextPressure({
      usedTokens: 9_000,
      limitTokens: 10_000,
    });

    expect(pressure.availableInputTokens).toBe(10_000);
    expect(pressure.needsCompaction).toBe(true);
  });
});

describe("estimateMessagesTokens", () => {
  it("estimates four characters per token", () => {
    const messages = [createUserMessage([textBlock("x".repeat(100))])];
    expect(estimateMessagesTokens(messages)).toBe(Math.ceil(JSON.stringify(messages).length / 4));
  });
});
