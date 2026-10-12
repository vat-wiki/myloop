import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeSystem, loadAgentsInstructions, readInstructions } from "../src/index.js";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("app instructions", () => {
  it("loads AGENTS files from ancestor to current directory", async () => {
    const root = await makeTemporaryDirectory();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Root instructions.");
    await writeFile(join(nested, "AGENTS.md"), "Nested instructions.");

    await expect(loadAgentsInstructions({ cwd: nested })).resolves.toBe(
      "Root instructions.\n\nNested instructions.",
    );
  });

  it("composes base, custom, AGENTS, and skill sections", () => {
    const system = composeSystem({
      basePrompt: "Terminal agent.",
      instructions: "Be precise.",
      agentsInstructions: "Use focused checks.",
      skills: [{
        name: "project-skill",
        description: "Project skill",
        instructions: "Skill instructions",
        path: "/tmp/project-skill/SKILL.md",
      }],
    });

    expect(system).toContain("Terminal agent.");
    expect(system).toContain("Be precise.");
    expect(system).toContain("Use focused checks.");
    expect(system).toContain("# Skills");
    expect(system).toContain("- `project-skill`: Project skill");
    expect(system).not.toContain("Skill instructions");
  });

  it("reads required instruction files", async () => {
    const root = await makeTemporaryDirectory();
    const path = join(root, "system.md");
    await writeFile(path, "Custom prompt.");

    await expect(readInstructions(path)).resolves.toBe("Custom prompt.");
    await expect(readInstructions(join(root, "missing.md"))).rejects.toThrow("not found");
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "myloop-app-sdk-instructions-"));
  temporaryDirectories.push(directory);
  return directory;
}
