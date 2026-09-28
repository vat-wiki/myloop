#!/usr/bin/env node
import { homedir } from "node:os";
import { sep } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { SingleAgent, createUserInputAdapter } from "mycoder/agent";
import { Anthropic } from "mycoder/clients/anthropic";
import { OpenAIChat } from "mycoder/clients/openai-chat";
import { OpenAIResponses } from "mycoder/clients/openai-responses";
import { createAgentLogger } from "mycoder/runtime";
import type { ModelClient } from "mycoder/runtime";
import { formatCliHelp, loadAgentConfig, parseCliArgs, type CliOptions } from "./cli.js";
import { composeCliSystem, loadAgentsInstructions, loadSystemPrompt } from "./prompt.js";
import { runTask, errorText } from "./run.js";
import { createCliSessionId, FileSessionStore } from "./session.js";

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    const { config } = await loadAgentConfig({ env: process.env });
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
      options.systemPromptEnabled ? loadSystemPrompt(options.systemPrompt) : Promise.resolve(""),
      options.systemPromptEnabled ? loadAgentsInstructions() : Promise.resolve(""),
    ]);
    const inputAdapter = createUserInputAdapter({ allowLocalFiles: options.allowLocalFiles });
    const sessionStore = new FileSessionStore({ cwd: process.cwd() });
    const logger = options.log
      ? await createAgentLogger({
        directory: ".agents/mycoder/logs",
        metadata: { protocol: options.protocol, model: options.model },
      })
      : undefined;
    const modelClient = createModelClient(options, process.env, inputAdapter.artifactStore);
    const agent = new SingleAgent({
      name: "cli-agent",
      modelClient,
      input: inputAdapter,
      system: composeCliSystem({ systemPrompt, agentsInstructions }),
      extensions: logger ? [logger.extension] : [],
      sessionId: options.sessionId ?? createCliSessionId(),
      sessionStore,
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
      });
    }

    return await runInteractive({ agent });
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`);
    return 1;
  }
}

async function runInteractive({ agent }: { agent: SingleAgent }): Promise<number> {
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

  const submit = async (rawInput: string): Promise<void> => {
    const input = rawInput.trim();
    if (!input) return;
    if (input === "/exit" || input === "/quit") {
      closed = true;
      readline.close();
      return;
    }
    if (input === "/reset") {
      if (agent.running) {
        process.stderr.write("agent is running\n");
        return;
      }
      agent.reset();
      await agent.saveSession();
      process.stderr.write("session reset\n");
      return;
    }
    if (input === "/help") {
      process.stderr.write("Commands: /reset, /exit · Ctrl+C interrupts, second Ctrl+C exits\n");
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

function createModelClient(
  options: CliOptions,
  env: NodeJS.ProcessEnv,
  artifactStore: ReturnType<typeof createUserInputAdapter>["artifactStore"],
): ModelClient {
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
      maxTokens: options.maxTokens,
      contextWindowTokens: options.contextWindowTokens,
      thinkingBudgetTokens: options.thinking ? options.thinkingBudgetTokens ?? 4_096 : undefined,
    });
  }
  if (options.protocol === "openai-chat") {
    return new OpenAIChat({
      ...httpOptions,
      apiKey,
      model: options.model,
      maxTokens: options.maxTokens,
      contextWindowTokens: options.contextWindowTokens,
      reasoning: options.thinking ? { effort: "medium", summary: "auto" } : undefined,
    });
  }
  return new OpenAIResponses({
    ...httpOptions,
      apiKey,
      model: options.model,
      maxTokens: options.maxTokens,
      contextWindowTokens: options.contextWindowTokens,
  });
}

if (import.meta.url === new URL(`file://${process.argv[1] ?? ""}`).href) {
  process.exitCode = await main();
}
