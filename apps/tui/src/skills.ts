import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Skill } from "mycoder/skills";

const SKILL_FILENAME = "SKILL.md";

export type LoadSkillsOptions = {
  cwd?: string;
  home?: string;
};

export async function loadSkills(options: LoadSkillsOptions = {}): Promise<Array<Skill>> {
  const cwd = options.cwd ?? process.cwd();
  const directories = await findSkillDirectories(cwd, options.home);
  const skills = new Map<string, Skill>();

  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true });
    const skillNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const skillName of skillNames) {
      const skillPath = join(directory, skillName, SKILL_FILENAME);
      if (!await exists(skillPath)) {
        continue;
      }

      const skill = parseSkillFile({
        directoryName: skillName,
        contents: await readFile(skillPath, "utf8"),
        path: skillPath,
      });
      if (!skills.has(skill.name)) {
        skills.set(skill.name, skill);
      }
    }
  }

  return [...skills.values()];
}

export function parseSkillFile({
  directoryName,
  contents,
  path,
}: {
  directoryName: string;
  contents: string;
  path: string;
}): Skill {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error(`invalid skill file ${path}: missing frontmatter`);
  }

  const metadata = parseFrontmatter(match[1] ?? "", path);
  const name = metadata.name ?? directoryName;
  const description = metadata.description;
  const instructions = contents.slice(match[0].length).trim();

  if (!name.trim()) {
    throw new Error(`invalid skill file ${path}: name cannot be empty`);
  }
  if (!description) {
    throw new Error(`invalid skill file ${path}: description is required`);
  }
  if (!instructions) {
    throw new Error(`invalid skill file ${path}: instructions cannot be empty`);
  }

  return {
    name,
    description,
    instructions,
  };
}

function parseFrontmatter(contents: string, path: string): Record<string, string | undefined> {
  const metadata: Record<string, string | undefined> = {};
  const lines = contents.split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const separator = trimmedLine.indexOf(":");
    if (separator <= 0) {
      throw new Error(`invalid skill file ${path}: invalid frontmatter line "${trimmedLine}"`);
    }

    const key = trimmedLine.slice(0, separator).trim();
    const value = trimmedLine.slice(separator + 1).trim();
    metadata[key] = unquote(value);
  }

  return metadata;
}

function unquote(value: string): string {
  if (value.length >= 2 && (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )) {
    return value.slice(1, -1);
  }
  return value;
}

async function findSkillDirectories(startDirectory: string, home?: string): Promise<Array<string>> {
  const directories: Array<string> = [];
  let directory = resolve(startDirectory);

  while (true) {
    const candidate = join(directory, ".agents", "skills");
    if (await exists(candidate)) {
      directories.push(candidate);
    }

    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  if (home) {
    const candidate = join(resolve(home), ".agents", "skills");
    if (await exists(candidate) && !directories.includes(candidate)) {
      directories.push(candidate);
    }
  }

  return directories;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
