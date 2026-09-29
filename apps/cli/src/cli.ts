import type { AgentConfig } from "myanne/config";

export type CliProtocol = "anthropic" | "openai-chat" | "openai-responses";

export type CliConfig = AgentConfig;

export type CliOptions = {
  protocol: CliProtocol;
  model: string;
  apiKey?: string;
  baseURL?: string;
  allowLocalFiles: boolean;
  maxTokens?: number;
  contextWindowTokens?: number;
  sessionId?: string;
  systemPrompt?: string;
  systemPromptEnabled: boolean;
  thinking: boolean;
  thinkingBudgetTokens?: number;
  log: boolean;
  prompt?: string;
  help: boolean;
};

export type { AgentConfig, ConfigProtocol, ConfigSources } from "myanne/config";
export { loadAgentConfig } from "myanne/config";

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
  let protocol: CliProtocol | undefined;
  let model: string | undefined;
  let baseURL: string | undefined;
  let contextWindowTokens: number | undefined;
  let sessionId: string | undefined;
  let systemPrompt: string | undefined;
  let systemPromptEnabled = true;
  let thinking = false;
  let thinkingBudgetTokens: number | undefined;
  let allowLocalFiles: boolean | undefined;
  let maxTokens: number | undefined;
  let log = false;
  const positionalArguments: Array<string> = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) break;
    const value = (): string | undefined => argv[++index];

    if (argument === "--") {
      positionalArguments.push(...argv.slice(index + 1));
      break;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--protocol") {
      const next = value();
      if (!isCliProtocol(next)) {
        throw new Error(`unknown protocol: ${next ?? "(missing)"}`);
      }
      protocol = next;
    } else if (argument === "--model") {
      model = value();
    } else if (argument === "--base-url") {
      baseURL = value();
    } else if (argument === "--max-tokens") {
      const next = Number(value());
      if (!Number.isInteger(next) || next <= 0) {
        throw new Error("max tokens must be a positive integer");
      }
      maxTokens = next;
    } else if (argument === "--context-window-tokens") {
      const next = Number(value());
      if (!Number.isInteger(next) || next <= 0) {
        throw new Error("context window tokens must be a positive integer");
      }
      contextWindowTokens = next;
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
    } else if (argument === "--thinking") {
      thinking = true;
    } else if (argument === "--thinking-budget-tokens") {
      const next = Number(value());
      if (!Number.isInteger(next) || next < 1024) {
        throw new Error("thinking budget tokens must be an integer of at least 1024");
      }
      thinkingBudgetTokens = next;
    } else if (argument === "--allow-local-files") {
      allowLocalFiles = true;
    } else if (argument === "--log") {
      log = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown argument: ${argument}`);
    } else {
      positionalArguments.push(argument);
    }
  }

  const selectedProtocol = protocol ?? config.protocol ?? (
    env.ANTHROPIC_API_KEY ? "anthropic" : "openai-chat"
  );
  const selectedModel = model ?? config.model ?? (
    selectedProtocol === "anthropic" ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL
  );
  if (!selectedModel && !help) {
    throw new Error("model is required");
  }

  return {
    protocol: selectedProtocol,
    model: selectedModel ?? "",
    apiKey: config.apiKey,
    baseURL: baseURL ?? config.baseURL,
    allowLocalFiles: allowLocalFiles ?? config.allowLocalFiles ?? false,
    maxTokens,
    contextWindowTokens: contextWindowTokens ?? config.contextWindowTokens,
    sessionId: sessionId ?? config.sessionId,
    systemPrompt: systemPromptEnabled
      ? systemPrompt ?? (typeof config.systemPrompt === "string" ? config.systemPrompt : undefined)
      : undefined,
    systemPromptEnabled: systemPromptEnabled && (systemPrompt !== undefined || config.systemPrompt !== false),
    thinking,
    thinkingBudgetTokens,
    log,
    prompt: positionalArguments.join(" ").trim() || undefined,
    help,
  };
}

export function formatCliHelp(): string {
  return [
    "myanne CLI",
    "",
    "Usage:",
    "  myanne [options] <task>     Run one task and print the result",
    "  myanne [options]            Start an interactive session",
    "",
    "Options:",
    "  --protocol <anthropic|openai-chat|openai-responses>",
    "  --model <model-id>",
    "  --base-url <url>",
    "  --max-tokens <tokens>",
    "  --context-window-tokens <tokens>",
    "  --session-id <id>            Resume a session",
    "  --system-prompt <file>       Add a system prompt file",
    "  --no-system-prompt           Disable prompt and AGENTS.md loading",
    "  --allow-local-files          Allow local file inputs",
    "  --thinking                   Ask reasoning models to expose thinking when supported",
    "  --thinking-budget-tokens <n> Anthropic thinking budget (minimum 1024)",
    "  --log                        Write model/tool logs",
    "  -h, --help",
    "",
    "Commands:",
    "  /reset Reset the current session",
    "  /exit  Exit the CLI",
  ].join("\n");
}
