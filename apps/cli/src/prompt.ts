import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeSystem,
  loadAgentsInstructions,
  readInstructions,
  type LoadedSkill,
} from "@myloop/app-sdk";

export const cliBasePrompt = "你是终端Agent。用command工具完成用户任务，用中文简洁回答。";

const coreInstructionsPath = fileURLToPath(new URL("../system.md", import.meta.url));
const systemPromptPath = join(".agents", "myloop", "system.md");

export type LoadSystemPromptOptions = {
  cwd?: string;
  home?: string;
  path?: string;
  enabled?: boolean;
};

export async function loadSystemPrompt({
  cwd = process.cwd(),
  home = process.env.HOME,
  path,
  enabled = true,
}: LoadSystemPromptOptions = {}): Promise<string> {
  if (!enabled) return "";
  if (path) return readInstructions(path, "system prompt file");

  const projectPath = await findProjectSystemPromptPath(cwd);
  if (projectPath) return readInstructions(projectPath, "project system prompt file");

  if (home) {
    const globalPath = join(resolve(home), systemPromptPath);
    if (await exists(globalPath)) {
      return readInstructions(globalPath, "global system prompt file");
    }
  }

  return readInstructions(coreInstructionsPath, "built-in system prompt file");
}

async function findProjectSystemPromptPath(startDirectory: string): Promise<string | undefined> {
  let directory = resolve(startDirectory);

  while (true) {
    const candidate = join(directory, systemPromptPath);
    if (await exists(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return isNotFoundError(error) ? false : true;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

export function composeCliSystem({
  systemPrompt = "",
  agentsInstructions = "",
  skills = [],
}: {
  systemPrompt?: string;
  agentsInstructions?: string;
  skills?: ReadonlyArray<LoadedSkill>;
} = {}): string {
  return composeSystem({
    basePrompt: cliBasePrompt,
    instructions: systemPrompt,
    agentsInstructions,
    skills,
  });
}

export { loadAgentsInstructions };
