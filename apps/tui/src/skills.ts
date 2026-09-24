import { access, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseSkillFile, type Skill } from "mycoder/skills";

const SKILL_FILENAME = "SKILL.md";

export type LoadedSkill = Skill & {
  path: string;
};

export type LoadSkillsOptions = {
  directories?: ReadonlyArray<string>;
  cwd?: string;
  home?: string;
};

export async function loadSkills(options: LoadSkillsOptions = {}): Promise<Array<LoadedSkill>> {
  const skillDirectories = options.directories ?? await findSkillDirectories(
    options.cwd ?? process.cwd(),
    options.home,
  );
  const skills = new Map<string, LoadedSkill>();

  for (const directory of skillDirectories) {
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

      const skill: LoadedSkill = {
        ...(await parseSkillFile(skillPath, { fallbackName: skillName })),
        path: skillPath,
      };
      if (!skills.has(skill.name)) {
        skills.set(skill.name, skill);
      }
    }
  }

  return [...skills.values()];
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
