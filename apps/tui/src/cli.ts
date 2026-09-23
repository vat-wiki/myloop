export type TuiProtocol = "anthropic" | "openai-chat" | "openai-responses";

export type TuiConfig = {
  protocol?: TuiProtocol;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  maxTokens?: number;
  timeoutMs?: number;
  retryAttempts?: number;
  allowLocalFiles?: boolean;
};

export type TuiCliOptions = {
  protocol: TuiProtocol;
  model: string;
  baseURL?: string;
  apiKey?: string;
  maxTokens: number;
  timeoutMs?: number;
  retryAttempts: number;
  allowLocalFiles: boolean;
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
  let maxTokens: number | undefined;
  let timeoutMs: number | undefined;
  let retryAttempts: number | undefined;
  let allowLocalFiles = false;
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
    } else if (argument === "--max-tokens") {
      maxTokens = parsePositiveInteger(value(), "--max-tokens");
    } else if (argument === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(value(), "--timeout-ms");
    } else if (argument === "--retry-attempts") {
      retryAttempts = parseNonNegativeInteger(value(), "--retry-attempts");
    } else if (argument === "--allow-local-files") {
      allowLocalFiles = true;
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

  return {
    protocol: selectedProtocol,
    model: selectedModel,
    baseURL: baseURL ?? config.baseURL,
    apiKey: config.apiKey,
    maxTokens: maxTokens ?? config.maxTokens ?? 8_192,
    timeoutMs: timeoutMs ?? config.timeoutMs,
    retryAttempts: retryAttempts ?? config.retryAttempts ?? 2,
    allowLocalFiles: allowLocalFiles || config.allowLocalFiles || false,
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
    "  --max-tokens <number>          Defaults to 8192",
    "  --timeout-ms <number>          Defaults to 60000",
    "  --retry-attempts <number>      Defaults to 2",
    "  --allow-local-files            Enables reading local image/document input",
    "  -h, --help",
    "",
    "Commands:",
    "  /help    Show commands",
    "  /usage   Show cumulative token usage",
    "  /reset   Reset conversation history and usage",
    "  /exit    Quit the TUI",
  ].join("\n");
}

function isProtocol(value: string | undefined): value is TuiProtocol {
  return PROTOCOLS.includes(value as TuiProtocol);
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
