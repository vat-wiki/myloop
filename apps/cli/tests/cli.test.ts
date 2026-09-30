import { describe, expect, it } from "vitest";
import { formatCliHelp, parseCliArgs } from "../src/cli.js";
import { formatInteractivePrompt } from "../src/main.js";

describe("CLI arguments", () => {
  it("parses a one-shot task", () => {
    const options = parseCliArgs(["fix", "the tests"], {}, {
      protocol: "openai-chat",
      model: "gpt-test",
      allowLocalFiles: true,
    });

    expect(options).toMatchObject({
      protocol: "openai-chat",
      model: "gpt-test",
      allowLocalFiles: true,
      prompt: "fix the tests",
      help: false,
      log: "events",
      printPrompts: true,
    });
  });

  it("uses config values", () => {
    const options = parseCliArgs([
      "--system-prompt",
      "./cli.md",
    ], {}, {
      protocol: "openai-chat",
      model: "gpt-test",
      apiKey: "config-key",
      baseURL: "https://example.com/v1",
      allowLocalFiles: true,
      sessionId: "work-1",
      systemPrompt: "./config.md",
    });

    expect(options).toMatchObject({
      protocol: "openai-chat",
      model: "gpt-test",
      apiKey: "config-key",
      baseURL: "https://example.com/v1",
      allowLocalFiles: true,
      sessionId: "work-1",
      systemPrompt: "./cli.md",
      systemPromptEnabled: true,
    });
  });

  it("can hide prompt declarations", () => {
    const options = parseCliArgs(["--no-print-prompts", "task"], {}, { model: "gpt-test" });

    expect(options.printPrompts).toBe(false);
  });

  it("uses config values when command-line options are omitted", () => {
    const options = parseCliArgs([], {}, {
      protocol: "anthropic",
      model: "claude-config",
      systemPrompt: false,
    });

    expect(options).toMatchObject({
      protocol: "anthropic",
      model: "claude-config",
      systemPrompt: undefined,
      systemPromptEnabled: false,
    });
  });

  it("selects Anthropic from the environment", () => {
    const options = parseCliArgs([], {
      ANTHROPIC_API_KEY: "test",
      ANTHROPIC_MODEL: "claude-test",
    });

    expect(options.protocol).toBe("anthropic");
    expect(options.model).toBe("claude-test");
  });

  it("renders help without requiring a model", () => {
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(formatCliHelp()).toContain("myloop CLI");
    expect(formatCliHelp()).toContain("--no-print-prompts");
  });

  it("rejects unknown arguments", () => {
    expect(parseCliArgs(["--log=errors"], {}, { model: "gpt-test" }).log).toBe("errors");
    expect(parseCliArgs(["--log", "events", "task"], {}, { model: "gpt-test" }).log).toBe("events");
    expect(parseCliArgs(["--log", "task"], {}, { model: "gpt-test" }).log).toBe("events");
    expect(parseCliArgs(["--log", "task"], {}, { model: "gpt-test" }).prompt).toBe("task");
    expect(() => parseCliArgs(["--log=verbose"], {}, { model: "gpt-test" }))
      .toThrow("log level must be one of");
    expect(() => parseCliArgs(["--unknown"]))
      .toThrow("unknown argument: --unknown");
    expect(() => parseCliArgs([], {})).toThrow("model is required");
  });
});

describe("interactive prompt", () => {
  it("abbreviates the home directory", () => {
    expect(formatInteractivePrompt("/Users/dev/projects/myloop", "/Users/dev")).toBe("~/projects/myloop ❯ ");
  });

  it("uses the original directory outside home", () => {
    expect(formatInteractivePrompt("/var/log", "/Users/dev")).toBe("/var/log ❯ ");
  });
});
