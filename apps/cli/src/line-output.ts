import process from "node:process";
import type { Interface } from "node:readline/promises";
import { FRAMES } from "./spinner.js";

export type LineOutputTarget = NodeJS.WriteStream | ((chunk: string) => void);

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

/**
 * Output hook that keeps the readline input line intact: before writing a
 * chunk the prompt line is lifted, the log takes its place, and readline
 * repaints the input (plus typed text) below the log.
 */
export function createLineOutput(target: LineOutputTarget = process.stdout): LineOutput {
  let readline: Interface | undefined;
  let parked: string | undefined;
  let frameRow = false;
  let streaming = false;

  const raw = (chunk: string): void => {
    if (typeof target === "function") target(chunk);
    else target.write(chunk);
  };

  /** Draw the spinner frame on the line below the prompt without scrolling;
   * `undefined` clears it. Falls back to in-place stderr rendering. */
  const parkFrame = (frame: string | undefined): void => {
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

  /** Append streamed fragments in place: first chunk lifts the prompt line,
   * fragments follow raw, and a trailing "\n" hands the row back to
   * readline and repaints the input. */
  const stream = (chunk: string): void => {
    if (!chunk) return;
    if (!readline) {
      raw(chunk);
      return;
    }
    if (streaming) {
      raw(chunk);
      if (chunk.endsWith("\n")) readline.prompt(true);
      return;
    }
    readline.pause();
    raw(FLUSH_LINE);
    raw(toCrlf(chunk));
    if (chunk.endsWith("\n")) {
      readline.prompt(true);
      if (parked) parkFrame(parked);
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
      frameRow = false;
      readline = rl;
    },
    detach(): void {
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
