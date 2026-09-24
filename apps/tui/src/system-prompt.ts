import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill } from "mycoder/skills";
import { loadSkills, type LoadedSkill } from "./skills.js";

export const tuiBasePrompt = "你是终端Agent。用bash工具完成用户任务，用中文简洁回答。";

const coreInstructionsPath = fileURLToPath(new URL("../system.md", import.meta.url));

export async function loadCoreInstructions({
  path = coreInstructionsPath,
}: { path?: string } = {}): Promise<string> {
  return (await readFile(path, "utf8")).trim();
}

export async function loadTuiSkills({
  cwd = process.cwd(),
  home = process.env.HOME,
}: {
  cwd?: string;
  home?: string;
} = {}): Promise<Array<LoadedSkill>> {
  return loadSkills({ cwd, home });
}

export function composeTuiSystem({
  instructions = "",
  skills = [],
}: {
  instructions?: string;
  skills?: ReadonlyArray<LoadedSkill | Skill>;
} = {}): string {
  return [
    tuiBasePrompt,
    instructions,
    renderSkillCatalog(skills),
  ].filter((section) => section.length > 0).join("\n\n");
}

function renderSkillCatalog(skills: ReadonlyArray<Skill>): string {
  if (skills.length === 0) {
    return "";
  }

  return [
    "## Skills",
    "",
    "Use bash to read the relevant `<skill-directory>/SKILL.md` before applying it.",
    "",
    ...renderSkillGroups(skills),
  ].join("\n");
}

function renderSkillGroups(skills: ReadonlyArray<Skill>): Array<string> {
  const groups = new Map<string, Array<{ skill: Skill; directory: string }>>();

  for (const skill of skills) {
    if (!("path" in skill) || typeof skill.path !== "string") {
      continue;
    }

    const skillDirectory = dirname(skill.path);
    const rootDirectory = dirname(skillDirectory);
    const group = groups.get(rootDirectory) ?? [];
    group.push({ skill, directory: basename(skillDirectory) });
    groups.set(rootDirectory, group);
  }

  return [...groups.entries()].flatMap(([rootDirectory, entries]) => [
    `\`${rootDirectory}\``,
    ...entries.map(({ skill, directory }) => {
      const suffix = directory === skill.name ? "" : ` (dir: \`${directory}\`)`;
      return `- \`${skill.name}\`${suffix}: ${skill.description}`;
    }),
    "",
  ]).slice(0, -1);
}
