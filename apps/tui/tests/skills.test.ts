import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeTuiSystem,
  loadAgentsInstructions,
  loadCoreInstructions,
  loadSystemInstructions,
  loadTuiSkills,
} from "../src/system-prompt.js";
import { parseSkillContents } from "mycoder/skills";
import { loadSkills } from "../src/skills.js";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mycoder-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("TUI skills loading", () => {
  it("loads project and global skills from .agents directories", async () => {
    const home = await makeTemporaryDirectory();
    const project = await makeTemporaryDirectory();
    await writeSkill(project, "project-skill", "Project instructions");
    await writeSkill(home, "global-skill", "Global instructions");

    const skills = await loadSkills({ cwd: project, home });

    expect(skills).toEqual([
      {
        name: "project-skill",
        description: "Project skill",
        instructions: "Project instructions",
        path: join(project, ".agents", "skills", "project-skill", "SKILL.md"),
      },
      {
        name: "global-skill",
        description: "Global skill",
        instructions: "Global instructions",
        path: join(home, ".agents", "skills", "global-skill", "SKILL.md"),
      },
    ]);
  });

  it("prefers the nearest skill when names collide", async () => {
    const home = await makeTemporaryDirectory();
    const root = await makeTemporaryDirectory();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeSkill(nested, "shared", "Nearest instructions");
    await writeSkill(root, "shared", "Ancestor instructions");

    const skills = await loadSkills({ cwd: nested, home });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.instructions).toBe("Nearest instructions");
  });

  it("parses quoted frontmatter values and trims instructions", () => {
    const skill = parseSkillContents(
      "---\nname: \"quoted-name\"\ndescription: 'Quoted skill'\n---\n\nBody\n",
      {
        fallbackName: "fallback-name",
        path: "/tmp/SKILL.md",
      },
    );

    expect(skill).toEqual({
      name: "quoted-name",
      description: "Quoted skill",
      instructions: "Body",
    });
  });

  it("rejects malformed skill files", () => {
    expect(() => parseSkillContents("No frontmatter", {
      path: "/tmp/SKILL.md",
    })).toThrow("missing frontmatter");
  });

});

describe("TUI system prompt", () => {
  it("loads the nearest project system prompt before global and built-in prompts", async () => {
    const home = await makeTemporaryDirectory();
    const root = await makeTemporaryDirectory();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await mkdir(join(home, ".agents", "mycoder"), { recursive: true });
    await mkdir(join(root, ".agents", "mycoder"), { recursive: true });
    await writeFile(join(home, ".agents", "mycoder", "system.md"), "Global prompt.");
    await writeFile(join(root, ".agents", "mycoder", "system.md"), "Root prompt.");

    await expect(loadSystemInstructions({ cwd: nested, home })).resolves.toBe("Root prompt.");
  });

  it("falls back to a global system prompt and the built-in prompt", async () => {
    const home = await makeTemporaryDirectory();
    const root = await makeTemporaryDirectory();
    await mkdir(join(home, ".agents", "mycoder"), { recursive: true });
    await writeFile(join(home, ".agents", "mycoder", "system.md"), "Global prompt.");

    await expect(loadSystemInstructions({ cwd: root, home })).resolves.toBe("Global prompt.");
    await expect(loadSystemInstructions({
      cwd: root,
      home: join(root, "missing-home"),
    })).resolves.toContain("# Shell Roadmap");
  });

  it("uses an explicit system prompt or disables it", async () => {
    const root = await makeTemporaryDirectory();
    const promptPath = join(root, "custom.md");
    await writeFile(promptPath, "Custom prompt.");

    await expect(loadSystemInstructions({ cwd: root, path: promptPath })).resolves.toBe("Custom prompt.");
    await expect(loadSystemInstructions({ cwd: root, enabled: false })).resolves.toBe("");
    await expect(loadSystemInstructions({ cwd: root, path: join(root, "missing.md") }))
      .rejects
      .toThrow("system prompt file not found");
  });

  it("loads applicable AGENTS files from root to working directory", async () => {
    const root = await makeTemporaryDirectory();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Root instructions.");
    await writeFile(join(nested, "AGENTS.md"), "Nested instructions.");

    await expect(loadAgentsInstructions({ cwd: nested })).resolves.toBe(
      "Root instructions.\n\nNested instructions.",
    );
  });

  it("does not load AGENTS instructions when no applicable file exists", async () => {
    const root = await makeTemporaryDirectory();

    await expect(loadAgentsInstructions({ cwd: root })).resolves.toBe("");
  });

  it("loads core shell instructions", async () => {
    const instructions = await loadCoreInstructions();

    expect(instructions).toContain("# Shell Roadmap");
    expect(instructions).toContain("Verify: focused check");
    expect(instructions).not.toContain("name:");
  });

  it("inlines core instructions and leaves skills on demand", () => {
    const system = composeTuiSystem({
      instructions: "Run focused checks first.",
      skills: [{
        name: "project-skill",
        description: "Project skill",
        instructions: "Project instructions",
        path: "/tmp/project-skill/SKILL.md",
      }],
    });

    expect(system).toContain("Run focused checks first.");
    expect(system).toContain("## Skills");
    expect(system).toContain("`/tmp`");
    expect(system).toContain("- `project-skill`: Project skill");
    expect(system).not.toContain("Project instructions");
  });

  it("inlines AGENTS instructions before the skill catalog", () => {
    const system = composeTuiSystem({
      agentsInstructions: "Use focused checks.",
      skills: [{
        name: "project-skill",
        description: "Project skill",
        instructions: "Project instructions",
        path: "/tmp/project-skill/SKILL.md",
      }],
    });

    expect(system.indexOf("Use focused checks.")).toBeLessThan(system.indexOf("## Skills"));
    expect(system).toContain("nested instructions override ancestor instructions.");
  });

  it("supports installed skill metadata in the catalog", () => {
    const system = composeTuiSystem({
      skills: [{
        name: "project-skill",
        description: "Project skill",
        instructions: "Project instructions",
        path: "/tmp/project-skill/SKILL.md",
      }],
    });

    expect(system).toContain("`/tmp`");
    expect(system).toContain("- `project-skill`: Project skill");
    expect(system).not.toContain("Project instructions");
  });
});

async function writeSkill(
  root: string,
  name: string,
  instructions: string,
): Promise<void> {
  const skillDirectory = join(root, ".agents", "skills", name);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${name === "project-skill" ? "Project skill" : name === "global-skill" ? "Global skill" : `${name} skill`}`,
    "---",
    "",
    instructions,
  ].join("\n"));
}
