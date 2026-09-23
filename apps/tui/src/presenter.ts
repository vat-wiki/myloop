export type TuiLineKind = "system" | "user" | "assistant" | "tool" | "error" | "usage" | "dim";

export type TuiLine = {
  kind: TuiLineKind;
  text: string;
  timestamp: Date;
};

export type TuiEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; name: string; output: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: "context_compacted" }
  | { type: "error"; error: unknown };

export class TuiPresenter {
  readonly #maxLines: number;
  readonly #lines: Array<TuiLine> = [];

  constructor(maxLines = 500) {
    this.#maxLines = maxLines;
  }

  get lines(): ReadonlyArray<TuiLine> {
    return this.#lines;
  }

  push(kind: TuiLineKind, text: string, timestamp = new Date()): void {
    const normalized = stripControlCharacters(text);
    for (const part of normalized.split("\n")) {
      this.#lines.push({ kind, text: part, timestamp });
    }
    if (this.#lines.length > this.#maxLines) {
      this.#lines.splice(0, this.#lines.length - this.#maxLines);
    }
  }

  pushEvent(event: TuiEvent, timestamp = new Date()): void {
    if (event.type === "assistant_text") {
      this.push("assistant", event.text, timestamp);
      return;
    }
    if (event.type === "tool_start") {
      this.push("tool", `▶ ${event.name} ${JSON.stringify(event.input)}`, timestamp);
      return;
    }
    if (event.type === "tool_end") {
      this.push("tool", `✓ ${event.name} ${stringifyResult(event.output)}`, timestamp);
      return;
    }
    if (event.type === "usage") {
      this.push(
        "usage",
        `tokens · in ${event.inputTokens} · out ${event.outputTokens} · total ${event.totalTokens}`,
        timestamp,
      );
      return;
    }
    if (event.type === "context_compacted") {
      this.push("dim", "context compacted", timestamp);
      return;
    }
    this.push("error", errorText(event.error), timestamp);
  }

  renderFrom(index: number): string {
    return this.#lines.slice(index).map(formatTuiLine).join("\n");
  }
}

export function formatTuiLine(line: TuiLine): string {
  const time = line.timestamp.toTimeString().slice(0, 8);
  const label = line.kind === "user" ? "you" : line.kind === "assistant" ? "agent" : line.kind;
  return `${style.dim(time)} ${colorize(label.padEnd(9), line.kind)} ${line.text}`;
}

export function stripControlCharacters(value: string): string {
  return value.replace(/\r/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

function colorize(text: string, kind: TuiLineKind): string {
  if (kind === "user") return style.cyan(text);
  if (kind === "assistant") return style.green(text);
  if (kind === "tool") return style.yellow(text);
  if (kind === "error") return style.red(text);
  if (kind === "usage") return style.magenta(text);
  return style.dim(text);
}

export const style = {
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
  dim: (text: string) => `\u001b[2m${text}\u001b[0m`,
  cyan: (text: string) => `\u001b[36m${text}\u001b[0m`,
  green: (text: string) => `\u001b[32m${text}\u001b[0m`,
  yellow: (text: string) => `\u001b[33m${text}\u001b[0m`,
  red: (text: string) => `\u001b[31m${text}\u001b[0m`,
  magenta: (text: string) => `\u001b[35m${text}\u001b[0m`,
};

export function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
