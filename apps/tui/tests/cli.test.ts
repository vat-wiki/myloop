import { describe, expect, it } from "vitest";
import { formatTuiHelp, parseTuiArgs } from "../src/cli.js";

describe("TUI CLI", () => {
  it("selects anthropic by default when its API key exists", () => {
    expect(parseTuiArgs([], { ANTHROPIC_API_KEY: "key", ANTHROPIC_MODEL: "claude-test" }))
      .toMatchObject({
        protocol: "anthropic",
        model: "claude-test",
        maxTokens: 8_192,
        retryAttempts: 2,
      });
  });

  it("parses explicit options", () => {
    expect(parseTuiArgs([
      "--protocol", "openai-responses",
      "--model", "gpt-test",
      "--base-url", "https://example.test/v1",
      "--max-tokens", "128",
      "--timeout-ms", "5000",
      "--retry-attempts", "0",
      "--allow-local-files",
    ])).toEqual({
      protocol: "openai-responses",
      model: "gpt-test",
      baseURL: "https://example.test/v1",
      apiKey: undefined,
      maxTokens: 128,
      timeoutMs: 5_000,
      retryAttempts: 0,
      allowLocalFiles: true,
      help: false,
    });
  });

  it("uses config values when CLI options are omitted", () => {
    expect(parseTuiArgs([], {}, {
      protocol: "openai-responses",
      model: "gpt-config",
      apiKey: "config-key",
      maxTokens: 256,
      timeoutMs: 3_000,
      retryAttempts: 4,
      allowLocalFiles: true,
    })).toEqual({
      protocol: "openai-responses",
      model: "gpt-config",
      baseURL: undefined,
      apiKey: "config-key",
      maxTokens: 256,
      timeoutMs: 3_000,
      retryAttempts: 4,
      allowLocalFiles: true,
      help: false,
    });
  });

  it("rejects invalid options and renders help", () => {
    expect(() => parseTuiArgs(["--protocol", "ollama"])).toThrow("unknown protocol: ollama");
    expect(() => parseTuiArgs([], {})).toThrow("model is required");
    expect(formatTuiHelp()).toContain("mycoder TUI");
  });
});
