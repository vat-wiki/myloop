#!/usr/bin/env node
import { homedir } from "node:os";
import { sep } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { SingleAgent } from "myloop/agent";
import { createAppAgent, loadAppSkills, type AppSessionSummary } from "@myloop/app-sdk";
import { formatCliHelp, loadAgentConfig, parseCliArgs, type CliOptions } from "./cli.js";
import { composeCliSystem, loadAgentsInstructions, loadSystemPrompt } from "./prompt.js";
import {
  printAgentPrompts,
  printSessionHistory,
  runTask,
  errorText,
} from "./run.js";
import { createCliSessionId, FileSessionStore } from "./session.js";

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

  if (options.listSessions) {
    const sessions = await new FileSessionStore({ cwd: process.cwd() }).listSessions();
    process.stdout.write(formatSessionList(sessions));
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
    const [systemPrompt, agentsInstructions, skills] = await Promise.all([
      loadSystemPrompt({
        path: options.systemPrompt,
        enabled: options.systemPromptEnabled,
      }),
      options.systemPromptEnabled ? loadAgentsInstructions() : Promise.resolve(""),
      options.systemPromptEnabled
        ? loadAppSkills({ cwd: process.cwd(), home: process.env.HOME })
        : Promise.resolve([]),
    ]);
    const sessionStore = new FileSessionStore({ cwd: process.cwd() });
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
      heartbeat: {
        intervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        mode: "always",
      },
      system: composeCliSystem({ systemPrompt, agentsInstructions, skills }),
      logger: options.log,
      sessionId: options.sessionId ?? createCliSessionId(),
      sessionStore,
      cwd: process.cwd(),
    });
    if (options.sessionId) {
      const loaded = await agent.loadSession();
      if (!loaded) throw new Error(`session not found: ${options.sessionId}`);
    } else if (options.continueLastSession) {
      const latestSessionId = await sessionStore.latest();
      if (!latestSessionId) throw new Error("no previous session found");
      await agent.loadSession(latestSessionId);
    }
    const printPrompts = () => {
      if (!options.printPrompts) return;
      printAgentPrompts({
        agent,
        status: (message) => process.stderr.write(`${message}\n`),
        trace: (text) => process.stderr.write(text),
        color: isColorEnabled(process.env, process.stderr),
        width: process.stderr.columns,
      });
    };
    printPrompts();
    printSessionHistory({
      messages: agent.messages,
      output: process.stdout,
      status: (message) => process.stderr.write(`${message}\n`),
      trace: (text) => process.stderr.write(text),
      color: isColorEnabled(process.env, process.stderr),
      width: process.stderr.columns,
    });

    if (options.bot) {
      return await runBotLoop({
        agent,
        botPrompt: options.botPrompt,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        color: isColorEnabled(process.env, process.stderr),
        width: process.stderr.columns,
      });
    }

    if (input !== undefined) {
      return await runTask({
        agent,
        input,
        saveSession: () => agent.saveSession(),
        output: process.stdout,
        status: (message) => process.stderr.write(`${message}\n`),
        trace: (text) => process.stderr.write(text),
        color: isColorEnabled(process.env, process.stderr),
        printPrompts: false,
      });
    }

    return await runInteractive({ agent, printPrompts: false });
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`);
    return 1;
  }
}

const BOT_PROMPT = "Heartbeat: check in briefly and keep working on what remains.";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

export async function runBotLoop({
  agent,
  botPrompt,
  heartbeatIntervalMs,
  color,
  width,
}: {
  agent: SingleAgent;
  botPrompt?: string;
  heartbeatIntervalMs?: number;
  color: boolean;
  width?: number;
}): Promise<number> {
  const runningBotPrompt = botPrompt ?? BOT_PROMPT;
  let botStopped = false;

  const redraw = (): void => {
    if (!agent.running) readline.prompt();
  };
  const offHeartbeat = createHeartbeatDriver({
    agent,
    botPrompt: runningBotPrompt,
    color,
    width,
    onDone: redraw,
  });
  agent.startHeartbeat();
  process.stderr.write(
    `bot mode started (heartbeat interval: ${heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS}ms)\n`,
  );

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: formatInteractivePrompt(process.cwd()),
  });

  readline.on("SIGINT", () => {
    if (agent.running) {
      agent.abort(new Error("interrupted"));
      return;
    }
    botStopped = true;
    readline.close();
  });

  const submit = createBotSubmit({ agent, color, width });
  readline.prompt();
  for await (const line of readline) {
    const input = String(line).trim();
    if (input === "/exit" || input === "/quit") botStopped = true;
    else if (input === "/help") {
      process.stderr.write("Commands: /exit · Ctrl+C interrupts, second Ctrl+C exits\n");
    } else if (input) await submit(input);
    if (botStopped) break;
    readline.prompt();
  }

  botStopped = true;
  offHeartbeat();
  agent.stopHeartbeat();
  if (agent.running) agent.abort(new Error("bot stopped"));
  process.stderr.write("\nbot mode stopped\n");
  return 0;
}

export function createHeartbeatDriver({
  agent,
  botPrompt,
  color,
  width,
  onDone,
}: {
  agent: SingleAgent;
  botPrompt: string;
  color: boolean;
  width?: number;
  onDone?: () => void;
}): () => void {
  let pending = false;
  return agent.on("heartbeat", (event) => {
    if (event.running || pending || agent.running) return;
    pending = true;
    const currentTick = event.tick;
    process.stderr.write(`\n♥ tick ${currentTick}\n`);
    runTask({
      agent,
      input: `[heartbeat #${currentTick}] ${botPrompt}`,
      saveSession: () => agent.saveSession(),
      output: process.stdout,
      status: (message) => process.stderr.write(`${message}\n`),
      trace: (text) => process.stderr.write(text),
      color,
      width,
    })
      .catch(() => {})
      .finally(() => {
        pending = false;
        onDone?.();
      });
  });
}

function createBotSubmit({
  agent,
  color,
  width,
}: {
  agent: SingleAgent;
  color: boolean;
  width?: number;
}): (input: string) => Promise<void> {
  return async (input) => {
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
      color,
      width,
    });
  };
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

function formatSessionList(sessions: ReadonlyArray<AppSessionSummary>): string {
  if (sessions.length === 0) return "No saved sessions\n";
  const sessionIdWidth = Math.max("SESSION ID".length, ...sessions.map((session) => session.sessionId.length));
  const createdAtWidth = Math.max("CREATED AT".length, ...sessions.map((session) => session.createdAt.length));
  return [
    `${"SESSION ID".padEnd(sessionIdWidth)}  ${"CREATED AT".padEnd(createdAtWidth)}  MESSAGES`,
    ...sessions.map((session) => [
      session.sessionId.padEnd(sessionIdWidth),
      session.createdAt.padEnd(createdAtWidth),
      String(session.messageCount),
    ].join("  ")),
    "",
  ].join("\n");
}

function isColorEnabled(env: NodeJS.ProcessEnv, output: NodeJS.WriteStream): boolean {
  return !env.NO_COLOR && Boolean(output.isTTY);
}

if (import.meta.url === new URL(`file://${process.argv[1] ?? ""}`).href) {
  process.exitCode = await main();
}
