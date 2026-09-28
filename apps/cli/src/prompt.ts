import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const cliBasePrompt = "你是终端Agent。用bash工具完成用户任务，用中文简洁回答。";

export async function loadSystemPrompt(path: string | undefined): Promise<string> {
  if (!path) return "";
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`system prompt file not found: ${path}`);
    }
    throw error;
  }
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
      const instruction = (await readFile(path, "utf8")).trim();
      if (instruction) instructions.push(instruction);
    } catch {
    }
  }

  return instructions.join("\n\n");
}

export function composeCliSystem({
  systemPrompt = "",
  agentsInstructions = "",
}: {
  systemPrompt?: string;
  agentsInstructions?: string;
} = {}): string {
  return [
    cliBasePrompt,
    systemPrompt,
    agentsInstructions && [
      "## AGENTS",
      "",
      "Follow the applicable instructions below; nested instructions override ancestor instructions.",
      "",
      agentsInstructions,
    ].join("\n"),
  ].filter((section) => section.length > 0).join("\n\n");
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
