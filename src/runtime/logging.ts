import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentExtension } from "./extension.js";

export type AgentLogLevel = "off" | "events" | "errors";

export type AgentLogEvent = {
  level?: "info" | "error";
  timestamp: string;
  type: string;
  [key: string]: unknown;
};

export type AgentDiagnosticEvent = {
  data?: Record<string, unknown>;
  level: "info" | "warn" | "error";
  message: string;
  type: "diagnostic";
  timestamp: string;
};

export type AgentLoggerOptions = {
  cwd?: string;
  directory: string;
  level?: AgentLogLevel;
  metadata?: Record<string, unknown>;
};

const AGENT_LOG_LEVELS: ReadonlyArray<AgentLogLevel> = ["off", "events", "errors"];

export class AgentLogger {
  readonly path: string;
  readonly level: AgentLogLevel;
  readonly extension: AgentExtension;
  readonly diagnosticsPath: string;

  #appendQueue: Promise<void> = Promise.resolve();
  #diagnosticsQueue: Promise<void> = Promise.resolve();
  readonly #cwd: string;

  constructor({ cwd = process.cwd(), directory, level = "events" }: AgentLoggerOptions) {
    this.#cwd = cwd;
    this.level = level;
    const filename = `${logTimestamp()}-${process.pid}.jsonl`;
    this.path = join(cwd, directory, filename);
    this.diagnosticsPath = join(cwd, directory, `diagnostics-${filename}`);
    this.extension = level === "events"
      ? {
          name: "runtime-logger",
          beforeModelCall: async (request) => {
            await this.log("model_request", {
              system: request.system,
              messages: request.messages,
              tools: request.tools,
            });
            return request;
          },
          afterModelResponse: async ({ request, response }) => {
            await this.log("model_response", {
              messageCount: request.messages.length,
              response,
            });
            return response;
          },
          wrapToolCall: ({ name, handler }) => {
            return async (input, context) => {
              const startedAt = Date.now();
              await this.log("tool_start", { name, input });
              try {
                const output = await handler(input, context);
                await this.log("tool_end", {
                  name,
                  input,
                  output,
                  durationMs: Date.now() - startedAt,
                  ok: true,
                });
                return output;
              } catch (error) {
                await this.logToolError(name, input, error, startedAt);
                throw error;
              }
            };
          },
        }
      : {
          name: "runtime-logger",
          wrapToolCall: ({ name, handler }) => {
            return async (input, context) => {
              const startedAt = Date.now();
              try {
                return await handler(input, context);
              } catch (error) {
                await this.logToolError(name, input, error, startedAt);
                throw error;
              }
            };
          },
        };
  }

  async initialize(metadata: Record<string, unknown> = {}): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await this.log("session_start", {
      cwd: this.#cwd,
      ...metadata,
      level: "info",
    });
  }

  async log(type: string, data: Record<string, unknown> = {}): Promise<void> {
    if (this.level === "off") return;
    const event: AgentLogEvent = {
      level: type.endsWith("error") ? "error" : "info",
      timestamp: new Date().toISOString(),
      type,
      ...data,
    };
    this.#appendQueue = this.#appendQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${serializeEvent(event)}\n`, "utf8");
    }).catch((error) => {
      process.stderr.write(`failed to write myloop log: ${errorText(error)}\n`);
    });
    await this.#appendQueue;
  }

  async diagnostic(
    level: AgentDiagnosticEvent["level"],
    message: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.level === "off") return;
    const event: AgentDiagnosticEvent = {
      data,
      level,
      message,
      type: "diagnostic",
      timestamp: new Date().toISOString(),
    };
    this.#diagnosticsQueue = this.#diagnosticsQueue.then(async () => {
      await mkdir(dirname(this.diagnosticsPath), { recursive: true });
      await appendFile(
        this.diagnosticsPath,
        `${serializeEvent(event)}\n`,
        "utf8",
      );
    }).catch((error) => {
      process.stderr.write(`failed to write myloop diagnostic log: ${errorText(error)}\n`);
    });
    await this.#diagnosticsQueue;
  }

  private async logToolError(
    name: string,
    input: unknown,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    if (this.level === "off") return;
    await this.log("tool_error", {
      name,
      input,
      error: serializeError(error),
      durationMs: Date.now() - startedAt,
      ok: false,
    });
  }
}

export async function createAgentLogger(options: AgentLoggerOptions): Promise<AgentLogger> {
  const logger = new AgentLogger(options);
  await logger.initialize(options.metadata);
  return logger;
}

function logTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function isAgentLogLevel(value: unknown): value is AgentLogLevel {
  return typeof value === "string" && AGENT_LOG_LEVELS.includes(value as AgentLogLevel);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializeEvent(event: AgentLogEvent | AgentDiagnosticEvent): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(event, (_key, value: unknown) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value instanceof Error) {
      return serializeError(value);
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value;
  });
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return { message: errorText(error) };
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}
