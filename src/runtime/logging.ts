import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentExtension } from "./extension.js";

export type AgentLogEvent = {
  timestamp: string;
  type: string;
  [key: string]: unknown;
};

export type AgentLoggerOptions = {
  cwd?: string;
  directory: string;
  metadata?: Record<string, unknown>;
};

export class AgentLogger {
  readonly path: string;
  readonly extension: AgentExtension;

  #appendQueue: Promise<void> = Promise.resolve();
  readonly #cwd: string;

  constructor({ cwd = process.cwd(), directory }: AgentLoggerOptions) {
    this.#cwd = cwd;
    this.path = join(cwd, directory, `${logTimestamp()}-${process.pid}.jsonl`);
    this.extension = {
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
            await this.log("tool_error", {
              name,
              input,
              error: serializeError(error),
              durationMs: Date.now() - startedAt,
              ok: false,
            });
            throw error;
          }
        };
      },
    };
  }

  async initialize(metadata: Record<string, unknown> = {}): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await this.log("session_start", { cwd: this.#cwd, ...metadata });
  }

  async log(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const event: AgentLogEvent = {
      timestamp: new Date().toISOString(),
      type,
      ...data,
    };
    this.#appendQueue = this.#appendQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${serializeEvent(event)}\n`, "utf8");
    }).catch((error) => {
      process.stderr.write(`failed to write myanne log: ${errorText(error)}\n`);
    });
    await this.#appendQueue;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializeEvent(event: AgentLogEvent): string {
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
