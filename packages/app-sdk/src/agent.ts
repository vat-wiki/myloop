import { createUserInputAdapter, SingleAgent } from "myloop/agent";
import { ShellCommandHost } from "myloop/command/shell";
import type { AgentExtension, CommandHost, HeartbeatOptions, RuntimeSessionStore } from "myloop/runtime";
import type { AgentLogLevel } from "myloop/runtime";
import { createAppLogger } from "./logging.js";
import { createAppModelClient, type AppProtocol } from "./model.js";
import { FileSessionStore } from "./session.js";

export type CreateAppAgentOptions = {
  name?: string;
  protocol: AppProtocol;
  model: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  baseURL?: string;
  contextWindowTokens?: number;
  maxTokens?: number;
  compactionThreshold?: number;
  heartbeat?: HeartbeatOptions;
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  allowLocalFiles?: boolean;
  system: string;
  sessionId?: string;
  sessionStore?: RuntimeSessionStore;
  cwd?: string;
  logger?: boolean | AgentLogLevel;
  extensions?: ReadonlyArray<AgentExtension>;
  /** 传 `null` 表示显式不挂 shell（例如只暴露自有工具的 Web 端）。 */
  commandHost?: CommandHost | null;
  commandHosts?: ReadonlyArray<CommandHost>;
};

export type AppAgent = {
  agent: SingleAgent;
  sessionStore: RuntimeSessionStore;
  logger: Awaited<ReturnType<typeof createAppLogger>> | undefined;
};

export async function createAppAgent(options: CreateAppAgentOptions): Promise<AppAgent> {
  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env[
    options.protocol === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
  ];
  const logLevel = options.logger === true
    ? "events"
    : options.logger === undefined || options.logger === false || options.logger === "off"
      ? undefined
      : options.logger;
  const logger = logLevel
    ? await createAppLogger({
        cwd: options.cwd,
        level: logLevel,
        protocol: options.protocol,
        model: options.model,
      })
    : undefined;
  const input = createUserInputAdapter({ allowLocalFiles: options.allowLocalFiles ?? false });
  const sessionStore = options.sessionStore ?? new FileSessionStore({ cwd: options.cwd });
  const agent = new SingleAgent({
    name: options.name ?? "app-agent",
    modelClient: createAppModelClient({
      protocol: options.protocol,
      model: options.model,
      apiKey,
      baseURL: options.baseURL,
      artifactStore: input.artifactStore,
      contextWindowTokens: options.contextWindowTokens,
      maxTokens: options.maxTokens,
      thinking: options.thinking,
      thinkingBudgetTokens: options.thinkingBudgetTokens,
    }),
    input,
    system: options.system,
    compactionThreshold: options.compactionThreshold,
    heartbeat: options.heartbeat,
    extensions: [...(logger ? [logger.extension] : []), ...(options.extensions ?? [])],
    commandHost: options.commandHost === null ? undefined : options.commandHost ?? new ShellCommandHost(),
    commandHosts: options.commandHosts,
    sessionId: options.sessionId,
    sessionStore,
  });

  return { agent, sessionStore, logger };
}
