import type { SingleAgent } from "myloop/agent";

export type InteractiveLoopOptions = {
  agent: SingleAgent;
  submit: (input: string) => Promise<void>;
  write: (text: string) => void;
  onIdle?: () => void;
  onEscape?: () => void;
};

const EXIT_COMMANDS = new Set(["/exit", "/quit"]);

export function createInteractiveLoop({ agent, submit, write, onIdle, onEscape }: InteractiveLoopOptions): {
  handleLine: (rawLine: string) => void;
  handleEscape: () => void;
  interrupt: () => void;
  isStopped: () => boolean;
  drain: () => Promise<void>;
} {
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;

  async function run(input: string): Promise<void> {
    if (EXIT_COMMANDS.has(input)) {
      stopped = true;
      return;
    }
    if (input === "/help") {
      write("Commands: /exit · Esc interrupts · Ctrl+C interrupts, second Ctrl+C exits\n");
      return;
    }
    await submit(input);
    if (!stopped) onIdle?.();
  }

  return {
    handleLine(rawLine: string): void {
      const input = rawLine.trim();
      if (!input) return;
      if (agent.running) {
        write("agent is running — press Esc to interrupt\n");
        return;
      }
      pending = run(input).catch(() => {});
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
    drain(): Promise<void> {
      return pending;
    },
  };
}
