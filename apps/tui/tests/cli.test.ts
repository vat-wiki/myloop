import { describe, expect, it } from "vitest";
import { formatTuiHelp, parseTuiArgs } from "../src/cli.js";

describe("TUI CLI", () => {
  it("selects anthropic by default when its API key exists", () => {
    expect(parseTuiArgs([], { ANTHROPIC_API_KEY: "key", ANTHROPIC_MODEL: "claude-test" }))
      .toMatchObject({
        protocol: "anthropic",
        model: "claude-test",
        allowLocalFiles: false,
      });
  });

  it("parses explicit options", () => {
    expect(parseTuiArgs([
      "--protocol", "openai-responses",
      "--model", "gpt-test",
      "--base-url", "https://example.test/v1",
      "--context-window-tokens", "131072",
    ])).toEqual({
      protocol: "openai-responses",
      model: "gpt-test",
      baseURL: "https://example.test/v1",
      apiKey: undefined,
      allowLocalFiles: false,
      contextWindowTokens: 131_072,
      sessionId: undefined,
      help: false,
    });
  });

  it("uses config values when CLI options are omitted", () => {
    expect(parseTuiArgs([], {}, {
      protocol: "openai-responses",
      model: "gpt-config",
      apiKey: "config-key",
      allowLocalFiles: true,
      contextWindowTokens: undefined,
      sessionId: "from-config",
    })).toEqual({
      protocol: "openai-responses",
      model: "gpt-config",
      baseURL: undefined,
      apiKey: "config-key",
      allowLocalFiles: true,
      contextWindowTokens: undefined,
      sessionId: "from-config",
      help: false,
    });
  });

  it("parses and validates a session id", () => {
    expect(parseTuiArgs(["--session-id", "work-1", "--model", "gpt-test"]).sessionId).toBe("work-1");
    expect(parseTuiArgs([], { OPENAI_MODEL: "gpt-test" }, { sessionId: "from-config" }).sessionId).toBe("from-config");
    expect(() => parseTuiArgs(["--session-id", "../escape", "--model", "gpt-test"])).toThrow("session id");
  });

  it("rejects invalid options and renders help", () => {
    expect(() => parseTuiArgs(["--protocol", "ollama"])).toThrow("unknown protocol: ollama");
    expect(() => parseTuiArgs([], {})).toThrow("model is required");
    expect(() => parseTuiArgs(["--max-tokens", "128"])).toThrow("unknown argument: --max-tokens");
    expect(() => parseTuiArgs(["--context-window-tokens", "0"])).toThrow("context window tokens must be a positive integer");
    expect(formatTuiHelp()).toContain("mycoder TUI");
  });
});
