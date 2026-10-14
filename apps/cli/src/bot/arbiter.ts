import type { Drive, DriveOutcome } from "./drives.js";

export type DriveSelection = {
  drive: Drive<never>;
  outcome: DriveOutcome;
};

/** 单个驱力一次 tick 的评测快照：outcome 为 null 表示未产生压力 */
export type DriveEvaluation = {
  drive: Drive<never>;
  outcome: DriveOutcome | null;
  /** 压力 >= threshold 才为 true；冷却中的驱力照报压力但算未过门 */
  passed: boolean;
};

export type DriveArbiterOptions = {
  drives: ReadonlyArray<Drive<never>>;
  /** 毫秒；任意两次行动之间的最小间隔，防止连发 */
  minIntervalMs?: number;
  now?: () => number;
  onSkip?: (reason: string) => void;
  /** 每 tick 评测完驱力后回调（含全部驱力的快照），宿主用来打日志/观测 */
  onEvaluated?: (evaluations: ReadonlyArray<DriveEvaluation>) => void;
  onAct?: (selection: DriveSelection) => void;
};

export type DriveArbiterDeps<W> = {
  /** 由宿主把真实世界状态翻译成 World 快照 */
  evaluate: (tick: number) => W | Promise<W>;
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
  readonly #onEvaluated?: (evaluations: ReadonlyArray<DriveEvaluation>) => void;
  readonly #onAct?: (selection: DriveSelection) => void;
  #cooldowns = new Map<string, number>();
  #lastActedAt: number | null = null;

  constructor({ drives, minIntervalMs = 0, now = Date.now, onSkip, onEvaluated, onAct }: DriveArbiterOptions) {
    if (drives.length === 0) throw new Error("bot loop needs at least one drive");
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new Error("minIntervalMs must be a non-negative number");
    }
    this.#drives = [...drives];
    this.#minIntervalMs = minIntervalMs;
    this.#now = now;
    this.#onSkip = onSkip;
    this.#onEvaluated = onEvaluated;
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

    const world = await deps.evaluate(tick);
    const candidates: Array<{ drive: Drive<never>; outcome: DriveOutcome; pressure: number }> = [];
    const evaluations: Array<DriveEvaluation> = [];
    for (const drive of this.#drives) {
      const outcome = await drive.evaluate(world as never);
      const lastTrigger = this.#cooldowns.get(drive.name);
      const cooling = lastTrigger !== undefined && now - lastTrigger < drive.cooldownMs;
      const passed = outcome !== null && outcome.pressure >= drive.threshold && !cooling;
      evaluations.push({ drive, outcome, passed });
      if (!passed) continue;
      candidates.push({ drive, outcome, pressure: outcome.pressure + jitter(tick) });
      this.#cooldowns.set(drive.name, now);
    }
    this.#onEvaluated?.(evaluations);

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
