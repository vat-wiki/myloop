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
  const queue: Array<string> = [];
  let processing = false;
  let stopped = false;

  async function drain(): Promise<void> {
    if (processing) return;
    processing = true;
    let didWork = false;
    try {
      while (queue.length > 0) {
        const line = queue.shift();
        if (line === undefined) break;
        const input = line.trim();
        if (!input) continue;
        if (EXIT_COMMANDS.has(input)) {
          stopped = true;
          return;
        }
        if (input === "/help") {
          write("Commands: /exit · Esc interrupts · Ctrl+C interrupts, second Ctrl+C exits\n");
          continue;
        }
        if (agent.running) {
          write("agent is running — input queued\n");
          queue.push(input);
          return;
        }
        didWork = true;
        await submit(input);
        if (stopped) return;
      }
    } finally {
      processing = false;
    }
    if (didWork && !stopped) onIdle?.();
  }

  return {
    handleLine(rawLine: string): void {
      queue.push(rawLine);
      void drain();
    },
    handleEscape(): void {
      if (!agent.running) {
        return;
      }
      agent.abort(new Error("interrupted"));
      queue.length = 0;
      write("interrupted — queued input discarded\n");
      onEscape?.();
    },
    interrupt(): void {
      if (agent.running) {
        agent.abort(new Error("interrupted"));
        queue.length = 0;
        write("interrupted — queued input discarded\n");
        return;
      }
      stopped = true;
    },
    isStopped(): boolean {
      return stopped;
    },
    drain,
  };
}
