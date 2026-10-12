import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type ConfigProtocol = "anthropic" | "openai-chat" | "openai-responses";

export type ProtocolConnectionConfig = {
  model?: string;
  apiKey?: string;
  baseURL?: string;
};

export type AnthropicProtocolConfig = ProtocolConnectionConfig & {
  thinking?: boolean;
  thinkingBudgetTokens?: number;
};

export type OpenAIChatProtocolConfig = ProtocolConnectionConfig & {
  thinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
};

export type OpenAIResponsesProtocolConfig = ProtocolConnectionConfig & {
  thinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  reasoningSummary?: "auto" | "concise" | "detailed";
};

export type ProtocolConfig = {
  anthropic?: AnthropicProtocolConfig;
  "openai-chat"?: OpenAIChatProtocolConfig;
  "openai-responses"?: OpenAIResponsesProtocolConfig;
};

export type AgentConfig = {
  protocol?: ConfigProtocol;
  compactionThreshold?: number;
  sessionId?: string;
  systemPrompt?: string | false;
  protocols?: ProtocolConfig;
  heartbeat?: {
    intervalMs?: number;
  };
  bot?: boolean;
  botPrompt?: string;
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
      merged = mergeConfigs(merged, projectConfig);
    }
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
    "compactionThreshold",
    "sessionId",
    "systemPrompt",
    "protocols",
    "heartbeat",
    "bot",
    "botPrompt",
  ]);

  const config: AgentConfig = {};

  if (input.protocol !== undefined) {
    if (!isProtocol(input.protocol)) {
      throw new Error(`config protocol must be one of: ${PROTOCOLS.join(", ")}`);
    }
    config.protocol = input.protocol;
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

  if (input.protocols !== undefined) {
    config.protocols = validateProtocolConfigs(input.protocols);
  }

  if (input.heartbeat !== undefined) {
    if (typeof input.heartbeat !== "object" || input.heartbeat === null || Array.isArray(input.heartbeat)) {
      throw new Error("config heartbeat must be an object");
    }
    const heartbeat = input.heartbeat as Record<string, unknown>;
    const unknownHeartbeatField = Object.keys(heartbeat).find((field) => field !== "intervalMs");
    if (unknownHeartbeatField !== undefined) {
      throw new Error(`config heartbeat has unknown field: ${unknownHeartbeatField}`);
    }
    if (heartbeat.intervalMs !== undefined) {
      if (typeof heartbeat.intervalMs !== "number" || !Number.isFinite(heartbeat.intervalMs) || heartbeat.intervalMs <= 0) {
        throw new Error("config heartbeat.intervalMs must be a positive number");
      }
      config.heartbeat = { intervalMs: heartbeat.intervalMs };
    } else {
      config.heartbeat = {};
    }
  }

  if (input.bot !== undefined) {
    if (typeof input.bot !== "boolean") {
      throw new Error("config bot must be a boolean");
    }
    config.bot = input.bot;
  }

  if (input.botPrompt !== undefined) {
    assertString(input.botPrompt, "config botPrompt");
    if (!input.botPrompt.trim()) {
      throw new Error("config botPrompt cannot be empty");
    }
    config.botPrompt = input.botPrompt;
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

function validateProtocolConfigs(value: unknown): ProtocolConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("config protocols must be an object");
  }

  const input = value as Record<string, unknown>;
  assertAllowedFields(input, ["anthropic", "openai-chat", "openai-responses"], "config protocols");
  const config: ProtocolConfig = {};

  if (input.anthropic !== undefined) {
    config.anthropic = validateProtocolConfig<AnthropicProtocolConfig>(
      input.anthropic,
      "config protocols.anthropic",
      ["thinking", "thinkingBudgetTokens"],
    );
    if (config.anthropic.thinkingBudgetTokens !== undefined) {
      assertThinkingBudgetTokens(config.anthropic.thinkingBudgetTokens);
    }
  }

  if (input["openai-chat"] !== undefined) {
    config["openai-chat"] = validateProtocolConfig<OpenAIChatProtocolConfig>(
      input["openai-chat"],
      "config protocols.openai-chat",
      ["thinking", "reasoningEffort"],
    );
  }

  if (input["openai-responses"] !== undefined) {
    config["openai-responses"] = validateProtocolConfig<OpenAIResponsesProtocolConfig>(
      input["openai-responses"],
      "config protocols.openai-responses",
      ["thinking", "reasoningEffort", "reasoningSummary"],
    );
  }

  return config;
}

function validateProtocolConfig<T extends Record<string, unknown>>(
  value: unknown,
  name: string,
  allowedFields: ReadonlyArray<string>,
): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }

  const input = value as Record<string, unknown>;
  assertAllowedFields(input, ["model", "apiKey", "baseURL", ...allowedFields], name);
  const config: Record<string, unknown> = {};

  if (input.model !== undefined) {
    assertString(input.model, `${name}.model`);
    if (!input.model.trim()) {
      throw new Error(`${name}.model cannot be empty`);
    }
    config.model = input.model;
  }

  if (input.apiKey !== undefined) {
    assertString(input.apiKey, `${name}.apiKey`);
    if (!input.apiKey.trim()) {
      throw new Error(`${name}.apiKey cannot be empty`);
    }
    config.apiKey = input.apiKey;
  }

  if (input.baseURL !== undefined) {
    assertString(input.baseURL, `${name}.baseURL`);
    try {
      new URL(input.baseURL);
    } catch {
      throw new Error(`${name}.baseURL must be a valid URL`);
    }
    config.baseURL = input.baseURL;
  }

  if (input.thinking !== undefined) {
    if (typeof input.thinking !== "boolean") {
      throw new Error(`${name}.thinking must be a boolean`);
    }
    config.thinking = input.thinking;
  }

  if (input.thinkingBudgetTokens !== undefined) {
    config.thinkingBudgetTokens = input.thinkingBudgetTokens;
  }

  if (input.reasoningEffort !== undefined) {
    if (!isReasoningEffort(input.reasoningEffort)) {
      throw new Error(`${name}.reasoningEffort must be one of: low, medium, high`);
    }
    config.reasoningEffort = input.reasoningEffort;
  }

  if (input.reasoningSummary !== undefined) {
    if (!isReasoningSummary(input.reasoningSummary)) {
      throw new Error(`${name}.reasoningSummary must be one of: auto, concise, detailed`);
    }
    config.reasoningSummary = input.reasoningSummary;
  }

  return config as T;
}

function isReasoningEffort(value: unknown): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function isReasoningSummary(value: unknown): value is "auto" | "concise" | "detailed" {
  return value === "auto" || value === "concise" || value === "detailed";
}

function assertThinkingBudgetTokens(value: number): void {
  if (!Number.isInteger(value) || value < 1_024) {
    throw new Error("config protocols.anthropic.thinkingBudgetTokens must be an integer of at least 1024");
  }
}

function mergeConfigs(left: AgentConfig, right: AgentConfig): AgentConfig {
  const merged: AgentConfig = {
    ...left,
    ...right,
  };
  const anthropic = mergeProtocolConfig(left.protocols?.anthropic, right.protocols?.anthropic);
  const openaiChat = mergeProtocolConfig(left.protocols?.["openai-chat"], right.protocols?.["openai-chat"]);
  const openaiResponses = mergeProtocolConfig(left.protocols?.["openai-responses"], right.protocols?.["openai-responses"]);
  if (anthropic || openaiChat || openaiResponses) {
    merged.protocols = {};
    if (anthropic) merged.protocols.anthropic = anthropic;
    if (openaiChat) merged.protocols["openai-chat"] = openaiChat;
    if (openaiResponses) merged.protocols["openai-responses"] = openaiResponses;
  }
  return merged;
}

function mergeProtocolConfig<T extends object>(left: T | undefined, right: T | undefined): T | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return { ...left, ...right };
}

function assertAllowedFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlyArray<string>,
  prefix = "config",
): void {
  const allowed = new Set(allowedFields);
  const unknownField = Object.keys(value).find(
    (field) => !allowed.has(field),
  );
  if (unknownField !== undefined) {
    throw new Error(`${prefix} has unknown field: ${unknownField}`);
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
}
