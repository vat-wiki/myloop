#!/usr/bin/env -S node --experimental-ffi
import { createUserInputAdapter, SingleAgent } from "mycoder/agent";
import { Anthropic } from "mycoder/clients/anthropic";
import { OpenAIChat } from "mycoder/clients/openai-chat";
import { OpenAIResponses } from "mycoder/clients/openai-responses";
import { runTuiApp } from "./app.js";
import { createTuiLogger } from "./logging.js";
import type { TuiLogger } from "./logging.js";
import {
  composeTuiSystem,
  loadAgentsInstructions,
  loadSystemInstructions,
  loadTuiSkills,
} from "./system-prompt.js";
import { loadTuiConfig } from "./config.js";
import { createTuiSessionId, FileSessionStore } from "./session.js";
import { errorText } from "./state.js";
import { formatTuiHelp, parseTuiArgs, type TuiCliOptions } from "./cli.js";

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  let options: TuiCliOptions;
  let input: ReturnType<typeof createUserInputAdapter>;
  let agent: SingleAgent;
  let logger: TuiLogger | undefined;
  let sessionStore: FileSessionStore | undefined;
  try {
    const { config } = await loadTuiConfig({ env: process.env });
    options = parseTuiArgs(argv, process.env, config);

    if (options.help) {
      process.stdout.write(`${formatTuiHelp()}\n`);
      return 0;
    }

    const [instructions, agentsInstructions, skills] = await Promise.all([
      loadSystemInstructions({
        path: options.systemPrompt,
        enabled: options.systemPromptEnabled,
      }),
      loadAgentsInstructions(),
      loadTuiSkills({ home: process.env.HOME }),
    ]);

    input = createUserInputAdapter({ allowLocalFiles: options.allowLocalFiles });
    sessionStore = new FileSessionStore({ cwd: process.cwd() });
    const modelClient = createModelClient(options, process.env, input.artifactStore);
    logger = await createTuiLogger({ protocol: options.protocol, model: options.model });
    agent = new SingleAgent({
      name: "tui-agent",
      modelClient,
      input,
      system: composeTuiSystem({ instructions, agentsInstructions, skills }),
      extensions: [logger.extension],
      sessionId: options.sessionId ?? createTuiSessionId(),
      sessionStore,
    });
    if (options.sessionId) await agent.loadSession();
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n\n${formatTuiHelp()}\n`);
    return 2;
  }

  try {
    await runTuiApp({ agent, protocol: options.protocol, model: options.model, logger, sessionStore });
    return 0;
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`);
    return 1;
  }
}

function createModelClient(
  options: TuiCliOptions,
  env: NodeJS.ProcessEnv,
  artifactStore: ReturnType<typeof createUserInputAdapter>["artifactStore"],
) {
  const httpOptions = {
    baseURL: options.baseURL,
    artifactStore,
  };
  const apiKey = options.apiKey ?? env[
    options.protocol === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
  ];

  if (options.protocol === "anthropic") {
    return new Anthropic({
      ...httpOptions,
      apiKey,
      model: options.model,
      contextWindowTokens: options.contextWindowTokens,
    });
  }
  if (options.protocol === "openai-chat") {
    return new OpenAIChat({
      ...httpOptions,
      apiKey,
      model: options.model,
      contextWindowTokens: options.contextWindowTokens,
    });
  }
  return new OpenAIResponses({
    ...httpOptions,
    apiKey,
    model: options.model,
    contextWindowTokens: options.contextWindowTokens,
  });
}

if (import.meta.url === new URL(`file://${process.argv[1] ?? ""}`).href) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
