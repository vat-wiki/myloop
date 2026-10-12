import process from "node:process";

export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type SpinnerOptions = {
  output?: NodeJS.WriteStream;
  intervalMs?: number;
};

export function createSpinner({ output = process.stderr, intervalMs = 120 }: SpinnerOptions = {}): {
  start: (label: string) => void;
  update: (label: string) => void;
  suspend: () => void;
  stop: () => void;
  readonly active: boolean;
} {
  let timer: NodeJS.Timeout | undefined;
  let frame = 0;
  let label = "";

  function render(): void {
    output.write(`\r${FRAMES[frame % FRAMES.length]} ${label}   \x1b[K`);
    frame += 1;
  }

  return {
    start(next: string): void {
      if (timer) return;
      label = next;
      render();
      timer = setInterval(render, intervalMs);
      timer.unref?.();
    },
    update(next: string): void {
      label = next;
    },
    suspend(): void {
      if (!timer) return;
      output.write("\r\x1b[K");
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      output.write("\r\x1b[K");
    },
    get active(): boolean {
      return timer !== undefined;
    },
  };
}
