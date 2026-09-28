import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill } from "mycoder/skills";
import { loadSkills, type LoadedSkill } from "./skills.js";

export const tuiBasePrompt = "你是终端Agent。用bash工具完成用户任务，用中文简洁回答。";

const coreInstructionsPath = fileURLToPath(new URL("../system.md", import.meta.url));
const agentsFileName = "AGENTS.md";
const systemPromptPath = join(".agents", "mycoder", "system.md");

export type LoadSystemInstructionsOptions = {
  cwd?: string;
  home?: string;
  path?: string;
  enabled?: boolean;
};

export async function loadSystemInstructions({
  cwd = process.cwd(),
  home = process.env.HOME,
  path,
  enabled = true,
}: LoadSystemInstructionsOptions = {}): Promise<string> {
  if (!enabled) {
    return "";
  }

  if (path) {
    return readInstructions(path, "system prompt file");
  }

  const projectPath = await findProjectSystemPromptPath(cwd);
  if (projectPath) {
    return readInstructions(projectPath, "project system prompt file");
  }

  if (home) {
    const globalPath = join(resolve(home), systemPromptPath);
    if (await exists(globalPath)) {
      return readInstructions(globalPath, "global system prompt file");
    }
  }

  return readInstructions(coreInstructionsPath, "built-in system prompt file");
}

export async function loadAgentsInstructions({
  cwd = process.cwd(),
}: {
  cwd?: string;
} = {}): Promise<string> {
  const paths: Array<string> = [];
  let directory = resolve(cwd);

  while (true) {
    paths.push(join(directory, agentsFileName));

    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  const instructions: Array<string> = [];
  for (const path of paths.reverse()) {
    try {
      const instructionsText = (await readFile(path, "utf8")).trim();
      if (instructionsText.length > 0) {
        instructions.push(instructionsText);
      }
    } catch {
    }
  }

  return instructions.join("\n\n");
}

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
  agentsInstructions = "",
  skills = [],
}: {
  instructions?: string;
  agentsInstructions?: string;
  skills?: ReadonlyArray<LoadedSkill | Skill>;
} = {}): string {
  return [
    tuiBasePrompt,
    instructions,
    renderAgentsInstructions(agentsInstructions),
    renderSkillCatalog(skills),
  ].filter((section) => section.length > 0).join("\n\n");
}

function renderAgentsInstructions(agentsInstructions: string): string {
  if (agentsInstructions.length === 0) {
    return "";
  }

  return [
    "## AGENTS",
    "",
    "Follow the applicable instructions below; nested instructions override ancestor instructions.",
    "",
    agentsInstructions,
  ].join("\n");
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

async function findProjectSystemPromptPath(startDirectory: string): Promise<string | undefined> {
  let directory = resolve(startDirectory);

  while (true) {
    const candidate = join(directory, systemPromptPath);
    if (await exists(candidate)) {
      return candidate;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

async function readInstructions(path: string, label: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`${label} not found: ${path}`);
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    return !isMissingFileError(error);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
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
