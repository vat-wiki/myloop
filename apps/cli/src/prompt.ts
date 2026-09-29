import { readFile } from "node:fs/promises";
import { composeSystem, loadAgentsInstructions } from "@myanne/app-sdk";

export const cliBasePrompt = "你是终端Agent。用command工具完成用户任务，用中文简洁回答。";

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

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

export function composeCliSystem({
  systemPrompt = "",
  agentsInstructions = "",
}: {
  systemPrompt?: string;
  agentsInstructions?: string;
} = {}): string {
  return composeSystem({
    basePrompt: cliBasePrompt,
    instructions: systemPrompt,
    agentsInstructions,
  });
}

export { loadAgentsInstructions };
