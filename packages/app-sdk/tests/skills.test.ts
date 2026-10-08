import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAppSkills } from "../src/skills.js";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "myloop-app-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSkill(
  root: string,
  name: string,
  contents: string,
): Promise<void> {
  await mkdir(join(root, ".agents", "skills", name), { recursive: true });
  await writeFile(join(root, ".agents", "skills", name, "SKILL.md"), contents);
}

describe("loadAppSkills", () => {
  it("loads skills from .agents/skills directories walking up from cwd", async () => {
    const root = await makeDirectory();
    const nested = join(root, "a", "b");
    await writeSkill(root, "root-skill", "---\nname: root-skill\ndescription: Root skill.\n---\nRoot instructions.");
    await writeSkill(nested, "nested-skill", "---\nname: nested-skill\ndescription: Nested skill.\n---\nNested instructions.");

    const skills = await loadAppSkills({ cwd: nested });

    expect(skills.map((skill) => skill.name)).toEqual(["nested-skill", "root-skill"]);
    expect(skills[0]?.path).toBe(join(nested, ".agents", "skills", "nested-skill", "SKILL.md"));
    expect(skills[1]?.path).toBe(join(root, ".agents", "skills", "root-skill", "SKILL.md"));
  });

  it("skips directories without a SKILL.md and deduplicates by name", async () => {
    const root = await makeDirectory();
    await writeSkill(root, "shared", "---\nname: shared\ndescription: From root.\n---\nRoot version.");
    const nested = join(root, "project");
    await writeSkill(nested, "shared", "---\nname: shared\ndescription: From nested.\n---\nNested version.");
    await mkdir(join(nested, ".agents", "skills", "empty"), { recursive: true });

    const skills = await loadAppSkills({ cwd: nested });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.instructions).toBe("Nested version.");
  });

  it("appends the home directory skills after cwd ancestors", async () => {
    const root = await makeDirectory();
    const home = await makeDirectory();
    await writeSkill(root, "project-skill", "---\nname: project-skill\ndescription: Project.\n---\nProject instructions.");
    await mkdir(join(home, ".agents", "skills", "home-skill"), { recursive: true });
    await writeFile(
      join(home, ".agents", "skills", "home-skill", "SKILL.md"),
      "---\nname: home-skill\ndescription: Home.\n---\nHome instructions.",
    );

    const skills = await loadAppSkills({ cwd: root, home });

    expect(skills.map((skill) => skill.name)).toEqual(["project-skill", "home-skill"]);
  });

  it("returns an empty list when no skill directories exist", async () => {
    const root = await makeDirectory();

    const skills = await loadAppSkills({ cwd: root, home: join(root, "missing-home") });

    expect(skills).toEqual([]);
  });
});
