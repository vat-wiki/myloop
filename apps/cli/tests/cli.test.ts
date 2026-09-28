import { describe, expect, it } from "vitest";
import { formatCliHelp, parseCliArgs } from "../src/cli.js";
import { formatInteractivePrompt } from "../src/main.js";

describe("CLI arguments", () => {
  it("parses a one-shot task", () => {
    const options = parseCliArgs([
      "--model",
      "gpt-test",
      "--max-tokens",
      "16384",
      "--allow-local-files",
      "fix",
      "the tests",
    ]);

    expect(options).toMatchObject({
      protocol: "openai-chat",
      model: "gpt-test",
      maxTokens: 16384,
      allowLocalFiles: true,
      prompt: "fix the tests",
      help: false,
    });
  });

  it("merges config with command-line precedence", () => {
    const options = parseCliArgs([
      "--model",
      "gpt-cli",
      "--allow-local-files",
      "--system-prompt",
      "./cli.md",
    ], {}, {
      protocol: "openai-chat",
      model: "gpt-config",
      apiKey: "config-key",
      baseURL: "https://example.com/v1",
      allowLocalFiles: false,
      contextWindowTokens: 64_000,
      sessionId: "work-1",
      systemPrompt: "./config.md",
    });

    expect(options).toMatchObject({
      protocol: "openai-chat",
      model: "gpt-cli",
      apiKey: "config-key",
      baseURL: "https://example.com/v1",
      allowLocalFiles: true,
      contextWindowTokens: 64_000,
      sessionId: "work-1",
      systemPrompt: "./cli.md",
      systemPromptEnabled: true,
    });
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
    expect(formatCliHelp()).toContain("mycoder CLI");
  });

  it("rejects invalid arguments", () => {
    expect(() => parseCliArgs(["--protocol", "ollama", "--model", "test"]))
      .toThrow("unknown protocol: ollama");
    expect(() => parseCliArgs(["--model", "test", "--unknown"]))
      .toThrow("unknown argument: --unknown");
    expect(() => parseCliArgs([], {})).toThrow("model is required");
  });
});

describe("interactive prompt", () => {
  it("abbreviates the home directory", () => {
    expect(formatInteractivePrompt("/Users/dev/projects/mycoder", "/Users/dev")).toBe("~/projects/mycoder ❯ ");
  });

  it("uses the original directory outside home", () => {
    expect(formatInteractivePrompt("/var/log", "/Users/dev")).toBe("/var/log ❯ ");
  });
});
