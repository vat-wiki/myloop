import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Skill } from "myloop/skills";

export type LoadedSkill = Skill & {
  path: string;
};

export function composeSystem({
  basePrompt,
  instructions = "",
  agentsInstructions = "",
  skills = [],
}: {
  basePrompt: string;
  instructions?: string;
  agentsInstructions?: string;
  skills?: ReadonlyArray<LoadedSkill | Skill>;
}): string {
  return [
    basePrompt,
    instructions,
    renderAgentsInstructions(agentsInstructions),
    renderSkillCatalog(skills),
  ].filter((section) => section.length > 0).join("\n\n");
}

export async function loadAgentsInstructions({
  cwd = process.cwd(),
}: {
  cwd?: string;
} = {}): Promise<string> {
  const paths: Array<string> = [];
  let directory = resolve(cwd);

  while (true) {
    paths.push(join(directory, "AGENTS.md"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  const instructions: Array<string> = [];
  for (const path of paths.reverse()) {
    try {
      const instructionsText = (await readFile(path, "utf8")).trim();
      if (instructionsText) instructions.push(instructionsText);
    } catch {
    }
  }

  return instructions.join("\n\n");
}

export async function readInstructions(path: string, label = "instructions file"): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`${label} not found: ${path}`);
    }
    throw error;
  }
}

function renderAgentsInstructions(agentsInstructions: string): string {
  if (agentsInstructions.length === 0) return "";

  return [
    "# AGENTS",
    "",
    "Follow the applicable instructions below; nested instructions override ancestor instructions.",
    "",
    agentsInstructions,
  ].join("\n");
}

function renderSkillCatalog(skills: ReadonlyArray<LoadedSkill | Skill>): string {
  if (skills.length === 0) return "";

  return [
    "# Skills",
    "",
    "Use command tool to read the relevant `<skill-directory>/SKILL.md` before applying it.",
    "",
    ...renderSkillGroups(skills),
  ].join("\n");
}

function renderSkillGroups(skills: ReadonlyArray<LoadedSkill | Skill>): Array<string> {
  const groups = new Map<string, Array<{ skill: LoadedSkill | Skill; directory: string }>>();

  for (const skill of skills) {
    if (!("path" in skill) || typeof skill.path !== "string") continue;

    const skillDirectory = dirname(skill.path);
    const rootDirectory = dirname(skillDirectory);
    const group = groups.get(rootDirectory) ?? [];
    group.push({ skill, directory: basename(skillDirectory) });
    groups.set(rootDirectory, group);
  }

  return [...groups.entries()].flatMap(([rootDirectory, entries]) => [
    `## \`${rootDirectory}\``,
    ...entries.map(({ skill, directory }) => {
      const suffix = directory === skill.name ? "" : ` (dir: \`${directory}\`)`;
      return `- \`${skill.name}\`${suffix}: ${skill.description}`;
    }),
    "",
  ]).slice(0, -1);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
