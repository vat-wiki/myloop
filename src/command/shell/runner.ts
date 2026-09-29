import os from "node:os";
import process from "node:process";
import { spawn as spawnProcess } from "node:child_process";

import { DEFAULT_HARD_TIMEOUT, DEFAULT_IDLE_TIMEOUT, KILL_GRACE_MS, cleanEnv } from "./internal.js";
import { resolveShell } from "./shell-resolver.js";

export type RunShellOptions = {
  command: string;
  cwd?: string;
  timeout?: number;
  idleTimeout?: number;
  signal?: AbortSignal;
};

export type CommandStatus =
  | "exited"
  | "timeout"
  | "aborted";

export type CommandResult = {
  status: CommandStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

const OUTPUT_LIMIT = 30_000;
const RESULT_LIMIT = 30_000;

class LimitedText {
  readonly #chunks: string[] = [];
  #length = 0;
  #truncated = false;

  add(data: string): void {
    if (this.#length >= OUTPUT_LIMIT) {
      this.#truncated = true;
      return;
    }

    const remaining = OUTPUT_LIMIT - this.#length;
    if (data.length > remaining) {
      this.#chunks.push(data.slice(0, remaining));
      this.#length = OUTPUT_LIMIT;
      this.#truncated = true;
      return;
    }

    this.#chunks.push(data);
    this.#length += data.length;
  }

  text(): string {
    return this.#truncated ? `${this.#chunks.join("")}\n...output truncated...` : this.#chunks.join("");
  }

  get truncated(): boolean {
    return this.#truncated;
  }
}

class ShellCommand {
  readonly #child: ReturnType<typeof spawnProcess>;
  readonly #signal?: AbortSignal;
  readonly #onAbort: () => void;
  readonly #stdout = new LimitedText();
  readonly #stderr = new LimitedText();
  readonly #exitPromise: Promise<void>;

  #status: CommandStatus = "exited";
  #exitCode: number | null = null;
  #exitSignal: NodeJS.Signals | null = null;
  #error?: Error;
  #exited = false;
  #hardTimeout: number;
  #idleTimeout: number;
  #hardTimer?: NodeJS.Timeout;
  #idleTimer?: NodeJS.Timeout;
  #forceKillTimer?: NodeJS.Timeout;
  #resolveExit?: () => void;

  constructor(options: RunShellOptions & { shell: { command: string; args: Array<string> } }) {
    const hardTimeout = options.timeout ?? DEFAULT_HARD_TIMEOUT;
    const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    if (!Number.isInteger(hardTimeout) || hardTimeout <= 0) throw new Error("timeout must be a positive integer");
    if (!Number.isInteger(idleTimeout) || idleTimeout <= 0) throw new Error("idleTimeout must be a positive integer");

    this.#hardTimeout = hardTimeout;
    this.#idleTimeout = idleTimeout;
    this.#signal = options.signal;
    this.#onAbort = () => void this.#terminate("aborted");

    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#child = spawnProcess(options.shell.command, options.shell.args, {
      cwd: options.cwd ?? process.cwd(),
      env: cleanEnv(),
      detached: os.platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.#child.stdout?.setEncoding("utf8");
    this.#child.stderr?.setEncoding("utf8");
    this.#child.stdout?.on("data", (data: string) => {
      this.#stdout.add(data);
      this.#armIdleTimer();
    });
    this.#child.stderr?.on("data", (data: string) => {
      this.#stderr.add(data);
      this.#armIdleTimer();
    });
    this.#child.on("error", (error) => {
      if (this.#exited) return;
      this.#error = error;
      this.#finish("exited", null, null);
    });
    this.#child.on("close", (exitCode, signal) => {
      if (this.#exited) return;
      this.#finish(this.#status, exitCode, signal ?? null);
    });

    this.#signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (this.#signal?.aborted) this.#onAbort();

    this.#hardTimer = setTimeout(() => void this.#terminate("timeout"), hardTimeout);
    this.#armIdleTimer();
  }

  async wait(): Promise<CommandResult> {
    await this.#exitPromise;
    if (this.#error) throw this.#error;
    return {
      status: this.#status,
      exitCode: this.#exitCode,
      signal: this.#exitSignal,
      stdout: this.#stdout.text(),
      stderr: this.#stderr.text(),
      stdoutTruncated: this.#stdout.truncated,
      stderrTruncated: this.#stderr.truncated,
    };
  }

  dispose(): void {
    this.#clearTimeouts();
    this.#signal?.removeEventListener("abort", this.#onAbort);
    if (!this.#exited) this.#kill("SIGKILL");
  }

  #finish(status: CommandStatus, exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#status = status;
    this.#exitCode = exitCode;
    this.#exitSignal = signal;
    this.#clearTimeouts();
    this.#signal?.removeEventListener("abort", this.#onAbort);
    this.#resolveExit?.();
  }

  #armIdleTimer(): void {
    if (this.#exited || this.#status !== "exited") return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => void this.#terminate("timeout"), this.#idleTimeout);
  }

  async #terminate(status: CommandStatus): Promise<void> {
    if (this.#exited || this.#status !== "exited") return;
    this.#status = status;
    this.#clearTimeouts();
    this.#kill("SIGTERM");
    this.#forceKillTimer = setTimeout(() => {
      if (!this.#exited) this.#kill("SIGKILL");
    }, KILL_GRACE_MS);
    await this.#exitPromise;
  }

  #kill(signal: NodeJS.Signals): void {
    if (this.#exited) return;
    if (os.platform() === "win32") {
      spawnProcess("taskkill", ["/pid", String(this.#child.pid), "/T", "/F"], { stdio: "ignore" })
        .on("error", () => this.#child.kill());
      return;
    }

    try {
      if (this.#child.pid !== undefined) process.kill(-this.#child.pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      this.#child.kill(signal);
    }
  }

  #clearTimeouts(): void {
    clearTimeout(this.#hardTimer);
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#forceKillTimer);
    this.#hardTimer = undefined;
    this.#idleTimer = undefined;
    this.#forceKillTimer = undefined;
  }
}

export async function runShell(options: RunShellOptions): Promise<string> {
  const command = new ShellCommand({ ...options, shell: await resolveShell(options.command) });
  try {
    return formatCommandResult(await command.wait());
  } finally {
    command.dispose();
  }
}

export function formatCommandResult(result: CommandResult): string {
  const header = result.status === "exited" && result.exitCode !== null
    ? `exit:${result.exitCode}`
    : result.status;
  const sections = [
    header,
    `stdout:\n${result.stdout.trimEnd() || "(empty)"}`,
    `stderr:\n${result.stderr.trimEnd() || "(empty)"}`,
  ];
  if (result.stdoutTruncated) sections.push("stdout truncated");
  if (result.stderrTruncated) sections.push("stderr truncated");
  return sections.join("\n").slice(0, RESULT_LIMIT);
}
