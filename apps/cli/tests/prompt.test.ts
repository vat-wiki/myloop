import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeCliSystem, loadSystemPrompt } from "../src/prompt.js";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "myloop-cli-prompt-"));
  temporaryDirectories.push(path);
  return path;
}

describe("CLI system prompt", () => {
  it("renders skill metadata as an on-demand catalog", () => {
    const system = composeCliSystem({
      systemPrompt: "Be precise.",
      skills: [{
        name: "project-skill",
        description: "Project skill",
        instructions: "Project instructions",
        path: "/tmp/project-skill/SKILL.md",
      }],
    });

    expect(system).toContain("Be precise.");
    expect(system).toContain("# Skills");
    expect(system).toContain("- `project-skill`: Project skill");
    expect(system).not.toContain("Project instructions");
  });

  it("loads the nearest project system prompt before global and built-in prompts", async () => {
    const home = await makeTemporaryDirectory();
    const root = await makeTemporaryDirectory();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await mkdir(join(home, ".agents", "myloop"), { recursive: true });
    await mkdir(join(root, ".agents", "myloop"), { recursive: true });
    await writeFile(join(home, ".agents", "myloop", "system.md"), "Global prompt.");
    await writeFile(join(root, ".agents", "myloop", "system.md"), "Root prompt.");

    await expect(loadSystemPrompt({ cwd: nested, home })).resolves.toBe("Root prompt.");
  });

  it("falls back to a global system prompt and the built-in prompt", async () => {
    const home = await makeTemporaryDirectory();
    const root = await makeTemporaryDirectory();
    await mkdir(join(home, ".agents", "myloop"), { recursive: true });
    await writeFile(join(home, ".agents", "myloop", "system.md"), "Global prompt.");

    await expect(loadSystemPrompt({ cwd: root, home })).resolves.toBe("Global prompt.");
    await expect(loadSystemPrompt({
      cwd: root,
      home: join(root, "missing-home"),
    })).resolves.toContain("# Shell 路线图");
  });

  it("uses an explicit system prompt or disables it", async () => {
    const root = await makeTemporaryDirectory();
    const promptPath = join(root, "custom.md");
    await writeFile(promptPath, "Custom prompt.");

    await expect(loadSystemPrompt({ cwd: root, path: promptPath })).resolves.toBe("Custom prompt.");
    await expect(loadSystemPrompt({ cwd: root, enabled: false })).resolves.toBe("");
    await expect(loadSystemPrompt({ cwd: root, path: join(root, "missing.md") }))
      .rejects
      .toThrow("system prompt file not found");
  });
});
