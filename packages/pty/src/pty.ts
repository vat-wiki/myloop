import process from "node:process";
import type { IPty } from "node-pty";

type PtyModule = typeof import("node-pty");
type HeadlessTerminalModule = typeof import("@xterm/headless");
type HeadlessTerminal = InstanceType<HeadlessTerminalModule["Terminal"]>;

let spawn: PtyModule["spawn"];
let Terminal: HeadlessTerminalModule["Terminal"];

export type PtyCommandOptions = {
  command: string;
  args?: Array<string>;
  cols?: number;
  rows?: number;
  cwd?: string;
  timeout?: number;
  idleTimeout?: number;
  signal?: AbortSignal;
};

export type PtyStatus =
  | "running"
  | "exited"
  | "timeout"
  | "aborted"
  | "killed";

export type PtySnapshot = {
  status: PtyStatus;
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
  outputChars: number;
  outputTruncated: boolean;
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const DEFAULT_SCROLLBACK = 2_000;
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_HARD_TIMEOUT = 120_000;
const DEFAULT_IDLE_TIMEOUT = 30_000;
const KILL_GRACE_MS = 2_000;
const INLINE_OUTPUT_LIMIT = 10_000;

class PtySession {
  readonly #pty: IPty;
  readonly #terminal: HeadlessTerminal;
  readonly #signal?: AbortSignal;
  readonly #onAbort: () => void;
  readonly #idleTimeout: number;
  readonly #exitPromise: Promise<void>;
  #outputChars = 0;

  #pendingWrite = Promise.resolve();
  #status: PtyStatus = "running";
  #ptyExited = false;
  #exitCode: number | null = null;
  #exitSignal: number | null = null;
  #lastOutputAt = Date.now();
  #hardTimer?: NodeJS.Timeout;
  #idleTimer?: NodeJS.Timeout;
  #forceKillTimer?: NodeJS.Timeout;
  #resolveExit?: () => void;

  constructor(options: PtyCommandOptions & { shell: { command: string; args: Array<string> } }) {
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const hardTimeout = options.timeout ?? DEFAULT_HARD_TIMEOUT;
    const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    if (!Number.isInteger(cols) || cols <= 0) throw new Error("cols must be a positive integer");
    if (!Number.isInteger(rows) || rows <= 0) throw new Error("rows must be a positive integer");
    if (!Number.isInteger(hardTimeout) || hardTimeout <= 0) throw new Error("timeout must be a positive integer");
    if (!Number.isInteger(idleTimeout) || idleTimeout <= 0) throw new Error("idleTimeout must be a positive integer");

    this.#signal = options.signal;
    this.#onAbort = () => void this.#terminate("aborted");
    this.#idleTimeout = idleTimeout;

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

  async wait(): Promise<PtySnapshot> {
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
    this.#captureOutput(data);
    this.#pendingWrite = this.#pendingWrite.then(
      () => new Promise<void>((resolve) => this.#terminal.write(data, resolve)),
    );
  }

  #captureOutput(data: string): void {
    this.#outputChars += data.length;
  }

  #armIdleTimer(): void {
    if (this.#ptyExited || this.#status !== "running") return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => void this.#terminate("timeout"), this.#idleTimeout);
  }

  async #terminate(status: PtyStatus): Promise<void> {
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

  async #snapshot(): Promise<PtySnapshot> {
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
      outputChars: this.#outputChars,
      outputTruncated: this.#outputChars > INLINE_OUTPUT_LIMIT,
    };
  }
}

export async function runPtyCommand(options: PtyCommandOptions): Promise<PtySnapshot> {
  const [ptyModule, importedTerminalModule] = await Promise.all([
    import("node-pty"),
    import("@xterm/headless"),
  ]);
  const headlessTerminalModule = importedTerminalModule.Terminal
    ? importedTerminalModule
    : importedTerminalModule.default;
  spawn = ptyModule.spawn;
  Terminal = headlessTerminalModule.Terminal;

  const session = new PtySession({
    ...options,
    shell: {
      command: options.command,
      args: options.args ?? [],
    },
  });
  try {
    return await session.wait();
  } finally {
    session.dispose();
  }
}

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}
