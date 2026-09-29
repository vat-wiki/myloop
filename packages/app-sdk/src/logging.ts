import { join } from "node:path";
import { createAgentLogger, type AgentLogger } from "myanne/runtime";

export type AppLoggerOptions = {
  cwd?: string;
  protocol: string;
  model: string;
};

export async function createAppLogger(options: AppLoggerOptions): Promise<AgentLogger> {
  const cwd = options.cwd ?? process.cwd();
  return createAgentLogger({
    cwd,
    directory: join(".agents", "myanne", "logs"),
    metadata: {
      protocol: options.protocol,
      model: options.model,
    },
  });
}
