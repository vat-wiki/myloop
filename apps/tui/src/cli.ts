import { isValidTuiSessionId } from "./session.js";

export { isValidTuiSessionId };

export type TuiProtocol = "anthropic" | "openai-chat" | "openai-responses";

export type TuiConfig = {
  protocol?: TuiProtocol;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  allowLocalFiles?: boolean;
  contextWindowTokens?: number;
  sessionId?: string;
  systemPrompt?: string | false;
};

export type TuiCliOptions = {
  protocol: TuiProtocol;
  model: string;
  baseURL?: string;
  apiKey?: string;
  allowLocalFiles: boolean;
  contextWindowTokens?: number;
  sessionId?: string;
  systemPrompt?: string;
  systemPromptEnabled: boolean;
  help: boolean;
};

const PROTOCOLS: ReadonlyArray<TuiProtocol> = ["anthropic", "openai-chat", "openai-responses"];

export function parseTuiArgs(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
  config: TuiConfig = {},
): TuiCliOptions {
  let protocol: TuiProtocol | undefined;
  let model: string | undefined;
  let baseURL: string | undefined;
  let contextWindowTokens: number | undefined;
  let sessionId: string | undefined;
  let systemPrompt: string | undefined;
  let noSystemPrompt = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = (): string | undefined => argv[++index];

    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--protocol") {
      const next = value();
      if (!isProtocol(next)) {
        throw new Error(`unknown protocol: ${next ?? "(missing)"}`);
      }
      protocol = next;
    } else if (argument === "--model") {
      model = value();
    } else if (argument === "--base-url") {
      baseURL = value();
    } else if (argument === "--context-window-tokens") {
      const next = Number(value());
      if (!Number.isInteger(next) || next <= 0) {
        throw new Error("context window tokens must be a positive integer");
      }
      contextWindowTokens = next;
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
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  const selectedProtocol = protocol ?? config.protocol ?? (
    env.ANTHROPIC_API_KEY ? "anthropic" : "openai-chat"
  );
  const selectedModel = model ?? config.model ?? (
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
    baseURL: baseURL ?? config.baseURL,
    apiKey: config.apiKey,
    allowLocalFiles: config.allowLocalFiles ?? false,
    contextWindowTokens: contextWindowTokens ?? config.contextWindowTokens,
    sessionId: sessionId ?? config.sessionId,
    systemPrompt: systemPromptEnabled ? configuredSystemPrompt : undefined,
    systemPromptEnabled,
    help,
  };
}

export function formatTuiHelp(): string {
  return [
    "mycoder TUI",
    "",
    "Usage: mycoder-tui [options]",
    "",
    "Options:",
    "  --protocol <anthropic|openai-chat|openai-responses>",
    "  --model <model-id>",
    "  --base-url <url>",
    "  --context-window-tokens <tokens>",
    "  --session-id <id>              Resume a session; defaults to a new session",
    "  --system-prompt <file>         Replace the built-in system prompt",
    "  --no-system-prompt             Disable the replaceable system prompt",
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
