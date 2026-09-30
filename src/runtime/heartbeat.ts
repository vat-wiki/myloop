export type HeartbeatTimer = {
  clear(): void;
};

export type HeartbeatTimerFactory = (
  callback: () => void,
  intervalMs: number,
) => HeartbeatTimer;

export type HeartbeatEvent = {
  tick: number;
  at: number;
  running: boolean;
};

export type HeartbeatOptions = {
  intervalMs: number;
  mode?: "running" | "always";
  timer?: HeartbeatTimerFactory;
};

export type HeartbeatHooks = {
  isBusy: () => boolean;
  onTick: (event: HeartbeatEvent) => void;
};

const defaultHeartbeatTimerFactory: HeartbeatTimerFactory = (callback, intervalMs) => {
  const timer = setTimeout(callback, intervalMs);
  timer.unref?.();
  return { clear: () => clearTimeout(timer) };
};

export class Heartbeat {
  readonly #timerFactory: HeartbeatTimerFactory;
  readonly #hooks: HeartbeatHooks;
  readonly #intervalMs: number;
  readonly #mode: "running" | "always";
  #timer: HeartbeatTimer | null = null;
  #tick = 0;
  #active = false;
  #stopped = false;

  constructor(options: HeartbeatOptions, hooks: HeartbeatHooks) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("heartbeat intervalMs must be a positive number");
    }

    this.#intervalMs = options.intervalMs;
    this.#mode = options.mode ?? "running";
    this.#timerFactory = options.timer ?? defaultHeartbeatTimerFactory;
    this.#hooks = hooks;
    if (this.#mode === "always") this.#start();
  }

  get mode(): "running" | "always" {
    return this.#mode;
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  start(): void {
    this.#stopped = false;
    this.#start();
  }

  stop(): void {
    this.#stopped = true;
    this.#clear();
  }

  resume(): void {
    this.#start();
  }

  pause(): void {
    if (this.#mode !== "running") return;
    this.#clear();
  }

  #start(): void {
    if (this.#stopped || this.#active) return;
    this.#active = true;
    this.#schedule();
  }

  #clear(): void {
    this.#timer?.clear();
    this.#timer = null;
    this.#active = false;
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = this.#timerFactory(() => {
      this.#timer = null;
      this.#tick += 1;
      this.#hooks.onTick({
        tick: this.#tick,
        at: Date.now(),
        running: this.#hooks.isBusy(),
      });
      if (this.#active) this.#schedule();
    }, this.#intervalMs);
  }
}
