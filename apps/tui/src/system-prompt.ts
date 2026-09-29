import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeSystem, loadAgentsInstructions, readInstructions, type LoadedSkill } from "@mycoder/app-sdk";
import { loadSkills } from "./skills.js";

export const tuiBasePrompt = "你是终端Agent。用command工具完成用户任务，用中文简洁回答。";

const coreInstructionsPath = fileURLToPath(new URL("../system.md", import.meta.url));
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

  if (path) return readInstructions(path, "system prompt file");

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

export { loadAgentsInstructions };

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
  skills?: ReadonlyArray<LoadedSkill>;
} = {}): string {
  return composeSystem({
    basePrompt: tuiBasePrompt,
    instructions,
    agentsInstructions,
    skills,
  });
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

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    return isMissingFileError(error) ? false : true;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
