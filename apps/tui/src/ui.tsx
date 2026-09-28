import { TextAttributes, TextareaRenderable } from "@opentui/core";
import { For, Show, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { SingleAgent } from "mycoder/agent";
import type { AgentContentBlock, AgentMessage } from "mycoder/messages";
import type { ContextPressure, RuntimeSessionStore } from "mycoder/runtime";
import type { TuiLogger } from "./logging.js";
import { readClipboardText } from "./clipboard.js";
import {
  errorText,
  formatTuiHelp,
  getTuiCommandSuggestions,
  stripControlCharacters,
} from "./state.js";

type TuiUsage = {
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
  sessionStore?: RuntimeSessionStore;
  onExit: () => void;
  registerInterrupt?: (interrupt: () => void) => void;
  registerClearInput?: (clearInput: () => void) => void;
  registerCompleteCommand?: (completeCommand: () => boolean) => void;
  registerSelectCommand?: (selectCommand: (direction: 1 | -1) => boolean) => void;
  registerSubmitCommand?: (submitCommand: () => boolean) => void;
  registerPasteClipboard?: (pasteClipboard: () => Promise<boolean>) => void;
  readClipboard?: () => Promise<string>;
};

const zeroUsage: TuiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
};

export function TuiApp({
  agent,
  protocol,
  model,
  logger,
  sessionStore,
  onExit,
  registerInterrupt,
  registerClearInput,
  registerCompleteCommand,
  registerSelectCommand,
  registerSubmitCommand,
  registerPasteClipboard,
  readClipboard = readClipboardText,
}: TuiAppProps): JSX.Element {
  const initialTasks = createTasksFromMessages(agent.messages);
  const [sessionId, setSessionId] = createSignal(agent.sessionId ?? "default");
  const [tasks, setTasks] = createSignal<TuiTask[]>(initialTasks);
  const [currentTask, setCurrentTask] = createSignal<string | null>(null);
  const [currentStep, setCurrentStep] = createSignal(0);
  const [currentDescription, setCurrentDescription] = createSignal("");
  const [elapsed, setElapsed] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [queuedInputs, setQueuedInputs] = createSignal<string[]>([]);
  const [usage, setUsage] = createSignal<TuiUsage>({ ...zeroUsage });
  const [contextPressure, setContextPressure] = createSignal<ContextPressure | null>(null);
  const [inputValue, setInputValue] = createSignal("");
  const [selectedCommandIndex, setSelectedCommandIndex] = createSignal(0);
  const [sessionPicker, setSessionPicker] = createSignal(false);
  const [sessions, setSessions] = createSignal<string[]>([]);
  const [selectedSessionIndex, setSelectedSessionIndex] = createSignal(0);

  let taskCounter = initialTasks.length;
  let startedAt = 0;
  let lastAssistantText = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let inputRef: TextareaRenderable | undefined;

  const listeners = [
    agent.on("assistant_message", (event) => {
      lastAssistantText = textOf(event.message.content);
    }),
    agent.on("tool_start", (event) => {
      setCurrentStep((step) => step + 1);
      setCurrentDescription(describeTool(event.name, event.input));
    }),
    agent.on("model_response", (event) => {
      setUsage({
        inputTokens: event.response.usage?.inputTokens ?? 0,
        outputTokens: event.response.usage?.outputTokens ?? 0,
        cacheReadInputTokens: event.response.usage?.cacheReadInputTokens ?? 0,
      });
    }),
    agent.on("context_pressure", (event) => {
      setContextPressure(event.pressure);
    }),
  ];

  onCleanup(() => {
    listeners.forEach((unsubscribe) => unsubscribe());
    stopTimer();
  });

  registerInterrupt?.(() => {
    if (sessionPicker()) {
      setSessionPicker(false);
      return;
    }
    if (busy()) agent.abort();
  });
  registerClearInput?.(() => {
    inputRef?.editBuffer.clear();
    setInputValue("");
    setSelectedCommandIndex(0);
  });
  registerCompleteCommand?.(() => {
    const command = commandSuggestions()[selectedCommandIndex()];
    if (!command || !inputRef) return false;

    inputRef.editBuffer.replaceText(command.command);
    inputRef.cursorOffset = command.command.length;
    setInputValue(command.command);
    setSelectedCommandIndex(0);
    return true;
  });
  registerSelectCommand?.((direction) => {
    if (sessionPicker()) {
      const count = sessions().length;
      if (count === 0) return false;

      setSelectedSessionIndex((index) => (index + direction + count) % count);
      return true;
    }

    const count = commandSuggestions().length;
    if (count === 0) return false;

    setSelectedCommandIndex((index) => (index + direction + count) % count);
    return true;
  });
  registerSubmitCommand?.(() => {
    if (sessionPicker()) {
      void switchSession(sessions()[selectedSessionIndex()]);
      return true;
    }

    const input = currentInputValue();
    const command = commandSuggestions()[activeCommandIndex()];
    if (!command || !inputRef || input === command.command) return false;

    inputRef.editBuffer.replaceText(command.command);
    inputRef.cursorOffset = command.command.length;
    setInputValue(command.command);
    setSelectedCommandIndex(0);
    if (busy()) queueInput(command.command);
    else void submit(command.command);
    return true;
  });
  registerPasteClipboard?.(async () => {
    const text = stripControlCharacters(await readClipboard());
    if (!text || !inputRef) return false;

    inputRef.editBuffer.insertText(text);
    setInputValue(inputRef.plainText ?? "");
    setSelectedCommandIndex(0);
    return true;
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

    inputRef?.editBuffer.clear();
    setInputValue("");
    if (handleCommand(input)) return;

    await runQueue(input);
  }

  function queueInput(value: string): void {
    const input = value.trim();
    if (!input || !busy()) return;

    inputRef?.editBuffer.clear();
    setInputValue("");
    if (handleCommand(input)) return;
    setQueuedInputs((current) => [...current, input]);
  }

  function dequeueQueuedInputs(): string | undefined {
    const inputs = queuedInputs();
    if (inputs.length === 0) return undefined;

    setQueuedInputs([]);
    return inputs.join("\n\n");
  }

  async function runQueue(initialInput: string): Promise<void> {
    let input: string | undefined = initialInput;

    while (input) {
      setCurrentTask(input);
      setCurrentStep(0);
      setCurrentDescription("");
      lastAssistantText = "";
      setBusy(true);
      startTimer();

      try {
        const completedInput = input;
        await logger?.log("run_start", { input });
        await agent.run(input);
        stopTimer();
        await logger?.log("run_end", {
          input: completedInput,
          output: lastAssistantText,
          durationMs: Date.now() - startedAt,
          ok: true,
        });
        pushTask({
          task: completedInput,
          status: "done",
          text: lastAssistantText || "(no output)",
          elapsedMs: Date.now() - startedAt,
        });
        await persistSession();
        input = dequeueQueuedInputs();
      } catch (error) {
        stopTimer();
        const failedInput = input ?? "";
        await logger?.log("run_error", {
          input: failedInput,
          error,
          durationMs: Date.now() - startedAt,
          ok: false,
        });
        pushTask({
          task: failedInput,
          status: "error",
          text: isAbortError(error) ? "(interrupted)" : errorText(error),
          elapsedMs: Date.now() - startedAt,
        });
        await persistSession();
        input = isAbortError(error) ? dequeueQueuedInputs() : undefined;
      }
    }

    setCurrentTask(null);
    setBusy(false);
  }

  function handleCommand(input: string): boolean {
    if (input === "/exit" || input === "/quit") {
      onExit();
      return true;
    }
    if (input === "/sessions") {
      void openSessionPicker();
      return true;
    }
    if (input === "/reset") {
      if (busy()) {
        pushTask({ task: "", status: "system", text: "Cannot reset while the agent is running.", elapsedMs: 0 });
        return true;
      }
      agent.reset();
      setTasks([]);
      setUsage({ ...zeroUsage });
      setContextPressure(null);
      setSessionPicker(false);
      void persistSession();
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

  async function openSessionPicker(): Promise<void> {
    if (busy()) {
      pushTask({ task: "", status: "system", text: "Cannot switch sessions while the agent is running.", elapsedMs: 0 });
      return;
    }

    try {
      const listed = await sessionStore?.list?.();
      if (!listed) {
        pushTask({ task: "", status: "system", text: "Session store does not support listing sessions.", elapsedMs: 0 });
        return;
      }

      const ids = [...new Set([sessionId(), ...listed])].sort();
      setSessions(ids);
      setSelectedSessionIndex(Math.max(0, ids.indexOf(sessionId())));
      setSessionPicker(true);
      inputRef?.editBuffer.clear();
      setInputValue("");
      setSelectedCommandIndex(0);
    } catch (error) {
      setSessionPicker(false);
      pushTask({ task: "", status: "error", text: errorText(error), elapsedMs: 0 });
    }
  }

  async function switchSession(nextSessionId: string | undefined): Promise<void> {
    if (!nextSessionId) return;
    if (busy()) {
      pushTask({ task: "", status: "system", text: "Cannot switch sessions while the agent is running.", elapsedMs: 0 });
      return;
    }

    try {
      await agent.loadSession(nextSessionId);
      setSessionId(nextSessionId);
      setSessionPicker(false);
      setTasks(createTasksFromMessages(agent.messages));
      taskCounter = tasks().length;
      setCurrentTask(null);
      setCurrentStep(0);
      setCurrentDescription("");
      setQueuedInputs([]);
      setUsage({ ...zeroUsage });
      setContextPressure(null);
      lastAssistantText = "";
      pushTask({ task: "", status: "system", text: `Switched to session: ${nextSessionId}`, elapsedMs: 0 });
    } catch (error) {
      setSessionPicker(false);
      pushTask({ task: "", status: "error", text: errorText(error), elapsedMs: 0 });
    }
  }

  async function persistSession(): Promise<void> {
    if (typeof agent.saveSession !== "function") return;
    try {
      await agent.saveSession();
    } catch (error) {
      pushTask({
        task: "",
        status: "system",
        text: `Failed to save session: ${errorText(error)}`,
        elapsedMs: 0,
      });
    }
  }

  const usageText = () => {
    const { inputTokens, outputTokens } = usage();
    return inputTokens > 0 || outputTokens > 0 ? formatUsage(usage()) : "";
  };

  const contextText = () => {
    const pressure = contextPressure();
    if (pressure?.ratio === undefined) return "";

    const percent = Math.round(pressure.ratio * 100);
    const scale = pressure.limitTokens === undefined
      ? ""
      : ` (${formatTokens(pressure.usedTokens)}/${formatTokens(pressure.limitTokens)})`;
    return `ctx ${percent}%${scale}`;
  };

  const statusText = () => [contextText(), usageText()].filter(Boolean).join(" · ");
  const currentInputValue = () => {
    const values = [inputRef?.plainText ?? "", inputValue()]
      .map((value) => value.trim())
      .filter((value) => value.startsWith("/") && !/\s/.test(value));
    return values.reduce((longest, value) => value.length > longest.length ? value : longest, "");
  };
  const commandSuggestions = () => getTuiCommandSuggestions(currentInputValue());
  const activeCommandIndex = () => {
    const count = commandSuggestions().length;
    return count === 0 ? 0 : selectedCommandIndex() % count;
  };
  const commandMenu = () => {
    const activeIndex = activeCommandIndex();
    return commandSuggestions().map((command, index) => ({
      ...command,
      active: index === activeIndex,
    }));
  };

  function handleContentChange(): void {
    setInputValue(inputRef?.plainText ?? "");
    setSelectedCommandIndex(0);
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} height={1}>
        <text fg="#22d3ee" attributes={TextAttributes.BOLD}>
          {`◆ mycoder · ${protocol} · ${model} · ${sessionId()}`}
        </text>
        <text fg="#64748b">{statusText()}</text>
      </box>

      <Show
        when={tasks().length > 0 || busy() || commandSuggestions().length > 0}
        fallback={<WelcomeView />}
      >
        <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
          <For each={tasks()}>
            {(task) => <TaskView task={task} />}
          </For>
        </scrollbox>
      </Show>

      <Show when={busy()}>
        <box flexShrink={0} backgroundColor="#0c1a24" paddingLeft={1} paddingRight={1} marginTop={1} flexDirection="row" gap={1}>
          <text fg="#22d3ee" attributes={TextAttributes.BOLD} wrapMode="char" flexGrow={1}>{currentTask() ?? ""}</text>
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

      <Show when={queuedInputs().length > 0}>
        <box flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
          <For each={queuedInputs()}>
            {(input) => <text fg="#94a3b8" wrapMode="char">{input}</text>}
          </For>
        </box>
      </Show>

      <Show when={commandSuggestions().length > 0}>
        <box flexShrink={0} marginTop={1} paddingLeft={1} paddingRight={1} flexDirection="column">
          <For each={commandMenu()}>
            {(command) => {
              const active = command.active;
              return (
                <box flexDirection="row" gap={1} backgroundColor={active ? "#0c1a24" : undefined}>
                  <text fg={active ? "#22d3ee" : "#94a3b8"} attributes={active ? TextAttributes.BOLD : 0}>
                    {command.command}
                  </text>
                  <text fg={active ? "#e2e8f0" : "#64748b"}>{command.description}</text>
                </box>
              );
            }}
          </For>
        </box>
      </Show>

      <Show when={sessionPicker()}>
        <box flexShrink={0} marginTop={1} border borderStyle="rounded" borderColor="#22d3ee" paddingLeft={1} paddingRight={1}>
          <text fg="#22d3ee" attributes={TextAttributes.BOLD}>Sessions</text>
          <For each={sessions()}>
            {(id, index) => {
              const active = index() === selectedSessionIndex();
              return (
                <box flexDirection="row" gap={1}>
                  <text fg={active ? "#22d3ee" : "#94a3b8"} attributes={active ? TextAttributes.BOLD : 0}>
                    {active ? "›" : " "}
                  </text>
                  <text fg={active ? "#e2e8f0" : "#64748b"}>{id}</text>
                </box>
              );
            }}
          </For>
          <text fg="#64748b">↑/↓ select · Enter switch · ESC cancel</text>
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
        <textarea
          ref={inputRef}
          focused
          width="100%"
          height="auto"
          wrapMode="char"
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "kpenter", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "kpenter", shift: true, action: "newline" },
          ]}
          placeholder={busy() ? "Agent is working…" : "Describe a task…"}
          onSubmit={() => {
            const value = inputRef?.plainText ?? "";
            if (busy()) queueInput(value);
            else void submit(value);
          }}
          onContentChange={handleContentChange}
        />
      </box>
    </box>
  );
}

function WelcomeView(): JSX.Element {
  return (
    <box
      height={15}
      width="100%"
      flexDirection="column"
      alignItems="center"
    >
      <box
        border
        borderStyle="rounded"
        borderColor="#22d3ee"
        width={22}
        height={5}
        justifyContent="center"
        alignItems="center"
      >
        <text fg="#22d3ee" attributes={TextAttributes.BOLD}>❯_</text>
      </box>
      <text fg="#22d3ee" attributes={TextAttributes.BOLD} marginTop={1}>M Y C O D E R</text>
      <text fg="#64748b">Your terminal agent</text>
      <text fg="#64748b">{[
        "Enter          Send message",
        "Shift+Enter    New line",
        "Ctrl+V         Paste",
        "Esc            Interrupt agent",
        "Ctrl+C         Exit mycoder",
        "Ctrl+U         Clear input",
        "Tab            Complete command",
      ].join("\n")}</text>
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
        <text fg="#22d3ee" attributes={TextAttributes.BOLD} wrapMode="char" flexGrow={1}>{task.task}</text>
        <text fg="#64748b">{formatElapsed(task.elapsedMs)}</text>
      </box>
      <box marginTop={1} paddingLeft={2}>
        {isDone
          ? <MarkdownText content={task.text} />
          : <text fg="#ef4444" wrapMode="char">{task.text}</text>}
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
        <text fg="#22d3ee" attributes={TextAttributes.BOLD} wrapMode="char">
          {line.replace(/^#{1,6}\s*/, "")}
        </text>,
      );
    } else if (/^\s*[-*]\s/.test(line)) {
      elements.push(
        <text fg="#e2e8f0" wrapMode="char">
          <span style={{ fg: "#64748b" }}>• </span>
          <InlineSegments text={line.replace(/^\s*[-*]\s*/, "")} />
        </text>,
      );
    } else {
      elements.push(
        <text fg="#e2e8f0" wrapMode="char">
          <InlineSegments text={line} />
        </text>,
      );
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
  if (!text) return <></>;
  const segments = parseInlineSegments(text);
  return (
    <>{segments.map((segment) => (
      <span
        style={{
          fg: segment.code ? "#facc15" : "#e2e8f0",
          bold: segment.bold ? true : undefined,
        }}
      >
        {segment.text}
      </span>
    ))}</>
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
  return `in ${formatTokens(value.inputTokens)} · out ${formatTokens(value.outputTokens)} · cache ${formatTokens(value.cacheReadInputTokens)}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = tokens / 1000;
  if (k >= 1000) return `${k / 1000 >= 100 ? String(Math.round(k / 1000)) : (k / 1000).toFixed(1)}M`;
  return `${k >= 100 ? String(Math.round(k)) : k.toFixed(1)}k`;
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

function createTasksFromMessages(messages: ReadonlyArray<AgentMessage> = []): Array<TuiTask> {
  const tasks: Array<Omit<TuiTask, "id">> = [];
  let task: string | null = null;
  let output: string | null = null;

  const flush = (): void => {
    if (task === null) return;
    tasks.push({
      task,
      status: output === null ? "error" : "done",
      text: output ?? "(no response)",
      elapsedMs: 0,
    });
    task = null;
    output = null;
  };

  for (const message of messages) {
    const text = textOf(message.content);
    if (message.role === "user") {
      if (text.startsWith("[Context fallback]")) continue;
      flush();
      task = text || (message.content.some((block) => block.type !== "text") ? "[attachment]" : "(empty input)");
      output = null;
      continue;
    }
    if (message.role === "assistant" && text) {
      output = output === null ? text : `${output}\n\n${text}`;
    }
  }
  flush();

  return tasks.map((task, index) => ({ ...task, id: index + 1 }));
}
