import type { AgentConfig } from "myloop/config";
import { isAgentLogLevel, type AgentLogLevel, type ToolDefinition } from "myloop/runtime";

export type CliProtocol = "anthropic" | "openai-chat" | "openai-responses";

export type CliConfig = AgentConfig & {
  botSensors?: ReadonlyArray<string>;
  botDrives?: ReadonlyArray<string>;
};

export type CliOptions = {
  protocol: CliProtocol;
  model: string;
  apiKey?: string;
  baseURL?: string;
  compactionThreshold?: number;
  sessionId?: string;
  continueLastSession: boolean;
  systemPrompt?: string;
  systemPromptEnabled: boolean;
  printPrompts: boolean;
  listSessions: boolean;
  thinking: boolean;
  thinkingBudgetTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  reasoningSummary?: "auto" | "concise" | "detailed";
  heartbeatIntervalMs?: number;
  bot: boolean;
  botPrompt?: string;
  botSensors?: ReadonlyArray<string>;
  botDrives?: ReadonlyArray<string>;
  log: AgentLogLevel;
  configPath?: string;
  prompt?: string;
  help: boolean;
};

export type { AgentConfig, ConfigProtocol, ConfigSources } from "myloop/config";
export { loadAgentConfig } from "myloop/config";

const PROTOCOLS: ReadonlyArray<CliProtocol> = [
  "anthropic",
  "openai-chat",
  "openai-responses",
];

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isCliProtocol(value: string | undefined): value is CliProtocol {
  return PROTOCOLS.includes(value as CliProtocol);
}

export function isValidCliSessionId(value: string | undefined): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function parseCliArgs(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
  config: CliConfig = {},
): CliOptions {
  let sessionId: string | undefined;
  let systemPrompt: string | undefined;
  let systemPromptEnabled = true;
  let printPrompts = true;
  let log: AgentLogLevel = "events";
  let configPath: string | undefined;
  let continueLastSession = false;
  let listSessions = false;
  let bot = false;
  const positionalArguments: Array<string> = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) break;
    const value = (): string | undefined => argv[++index];

    if (argument === "--") {
      positionalArguments.push(...argv.slice(index + 1));
      break;
    } else if (argument === "--continue" || argument === "-c") {
      continueLastSession = true;
    } else if (argument === "--list-sessions" || argument === "-l") {
      listSessions = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--session-id") {
      const next = value();
      if (!isValidCliSessionId(next)) {
        throw new Error("session id must contain 1-128 letters, numbers, dots, underscores, or hyphens");
      }
      sessionId = next;
    } else if (argument === "--system-prompt") {
      const next = value();
      if (!next) {
        throw new Error("system prompt path is required");
      }
      systemPrompt = next;
    } else if (argument === "--no-system-prompt") {
      systemPromptEnabled = false;
    } else if (argument === "--no-print-prompts") {
      printPrompts = false;
    } else if (argument === "--bot") {
      bot = true;
    } else if (argument === "--log") {
      const next = argv[index + 1];
      if (isAgentLogLevel(next)) {
        log = next;
        index += 1;
      } else {
        log = "events";
      }
    } else if (argument.startsWith("--log=")) {
      const level = argument.slice("--log=".length);
      if (!isAgentLogLevel(level)) {
        throw new Error("log level must be one of: off, events, errors");
      }
      log = level;
    } else if (argument === "--config") {
      const next = value();
      if (!next) {
        throw new Error("config file path is required");
      }
      configPath = next;
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown argument: ${argument}`);
    } else {
      positionalArguments.push(argument);
    }
  }

  const selectedProtocol = config.protocol ?? (
    env.ANTHROPIC_API_KEY ? "anthropic" : "openai-chat"
  );
  const selectedProtocolConfig = config.protocols?.[selectedProtocol];
  const selectedModel = selectedProtocolConfig?.model ?? (
    selectedProtocol === "anthropic" ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL
  );
  if (!selectedModel && !help && !listSessions) {
    throw new Error("model is required");
  }
  if (continueLastSession && sessionId) {
    throw new Error("--continue cannot be used with --session-id");
  }

  return {
    protocol: selectedProtocol,
    model: selectedModel ?? "",
    apiKey: selectedProtocolConfig?.apiKey,
    baseURL: selectedProtocolConfig?.baseURL,
    compactionThreshold: config.compactionThreshold,
    sessionId: continueLastSession ? undefined : sessionId ?? config.sessionId,
    continueLastSession,
    systemPrompt: systemPromptEnabled
      ? systemPrompt ?? (typeof config.systemPrompt === "string" ? config.systemPrompt : undefined)
      : undefined,
    systemPromptEnabled: systemPromptEnabled && (systemPrompt !== undefined || config.systemPrompt !== false),
    printPrompts,
    listSessions,
    thinking: selectedProtocolConfig?.thinking ?? false,
    thinkingBudgetTokens: config.protocols?.anthropic?.thinkingBudgetTokens,
    reasoningEffort: selectedProtocol === "anthropic" ? undefined : config.protocols?.[selectedProtocol]?.reasoningEffort,
    reasoningSummary: selectedProtocol === "openai-responses" ? config.protocols?.["openai-responses"]?.reasoningSummary : undefined,
    heartbeatIntervalMs: config.heartbeat?.intervalMs,
    bot,
    botPrompt: config.botPrompt,
    botSensors: (config as CliConfig).botSensors,
    botDrives: (config as CliConfig).botDrives,
    log,
    configPath,
    prompt: positionalArguments.join(" ").trim() || undefined,
    help,
  };
}

export function formatCliHelp(): string {
  return [
    "myloop CLI",
    "",
    "Usage:",
    "  myloop [options] <task>     Run one task and print the result",
    "  myloop [options]            Start an interactive session",
    "",
    "Options:",
    "  --config <file>              Use a specific config file",
    "  --session-id <id>            Resume a session",
    "  -c, --continue               Resume the most recently saved session",
    "  -l, --list-sessions          List saved sessions",
    "  --system-prompt <file>       Add a system prompt file",
    "  --no-system-prompt           Disable prompt and AGENTS.md loading",
    "  --no-print-prompts           Hide system prompt and tool declarations",
    "  --bot                        Bot mode: keep the agent alive with heartbeats",
    "  --log[=<off|events|errors>]  Write model/tool audit logs (default: events)",
    "  -h, --help",
    "",
    "Commands:",
    "  /exit  Exit the CLI",
  ].join("\n");
}
