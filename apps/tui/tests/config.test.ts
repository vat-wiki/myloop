import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTuiConfig } from "../src/config.js";

describe("TUI config loading", () => {
  const temporaryDirectories: Array<string> = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })));
  });

  it("reads the global .agents config", async () => {
    const home = await makeTemporaryDirectory();
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, ".agents", "mycoder.json"), JSON.stringify({
      protocol: "openai-chat",
      model: "gpt-home",
      apiKey: "direct-key",
    }));

    const { config, sources } = await loadTuiConfig({ env: {}, cwd: home, home });

    expect(config).toEqual({
      protocol: "openai-chat",
      model: "gpt-home",
      apiKey: "direct-key",
    });
    expect(sources.global).toBe(join(home, ".agents", "mycoder.json"));
  });

  it("lets the project config override global config", async () => {
    const home = await makeTemporaryDirectory();
    const project = await makeTemporaryDirectory();
    await mkdir(join(home, ".agents"), { recursive: true });
    await mkdir(join(project, ".agents"), { recursive: true });
    await writeFile(join(home, ".agents", "mycoder.json"), JSON.stringify({
      protocol: "anthropic",
      model: "claude-home",
      maxTokens: 1_000,
      allowLocalFiles: false,
    }));
    await writeFile(join(project, ".agents", "mycoder.json"), JSON.stringify({
      protocol: "openai-chat",
      model: "gpt-project",
      allowLocalFiles: true,
    }));

    const { config, sources } = await loadTuiConfig({
      env: { NODE_ENV: "development" },
      cwd: project,
      home,
    });

    expect(config).toEqual({
      protocol: "openai-chat",
      model: "gpt-project",
      maxTokens: 1_000,
      allowLocalFiles: true,
    });
    expect(sources.global).toBe(join(home, ".agents", "mycoder.json"));
    expect(sources.project).toBe(join(project, ".agents", "mycoder.json"));
  });

  it("searches ancestor directories for the nearest project config", async () => {
    const home = await makeTemporaryDirectory();
    const root = await makeTemporaryDirectory();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await mkdir(join(root, ".agents"), { recursive: true });
    await writeFile(join(root, ".agents", "mycoder.json"), JSON.stringify({
      model: "gpt-root",
    }));

    const { config, sources } = await loadTuiConfig({
      env: {},
      cwd: nested,
      home,
    });

    expect(config).toEqual({ model: "gpt-root" });
    expect(sources).toEqual({
      project: join(root, ".agents", "mycoder.json"),
    });
  });

  it("rejects invalid or unknown config values", async () => {
    const invalid = await makeTemporaryDirectory();
    await mkdir(join(invalid, ".agents"), { recursive: true });
    await writeFile(join(invalid, ".agents", "mycoder.json"), JSON.stringify({ protocol: "ollama" }));

    await expect(loadTuiConfig({ env: {}, cwd: invalid, home: invalid }))
      .rejects
      .toThrow("config protocol must be one of");

    const unknown = await makeTemporaryDirectory();
    await mkdir(join(unknown, ".agents"), { recursive: true });
    await writeFile(join(unknown, ".agents", "mycoder.json"), JSON.stringify({ provider: "anthropic" }));

    await expect(loadTuiConfig({ env: {}, cwd: unknown, home: unknown }))
      .rejects
      .toThrow("config has unknown field: provider");
  });

  async function makeTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "mycoder-config-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});
