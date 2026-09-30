#!/usr/bin/env node
import { homedir } from "node:os";
import { sep } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { SingleAgent } from "myloop/agent";
import { createAppAgent } from "@myloop/app-sdk";
import { formatCliHelp, loadAgentConfig, parseCliArgs, type CliOptions } from "./cli.js";
import { composeCliSystem, loadAgentsInstructions, loadSystemPrompt } from "./prompt.js";
import { printAgentPrompts, runTask, errorText } from "./run.js";
import { createCliSessionId } from "./session.js";

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    const configPath = argv.includes("--config")
      ? argv[argv.indexOf("--config") + 1]
      : undefined;
    const { config } = await loadAgentConfig({ env: process.env, configPath });
    options = parseCliArgs(argv, process.env, config);
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n\n${formatCliHelp()}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${formatCliHelp()}\n`);
    return 0;
  }

  let input = options.prompt;
  if (input === undefined && !process.stdin.isTTY) {
    const chunks: Array<string> = [];
    for await (const chunk of process.stdin) {
      chunks.push(String(chunk));
    }
    input = chunks.join("").trim() || undefined;
  }

  if (input === undefined && !process.stdin.isTTY) {
    process.stderr.write("task is required\n");
    return 2;
  }

  try {
    const [systemPrompt, agentsInstructions] = await Promise.all([
      loadSystemPrompt({
        path: options.systemPrompt,
        enabled: options.systemPromptEnabled,
      }),
      options.systemPromptEnabled ? loadAgentsInstructions() : Promise.resolve(""),
    ]);
    const { agent } = await createAppAgent({
      name: "cli-agent",
      protocol: options.protocol,
      model: options.model,
      apiKey: options.apiKey,
      env: process.env,
      baseURL: options.baseURL,
      compactionThreshold: options.compactionThreshold,
      thinking: options.thinking,
      allowLocalFiles: options.allowLocalFiles,
      system: composeCliSystem({ systemPrompt, agentsInstructions }),
      logger: options.log,
      sessionId: options.sessionId ?? createCliSessionId(),
      cwd: process.cwd(),
    });
    if (options.sessionId) await agent.loadSession();

    if (input !== undefined) {
      return await runTask({
        agent,
        input,
        saveSession: () => agent.saveSession(),
        output: process.stdout,
        status: (message) => process.stderr.write(`${message}\n`),
        trace: (text) => process.stderr.write(text),
        color: isColorEnabled(process.env, process.stderr),
        printPrompts: options.printPrompts,
      });
    }

    return await runInteractive({ agent, printPrompts: options.printPrompts });
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`);
    return 1;
  }
}

async function runInteractive({
  agent,
  printPrompts,
}: { agent: SingleAgent; printPrompts: boolean }): Promise<number> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: formatInteractivePrompt(process.cwd()),
  });
  let exitCode = 0;
  let closed = false;

  readline.on("SIGINT", () => {
    if (agent.running) {
      agent.abort(new Error("interrupted"));
      return;
    }
    closed = true;
    readline.close();
  });

  if (printPrompts) {
    printAgentPrompts({
      agent,
      status: (message) => process.stderr.write(`${message}\n`),
      trace: (text) => process.stderr.write(text),
      color: isColorEnabled(process.env, process.stderr),
      width: process.stderr.columns,
    });
  }

  const submit = async (rawInput: string): Promise<void> => {
    const input = rawInput.trim();
    if (!input) return;
    if (input === "/exit" || input === "/quit") {
      closed = true;
      readline.close();
      return;
    }
    if (input === "/help") {
      process.stderr.write("Commands: /exit · Ctrl+C interrupts, second Ctrl+C exits\n");
      return;
    }
    if (agent.running) {
      process.stderr.write("agent is running\n");
      return;
    }

    await runTask({
      agent,
      input,
      saveSession: () => agent.saveSession(),
      output: process.stdout,
      status: (message) => process.stderr.write(`${message}\n`),
      trace: (text) => process.stderr.write(text),
      color: isColorEnabled(process.env, process.stderr),
      width: process.stderr.columns,
    });
  };

  readline.prompt();
  for await (const line of readline) {
    await submit(String(line));
    if (!closed) {
      process.stderr.write("\n");
      readline.prompt();
    }
  }

  return exitCode;
}

export function formatInteractivePrompt(cwd: string, home = homedir()): string {
  const directory = cwd === home
    ? "~"
    : cwd.startsWith(`${home}${sep}`)
      ? `~${cwd.slice(home.length)}`
      : cwd;
  return `${directory} ❯ `;
}

function isColorEnabled(env: NodeJS.ProcessEnv, output: NodeJS.WriteStream): boolean {
  return !env.NO_COLOR && Boolean(output.isTTY);
}

if (import.meta.url === new URL(`file://${process.argv[1] ?? ""}`).href) {
  process.exitCode = await main();
}
