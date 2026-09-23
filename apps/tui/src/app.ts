import readline from "node:readline";
import type { SingleAgent } from "mycoder/agent";
import type { AgentContentBlock } from "mycoder/messages";
import { TuiPresenter, errorText, formatTuiLine, stripControlCharacters, style } from "./presenter.js";

export type TuiAppOptions = {
  agent: SingleAgent;
  protocol: string;
  model: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  isTTY?: boolean;
};

export async function runTuiApp({
  agent,
  protocol,
  model,
  input = process.stdin,
  output = process.stdout,
  isTTY = process.stdout.isTTY,
}: TuiAppOptions): Promise<void> {
  const presenter = new TuiPresenter();
  const stream = output as NodeJS.WriteStream;
  const renderedCount = { value: 0 };
  const streamingText = { value: false };
  const unsubscribe = observeAgent(agent, presenter, () => writeNewLines());
  const rl = readline.createInterface({
    input,
    output: isTTY ? stream : undefined,
    prompt: style.cyan("❯ "),
    terminal: isTTY,
  });

  presenter.push("system", `mycoder TUI · protocol ${protocol} · model ${model}`);
  presenter.push("dim", "Type a task. /help shows commands. Ctrl+C aborts or exits.");
  writeNewLines();
  rl.prompt();

  const pending: Array<string> = [];
  let processing = false;
  let closed = false;
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  rl.on("line", (line) => {
    pending.push(line);
    void processPending();
  });
  rl.on("SIGINT", () => {
    if (agent.running) {
      agent.abort();
      presenter.push("dim", "aborting current task...");
      writeNewLines();
      rl.prompt(true);
      return;
    }
    rl.close();
  });
  rl.on("close", () => {
    if (closed) return;
    closed = true;
    presenter.push("system", "bye");
    writeNewLines();
    unsubscribe();
    resolveClosed?.();
  });

  await closedPromise;

  async function processPending(): Promise<void> {
    if (processing) return;
    processing = true;

    while (pending.length > 0 && !closed) {
      const input = pending.shift()?.trim();
      if (input === undefined || input.length === 0) {
        rl.prompt(true);
        continue;
      }

      if (handleCommand(input)) {
        if (!closed) rl.prompt(true);
        continue;
      }

      presenter.push("user", input);
      writeNewLines();
      try {
        await agent.run(input);
      } catch (error) {
        if (!isAbortError(error)) {
          presenter.push("error", errorText(error));
          writeNewLines();
        }
      }
      if (!closed) rl.prompt(true);
    }

    processing = false;
  }

  function handleCommand(input: string): boolean {
    if (input === "/exit" || input === "/quit") {
      rl.close();
      return true;
    }
    if (input === "/reset") {
      agent.reset();
      presenter.push("system", "conversation and usage reset");
      writeNewLines();
      return true;
    }
    if (input === "/usage") {
      const usage = agent.usage;
      presenter.push("usage", `requests ${usage.requests} · in ${usage.inputTokens} · out ${usage.outputTokens} · total ${usage.totalTokens}`);
      writeNewLines();
      return true;
    }
    if (input === "/help") {
      presenter.push("system", "Commands: /help, /usage, /reset, /exit");
      writeNewLines();
      return true;
    }
    return false;
  }

  function observeAgent(
    observedAgent: SingleAgent,
    eventPresenter: TuiPresenter,
    flush: () => void,
  ): () => void {
    const listeners: Array<() => void> = [];
    listeners.push(observedAgent.on("assistant_message", (event) => {
      if (streamingText.value) {
        stream.write("\n");
        streamingText.value = false;
      } else {
        eventPresenter.pushEvent({ type: "assistant_text", text: textOf(event.message.content) });
      }
      flush();
    }));
    listeners.push(observedAgent.on("text_delta", (event) => {
      if (!streamingText.value) {
        const line = {
          kind: "assistant",
          text: "",
          timestamp: new Date(),
        } as const;
        stream.write(`${formatTuiLine(line)} `);
        streamingText.value = true;
      }
      stream.write(stripControlCharacters(event.delta));
      flush();
    }));
    listeners.push(observedAgent.on("tool_start", (event) => {
      eventPresenter.pushEvent({ type: "tool_start", name: event.name, input: event.input });
      flush();
    }));
    listeners.push(observedAgent.on("tool_end", (event) => {
      eventPresenter.pushEvent({ type: "tool_end", name: event.name, output: event.output });
      flush();
    }));
    listeners.push(observedAgent.on("model_usage", (event) => {
      eventPresenter.pushEvent({
        type: "usage",
        inputTokens: event.usage?.inputTokens ?? 0,
        outputTokens: event.usage?.outputTokens ?? 0,
        totalTokens: event.usage?.totalTokens ?? 0,
      });
      flush();
    }));
    listeners.push(observedAgent.on("context_compacted", () => {
      eventPresenter.pushEvent({ type: "context_compacted" });
      flush();
    }));
    listeners.push(observedAgent.on("error", (event) => {
      eventPresenter.pushEvent({ type: "error", error: event.error });
      flush();
    }));
    return () => listeners.forEach((unsubscribe) => unsubscribe());
  }

  function textOf(content: Array<AgentContentBlock>): string {
    return content
      .filter((block) => block.type === "text")
      .map((block) => block.type === "text" ? block.text : "")
      .join("\n")
      .trim();
  }

  function writeNewLines(): void {
    const rendered = presenter.renderFrom(renderedCount.value);
    if (rendered.length > 0) stream.write(`${rendered}\n`);
    renderedCount.value = presenter.lines.length;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
