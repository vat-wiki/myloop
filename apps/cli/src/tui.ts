import process from "node:process";
import type { Interface } from "node:readline/promises";
import { homedir } from "node:os";
import { sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Compose the interactive prompt: ~-abbreviated cwd + "❯". */
export function formatInteractivePrompt(cwd: string, home = homedir()): string {
  const directory = cwd === home
    ? "~"
    : cwd.startsWith(`${home}${sep}`)
      ? `~${cwd.slice(home.length)}`
      : cwd;
  return `${directory} ❯ `;
}

export type SpinnerOptions = {
  output?: NodeJS.WriteStream;
  intervalMs?: number;
};

/** Standalone stderr spinner for non-readline output paths. */
export function createSpinner({ output = process.stderr, intervalMs = 120 }: SpinnerOptions = {}): {
  start: (label: string) => void;
  update: (label: string) => void;
  suspend: () => void;
  stop: () => void;
  readonly active: boolean;
} {
  let timer: NodeJS.Timeout | undefined;
  let frame = 0;
  let label = "";

  function render(): void {
    output.write(`\r${FRAMES[frame % FRAMES.length]} ${label}   \x1b[K`);
    frame += 1;
  }

  return {
    start(next: string): void {
      if (timer) return;
      label = next;
      render();
      timer = setInterval(render, intervalMs);
      timer.unref?.();
    },
    update(next: string): void {
      label = next;
    },
    suspend(): void {
      if (!timer) return;
      output.write("\r\x1b[K");
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      output.write("\r\x1b[K");
    },
    get active(): boolean {
      return timer !== undefined;
    },
  };
}

export type LineOutputTarget = NodeJS.WriteStream | ((chunk: string) => void);

export type LineOutputOptions = { rows?: () => number | undefined; columns?: () => number | undefined };

export type LineOutput = {
  write: (chunk: string) => void;
  stream: (chunk: string) => void;
  parkFrame: (frame: string | undefined) => void;
  attach: (rl: Interface) => void;
  detach: () => void;
};

/** Move to col 1 and erase to screen end: lifts the prompt line off screen. */
const FLUSH_LINE = "\x1b[1G\x1b[0J";

/** Normalize bare \n to \r\n: stdin is raw, the terminal does not translate. */
function toCrlf(chunk: string): string {
  return chunk.replace(/\r?\n/g, "\r\n");
}

const WIDE_CHARACTERS = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

function characterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (/\p{M}/u.test(character)) return 0;
  if (WIDE_CHARACTERS.test(character)) return 2;
  if (codePoint >= 0x1100 && /\p{Extended_Pictographic}/u.test(character)) return 2;
  return 1;
}

function cursorColumnAfter(chunk: string, column: number, columns: number): number {
  const visible = stripVTControlCharacters(toCrlf(chunk));
  let next = column;
  const segmenter = typeof Intl === "object" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;
  const graphemes = segmenter
    ? Array.from(segmenter.segment(visible), (segment) => segment.segment)
    : Array.from(visible);
  for (const character of graphemes) {
    if (character === "\n" || character === "\r") {
      next = 0;
      continue;
    }
    if (character === "\t") {
      next = Math.min(columns, (Math.floor(next / 8) + 1) * 8);
      continue;
    }
    const width = characterWidth(character);
    if (next + width > columns) next = width;
    else next += width;
  }
  return next;
}

function terminalColumn(column: number, columns: number): number {
  return column === columns ? columns : column + 1;
}

/**
 * Output hook that keeps the readline input line intact: before writing a
 * chunk the prompt line is lifted, the log takes its place, and readline
 * repaints the input (plus typed text) below the log.
 */
export function createLineOutput(target: LineOutputTarget = process.stdout, options: LineOutputOptions = {}): LineOutput {
  let readline: Interface | undefined;
  let parked: string | undefined;
  let frameRow = false;
  let streaming = false;
  let regionRows: number | undefined;
  let streamColumn = 0;
  let onResize: (() => void) | undefined;

  const rowsOf = (): number | undefined => {
    if (options.rows) return options.rows();
    if (typeof target === "object" && typeof target.rows === "number") return target.rows;
    return undefined;
  };

  const columnsOf = (): number | undefined => {
    if (options.columns) return options.columns();
    if (typeof target === "object" && typeof target.columns === "number") return target.columns;
    return undefined;
  };

  const raw = (chunk: string): void => {
    if (typeof target === "function") target(chunk);
    else target.write(chunk);
  };

  /** Confine appended logs to the scrollback above the status and prompt rows. */
  const setupRegion = (): void => {
    if (regionRows || !readline) return;
    const rows = rowsOf();
    if (!rows || rows < 3) return;
    regionRows = rows;
    raw(`\x1b[${rows - 1};1H\x1b[2K\n\x1b[1;${rows - 2}r\x1b[${rows - 2};1H\x1b[2K\x1b[${rows};1H`);
    readline.prompt(true);
  };

  const teardownRegion = (): void => {
    if (!regionRows) return;
    const rows = regionRows;
    regionRows = undefined;
    streaming = false;
    raw(`\x1b[${rows};1H\x1b[r\x1b[${rows};1H`);
  };

  /** Draw the spinner frame on the status row without disturbing the stream
   * cursor. Falls back to in-place rendering for non-TTY output. */
  const parkFrame = (frame: string | undefined): void => {
    if (regionRows) {
      if (!frame && !parked) return;
      raw(`\x1b7\x1b[${regionRows - 1};1H${frame ? `${frame}\x1b[K` : "\x1b[2K"}\x1b8`);
      parked = frame;
      return;
    }
    if (streaming) {
      parked = frame;
      return;
    }
    if (!readline) {
      if (frame) {
        raw(`\r${frame}\x1b[K`);
        parked = frame;
      } else if (parked) {
        raw("\r\x1b[K");
        parked = undefined;
      }
      return;
    }
    if (frame) {
      parked = frame;
      readline.pause();
      const col = readline.getCursorPos().cols;
      const down = frameRow ? "\x1b[1B\r" : "\n\r";
      frameRow = true;
      raw(`${down}${frame}\x1b[K\x1b[1A\x1b[${col + 1}G`);
      readline.resume();
      return;
    }
    if (parked) {
      parked = undefined;
      readline.pause();
      const col = readline.getCursorPos().cols;
      raw(`\x1b[1B\r\x1b[2K\x1b[1A\x1b[${col + 1}G`);
      readline.resume();
    }
  };

  const write = (chunk: string): void => {
    if (regionRows) {
      if (!chunk) return;
      readline?.pause();
      const parts: Array<string> = [];
      if (streaming) {
        const columns = columnsOf();
        if (columns) {
          parts.push(`\x1b7\x1b[${regionRows - 2};${terminalColumn(streamColumn, columns)}H\r\n\x1b8`);
        } else {
          parts.push("\r\n\x1b8");
        }
        streaming = false;
      }
      parts.push(`\x1b7\x1b[${regionRows - 2};1H`);
      parts.push(chunk.endsWith("\n") || chunk.endsWith("\r") ? toCrlf(chunk) : `${toCrlf(chunk)}\r\n`);
      parts.push("\x1b8");
      raw(parts.join(""));
      readline!.prompt(true);
      if (parked) parkFrame(parked);
      readline?.resume();
      return;
    }
    if (!readline) {
      raw(chunk);
      return;
    }
    if (!chunk) return;
    readline.pause();
    raw(FLUSH_LINE);
    raw(chunk.endsWith("\n") || chunk.endsWith("\r") ? toCrlf(chunk) : `${toCrlf(chunk)}\r\n`);
    readline.prompt(true);
    readline.resume();
    frameRow = false;
    streaming = false;
    if (parked) parkFrame(parked);
  };

  /** Append streamed fragments once. The prompt row remains active; each
   * fragment is written synchronously and the cursor is restored before
   * control returns to readline. */
  const stream = (chunk: string): void => {
    if (!chunk) return;
    if (regionRows) {
      if (!readline) return;
      if (streaming) {
        const columns = columnsOf();
        if (columns) {
          const nextColumn = cursorColumnAfter(chunk, streamColumn, columns);
          raw(`\x1b7\x1b[${regionRows - 2};${terminalColumn(streamColumn, columns)}H${toCrlf(chunk)}\x1b8`);
          streamColumn = nextColumn;
        } else {
          raw(toCrlf(chunk));
        }
        if (chunk.endsWith("\n")) {
          streaming = false;
          streamColumn = 0;
          readline.prompt(true);
          readline.resume();
        }
        return;
      }
      streaming = true;
      const columns = columnsOf();
      streamColumn = columns ? cursorColumnAfter(chunk, 0, columns) : 0;
      if (columns) {
        raw(`\x1b7\x1b[${regionRows - 2};1H${toCrlf(chunk)}\x1b8`);
      } else {
        raw(`\x1b7\x1b[${regionRows - 2};1H${toCrlf(chunk)}`);
      }
      if (chunk.endsWith("\n")) {
        streaming = false;
        streamColumn = 0;
        readline.prompt(true);
      }
      return;
    }
    if (!readline) {
      raw(chunk);
      return;
    }
    if (streaming) {
      raw(toCrlf(chunk));
      if (chunk.endsWith("\n")) {
        streaming = false;
        readline.prompt(true);
        readline.resume();
      }
      return;
    }
    readline.pause();
    raw(FLUSH_LINE);
    raw(toCrlf(chunk));
    const hadParked = parked;
    parked = undefined;
    frameRow = false;
    if (chunk.endsWith("\n")) {
      readline.prompt(true);
      if (hadParked) parkFrame(hadParked);
    } else {
      streaming = true;
    }
    readline.resume();
  };

  return {
    write,
    stream,
    parkFrame,
    attach(rl: Interface): void {
      readline = rl;
      frameRow = false;
      setupRegion();
      onResize = (): void => {
        if (!readline) return;
        const rows = rowsOf();
        if (regionRows && (!rows || rows < 3 || rows !== regionRows)) {
          teardownRegion();
          setupRegion();
        }
      };
      if (typeof target === "object") target.on("resize", onResize);
    },
    detach(): void {
      if (onResize && typeof target === "object") {
        target.off("resize", onResize);
        onResize = undefined;
      }
      teardownRegion();
      parked = undefined;
      frameRow = false;
      streaming = false;
      readline = undefined;
    },
  };
}

export type ReadlineSpinner = ReturnType<typeof createReadlineSpinner>;

/** Spinner that parks its animation frame below the prompt line via
 * LineOutput.parkFrame, so ticks never scroll the screen. */
export function createReadlineSpinner(output: LineOutput): {
  start: (label: string) => void;
  update: (label: string) => void;
  suspend: () => void;
  stop: () => void;
  readonly active: boolean;
} {
  let timer: NodeJS.Timeout | undefined;
  let tick = 0;
  let label = "";
  const render = (): void => {
    output.parkFrame(`${FRAMES[tick % FRAMES.length]} ${label}   `);
    tick += 1;
  };
  return {
    start(next: string): void {
      if (timer) return;
      label = next;
      render();
      timer = setInterval(render, 120);
      timer.unref?.();
    },
    update(next: string): void {
      label = next;
    },
    suspend(): void {
      output.parkFrame(undefined);
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      output.parkFrame(undefined);
    },
    get active(): boolean {
      return timer !== undefined;
    },
  };
}
