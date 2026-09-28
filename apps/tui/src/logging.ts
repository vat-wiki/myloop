import { join } from "node:path";
import { createAgentLogger, type AgentLogEvent, type AgentLogger } from "mycoder/runtime";

export type TuiLogEvent = AgentLogEvent;
export type TuiLogger = AgentLogger;

export type TuiLoggerOptions = {
  cwd?: string;
  protocol: string;
  model: string;
};

export async function createTuiLogger(options: TuiLoggerOptions): Promise<TuiLogger> {
  const cwd = options.cwd ?? process.cwd();
  return createAgentLogger({
    cwd,
    directory: join(".agents", "mycoder", "logs"),
    metadata: {
      protocol: options.protocol,
      model: options.model,
    },
  });
}
