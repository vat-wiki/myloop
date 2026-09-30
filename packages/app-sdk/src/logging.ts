import { join } from "node:path";
import { createAgentLogger, type AgentLogLevel, type AgentLogger } from "myloop/runtime";

export type AppLoggerOptions = {
  cwd?: string;
  level?: AgentLogLevel;
  protocol: string;
  model: string;
};

export type { AgentLogLevel };

export async function createAppLogger(options: AppLoggerOptions): Promise<AgentLogger> {
  const cwd = options.cwd ?? process.cwd();
  return createAgentLogger({
    cwd,
    directory: join(".agents", "myloop", "logs"),
    level: options.level,
    metadata: {
      protocol: options.protocol,
      model: options.model,
    },
  });
}
