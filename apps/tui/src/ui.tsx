import { InputRenderable, TextAttributes } from "@opentui/core";
import { For, Show, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { SingleAgent } from "mycoder/agent";
import type { AgentContentBlock } from "mycoder/messages";
import type { TuiLogger } from "./logging.js";
import { errorText, formatTuiHelp, stripControlCharacters } from "./state.js";

type TuiUsage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
};

type TuiTaskStatus = "done" | "error" | "system";

type TuiTask = {
  id: number;
  task: string;
  status: TuiTaskStatus;
  text: string;
  elapsedMs: number;
};

export type TuiAppProps = {
  agent: SingleAgent;
  protocol: string;
  model: string;
  logger?: TuiLogger;
  onExit: () => void;
};

const zeroUsage: TuiUsage = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
};

export function TuiApp({ agent, protocol, model, logger, onExit }: TuiAppProps): JSX.Element {
  const [tasks, setTasks] = createSignal<TuiTask[]>([]);
  const [currentTask, setCurrentTask] = createSignal<string | null>(null);
  const [currentStep, setCurrentStep] = createSignal(0);
  const [currentDescription, setCurrentDescription] = createSignal("");
  const [elapsed, setElapsed] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [usage, setUsage] = createSignal<TuiUsage>({ ...zeroUsage });

  let taskCounter = 0;
  let startedAt = 0;
  let lastAssistantText = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let inputRef: InputRenderable | undefined;

  const listeners = [
    agent.on("assistant_message", (event) => {
      lastAssistantText = textOf(event.message.content);
    }),
    agent.on("tool_start", (event) => {
      setCurrentStep((step) => step + 1);
      setCurrentDescription(describeTool(event.name, event.input));
    }),
    agent.on("model_usage", (event) => {
      setUsage({
        requests: event.totalUsage.requests,
        inputTokens: event.totalUsage.inputTokens,
        outputTokens: event.totalUsage.outputTokens,
        cacheReadInputTokens: event.totalUsage.cacheReadInputTokens,
      });
    }),
  ];

  onCleanup(() => {
    listeners.forEach((unsubscribe) => unsubscribe());
    stopTimer();
  });

  function startTimer(): void {
    startedAt = Date.now();
    setElapsed(0);
    timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function pushTask(task: Omit<TuiTask, "id">): void {
    taskCounter += 1;
    setTasks((current) => [...current, { ...task, id: taskCounter }]);
  }

  async function submit(value: string): Promise<void> {
    const input = value.trim();
    if (!input || busy()) return;

    if (handleCommand(input)) return;
    if (inputRef) inputRef.value = "";

    setCurrentTask(input);
    setCurrentStep(0);
    setCurrentDescription("");
    lastAssistantText = "";
    setBusy(true);
      startTimer();

      try {
        await logger?.log("run_start", { input });
        await agent.run(input);
        stopTimer();
        await logger?.log("run_end", {
          input,
          output: lastAssistantText,
          durationMs: Date.now() - startedAt,
          ok: true,
        });
      pushTask({
        task: input,
        status: "done",
        text: lastAssistantText || "(no output)",
        elapsedMs: Date.now() - startedAt,
      });
      } catch (error) {
        stopTimer();
        await logger?.log("run_error", {
          input,
          error,
          durationMs: Date.now() - startedAt,
          ok: false,
        });
      pushTask({
        task: input,
        status: "error",
        text: isAbortError(error) ? "(interrupted)" : errorText(error),
        elapsedMs: Date.now() - startedAt,
      });
    } finally {
      setCurrentTask(null);
      setBusy(false);
    }
  }

  function handleCommand(input: string): boolean {
    if (input === "/exit" || input === "/quit") {
      onExit();
      return true;
    }
    if (input === "/reset") {
      agent.reset();
      setTasks([]);
      setUsage({ ...zeroUsage });
      return true;
    }
    if (input === "/usage") {
      pushTask({ task: "", status: "system", text: formatUsage(usage()), elapsedMs: 0 });
      return true;
    }
    if (input === "/help") {
      pushTask({ task: "", status: "system", text: formatTuiHelp(), elapsedMs: 0 });
      return true;
    }
    return false;
  }

  const usageText = () => usage().requests > 0 ? formatUsage(usage()) : "";

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} height={1}>
        <text fg="#22d3ee" attributes={TextAttributes.BOLD}>
          {`◆ mycoder · ${protocol} · ${model}`}
        </text>
        <text fg="#64748b">{usageText()}</text>
      </box>

      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
        <For each={tasks()}>
          {(task) => <TaskView task={task} />}
        </For>
      </scrollbox>

      <Show when={busy()}>
        <box flexShrink={0} backgroundColor="#0c1a24" paddingLeft={1} paddingRight={1} marginTop={1} flexDirection="row" gap={1}>
          <text fg="#22d3ee" attributes={TextAttributes.BOLD} wrapMode="word" flexGrow={1}>{currentTask() ?? ""}</text>
        </box>
        <box flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
          <text fg="#facc15">●</text>
          <text fg="#facc15" flexGrow={1}>
            {currentStep() > 0
              ? `step ${currentStep()} · ${currentDescription()}`
              : "thinking"}
          </text>
          <text fg="#64748b">{elapsed() > 0 ? `${elapsed()}s` : ""}</text>
        </box>
      </Show>

      <box
        flexShrink={0}
        marginTop={1}
        border
        borderStyle="rounded"
        borderColor={busy() ? "#facc15" : "#22d3ee"}
        paddingLeft={1}
        paddingRight={1}
      >
        <input
          ref={inputRef}
          focused={!busy()}
          placeholder={busy() ? "Agent is working…" : "Describe a task…"}
          onSubmit={(value) => {
            if (typeof value === "string") {
              void submit(value);
            }
          }}
        />
      </box>
    </box>
  );
}

function TaskView({ task }: { task: TuiTask }): JSX.Element {
  if (task.status === "system") {
    return <text fg="#64748b">{task.text}</text>;
  }

  const isDone = task.status === "done";

  return (
    <box marginTop={1}>
      <box backgroundColor="#0c1a24" paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
        <text fg="#22d3ee" attributes={TextAttributes.BOLD} wrapMode="word" flexGrow={1}>{task.task}</text>
        <text fg="#64748b">{formatElapsed(task.elapsedMs)}</text>
      </box>
      <box marginTop={1} paddingLeft={2}>
        {isDone
          ? <MarkdownText content={task.text} />
          : <text fg="#ef4444" wrapMode="word">{task.text}</text>}
      </box>
      <box marginTop={1} border={["top"]} borderColor="#334155" borderStyle="single">
      </box>
    </box>
  );
}

type InlineSegment = {
  text: string;
  bold: boolean;
  code: boolean;
};

function parseInlineSegments(text: string): Array<InlineSegment> {
  const segments: Array<InlineSegment> = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, index), bold: false, code: false });
    }
    const token = match[0];
    if (token.startsWith("**")) {
      segments.push({ text: token.slice(2, -2), bold: true, code: false });
    } else {
      segments.push({ text: token.slice(1, -1), bold: false, code: true });
    }
    lastIndex = index + token.length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), bold: false, code: false });
  }
  return segments.length > 0 ? segments : [{ text, bold: false, code: false }];
}

function MarkdownText({ content }: { content: string }): JSX.Element {
  const lines = content.split("\n").filter((line, index, array) => {
    if (line.trim() === "" && (index === 0 || index === array.length - 1)) return false;
    return true;
  });
  const elements: Array<JSX.Element> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isTableLine(line)) {
      const tableLines: Array<string> = [];
      while (index < lines.length && isTableLine(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      elements.push(<TableBlockView lines={tableLines} />);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      elements.push(
        <text fg="#22d3ee" attributes={TextAttributes.BOLD} wrapMode="word">
          {line.replace(/^#{1,6}\s*/, "")}
        </text>,
      );
    } else if (/^\s*[-*]\s/.test(line)) {
      elements.push(
        <box flexDirection="row" gap={1}>
          <text fg="#64748b">•</text>
          <InlineSegments text={line.replace(/^\s*[-*]\s*/, "")} />
        </box>,
      );
    } else {
      elements.push(<InlineSegments text={line} />);
    }
  }
  return (
    <box flexDirection="column">
      {elements}
    </box>
  );
}

function isTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function parseTableCells(line: string): Array<string> {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparatorRow(cells: Array<string>): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += isFullWidthCharacter(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

function isFullWidthCharacter(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function padCell(cell: string, width: number): string {
  const padding = width - displayWidth(cell);
  return padding > 0 ? `${cell}${" ".repeat(padding)}` : cell;
}

function TableBlockView({ lines }: { lines: Array<string> }): JSX.Element {
  const rows: Array<{ cells: Array<string>; header: boolean }> = [];
  const parsed = lines.map(parseTableCells);
  parsed.forEach((cells, index) => {
    if (isTableSeparatorRow(cells)) return;
    if (rows.length === 0 && isTableSeparatorRow(parsed[1] ?? [])) {
      rows.push({ cells, header: true });
    } else {
      rows.push({ cells, header: false });
    }
  });
  if (rows.length === 0) return <text>{""}</text>;
  const columnCount = Math.max(...rows.map((row) => row.cells.length));
  const widths = Array.from(
    { length: columnCount },
    (_, column) => Math.max(...rows.map((row) => displayWidth(row.cells[column] ?? ""))),
  );
  return (
    <box flexDirection="column">
      {rows.map((row, index) => (
        <box flexDirection="row">
          {Array.from({ length: columnCount }, (_, column) => (
            <text
              fg={row.header ? "#22d3ee" : "#e2e8f0"}
              attributes={row.header ? TextAttributes.BOLD : 0}
            >
              {padCell(row.cells[column] ?? "", (widths[column] ?? 0) + 1)}
            </text>
          ))}
        </box>
      ))}
    </box>
  );
}

function InlineSegments({ text }: { text: string }): JSX.Element {
  if (!text) return <text>{""}</text>;
  const segments = parseInlineSegments(text);
  return (
    <box flexDirection="row">
      {segments.map((segment) => (
        <text
          fg={segment.code ? "#facc15" : "#e2e8f0"}
          attributes={segment.bold ? TextAttributes.BOLD : 0}
        >
          {segment.text}
        </text>
      ))}
    </box>
  );
}

function describeTool(name: string, input: Record<string, unknown>): string {
  if (name === "bash" && typeof input.command === "string") {
    const command = input.command.trim();
    if (!command) return "bash";
    return command.length > 60 ? `${command.slice(0, 57)}…` : command;
  }
  return name;
}

function formatUsage(value: TuiUsage): string {
  return `in ${value.inputTokens} · out ${value.outputTokens} · cache ${value.cacheReadInputTokens}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function textOf(content: Array<AgentContentBlock>): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.type === "text" ? stripControlCharacters(block.text) : "")
    .join("\n")
    .trim();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
