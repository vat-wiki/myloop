import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Skill } from "./compose.js";

const FRONTMATTER_PATTERN = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export type ParseSkillSource = {
  contents?: string;
  path?: string;
};

export type ParseSkillOptions = {
  fallbackName?: string;
  path?: string;
};

export async function parseSkill(
  source: string | ParseSkillSource,
  options: ParseSkillOptions = {},
): Promise<Skill> {
  if (typeof source === "string") {
    if (hasFrontmatter(source)) {
      return parseSkillContents(source, options);
    }

    return parseSkillFile(source, options);
  }

  const { contents, path } = source;
  if (contents !== undefined) {
    return parseSkillContents(contents, { ...options, path });
  }
  if (path !== undefined) {
    return parseSkillFile(path, options);
  }

  throw new TypeError("skill source must include contents or path");
}

export async function parseSkillFile(
  path: string,
  options: { fallbackName?: string } = {},
): Promise<Skill> {
  const contents = await readFile(path, "utf8");
  return parseSkillContents(contents, { ...options, path });
}

export function parseSkillContents(
  contents: string,
  { fallbackName, path }: ParseSkillOptions = {},
): Skill {
  const errorPath = path ?? "skill";
  const match = contents.match(FRONTMATTER_PATTERN);
  if (!match) {
    throw new Error(`invalid skill file ${errorPath}: missing frontmatter`);
  }

  const metadata = parseFrontmatter(match[1] ?? "", errorPath);
  const nameFallback = fallbackName ?? (path === undefined ? undefined : basename(dirname(path)));
  const name = (metadata.get("name") ?? nameFallback)?.trim();
  const description = metadata.get("description")?.trim();
  const instructions = contents.slice(match[0].length).trim();

  if (!name) {
    throw new Error(`invalid skill file ${errorPath}: name is required`);
  }
  if (!description) {
    throw new Error(`invalid skill file ${errorPath}: description is required`);
  }
  if (!instructions) {
    throw new Error(`invalid skill file ${errorPath}: instructions cannot be empty`);
  }

  return { name, description, instructions };
}

function hasFrontmatter(contents: string): boolean {
  return /^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(contents);
}

function parseFrontmatter(contents: string, path: string): Map<string, string> {
  const metadata = new Map<string, string>();

  for (const line of contents.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const separator = trimmedLine.indexOf(":");
    if (separator <= 0) {
      throw new Error(`invalid skill file ${path}: invalid frontmatter line "${trimmedLine}"`);
    }

    const key = trimmedLine.slice(0, separator).trim();
    const value = unquote(trimmedLine.slice(separator + 1).trim());
    if (metadata.has(key)) {
      throw new Error(`invalid skill file ${path}: duplicate frontmatter field "${key}"`);
    }

    metadata.set(key, value);
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
