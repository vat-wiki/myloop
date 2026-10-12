import type { SingleAgent } from "myloop/agent";

export type InteractiveLoopOptions = {
  agent: SingleAgent;
  submit: (input: string) => Promise<void>;
  write: (text: string) => void;
  onPromptChange?: (continuing: boolean) => void;
  onIdle?: () => void;
  onEscape?: () => void;
};

const EXIT_COMMANDS = new Set(["/exit", "/quit"]);
const CONTINUATION_SUFFIX = "\\";

export function createInteractiveLoop({ agent, submit, write, onPromptChange, onIdle, onEscape }: InteractiveLoopOptions): {
  handleLine: (rawLine: string) => void;
  handleEscape: () => void;
  interrupt: () => void;
  isStopped: () => boolean;
  isContinuing: () => boolean;
  drain: () => Promise<void>;
} {
  let continuation: Array<string> | undefined;
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;

  const stopContinuation = (): void => {
    if (continuation === undefined) return;
    continuation = undefined;
    onPromptChange?.(false);
  };

  async function run(input: string): Promise<void> {
    if (EXIT_COMMANDS.has(input)) {
      stopped = true;
      stopContinuation();
      return;
    }
    if (input === "/help") {
      write("Commands: /exit · /cancel multiline · trailing \\ continues · Esc interrupts · Ctrl+C interrupts, second Ctrl+C exits\n");
      return;
    }
    await submit(input);
    if (!stopped) onIdle?.();
  }

  return {
    handleLine(rawLine: string): void {
      const input = rawLine.trim();
      const continuing = continuation !== undefined;
      if (!input && !continuing) return;
      if (EXIT_COMMANDS.has(input)) {
        stopped = true;
        stopContinuation();
        return;
      }
      if (input === "/help") {
        write("Commands: /exit · /cancel multiline · trailing \\ continues · Esc interrupts · Ctrl+C interrupts, second Ctrl+C exits\n");
        return;
      }
      if (input === "/cancel") {
        if (continuing) {
          stopContinuation();
          write("multiline input cancelled\n");
        }
        return;
      }
      if (agent.running) {
        write("agent is running — press Esc to interrupt\n");
        return;
      }
      const endsWithContinuation = input.endsWith(CONTINUATION_SUFFIX);
      const line = endsWithContinuation ? input.slice(0, -CONTINUATION_SUFFIX.length) : input;
      if (continuation === undefined) {
        if (!endsWithContinuation) {
          pending = run(input).catch(() => {});
          return;
        }
        continuation = [line];
        onPromptChange?.(true);
        return;
      }
      continuation.push(line);
      if (endsWithContinuation) return;
      const multilineInput = continuation.join("\n");
      stopContinuation();
      pending = run(multilineInput).catch(() => {});
    },
    handleEscape(): void {
      if (!agent.running) {
        return;
      }
      agent.abort(new Error("interrupted"));
      write("interrupted\n");
      onEscape?.();
    },
    interrupt(): void {
      if (agent.running) {
        agent.abort(new Error("interrupted"));
        write("interrupted\n");
        return;
      }
      stopped = true;
    },
    isStopped(): boolean {
      return stopped;
    },
    isContinuing(): boolean {
      return continuation !== undefined;
    },
    drain(): Promise<void> {
      return pending;
    },
  };
}
