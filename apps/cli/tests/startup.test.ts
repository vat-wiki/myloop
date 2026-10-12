import { describe, expect, it } from "vitest";
import { formatStartupStatus } from "../src/startup.js";
import type { CliOptions } from "../src/cli.js";

describe("startup status", () => {
  it("shows loaded sources, model, reasoning, and session without credentials", () => {
    const options = {
      protocol: "anthropic",
      model: "claude-test",
      apiKey: "secret",
      baseURL: "https://example.com/v1",
      thinking: true,
      thinkingBudgetTokens: 8_192,
    } as CliOptions;

    expect(formatStartupStatus({
      options,
      sources: {
        global: "/home/dev/.agents/myloop.json",
        project: "/home/dev/myloop/.agents/myloop.json",
      },
      sessionId: "session-1",
    })).toBe([
      "[myloop] config global=/home/dev/.agents/myloop.json · project=/home/dev/myloop/.agents/myloop.json",
      "[myloop] model anthropic/claude-test",
      "[myloop] endpoint https://example.com/v1",
      "[myloop] thinking enabled (budget 8192)",
      "[myloop] session session-1",
    ].join("\n"));
  });
});
