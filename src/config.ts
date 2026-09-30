import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type ConfigProtocol = "anthropic" | "openai-chat" | "openai-responses";

export type AgentConfig = {
  protocol?: ConfigProtocol;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  allowLocalFiles?: boolean;
  compactionThreshold?: number;
  sessionId?: string;
  systemPrompt?: string | false;
  thinking?: boolean;
};

export type ConfigSources = {
  global?: string;
  project?: string;
};

export type LoadAgentConfigOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  configPath?: string;
};

const PROTOCOLS: ReadonlyArray<ConfigProtocol> = [
  "anthropic",
  "openai-chat",
  "openai-responses",
];
const AGENTS_DIRECTORY = ".agents";
const CONFIG_FILENAME = "myloop.json";
const DEPRECATED_CONFIG_FIELDS = new Set([
  "maxTokens",
  "contextWindowTokens",
  "timeoutMs",
]);
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export async function loadAgentConfig(
  options: LoadAgentConfigOptions = {},
): Promise<{ config: AgentConfig; sources: ConfigSources }> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? env.HOME;
  const configPath = options.configPath;
  const sources: ConfigSources = {};

  if (configPath) {
    const explicitConfig = await readJsonConfig(configPath);
    if (!explicitConfig) {
      throw new Error(`config file not found: ${configPath}`);
    }
    return {
      config: explicitConfig,
      sources: { project: configPath },
    };
  }

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

async function readJsonConfig(path: string | undefined): Promise<AgentConfig | undefined> {
  if (!path || !await exists(path)) {
    return undefined;
  }

  try {
    const config = validateAgentConfig(JSON.parse(await readFile(path, "utf8")));
    if (typeof config.systemPrompt === "string") {
      config.systemPrompt = resolve(dirname(path), config.systemPrompt);
    }
    return config;
  } catch (error) {
    throw new Error(`invalid config file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateAgentConfig(value: unknown): AgentConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("config must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  assertAllowedFields(input, [
    "protocol",
    "model",
    "baseURL",
    "apiKey",
    "allowLocalFiles",
    "compactionThreshold",
    "sessionId",
    "systemPrompt",
    "thinking",
  ]);

  const config: AgentConfig = {};

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

  if (input.allowLocalFiles !== undefined) {
    if (typeof input.allowLocalFiles !== "boolean") {
      throw new Error("config allowLocalFiles must be a boolean");
    }
    config.allowLocalFiles = input.allowLocalFiles;
  }

  if (input.compactionThreshold !== undefined) {
    if (typeof input.compactionThreshold !== "number" || Number.isNaN(input.compactionThreshold) || input.compactionThreshold <= 0 || input.compactionThreshold > 1) {
      throw new Error("config compactionThreshold must be a number between 0 and 1");
    }
    config.compactionThreshold = input.compactionThreshold;
  }


  if (input.sessionId !== undefined) {
    assertString(input.sessionId, "config sessionId");
    if (!SESSION_ID_PATTERN.test(input.sessionId)) {
      throw new Error("config sessionId must contain 1-128 letters, numbers, dots, underscores, or hyphens");
    }
    config.sessionId = input.sessionId;
  }

  if (input.systemPrompt !== undefined) {
    if (typeof input.systemPrompt === "boolean") {
      if (input.systemPrompt !== false) {
        throw new Error("config systemPrompt must be false or a non-empty path");
      }
      config.systemPrompt = false;
    } else {
      assertString(input.systemPrompt, "config systemPrompt");
      if (!input.systemPrompt.trim()) {
        throw new Error("config systemPrompt must be false or a non-empty path");
      }
      config.systemPrompt = input.systemPrompt;
    }
  }

  if (input.thinking !== undefined) {
    if (typeof input.thinking !== "boolean") {
      throw new Error("config thinking must be a boolean");
    }
    config.thinking = input.thinking;
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

function isProtocol(value: unknown): value is ConfigProtocol {
  return PROTOCOLS.includes(value as ConfigProtocol);
}

function assertAllowedFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlyArray<string>,
): void {
  const allowed = new Set(allowedFields);
  const unknownField = Object.keys(value).find(
    (field) => !allowed.has(field) && !DEPRECATED_CONFIG_FIELDS.has(field),
  );
  if (unknownField !== undefined) {
    throw new Error(`config has unknown field: ${unknownField}`);
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
}
