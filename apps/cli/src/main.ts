#!/usr/bin/env node
import { homedir } from "node:os";
import { sep } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { SingleAgent } from "myloop/agent";
import { createAppAgent, loadAppSkills, type AppSessionSummary } from "@myloop/app-sdk";
import { formatCliHelp, loadAgentConfig, parseCliArgs, type CliOptions } from "./cli.js";
import { createInteractiveLoop } from "./interactive.js";
import { createSpinner } from "./spinner.js";
import { composeCliSystem, loadAgentsInstructions, loadSystemPrompt } from "./prompt.js";
import {
  printAgentPrompts,
  printSessionHistory,
  runTask,
  errorText,
} from "./run.js";
import { createCliSessionId, FileSessionStore } from "./session.js";
import { createBotHost } from "./bot/host.js";
import { DriveArbiter } from "./bot/arbiter.js";

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

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

type CliWorldShape = import("./bot/host.js").CliWorld;

export async function runBotLoop({
  agent,
  heartbeatIntervalMs,
  color,
  width,
}: {
  agent: SingleAgent;
  heartbeatIntervalMs?: number;
  color: boolean;
  width?: number;
}): Promise<number> {
  let botStopped = false;

  const redraw = (): void => {
    if (!agent.running) readline.prompt();
  };
  const pendingUnread: Array<{ text: string; at: number }> = [];
  const host = createBotHost({
    agent,
    color,
    width,
    unread: () => pendingUnread,
  });
  const arbiter = new DriveArbiter<CliWorldShape>({ drives: [...host.drives], onSkip: (reason) => {
    if (reason !== "no-drive-above-threshold") {
      process.stderr.write(`  (tick skipped: ${reason})\n`);
    }
  } });
  const offHeartbeat = agent.on("heartbeat", (event) => {
    if (event.running || agent.running) return;
    void arbiter
      .tick(event.tick, host.deps)
      .then((selection) => {
        // respond-unread 行动成功 = 未读已回复，清空积压
        if (selection?.drive.name === "respond-unread") pendingUnread.length = 0;
      })
      .then(redraw);
  });
  agent.startHeartbeat();
  process.stderr.write(
    `bot mode started (heartbeat interval: ${heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS}ms, drives: ${host.drives.map((d) => d.name).join(", ")})\n`,
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

  const wasRaw = process.stdin.isRaw ?? false;
  process.stdin.setRawMode?.(true);
  const onKeypress = (_char: string, key: { name?: string; ctrl?: boolean }): void => {
    if (key?.name === "escape" && !key.ctrl && agent.running) {
      agent.abort(new Error("interrupted"));
    }
  };
  process.stdin.on("keypress", onKeypress);

  const submit = createBotSubmit({ agent, color, width });
  readline.prompt();
  for await (const line of readline) {
    const input = String(line).trim();
    if (input === "/exit" || input === "/quit") botStopped = true;
    else if (input === "/help") {
      process.stderr.write("Commands: /exit · Esc interrupts · Ctrl+C interrupts, second Ctrl+C exits\n");
    } else if (input) {
      if (agent.running) {
        pendingUnread.push({ text: input, at: Date.now() });
        process.stderr.write("(agent busy — queued as unread)\n");
      } else {
        await submit(input);
      }
    }
    if (botStopped) break;
    readline.prompt();
  }

  process.stdin.setRawMode?.(wasRaw);
  process.stdin.off("keypress", onKeypress);

  botStopped = true;
  offHeartbeat();
  agent.stopHeartbeat();
  if (agent.running) agent.abort(new Error("bot stopped"));
  process.stderr.write("\nbot mode stopped\n");
  return 0;
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
  const loop = createInteractiveLoop({
    agent,
    submit: async (input) => {
      const spinner = createSpinner();
      let spinnerActive = false;
      const stopSpinner = (): void => {
        if (!spinnerActive) return;
        spinnerActive = false;
        spinner.stop();
      };
      const statusWithSpinner = (message: string): void => {
        spinner.suspend();
        process.stderr.write(message);
      };
      const removeEnd = agent.on("end", () => stopSpinner());
      const removeError = agent.on("error", () => stopSpinner());
      const removeToolStart = agent.on("tool_start", ({ name }) => {
        if (spinnerActive) return;
        spinnerActive = true;
        spinner.start(`${name}…`);
      });
      const removeToolEnd = agent.on("tool_end", () => stopSpinner());
      await runTask({
        agent,
        input,
        saveSession: () => agent.saveSession(),
        output: process.stdout,
        status: (message) => statusWithSpinner(`${message}\n`),
        trace: (text) => statusWithSpinner(text),
        color: isColorEnabled(process.env, process.stderr),
        width: process.stderr.columns,
      });
      stopSpinner();
      removeEnd();
      removeError();
      removeToolStart();
      removeToolEnd();
    },
    write: (text) => process.stderr.write(text),
    onIdle: () => {
      process.stderr.write("\n");
      readline.prompt();
    },
  });

  readline.on("SIGINT", () => {
    loop.interrupt();
    if (loop.isStopped()) readline.close();
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

  readline.prompt();
  const wasRaw = process.stdin.isRaw ?? false;
  process.stdin.setRawMode?.(true);
  const onKeypress = (_char: string, key: { name?: string; ctrl?: boolean }): void => {
    if (key?.name === "escape" && !key.ctrl) {
      loop.handleEscape();
    }
  };
  process.stdin.on("keypress", onKeypress);
  for await (const line of readline) {
    loop.handleLine(String(line));
    if (loop.isStopped()) break;
  }
  process.stdin.setRawMode?.(wasRaw);
  process.stdin.off("keypress", onKeypress);

  return 0;
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
