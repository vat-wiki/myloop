import os from "node:os";
import process from "node:process";
import { basename, delimiter as pathDelimiter, join } from "node:path";
import { access, constants } from "node:fs/promises";
import { spawn as spawnProcess } from "node:child_process";
import type { IPty } from "node-pty";
import type { ToolDefinition } from "./messages.js";

type PtyModule = typeof import("node-pty");
type HeadlessTerminalModule = typeof import("@xterm/headless");
type HeadlessTerminal = InstanceType<HeadlessTerminalModule["Terminal"]>;

type ResolvedShell = {
  command: string;
  args: Array<string>;
};

let spawn: PtyModule["spawn"];
let Terminal: HeadlessTerminalModule["Terminal"];

export type RunPtyOptions = {
  command: string;
  cwd?: string;
  timeout?: number;
  idleTimeout?: number;
  signal?: AbortSignal;
};

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
const DEFAULT_SCROLLBACK = 2_000;
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_HARD_TIMEOUT = 120_000;
const DEFAULT_IDLE_TIMEOUT = 30_000;
const KILL_GRACE_MS = 2_000;
const RESULT_LIMIT = 30_000;
const OUTPUT_LIMIT = 30_000;
const MULTIPLEXER = os.platform() === "win32" ? "psmux" : "tmux";

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
    const text = this.#chunks.join("");
    return this.#truncated ? `${text}\n...output truncated...` : text;
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

  constructor(options: RunShellOptions & { shell: ResolvedShell }) {
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

class PtySession {

  readonly #pty: IPty;
  readonly #terminal: HeadlessTerminal;
  readonly #signal?: AbortSignal;
  readonly #onAbort: () => void;
  readonly #hardTimeout: number;
  readonly #idleTimeout: number;
  readonly #exitPromise: Promise<void>;

  #pendingWrite = Promise.resolve();
  #status: TerminalStatus = "running";
  #ptyExited = false;
  #exitCode: number | null = null;
  #exitSignal: number | null = null;
  #lastOutputAt = Date.now();
  #hardTimer?: NodeJS.Timeout;
  #idleTimer?: NodeJS.Timeout;
  #forceKillTimer?: NodeJS.Timeout;
  #resolveExit?: () => void;

  constructor(options: RunPtyOptions & { shell: ResolvedShell }) {
    const cols = DEFAULT_COLS;
    const rows = DEFAULT_ROWS;
    const hardTimeout = options.timeout ?? DEFAULT_HARD_TIMEOUT;
    const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    if (!Number.isInteger(hardTimeout) || hardTimeout <= 0) throw new Error("timeout must be a positive integer");
    if (!Number.isInteger(idleTimeout) || idleTimeout <= 0) throw new Error("idleTimeout must be a positive integer");

    this.#hardTimeout = hardTimeout;
    this.#idleTimeout = idleTimeout;
    this.#signal = options.signal;
    this.#onAbort = () => void this.#terminate("aborted");

    this.#terminal = new Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: DEFAULT_SCROLLBACK,
    });
    this.#pty = spawn(options.shell.command, options.shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd ?? process.cwd(),
      env: cleanEnv(),
    });

    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#pty.onData((data) => this.#handleData(data));
    this.#pty.onExit(({ exitCode, signal }) => {
      this.#ptyExited = true;
      this.#exitCode = exitCode;
      this.#exitSignal = signal ?? null;
      if (this.#status === "running") this.#status = "exited";
      this.#clearTimeouts();
      this.#signal?.removeEventListener("abort", this.#onAbort);
      this.#resolveExit?.();
    });
    this.#signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (this.#signal?.aborted) this.#onAbort();

    this.#hardTimer = setTimeout(() => void this.#terminate("timeout"), hardTimeout);
    this.#armIdleTimer();
  }

  async wait(): Promise<TerminalSnapshot> {
    await this.#exitPromise;
    await this.#pendingWrite;
    return this.#snapshot();
  }

  dispose(): void {
    this.#clearTimeouts();
    this.#signal?.removeEventListener("abort", this.#onAbort);
    if (!this.#ptyExited) this.#killTree("SIGKILL");
    this.#terminal.dispose();
  }

  #handleData(data: string): void {
    if (this.#ptyExited) return;
    this.#lastOutputAt = Date.now();
    this.#armIdleTimer();
    this.#pendingWrite = this.#pendingWrite.then(
      () => new Promise<void>((resolve) => this.#terminal.write(data, resolve)),
    );
  }

  #armIdleTimer(): void {
    if (this.#ptyExited || this.#status !== "running") return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(
      () => void this.#terminate("timeout"),
      this.#idleTimeout,
    );
  }

  async #terminate(status: TerminalStatus): Promise<void> {
    if (this.#status !== "running" || this.#ptyExited) return;
    this.#status = status;
    this.#clearTimeouts();
    this.#killTree("SIGTERM");
    this.#forceKillTimer = setTimeout(() => {
      if (!this.#ptyExited) this.#killTree("SIGKILL");
    }, KILL_GRACE_MS);
    await this.#exitPromise;
  }

  #killTree(signal: NodeJS.Signals): void {
    if (this.#ptyExited) return;
    if (process.platform === "win32") {
      this.#pty.kill();
      return;
    }

    try {
      process.kill(-this.#pty.pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      this.#pty.kill(signal);
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

  async #snapshot(): Promise<TerminalSnapshot> {
    const buffer = this.#terminal.buffer.active;
    const logicalLines: string[] = [];
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped && logicalLines.length > 0) {
        const previous = logicalLines[logicalLines.length - 1];
        logicalLines[logicalLines.length - 1] = `${previous ?? ""}${text}`;
      } else {
        logicalLines.push(text);
      }
    }

    let lastLogicalLine = logicalLines.at(-1);
    while (lastLogicalLine !== undefined && lastLogicalLine.length === 0) {
      logicalLines.pop();
      lastLogicalLine = logicalLines.at(-1);
    }

    const viewportStart = Math.max(0, buffer.viewportY);
    const viewportEnd = Math.min(buffer.length, viewportStart + this.#terminal.rows);
    const screenRows: string[] = [];
    for (let y = viewportStart; y < viewportEnd; y += 1) {
      screenRows.push(buffer.getLine(y)?.translateToString(true) ?? "");
    }
    let lastScreenRow = screenRows.at(-1);
    while (lastScreenRow !== undefined && lastScreenRow.length === 0) {
      screenRows.pop();
      lastScreenRow = screenRows.at(-1);
    }

    const tailLineCount = Math.min(DEFAULT_TAIL_LINES, logicalLines.length);
    return {
      status: this.#status,
      busy: this.#status === "running",
      exitCode: this.#exitCode,
      signal: this.#exitSignal,
      screen: screenRows.join("\n"),
      tail: logicalLines.slice(-tailLineCount),
      bufferType: buffer.type,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      cols: this.#terminal.cols,
      rows: this.#terminal.rows,
      lastOutputAt: this.#lastOutputAt,
    };
  }
}

export async function runPty(options: RunPtyOptions): Promise<string> {
  const [ptyModule, headlessTerminalModule] = await Promise.all([
    import("node-pty"),
    import("@xterm/headless"),
  ]);
  spawn = ptyModule.spawn;
  Terminal = headlessTerminalModule.Terminal;
  const session = new PtySession({ ...options, shell: await resolveShell(options.command) });
  try {
    const snapshot = await session.wait();
    return formatTerminalSnapshot(snapshot);
  } finally {
    session.dispose();
  }
}

export async function runShell(options: RunShellOptions): Promise<string> {
  const command = new ShellCommand({ ...options, shell: await resolveShell(options.command) });
  try {
    const result = await command.wait();
    return formatCommandResult(result);
  } finally {
    command.dispose();
  }
}

async function resolveShell(command: string): Promise<ResolvedShell> {
  const override = process.env.MYCODER_SHELL?.trim();
  if (override) {
    const shellName = basename(override).toLowerCase();
    const executable = override.includes("/") || override.includes("\\")
      ? override
      : await findExecutableInPath(override) ?? override;
    return { command: executable, args: shellInvocationArgs(shellName, command) };
  }

  if (os.platform() === "win32") {
    for (const filename of ["pwsh.exe", "powershell.exe"]) {
      const powerShell = await findExecutableInPath(filename);
      if (powerShell) {
        return { command: powerShell, args: windowsPowerShellArgs(command) };
      }
    }

    const comspec = process.env.ComSpec?.trim() || "cmd.exe";
    return { command: comspec, args: ["/d", "/s", "/c", command] };
  }

  for (const shellName of ["bash", "sh"]) {
    const candidates = [
      `/bin/${shellName}`,
      `/usr/bin/${shellName}`,
      `/usr/local/bin/${shellName}`,
      `/opt/homebrew/bin/${shellName}`,
      await findExecutableInPath(shellName),
    ];

    for (const candidate of candidates) {
      if (candidate && await isExecutable(candidate)) {
        return { command: candidate, args: ["-c", command] };
      }
    }
  }

  throw new Error("no compatible shell found: expected bash or sh");
}

function shellInvocationArgs(shellName: string, command: string): Array<string> {
  if (shellName === "cmd" || shellName === "cmd.exe") return ["/d", "/s", "/c", command];
  if (shellName === "powershell" || shellName === "powershell.exe" || shellName === "pwsh" || shellName === "pwsh.exe") {
    return windowsPowerShellArgs(command);
  }
  return ["-c", command];
}

function windowsPowerShellArgs(command: string): Array<string> {
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand,
  ];
}

async function findExecutableInPath(filename: string): Promise<string | undefined> {
  const directories = (process.env.PATH ?? "")
    .split(pathDelimiter)
    .map((directory) => directory.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  for (const directory of directories) {
    const candidate = join(directory, filename);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
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

export function formatTerminalSnapshot(snapshot: TerminalSnapshot): string {
  const header = snapshot.status === "exited" && snapshot.exitCode !== null
    ? `exit:${snapshot.exitCode}`
    : snapshot.status;
  return [header, ...snapshot.tail].join("\n").slice(0, RESULT_LIMIT);
}

export function createTerminalTool(): ToolDefinition {
  return {
    name: "bash",
    description: `一次性运行命令并等待退出；超时终止进程树并返回输出。默认使用非 TTY 子进程；仅当命令必须检测 TTY、渲染 TUI 或读取 /dev/tty 时设置 tty=true，该模式要求安装 node-pty 和 @xterm/headless。长驻服务优先使用项目已有的进程管理方式，临时可恢复会话使用 ${MULTIPLEXER}`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "执行的命令；必须自然退出或被超时终止" },
        cwd: { type: "string", description: "命令工作目录" },
        timeout: { type: "number", description: "硬超时毫秒；默认 120000" },
        idleTimeout: { type: "number", description: "无输出超时毫秒；默认 30000" },
        tty: {
          type: "boolean",
          description: "默认 false；仅在命令需要真实 TTY 语义时设为 true",
        },
      },
      required: ["command"],
    },
  };
}

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}
