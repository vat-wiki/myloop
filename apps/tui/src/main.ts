#!/usr/bin/env -S node --experimental-ffi
import { createUserInputAdapter, SingleAgent } from "mycoder/agent";
import { Anthropic } from "mycoder/clients/anthropic";
import { OpenAIChat } from "mycoder/clients/openai-chat";
import { OpenAIResponses } from "mycoder/clients/openai-responses";
import { runTuiApp } from "./app.js";
import { createTuiLogger } from "./logging.js";
import type { TuiLogger } from "./logging.js";
import { composeTuiSystem, loadCoreInstructions, loadTuiSkills } from "./system-prompt.js";
import { loadTuiConfig } from "./config.js";
import { errorText } from "./state.js";
import { formatTuiHelp, parseTuiArgs, type TuiCliOptions } from "./cli.js";

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  let options: TuiCliOptions;
  let input: ReturnType<typeof createUserInputAdapter>;
  let agent: SingleAgent;
  let logger: TuiLogger | undefined;
  try {
    const { config } = await loadTuiConfig({ env: process.env });
    const [instructions, skills] = await Promise.all([
      loadCoreInstructions(),
      loadTuiSkills({ home: process.env.HOME }),
    ]);
    options = parseTuiArgs(argv, process.env, config);

    if (options.help) {
      process.stdout.write(`${formatTuiHelp()}\n`);
      return 0;
    }

    input = createUserInputAdapter({ allowLocalFiles: options.allowLocalFiles });
    const modelClient = createModelClient(options, process.env, input.artifactStore);
    const logger = await createTuiLogger({ protocol: options.protocol, model: options.model });
    agent = new SingleAgent({
      name: "tui-agent",
      modelClient,
      input,
      system: composeTuiSystem({ instructions, skills }),
      extensions: [logger.extension],
    });
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n\n${formatTuiHelp()}\n`);
    return 2;
  }

  try {
    await runTuiApp({ agent, protocol: options.protocol, model: options.model, logger });
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
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    retry: { attempts: options.retryAttempts },
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
    });
  }
  if (options.protocol === "openai-chat") {
    return new OpenAIChat({
      ...httpOptions,
      apiKey,
      model: options.model,
    });
  }
  return new OpenAIResponses({
    ...httpOptions,
    apiKey,
    model: options.model,
  });
}

if (import.meta.url === new URL(`file://${process.argv[1] ?? ""}`).href) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
