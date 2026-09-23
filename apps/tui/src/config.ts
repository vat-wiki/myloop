import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { TuiConfig, TuiProtocol } from "./cli.js";

const PROTOCOLS: ReadonlyArray<TuiProtocol> = ["anthropic", "openai-chat", "openai-responses"];
const AGENTS_DIRECTORY = ".agents";
const CONFIG_FILENAME = "mycoder.json";

export type TuiConfigSources = {
  global?: string;
  project?: string;
};

export type LoadTuiConfigOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
};

export async function loadTuiConfig(
  options: LoadTuiConfigOptions = {},
): Promise<{ config: TuiConfig; sources: TuiConfigSources }> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? env.HOME;
  const sources: TuiConfigSources = {};

  const globalConfigPath = home ? join(home, AGENTS_DIRECTORY, CONFIG_FILENAME) : undefined;
  const globalConfig = await readJsonConfig(globalConfigPath);
  if (globalConfig && globalConfigPath) {
    sources.global = globalConfigPath;
  }
  let merged = globalConfig ?? {};

  const projectPath = await findProjectConfigPath(cwd);
  if (projectPath && projectPath !== globalConfigPath) {
    const projectConfig = await readJsonConfig(projectPath);
    if (projectConfig) {
      sources.project = projectPath;
    }
    merged = {
      ...merged,
      ...projectConfig,
    };
  }

  return {
    config: merged,
    sources,
  };
}

async function findProjectConfigPath(startDirectory: string): Promise<string | undefined> {
  let directory = resolve(startDirectory);

  while (true) {
    const candidate = join(directory, AGENTS_DIRECTORY, CONFIG_FILENAME);
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

async function readJsonConfig(path: string | undefined): Promise<TuiConfig | undefined> {
  if (!path || !await exists(path)) {
    return undefined;
  }

  try {
    return validateTuiConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(`invalid config file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateTuiConfig(value: unknown): TuiConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("config must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  assertAllowedFields(input, [
    "protocol",
    "model",
    "baseURL",
    "apiKey",
    "maxTokens",
    "timeoutMs",
    "retryAttempts",
    "allowLocalFiles",
  ]);

  const config: TuiConfig = {};

  if (input.protocol !== undefined) {
    if (!isProtocol(input.protocol)) {
      throw new Error(`config protocol must be one of: ${PROTOCOLS.join(", ")}`);
    }
    config.protocol = input.protocol;
  }

  if (input.model !== undefined) {
    assertString(input.model, "config model");
    if (!input.model.trim()) {
      throw new Error("config model cannot be empty");
    }
    config.model = input.model;
  }

  if (input.baseURL !== undefined) {
    assertString(input.baseURL, "config baseURL");
    try {
      new URL(input.baseURL);
    } catch {
      throw new Error("config baseURL must be a valid URL");
    }
    config.baseURL = input.baseURL;
  }

  if (input.apiKey !== undefined) {
    assertString(input.apiKey, "config apiKey");
    if (!input.apiKey.trim()) {
      throw new Error("config apiKey cannot be empty");
    }
    config.apiKey = input.apiKey;
  }

  if (input.maxTokens !== undefined) {
    config.maxTokens = assertPositiveInteger(input.maxTokens, "config maxTokens");
  }
  if (input.timeoutMs !== undefined) {
    config.timeoutMs = assertPositiveInteger(input.timeoutMs, "config timeoutMs");
  }
  if (input.retryAttempts !== undefined) {
    config.retryAttempts = assertNonNegativeInteger(input.retryAttempts, "config retryAttempts");
  }
  if (input.allowLocalFiles !== undefined) {
    if (typeof input.allowLocalFiles !== "boolean") {
      throw new Error("config allowLocalFiles must be a boolean");
    }
    config.allowLocalFiles = input.allowLocalFiles;
  }

  return config;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isProtocol(value: unknown): value is TuiProtocol {
  return PROTOCOLS.includes(value as TuiProtocol);
}

function assertAllowedFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlyArray<string>,
): void {
  const unknownField = Object.keys(value).find((field) => !allowedFields.includes(field));
  if (unknownField !== undefined) {
    throw new Error(`config has unknown field: ${unknownField}`);
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
}

function assertPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
