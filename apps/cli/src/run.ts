export type RunTaskOptions = {
  agent: {
    on(event: "tool_start", listener: (event: { id?: string; name: string; input: Record<string, unknown> }) => void): () => void;
    on(event: "tool_end", listener: (event: { id?: string; name?: string; output: unknown }) => void): () => void;
    on(event: "thinking_delta", listener: (event: { delta: string }) => void): () => void;
    on(event: "text_delta", listener: (event: { delta: string }) => void): () => void;
    on(event: "assistant_message", listener: () => void): () => void;
    abort(reason?: unknown): void;
    reset(): void;
    run(input: string): Promise<{
      answer: string;
      response: { stopReason: "end" | "tool_call" | "max_tokens" };
    }>;
  };
  input: string;
  saveSession: () => Promise<void>;
  output: NodeJS.WriteStream;
  status: (message: string) => void;
  trace: (text: string) => void;
  color?: boolean;
  width?: number;
};

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
} as const;

export async function runTask({
  agent,
  input,
  saveSession,
  output,
  status,
  trace,
  color: colorEnabled = false,
  width = 72,
}: RunTaskOptions): Promise<number> {
  const startedAt = Date.now();
  let stream: "thinking" | "text" | undefined;
  let currentColor = "";
  let answerStreamed = false;
  const activeTools = new Map<string, { name: string; startedAt: number }>();
  let lastTool: { name: string; startedAt: number } | undefined;

  const paintIfEnabled = (text: string, color: string): string => {
    return colorEnabled ? paint(text, color) : text;
  };

  const event = (
    name: string,
    options: EventDividerOptions = {},
    color: string = COLORS.dim,
  ): void => {
    status(paintIfEnabled(formatEventDivider(name, options, width), color));
  };

  const appendStream = (next: "thinking" | "text", delta: string): void => {
    if (!delta) return;
    if (stream !== next) {
      if (stream !== undefined) trace("\n");
      currentColor = next === "thinking" ? COLORS.magenta : COLORS.blue;
      event(next === "thinking" ? "thinking" : "assistant");
      stream = next;
      if (next === "text") answerStreamed = true;
    }
    if (next === "text") {
      output.write(paintIfEnabled(delta, currentColor));
    } else {
      trace(paintIfEnabled(delta, currentColor));
    }
  };
  const endStream = (): void => {
    if (stream !== undefined) {
      if (stream === "text") output.write("\n");
      else trace("\n");
      stream = undefined;
    }
  };

  const removeToolStart = agent.on("tool_start", ({ id, name, input: toolInput }) => {
    endStream();
    const tool = { name, startedAt: Date.now() };
    if (id) activeTools.set(id, tool);
    lastTool = tool;
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    event("tool.start", { target: name });
    status(paintIfEnabled(`$ ${command}`, COLORS.cyan));
  });
  const removeToolEnd = agent.on("tool_end", ({ id, name, output: toolOutput }) => {
    const trackedTool = id ? activeTools.get(id) : lastTool;
    if (id) activeTools.delete(id);
    const resultColor = isFailedToolOutput(toolOutput) ? COLORS.red : COLORS.green;
    event("tool.end", {
      target: trackedTool?.name ?? name ?? "tool",
      ...(trackedTool ? { durationMs: Date.now() - trackedTool.startedAt } : {}),
    }, resultColor);
    status(paintIfEnabled(formatToolOutput(toolOutput), resultColor));
  });
  const removeThinkingDelta = agent.on("thinking_delta", ({ delta }) => {
    appendStream("thinking", delta);
  });
  const removeTextDelta = agent.on("text_delta", ({ delta }) => {
    appendStream("text", delta);
  });
  const removeAssistantMessage = agent.on("assistant_message", () => {
    endStream();
  });

  try {
    const result = await agent.run(input);
    endStream();
    if (result.response.stopReason === "max_tokens") {
      status(paintIfEnabled("⚠ model output truncated at max_tokens", COLORS.yellow));
    }
    if (!answerStreamed) {
      output.write(`${result.answer || "(no output)"}\n`);
    }
    status(paintIfEnabled(
      `✓ ${formatDuration(Date.now() - startedAt)} · ${formatTimestamp()}`,
      COLORS.green,
    ));
    return 0;
  } catch (error) {
    status(paintIfEnabled(
      `✕ ${formatDuration(Date.now() - startedAt)} · ${formatTimestamp()} · ${errorText(error)}`,
      COLORS.red,
    ));
    return 1;
  } finally {
    removeToolStart();
    removeToolEnd();
    removeThinkingDelta();
    removeTextDelta();
    removeAssistantMessage();
    try {
      await saveSession();
    } catch (error) {
      status(`failed to save session: ${errorText(error)}`);
    }
  }
}

function paint(text: string, color: string): string {
  return color ? `${color}${text}${COLORS.reset}` : text;
}

export function formatDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(0)}s`;
}

export type EventDividerOptions = {
  target?: string;
  durationMs?: number;
  timestamp?: Date;
};

export function formatEventDivider(
  event: string,
  { target, durationMs, timestamp }: EventDividerOptions = {},
  width = 72,
): string {
  const label = [event, target, durationMs === undefined ? undefined : formatDuration(durationMs)]
    .filter((part) => part !== undefined)
    .join(" · ");
  const time = formatTimestamp(timestamp);
  const prefix = "──── ";
  const fill = "─".repeat(Math.max(4, width - prefix.length - label.length - time.length - 2));
  return `${prefix}${label} ${fill} ${time}`;
}

export function formatTimestamp(timestamp = new Date()): string {
  const units = [timestamp.getHours(), timestamp.getMinutes(), timestamp.getSeconds()];
  return units.map((unit) => String(unit).padStart(2, "0")).join(":");
}

export function formatToolOutput(output: unknown, limit = 4_000): string {
  const text = typeof output === "string"
    ? output
    : JSON.stringify(output, null, 2);
  const normalized = text.trim() || "(no output)";
  const truncated = normalized.length > limit
    ? `${normalized.slice(0, limit)}\n... output truncated ...`
    : normalized;

  return truncated.split("\n").map((line) => `  ${line}`).join("\n");
}

function isFailedToolOutput(output: unknown): boolean {
  const header = typeof output === "string"
    ? output.split("\n", 1)[0]?.trim() ?? ""
    : "";
  return /^(exit:[1-9]\d*|timeout|aborted)/.test(header);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
