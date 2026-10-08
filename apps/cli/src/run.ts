import type { AgentMessage, ContextPressure, ModelUsage, ToolDefinition } from "myloop/runtime";

export type RunTaskOptions = {
  agent: {
    system: string;
    tools: ReadonlyArray<ToolDefinition>;
    on(event: "tool_start", listener: (event: { id?: string; name: string; input: Record<string, unknown> }) => void): () => void;
    on(event: "tool_end", listener: (event: { id?: string; name?: string; output: unknown }) => void): () => void;
    on(event: "thinking_delta", listener: (event: { delta: string }) => void): () => void;
    on(event: "text_delta", listener: (event: { delta: string }) => void): () => void;
    on(event: "context_pressure", listener: (event: { pressure: ContextPressure }) => void): () => void;
    on(event: "assistant_message", listener: () => void): () => void;
    on(event: "model_response", listener: (event: { response: { usage?: ModelUsage } }) => void): () => void;
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
  printPrompts?: boolean;
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
  printPrompts = false,
}: RunTaskOptions): Promise<number> {
  const startedAt = Date.now();
  let stream: "thinking" | "text" | undefined;
  let currentColor = "";
  let answerStreamed = false;
  const activeTools = new Map<string, { name: string; startedAt: number }>();
  let lastTool: { name: string; startedAt: number } | undefined;
  let receivedModelResponse = false;

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

  if (printPrompts) printAgentPrompts({ agent, status, trace, color: colorEnabled, width });

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
  const removeContextPressure = agent.on("context_pressure", ({ pressure }) => {
    event("context.estimate", { contextPressure: pressure });
  });
  const removeTextDelta = agent.on("text_delta", ({ delta }) => {
    appendStream("text", delta);
  });
  const removeAssistantMessage = agent.on("assistant_message", () => {
    endStream();
  });
  const removeModelResponse = agent.on("model_response", (payload = { response: {} }) => {
    const response = payload.response;
    receivedModelResponse = true;
    if (!response.usage) return;
    endStream();
    event("model.usage", { target: formatModelUsage(response.usage) });
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
    removeContextPressure();
    removeTextDelta();
    removeAssistantMessage();
    if (receivedModelResponse) {
      try {
        await saveSession();
      } catch (error) {
        status(`failed to save session: ${errorText(error)}`);
      }
    }
  }
}

export function printSessionHistory({
  messages,
  output,
  status,
  trace,
  color = false,
  width = 72,
}: {
  messages: ReadonlyArray<AgentMessage>;
  output: NodeJS.WriteStream;
  status: (message: string) => void;
  trace: (text: string) => void;
  color?: boolean;
  width?: number;
}): void {
  if (messages.length === 0) return;

  const paintIfEnabled = (text: string, colorCode: string): string => {
    return color ? paint(text, colorCode) : text;
  };
  const event = (name: string, target?: string, colorCode: string = COLORS.dim): void => {
    status(paintIfEnabled(
      formatEventDivider(name, { ...(target === undefined ? {} : { target }) }, width),
      colorCode,
    ));
  };

  status(paintIfEnabled(
    formatEventDivider("restored", { target: `${messages.length} messages` }, width),
    COLORS.dim,
  ));
  for (const message of messages) {
    if (message.role === "user") {
      event("user");
      const text = historyText(message.content);
      if (text) output.write(`${text}\n`);
      continue;
    }
    if (message.role === "assistant") {
      event("assistant");
      const text = historyText(message.content);
      if (text) output.write(`${text}\n`);
      for (const block of message.content) {
        if (block.type === "tool_call") {
          event("tool.start", block.name);
          status(paintIfEnabled(`$ ${formatHistoryToolInput(block.arguments)}`, COLORS.cyan));
        }
      }
      continue;
    }

    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const resultColor = isFailedToolOutput(block.content) ? COLORS.red : COLORS.green;
      event("tool.end", "tool", resultColor);
      status(paintIfEnabled(formatToolOutput(block.content), resultColor));
    }
  }
}

function historyText(content: ReadonlyArray<AgentMessage["content"][number]>): string {
  return content
    .filter((block): block is Extract<AgentMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function formatHistoryToolInput(input: Record<string, unknown>): string {
  const command = input.command;
  if (typeof command === "string") return command;
  return JSON.stringify(input, null, 2);
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

export function printAgentPrompts({
  agent,
  status,
  trace,
  color = false,
  width = 72,
}: {
  agent: Pick<RunTaskOptions["agent"], "system" | "tools">;
  status: (message: string) => void;
  trace: (text: string) => void;
  color?: boolean;
  width?: number;
}): void {
  const paintIfEnabled = (text: string, colorCode: string): string => {
    return color ? paint(text, colorCode) : text;
  };

  status(paintIfEnabled(formatEventDivider("system", {}, width), COLORS.dim));
  trace(`${agent.system}\n`);
  status(paintIfEnabled(formatEventDivider("tools", {}, width), COLORS.dim));
  trace(`${JSON.stringify(agent.tools, null, 2)}\n`);
}

export type EventDividerOptions = {
  target?: string;
  durationMs?: number;
  timestamp?: Date;
  contextPressure?: ContextPressure;
};

export function formatEventDivider(
  event: string,
  { target, durationMs, timestamp, contextPressure }: EventDividerOptions = {},
  width = 72,
): string {
  const label = [
    event,
    target,
    durationMs === undefined ? undefined : formatDuration(durationMs),
    contextPressure === undefined ? undefined : formatContextUsage(contextPressure),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  const time = formatTimestamp(timestamp);
  const prefix = "──── ";
  const fill = "─".repeat(Math.max(4, width - prefix.length - label.length - time.length - 2));
  return `${prefix}${label} ${fill} ${time}`;
}

export function formatContextUsage(pressure: ContextPressure): string {
  const used = formatTokensInK(pressure.usedTokens);
  if (pressure.limitTokens === undefined) return `context ${used}`;

  const ratio = pressure.ratio ?? pressure.usedTokens / pressure.limitTokens;
  return `context ${used}/${formatTokensInK(pressure.limitTokens)} (${(ratio * 100).toFixed(1)}%)`;
}

export function formatModelUsage(usage: ModelUsage): string {
  const parts = [
    usage.inputTokens === undefined ? undefined : `in ${usage.inputTokens}`,
    usage.outputTokens === undefined ? undefined : `out ${usage.outputTokens}`,
    usage.totalTokens === undefined ? undefined : `total ${usage.totalTokens}`,
    usage.cacheReadInputTokens === undefined ? undefined : `cache-read ${usage.cacheReadInputTokens}`,
    usage.cacheCreationInputTokens === undefined ? undefined : `cache-create ${usage.cacheCreationInputTokens}`,
    usage.reasoningOutputTokens === undefined ? undefined : `reasoning ${usage.reasoningOutputTokens}`,
  ].filter((part) => part !== undefined);
  return parts.join(" · ");
}


export function formatTokensInK(tokens: number): string {
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
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
