import os from "node:os";
import process from "node:process";
import { resolve } from "node:path";
import { spawn as spawnProcess } from "node:child_process";

import {
  DEFAULT_HARD_TIMEOUT,
  DEFAULT_IDLE_TIMEOUT,
  KILL_GRACE_MS,
  cleanEnv,
} from "./internal.js";
import { findExecutableInPath, isExecutable, resolveShell } from "./shell-resolver.js";

export type RunPtyOptions = {
  command: string;
  args?: Array<string>;
  cols?: number;
  rows?: number;
  cwd?: string;
  timeout?: number;
  idleTimeout?: number;
  signal?: AbortSignal;
};

export type TerminalStatus =
  | "running"
  | "exited"
  | "timeout"
  | "aborted"
  | "killed";

export type TerminalSnapshot = {
  status: TerminalStatus;
  busy: boolean;
  exitCode: number | null;
  signal: number | null;
  screen: string;
  tail: string[];
  bufferType: "normal" | "alternate";
  cursor: { x: number; y: number };
  cols: number;
  rows: number;
  lastOutputAt: number;
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const RESULT_LIMIT = 30_000;
export async function runPtyProcess(options: RunPtyOptions): Promise<TerminalSnapshot> {
  const helper = await findPtyHelper();
  const shell = options.args
    ? { command: options.command, args: options.args }
    : await resolveShell(options.command);
  return runPtyWithHelper(helper, { ...options, command: shell.command, args: shell.args });
}

async function findPtyHelper(): Promise<string> {
  const configured = process.env.MYCODER_PTY_BIN?.trim();
  if (!configured) {
    const candidate = await findExecutableInPath("mcpty");
    if (!candidate) throw new Error("mcpty not found in PATH; install @mycoder/pty or set MYCODER_PTY_BIN");
    return candidate;
  }

  if (configured.includes("/") || configured.includes("\\")) {
    const candidate = resolve(configured);
    if (await isExecutable(candidate)) return candidate;
    throw new Error(`MYCODER_PTY_BIN is not executable: ${configured}`);
  }

  const candidate = await findExecutableInPath(configured);
  if (!candidate) throw new Error(`MYCODER_PTY_BIN not found in PATH: ${configured}`);
  return candidate;
}

async function runPtyWithHelper(helper: string, options: RunPtyOptions): Promise<TerminalSnapshot> {
  if (options.signal?.aborted) return abortedPtySnapshot(options);

  const args = [
    "--timeout",
    String(options.timeout ?? DEFAULT_HARD_TIMEOUT),
    "--idle-timeout",
    String(options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT),
    "--cols",
    String(options.cols ?? DEFAULT_COLS),
    "--rows",
    String(options.rows ?? DEFAULT_ROWS),
    "--",
    options.command,
    ...(options.args ?? []),
  ];
  if (options.cwd) args.splice(0, 0, "--cwd", options.cwd);

  return new Promise<TerminalSnapshot>((resolvePromise, rejectPromise) => {
    const stdoutChunks: Array<string> = [];
    const stderrChunks: Array<string> = [];
    let settled = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const onAbort = () => killTree("SIGTERM");
    const child = spawnProcess(helper, args, {
      cwd: options.cwd ?? process.cwd(),
      env: cleanEnv(),
      detached: os.platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderrChunks.push(chunk));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const removeAbortListener = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      clearTimeout(forceKillTimer);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    };
    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      const pid = child.pid;
      if (os.platform() === "win32") {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") child.kill(signal);
      }
      forceKillTimer = setTimeout(() => {
        if (os.platform() === "win32") child.kill("SIGKILL");
        else {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }, KILL_GRACE_MS);
    };

    child.on("error", fail);
    child.on("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      const stderr = stderrChunks.join("").trim();
      if (aborted) {
        resolvePromise(abortedPtySnapshot(options));
        return;
      }
      if (exitCode !== 0) {
        fail(new Error(stderr || `mcpty exited with ${exitCode ?? `signal ${exitSignal ?? "unknown"}`}`));
        return;
      }

      try {
        resolvePromise(parseTerminalSnapshot(stdoutChunks.join("")));
      } catch (error) {
        fail(error);
      }
    });

    if (options.signal?.aborted) {
      aborted = true;
      killTree("SIGTERM");
    }
  });
}

function abortedPtySnapshot(options: RunPtyOptions): TerminalSnapshot {
  return {
    status: "aborted",
    busy: false,
    exitCode: null,
    signal: null,
    screen: "",
    tail: [],
    bufferType: "normal",
    cursor: { x: 0, y: 0 },
    cols: options.cols ?? DEFAULT_COLS,
    rows: options.rows ?? DEFAULT_ROWS,
    lastOutputAt: Date.now(),
  };
}

function parseTerminalSnapshot(output: string): TerminalSnapshot {
  const firstNewline = output.indexOf("\n");
  const json = firstNewline === -1 ? output : output.slice(0, firstNewline);
  const value = JSON.parse(json) as unknown;
  if (!isTerminalSnapshot(value)) throw new Error("mcpty returned an invalid terminal snapshot");
  return value;
}

function isTerminalSnapshot(value: unknown): value is TerminalSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Partial<TerminalSnapshot>;
  return typeof snapshot.status === "string"
    && typeof snapshot.busy === "boolean"
    && typeof snapshot.screen === "string"
    && Array.isArray(snapshot.tail)
    && typeof snapshot.bufferType === "string"
    && typeof snapshot.cursor?.x === "number"
    && typeof snapshot.cursor?.y === "number"
    && typeof snapshot.cols === "number"
    && typeof snapshot.rows === "number"
    && typeof snapshot.lastOutputAt === "number";
}

export async function runPty(options: RunPtyOptions): Promise<string> {
  return formatTerminalSnapshot(await runPtyProcess(options));
}


export function formatTerminalSnapshot(snapshot: TerminalSnapshot): string {
  const header = snapshot.status === "exited" && snapshot.exitCode !== null
    ? `exit:${snapshot.exitCode}`
    : snapshot.status;
  return [header, ...snapshot.tail].join("\n").slice(0, RESULT_LIMIT);
}
