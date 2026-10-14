#!/usr/bin/env node
import process from "node:process";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline/promises";
import type { SingleAgent } from "myloop/agent";
import { createAppAgent, loadAppSkills, type AppSessionSummary } from "@myloop/app-sdk";
import { formatCliHelp, loadAgentConfig, parseCliArgs, type CliOptions } from "./cli.js";
import { formatStartupStatus } from "./startup.js";
import { createInteractiveLoop } from "./interactive.js";
import { createLineOutput, createReadlineSpinner, formatInteractivePrompt } from "./tui.js";
import { composeCliSystem, loadAgentsInstructions, loadSystemPrompt } from "./prompt.js";
import {
  formatEventDivider,
  printAgentPrompts,
  printSessionHistory,
  runTask,
  errorText,
} from "./run.js";
import { createCliSessionId, FileSessionStore } from "./session.js";
import { createBotHost } from "./bot/host.js";
import type { UnreadMessage } from "./bot/drives.js";
import { loadBotModules } from "./bot/modules.js";
import { DriveArbiter } from "./bot/arbiter.js";
import { Memory, renderMemorySection } from "./memory/memory.js";

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  let sources: import("myloop/config").ConfigSources = {};
  try {
    const configPath = argv.includes("--config")
      ? argv[argv.indexOf("--config") + 1]
      : undefined;
    const loaded = await loadAgentConfig({ env: process.env, configPath });
    const config = loaded.config;
    sources = loaded.sources;
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

  const sessionId = options.sessionId ?? createCliSessionId();
  process.stderr.write(`${formatStartupStatus({ options, sources, sessionId })}\n`);

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
    const memory = new Memory({ cwd: process.cwd(), home: process.env.HOME });
    memory.ensureScaffold();
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
      thinkingBudgetTokens: options.thinkingBudgetTokens,
      reasoningEffort: options.reasoningEffort,
      reasoningSummary: options.reasoningSummary,
      heartbeat: {
        intervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        mode: "always",
      },
      system: composeCliSystem({
        systemPrompt,
        agentsInstructions,
        skills,
        memorySection: renderMemorySection({ dir: memory.dir, index: memory.readIndex() }),
      }),
      logger: options.log,
      sessionId,
      sessionStore,
      cwd: process.cwd(),
    });
    if (options.bot) {
      // 压缩摘要不丢：进记忆 pending，由 memory-grooming 驱力消化成 wiki 条目
      agent.on("context_compacted", (event) => {
        if (event.summary.trim()) memory.appendPending(event.summary);
      });
    }
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
        sensorPaths: options.botSensors,
        drivePaths: options.botDrives,
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

/** 粘贴结束后 readline 缓冲里残留的未换行尾部：吸出并交给 paste 批次 */
function drainReadlineTail(readline: Interface): string {
  const tail = readline.line;
  for (let i = 0; i < tail.length; i += 1) readline.write(null, { name: "backspace" });
  return tail;
}

export async function runBotLoop({
  agent,
  heartbeatIntervalMs,
  sensorPaths,
  drivePaths,
  color,
  width,
}: {
  agent: SingleAgent;
  heartbeatIntervalMs?: number;
  sensorPaths?: ReadonlyArray<string>;
  drivePaths?: ReadonlyArray<string>;
  color: boolean;
  width?: number;
}): Promise<number> {
  let botStopped = false;
  const out = createLineOutput(process.stdout);
  const { sensors: extensionSensors, drives: extensionDrives } = await loadBotModules({
    sensorPaths,
    drivePaths,
    cwd: process.cwd(),
  });

  const redraw = (): void => {
    if (!agent.running) readline.prompt();
  };
  const pendingUnread: UnreadMessage[] = [];
  const memory = new Memory({ cwd: process.cwd(), home: process.env.HOME });
  memory.ensureScaffold();
  const host = createBotHost({
    agent,
    color,
    width,
    output: out,
    unread: () => pendingUnread,
    memorySenses: () => memory.senses(),
    extensionSensors,
    extensionDrives,
  });
  const arbiter = new DriveArbiter<CliWorldShape>({
    drives: [...host.drives],
    onSkip: (reason) => {
      out.write(`  (tick skipped: ${reason})`);
    },
    onEvaluated: (evaluations) => {
      out.write(
        `  (drives: ${evaluations.map((e) => `${e.drive.name}=${e.outcome ? e.outcome.pressure.toFixed(2) : "idle"}${e.passed ? "*" : ""}`).join(" ")})`,
      );
    },
  });
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
  out.write(
    `bot mode started (heartbeat interval: ${heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS}ms, drives: ${host.drives.map((d) => d.name).join(", ")})\n`,
  );

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: formatInteractivePrompt(process.cwd()),
    completer: (line: string): [Array<string>, string] => {
      const commands = ["/cancel", "/exit", "/help", "/quit"];
      const completions = line.startsWith("/") ? commands.filter((command) => command.startsWith(line)) : [];
      return [completions, line];
    },
    historySize: 1_000,
  });

  readline.on("SIGINT", () => {
    if (agent.running) {
      agent.abort(new Error("interrupted"));
      return;
    }
    botStopped = true;
    readline.close();
  });

  out.attach(readline);

  const wasRaw = process.stdin.isRaw ?? false;
  process.stdin.setRawMode?.(true);
  const onKeypress = (_char: string, key: { name?: string; ctrl?: boolean }): void => {
    if (key?.name === "paste-start") {
      lineBatch = [];
      return;
    }
    if (key?.name === "paste-end") {
      // 无结尾换行的最后一行留在 readline 缓冲里，paste-end 时吸出并入批次
      lineBatch.push(drainReadlineTail(readline));
      return;
    }
    if (key?.name === "escape" && !key.ctrl && agent.running) {
      agent.abort(new Error("interrupted"));
    }
  };
  process.stdin.on("keypress", onKeypress);

  const submit = createBotSubmit({ agent, color, width, out });
  let lineBatch: Array<string> = [];
  let lineBatchFlushScheduled = false;
  readline.prompt();
  // line 监听必须同步（同交互模式）：否则 paste-end 的吸尾会先于 line 事件入批，顺序颠倒
  readline.on("line", (line) => {
    // 粘贴的多行文本会在同一次 flush 里连续到达：合批为一条消息，避免逐行拆散
    lineBatch.push(String(line));
    if (lineBatchFlushScheduled) return;
    lineBatchFlushScheduled = true;
    setImmediate(() => {
      lineBatchFlushScheduled = false;
      const input = lineBatch.map((l) => l.replace(/\r$/, "")).join("\n").trim();
      lineBatch = [];
      if (input === "/exit" || input === "/quit") botStopped = true;
      else if (input === "/help") {
        out.write("Commands: /exit · Esc interrupts · Ctrl+C interrupts, second Ctrl+C exits");
      } else if (input) {
        if (agent.running) {
          pendingUnread.push({ text: input, at: Date.now(), source: "user" });
          // 排队回显带消息预览：只确认不回显内容会让用户以为输入丢了
          const firstLine = input.split("\n")[0] ?? "";
          const preview = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
          const extra = input.includes("\n") ? ` (+${input.split("\n").length - 1} lines)` : "";
          out.write(`(agent busy — queued as unread: ${preview}${extra})`);
        } else {
          void submit(input)
            .catch(() => {})
            .finally(() => {
              if (!botStopped && !agent.running) readline.prompt();
            });
        }
      }
      if (botStopped) readline.close();
      else readline.prompt();
    });
  });
  await once(readline, "close");

  process.stdin.setRawMode?.(wasRaw);
  process.stdin.off("keypress", onKeypress);

  botStopped = true;
  offHeartbeat();
  agent.stopHeartbeat();
  if (agent.running) agent.abort(new Error("bot stopped"));
  out.detach();
  out.write("\nbot mode stopped\n");
  return 0;
}

function createBotSubmit({
  agent,
  color,
  width,
  out,
}: {
  agent: SingleAgent;
  color: boolean;
  width?: number;
  out: ReturnType<typeof createLineOutput>;
}): (input: string) => Promise<void> {
  return async (input) => {
    if (agent.running) {
      out.write("agent is running");
      return;
    }
    const divider = color
      ? `\x1b[2m${formatEventDivider("user", {}, width)}\x1b[0m`
      : formatEventDivider("user", {}, width);
    out.write(`${divider}\n${input}\n`);
    await runTask({
      agent,
      input,
      saveSession: () => agent.saveSession(),
      output: out,
      status: (message) => out.write(message),
      trace: (text) => out.write(text),
      color,
      width,
    });
  };
}


async function runInteractive({
  agent,
  printPrompts,
}: { agent: SingleAgent; printPrompts: boolean }): Promise<number> {
  const out = createLineOutput(process.stdout);
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: formatInteractivePrompt(process.cwd()),
  });
  const loop = createInteractiveLoop({
    agent,
    submit: async (input) => {
      const color = isColorEnabled(process.env, process.stderr);
      const width = process.stderr.columns;
      const divider = color
        ? `\x1b[2m${formatEventDivider("user", {}, width)}\x1b[0m`
        : formatEventDivider("user", {}, width);
      out.write(`${divider}\n${input}\n`);
      const spinner = createReadlineSpinner(out);
      const stopSpinner = (): void => {
        if (!spinner.active) return;
        spinner.stop();
      };
      const statusWithSpinner = (message: string): void => {
        spinner.suspend();
        out.write(message);
      };
      const removeEnd = agent.on("end", () => stopSpinner());
      const removeError = agent.on("error", () => stopSpinner());
      const removeToolStart = agent.on("tool_start", ({ name }) => {
        spinner.start(`${name}…`);
      });
      const removeToolEnd = agent.on("tool_end", () => stopSpinner());
      await runTask({
        agent,
        input,
        saveSession: () => agent.saveSession(),
        output: out,
        status: (message) => statusWithSpinner(`${message}\n`),
        trace: (text) => statusWithSpinner(text),
        color,
        width,
      });
      stopSpinner();
      removeEnd();
      removeError();
      removeToolStart();
      removeToolEnd();
    },
    write: (text) => out.write(text),
    onPromptChange: (continuing) => {
      readline.setPrompt(continuing ? "… ❯ " : formatInteractivePrompt(process.cwd()));
      readline.prompt(true);
    },
    onIdle: () => {
      readline.prompt(true);
    },
  });
  out.attach(readline);

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
    if (key?.name === "paste-start") {
      loop.handlePasteStart();
      return;
    }
    if (key?.name === "paste-end") {
      loop.handlePasteEnd(drainReadlineTail(readline));
      return;
    }
    if (key?.name === "escape" && !key.ctrl) {
      loop.handleEscape();
    }
  };
  process.stdin.on("keypress", onKeypress);
  // line 监听必须同步：粘贴 chunk 内 keypress(paste) 与 line 事件同步到达，
  // for-await 会把处理推迟到微任务，导致 paste-end 先于缓冲行执行
  readline.on("line", (line) => {
    loop.handleLine(String(line));
    if (loop.isStopped()) readline.close();
  });
  await once(readline, "close");
  out.detach();
  process.stdin.setRawMode?.(wasRaw);
  process.stdin.off("keypress", onKeypress);

  return 0;
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
