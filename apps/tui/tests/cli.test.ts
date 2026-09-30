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
    expect(parseTuiArgs([], {}, {
      protocol: "openai-responses",
      model: "gpt-test",
      baseURL: "https://example.test/v1",
    })).toEqual({
      protocol: "openai-responses",
      model: "gpt-test",
      baseURL: "https://example.test/v1",
      apiKey: undefined,
      allowLocalFiles: false,
      sessionId: undefined,
      systemPrompt: undefined,
      systemPromptEnabled: true,
      log: "events",
      help: false,
    });
  });

  it("uses config values when CLI options are omitted", () => {
    expect(parseTuiArgs([], {}, {
      protocol: "openai-responses",
      model: "gpt-config",
      apiKey: "config-key",
      allowLocalFiles: true,
      sessionId: "from-config",
    })).toEqual({
      protocol: "openai-responses",
      model: "gpt-config",
      baseURL: undefined,
      apiKey: "config-key",
      allowLocalFiles: true,
      sessionId: "from-config",
      systemPrompt: undefined,
      systemPromptEnabled: true,
      log: "events",
      help: false,
    });
  });

  it("parses system prompt controls and config overrides", () => {
    expect(parseTuiArgs(["--system-prompt", "custom.md"], {}, { model: "gpt-test" }))
      .toMatchObject({
        systemPrompt: "custom.md",
        systemPromptEnabled: true,
      });
    expect(parseTuiArgs(["--no-system-prompt"], {}, { model: "gpt-test" }))
      .toMatchObject({
        systemPrompt: undefined,
        systemPromptEnabled: false,
      });
    expect(parseTuiArgs([], {}, { model: "gpt-test", systemPrompt: "config.md" }))
      .toMatchObject({
        systemPrompt: "config.md",
        systemPromptEnabled: true,
      });
    expect(parseTuiArgs([], {}, { model: "gpt-test", systemPrompt: false }))
      .toMatchObject({
        systemPrompt: undefined,
        systemPromptEnabled: false,
      });
    expect(parseTuiArgs(["--system-prompt", "custom.md"], {}, { model: "gpt-test", systemPrompt: false }))
      .toMatchObject({
        systemPrompt: "custom.md",
        systemPromptEnabled: true,
      });
    expect(parseTuiArgs(["--no-system-prompt"], {}, { model: "gpt-test", systemPrompt: "config.md" }))
      .toMatchObject({
        systemPrompt: undefined,
        systemPromptEnabled: false,
      });
    expect(() => parseTuiArgs(["--system-prompt"], {}, { model: "gpt-test" }))
      .toThrow("system prompt path is required");
  });

  it("parses and validates a session id", () => {
    expect(parseTuiArgs(["--session-id", "work-1"], {}, { model: "gpt-test" }).sessionId).toBe("work-1");
    expect(parseTuiArgs([], { OPENAI_MODEL: "gpt-test" }, { sessionId: "from-config" }).sessionId).toBe("from-config");
    expect(() => parseTuiArgs(["--session-id", "../escape"], {}, { model: "gpt-test" })).toThrow("session id");
  });

  it("parses logging levels and disables logs by default", () => {
    expect(parseTuiArgs([], {}, { model: "gpt-test" }).log).toBe("events");
    expect(parseTuiArgs(["--log=errors"], {}, { model: "gpt-test" }).log).toBe("errors");
    expect(parseTuiArgs(["--log", "events"], {}, { model: "gpt-test" }).log).toBe("events");
    expect(() => parseTuiArgs(["--log=full"], {}, { model: "gpt-test" }))
      .toThrow("log level must be one of");
  });

  it("rejects invalid options and renders help", () => {
    expect(() => parseTuiArgs([], {})).toThrow("model is required");
    expect(() => parseTuiArgs(["--max-tokens", "128"])).toThrow("unknown argument: --max-tokens");
    expect(formatTuiHelp()).toContain("myloop TUI");
  });
});
