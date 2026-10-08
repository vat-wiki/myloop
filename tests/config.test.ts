import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function writeConfig(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "myloop-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "myloop.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("agent config bot options", () => {
  it("parses heartbeat, bot, and botPrompt", async () => {
    const path = await writeConfig({
      model: "test-model",
      heartbeat: { intervalMs: 250 },
      bot: true,
      botPrompt: "keep going",
    });

    const { config } = await loadAgentConfig({ env: {}, configPath: path });

    expect(config.heartbeat).toEqual({ intervalMs: 250 });
    expect(config.bot).toBe(true);
    expect(config.botPrompt).toBe("keep going");
  });

  it("allows an empty heartbeat object and rejects invalid values", async () => {
    const path = await writeConfig({ heartbeat: {} });
    const { config } = await loadAgentConfig({ env: {}, configPath: path });
    expect(config.heartbeat).toEqual({});

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ heartbeat: { intervalMs: 0 } }),
    })).rejects.toThrow("config heartbeat.intervalMs must be a positive number");

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ bot: "yes" }),
    })).rejects.toThrow("config bot must be a boolean");

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ botPrompt: "  " }),
    })).rejects.toThrow("config botPrompt cannot be empty");

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ heartbeat: { timeout: 1 } }),
    })).rejects.toThrow("config heartbeat has unknown field: timeout");
  });
});

describe("agent config validation", () => {
  it("rejects invalid protocol, model, baseURL, apiKey, and sessionId values", async () => {
    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ protocol: "gemini" }),
    })).rejects.toThrow("config protocol must be one of: anthropic, openai-chat, openai-responses");

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ model: "  " }),
    })).rejects.toThrow("config model cannot be empty");

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ baseURL: "not a url" }),
    })).rejects.toThrow("config baseURL must be a valid URL");

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ apiKey: "" }),
    })).rejects.toThrow("config apiKey cannot be empty");

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ sessionId: "../escape" }),
    })).rejects.toThrow("config sessionId must contain 1-128 letters, numbers, dots, underscores, or hyphens");
  });

  it("rejects non-boolean flags and an out-of-range compactionThreshold", async () => {
    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ allowLocalFiles: "yes" }),
    })).rejects.toThrow("config allowLocalFiles must be a boolean");

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ thinking: "on" }),
    })).rejects.toThrow("config thinking must be a boolean");

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ compactionThreshold: 1.5 }),
    })).rejects.toThrow("config compactionThreshold must be a number between 0 and 1");
  });

  it("accepts systemPrompt as false or a path resolved against the config directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "myloop-config-prompt-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "custom-prompt.md"), "Custom prompt.");

    const disabled = await loadAgentConfig({
      env: {},
      configPath: await writeConfig({ systemPrompt: false }),
    });
    expect(disabled.config.systemPrompt).toBe(false);

    const configPath = join(directory, "myloop.json");
    await writeFile(configPath, JSON.stringify({ systemPrompt: "custom-prompt.md" }));
    const resolved = await loadAgentConfig({ env: {}, configPath });
    expect(resolved.config.systemPrompt).toBe(join(directory, "custom-prompt.md"));
  });

  it("rejects a true systemPrompt and an empty string", async () => {
    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ systemPrompt: true }),
    })).rejects.toThrow("config systemPrompt must be false or a non-empty path");

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ systemPrompt: "" }),
    })).rejects.toThrow("config systemPrompt must be false or a non-empty path");
  });

  it("ignores deprecated fields but rejects other unknown fields", async () => {
    const deprecated = await loadAgentConfig({
      env: {},
      configPath: await writeConfig({ maxTokens: 1_024, timeoutMs: 5_000 }),
    });
    expect(deprecated.config).toEqual({});

    await expect(loadAgentConfig({
      env: {},
      configPath: await writeConfig({ noSuchField: 1 }),
    })).rejects.toThrow("config has unknown field: noSuchField");
  });

  it("merges global then project configs with the project winning", async () => {
    const home = await mkdtemp(join(tmpdir(), "myloop-config-home-"));
    const project = await mkdtemp(join(tmpdir(), "myloop-config-project-"));
    temporaryDirectories.push(home, project);
    await mkdir(join(home, ".agents"), { recursive: true });
    await mkdir(join(project, ".agents"), { recursive: true });
    await writeFile(join(home, ".agents", "myloop.json"), JSON.stringify({
      protocol: "openai-chat",
      model: "global-model",
    }));
    await writeFile(join(project, ".agents", "myloop.json"), JSON.stringify({
      model: "project-model",
    }));

    const { config, sources } = await loadAgentConfig({ env: {}, cwd: project, home });

    expect(config).toEqual({ protocol: "openai-chat", model: "project-model" });
    expect(sources.global).toBe(join(home, ".agents", "myloop.json"));
    expect(sources.project).toBe(join(project, ".agents", "myloop.json"));
  });

  it("finds the project config in a parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "myloop-config-root-"));
    temporaryDirectories.push(root);
    const nested = join(root, "deep", "deeper");
    await mkdir(nested, { recursive: true });
    await mkdir(join(root, ".agents"), { recursive: true });
    await writeFile(join(root, ".agents", "myloop.json"), JSON.stringify({ model: "root-model" }));

    const { config, sources } = await loadAgentConfig({ env: {}, cwd: nested, home: join(root, "no-home") });

    expect(config.model).toBe("root-model");
    expect(sources.project).toBe(join(root, ".agents", "myloop.json"));
    expect(sources.global).toBeUndefined();
  });

  it("throws for an explicit configPath that does not exist", async () => {
    await expect(loadAgentConfig({
      env: {},
      configPath: "/nonexistent/myloop.json",
    })).rejects.toThrow("config file not found: /nonexistent/myloop.json");
  });

  it("reports the underlying error for malformed JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "myloop-config-bad-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "myloop.json");
    await writeFile(path, "{ not json");

    await expect(loadAgentConfig({ env: {}, configPath: path })).rejects.toThrow("invalid config file");
  });
});
