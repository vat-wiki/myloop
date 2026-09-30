import { isValidTuiSessionId } from "./session.js";
import { isAgentLogLevel, type AgentLogLevel } from "myloop/runtime";

export { isValidTuiSessionId };

export type TuiProtocol = "anthropic" | "openai-chat" | "openai-responses";

export type TuiConfig = {
  protocol?: TuiProtocol;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  allowLocalFiles?: boolean;
  compactionThreshold?: number;
  sessionId?: string;
  systemPrompt?: string | false;
};

export type TuiCliOptions = {
  protocol: TuiProtocol;
  model: string;
  baseURL?: string;
  apiKey?: string;
  allowLocalFiles: boolean;
  compactionThreshold?: number;
  sessionId?: string;
  systemPrompt?: string;
  systemPromptEnabled: boolean;
  log: AgentLogLevel;
  help: boolean;
};

const PROTOCOLS: ReadonlyArray<TuiProtocol> = ["anthropic", "openai-chat", "openai-responses"];

export function parseTuiArgs(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
  config: TuiConfig = {},
): TuiCliOptions {
  let sessionId: string | undefined;
  let systemPrompt: string | undefined;
  let noSystemPrompt = false;
  let log: AgentLogLevel = "events";
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const value = (): string | undefined => argv[++index];

    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--config") {
      value();
    } else if (argument === "--session-id") {
      const next = value();
      if (!next || !isValidTuiSessionId(next)) {
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
      noSystemPrompt = true;
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
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  const selectedProtocol = config.protocol ?? (
    env.ANTHROPIC_API_KEY ? "anthropic" : "openai-chat"
  );
  const selectedModel = config.model ?? (
    selectedProtocol === "anthropic" ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL
  );
  if (!selectedModel) {
    throw new Error("model is required");
  }

  const configuredSystemPrompt = systemPrompt ?? (
    typeof config.systemPrompt === "string" ? config.systemPrompt : undefined
  );
  const systemPromptEnabled = noSystemPrompt
    ? false
    : systemPrompt !== undefined || config.systemPrompt !== false;

  return {
    protocol: selectedProtocol,
    model: selectedModel,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    allowLocalFiles: config.allowLocalFiles ?? false,
    compactionThreshold: config.compactionThreshold,
    sessionId: sessionId ?? config.sessionId,
    systemPrompt: systemPromptEnabled ? configuredSystemPrompt : undefined,
    systemPromptEnabled,
    log,
    help,
  };
}

export function formatTuiHelp(): string {
  return [
    "myloop TUI",
    "",
    "Usage: myloop-tui [options]",
    "",
    "Options:",
    "  --config <file>                Use a specific config file",
    "  --session-id <id>              Resume a session; defaults to a new session",
    "  --system-prompt <file>         Replace the built-in system prompt",
    "  --no-system-prompt             Disable the replaceable system prompt",
    "  --log[=<off|events|errors>]  Write model/tool audit logs (default: events)",
    "  -h, --help",
    "",
    "Commands:",
    "  /sessions List and switch sessions",
    "  /help    Show commands",
    "  /usage   Show latest token usage",
    "  /reset   Reset conversation history and usage",
    "  /exit    Quit the TUI",
  ].join("\n");
}

function isProtocol(value: string | undefined): value is TuiProtocol {
  return PROTOCOLS.includes(value as TuiProtocol);
}
