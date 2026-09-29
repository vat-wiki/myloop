import { createUserInputAdapter, SingleAgent } from "mycoder/agent";
import { ShellCommandHost } from "mycoder/command/shell";
import type { AgentExtension, CommandHost, RuntimeSessionStore } from "mycoder/runtime";
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
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  allowLocalFiles?: boolean;
  system: string;
  sessionId?: string;
  sessionStore?: RuntimeSessionStore;
  cwd?: string;
  logger?: boolean;
  extensions?: ReadonlyArray<AgentExtension>;
  commandHost?: CommandHost;
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
  const logger = options.logger === true
    ? await createAppLogger({ cwd: options.cwd, protocol: options.protocol, model: options.model })
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
    extensions: [...(logger ? [logger.extension] : []), ...(options.extensions ?? [])],
    commandHost: options.commandHost ?? new ShellCommandHost(),
    sessionId: options.sessionId,
    sessionStore,
  });

  return { agent, sessionStore, logger };
}
