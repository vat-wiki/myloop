import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkills, parseSkillFile } from "../src/skills.js";

describe("TUI skills loading", () => {
  const temporaryDirectories: Array<string> = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })));
  });

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
      },
      {
        name: "global-skill",
        description: "Global skill",
        instructions: "Global instructions",
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
    const skill = parseSkillFile({
      directoryName: "fallback-name",
      contents: "---\nname: \"quoted-name\"\ndescription: 'Quoted skill'\n---\n\nBody\n",
      path: "/tmp/SKILL.md",
    });

    expect(skill).toEqual({
      name: "quoted-name",
      description: "Quoted skill",
      instructions: "Body",
    });
  });

  it("rejects malformed skill files", () => {
    expect(() => parseSkillFile({
      directoryName: "invalid",
      contents: "No frontmatter",
      path: "/tmp/SKILL.md",
    })).toThrow("missing frontmatter");
  });

  async function makeTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "mycoder-skills-"));
    temporaryDirectories.push(directory);
    return directory;
  }
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
