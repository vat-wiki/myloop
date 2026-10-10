import type { Drive, DriveOutcome } from "./drives.js";

export type DriveSelection = {
  drive: Drive<never>;
  outcome: DriveOutcome;
};

export type DriveArbiterOptions = {
  drives: ReadonlyArray<Drive<never>>;
  /** 毫秒；任意两次行动之间的最小间隔，防止连发 */
  minIntervalMs?: number;
  now?: () => number;
  onSkip?: (reason: string) => void;
  onAct?: (selection: DriveSelection) => void;
};

export type DriveArbiterDeps<W> = {
  /** 由宿主把真实世界状态翻译成 World 快照 */
  evaluate: (tick: number) => W;
  act: (selection: DriveSelection) => Promise<void>;
  isBusy: () => boolean;
};

/**
 * 驱力仲裁者（脑干）：每个心跳 tick 被调用一次。
 * 不理解世界的结构——World 由宿主声明，驱力各自声明自己需要的感官子集。
 */
export class DriveArbiter<W> {
  readonly #drives: ReadonlyArray<Drive<never>>;
  readonly #minIntervalMs: number;
  readonly #now: () => number;
  readonly #onSkip?: (reason: string) => void;
  readonly #onAct?: (selection: DriveSelection) => void;
  #cooldowns = new Map<string, number>();
  #lastActedAt: number | null = null;

  constructor({ drives, minIntervalMs = 0, now = Date.now, onSkip, onAct }: DriveArbiterOptions) {
    if (drives.length === 0) throw new Error("bot loop needs at least one drive");
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new Error("minIntervalMs must be a non-negative number");
    }
    this.#drives = [...drives];
    this.#minIntervalMs = minIntervalMs;
    this.#now = now;
    this.#onSkip = onSkip;
    this.#onAct = onAct;
  }

  /** 每个心跳 tick 调用一次 */
  async tick(tick: number, deps: DriveArbiterDeps<W>): Promise<DriveSelection | null> {
    if (deps.isBusy()) {
      this.#onSkip?.("busy");
      return null;
    }
    const now = this.#now();
    if (this.#lastActedAt !== null && now - this.#lastActedAt < this.#minIntervalMs) {
      this.#onSkip?.("min-interval");
      return null;
    }

    const world = deps.evaluate(tick);
    const candidates: Array<{ drive: Drive<never>; outcome: DriveOutcome; pressure: number }> = [];
    for (const drive of this.#drives) {
      const outcome = drive.evaluate(world as never);
      if (!outcome) continue;
      if (outcome.pressure < drive.threshold) continue;
      const lastTrigger = this.#cooldowns.get(drive.name);
      if (lastTrigger !== undefined && now - lastTrigger < drive.cooldownMs) continue;
      candidates.push({ drive, outcome, pressure: outcome.pressure + jitter(tick) });
      this.#cooldowns.set(drive.name, now);
    }

    const winner = candidates.sort((a, b) => b.pressure - a.pressure)[0];
    if (!winner) {
      this.#onSkip?.("no-drive-above-threshold");
      return null;
    }

    const selection: DriveSelection = { drive: winner.drive, outcome: winner.outcome };
    this.#lastActedAt = now;
    this.#onAct?.(selection);
    await deps.act(selection);
    return selection;
  }
}

/** 稳定的微小扰动：同分驱力按 tick 轮转，避免永远选中同一个 */
function jitter(tick: number): number {
  return (tick % 7) * 0.001;
}
