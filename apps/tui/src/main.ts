#!/usr/bin/env -S node --experimental-ffi
import type { SingleAgent } from "mycoder/agent";
import type { RuntimeSessionStore } from "mycoder/runtime";
import { createAppAgent } from "@mycoder/app-sdk";
import { runTuiApp } from "./app.js";
import type { TuiLogger } from "./logging.js";
import {
  composeTuiSystem,
  loadAgentsInstructions,
  loadSystemInstructions,
  loadTuiSkills,
} from "./system-prompt.js";
import { loadTuiConfig } from "./config.js";
import { createTuiSessionId } from "./session.js";
import { errorText } from "./state.js";
import { formatTuiHelp, parseTuiArgs, type TuiCliOptions } from "./cli.js";

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  let options: TuiCliOptions;
  let agent: SingleAgent;
  let logger: TuiLogger | undefined;
  let sessionStore: RuntimeSessionStore | undefined;
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

    ({ agent, logger, sessionStore } = await createAppAgent({
      name: "tui-agent",
      protocol: options.protocol,
      model: options.model,
      apiKey: options.apiKey,
      env: process.env,
      baseURL: options.baseURL,
      contextWindowTokens: options.contextWindowTokens,
      allowLocalFiles: options.allowLocalFiles,
      system: composeTuiSystem({ instructions, agentsInstructions, skills }),
      logger: true,
      sessionId: options.sessionId ?? createTuiSessionId(),
      cwd: process.cwd(),
    }));
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

if (import.meta.url === new URL(`file://${process.argv[1] ?? ""}`).href) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
