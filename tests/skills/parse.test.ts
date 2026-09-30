import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSkill, parseSkillContents } from "../../src/skills/parse.js";

describe("parseSkill", () => {
  const temporaryDirectories: Array<string> = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })));
  });

  it("parses frontmatter and instructions from a path", async () => {
    const directory = await makeTemporaryDirectory();
    const skillDirectory = join(directory, "repo");
    await mkdir(skillDirectory, { recursive: true });
    const path = join(skillDirectory, "SKILL.md");
    await writeFile(path, [
      "---",
      'description: "Analyze the repository"',
      "---",
      "",
      "Read README.md first.",
      "",
    ].join("\n"));

    await expect(parseSkill(path)).resolves.toEqual({
      name: "repo",
      description: "Analyze the repository",
      instructions: "Read README.md first.",
    });
  });

  it("parses markdown contents and quoted values", async () => {
    const contents = [
      "---",
      'name: "repository"',
      "description: 'Analyze the repository'",
      "---",
      "",
      "Read package.json first.",
    ].join("\n");

    await expect(parseSkill(contents)).resolves.toEqual({
      name: "repository",
      description: "Analyze the repository",
      instructions: "Read package.json first.",
    });
  });

  it("accepts a contents and path pair", async () => {
    await expect(parseSkill({
      contents: "---\ndescription: Analyze\n---\n\nBody\n",
      path: "/skills/repo/SKILL.md",
    })).resolves.toEqual({
      name: "repo",
      description: "Analyze",
      instructions: "Body",
    });
  });

  it("uses explicit fallback names", async () => {
    expect(parseSkillContents("---\ndescription: Analyze\n---\n\nBody\n", {
      fallbackName: "explicit",
    })).toEqual({
      name: "explicit",
      description: "Analyze",
      instructions: "Body",
    });
  });

  it("rejects invalid skill markdown", () => {
    expect(() => parseSkillContents("No frontmatter", {
      path: "/tmp/SKILL.md",
    })).toThrow("missing frontmatter");

    expect(() => parseSkillContents("---\nname: repository\n---\n\nBody\n")).toThrow(
      "description is required",
    );
  });

  async function makeTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "myloop-skill-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});
