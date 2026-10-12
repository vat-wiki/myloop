/**
 * 驱力只声明"我需要什么感官"（Needs 类型），不关心世界的全貌。
 * World 由宿主定义：宿主的世界里有什么，驱力就能用什么——加驱力无需改核心类型。
 */
export type DriveOutcome = {
  /** 0 = 无压力，1 = 最疼 */
  pressure: number;
  /** 压力达标时注入 runtime 的行动 prompt */
  prompt: string;
};

export type Drive<W = unknown> = {
  name: string;
  threshold: number;
  cooldownMs: number;
  evaluate(world: W): DriveOutcome | null;
};

/** 自定义驱力的最小样板：实现 evaluate 纯函数，声明自己需要的感官即可 */
export function defineDrive<W>(drive: Drive<W>): Drive<W> {
  return drive;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// ---------- 内置驱力的感官声明（Needs）：谁想用，谁的世界至少要有这些字段 ----------

export type UnreadSenses = {
  now: number;
  unreadCount: number;
  oldestUnreadAt?: number;
  /** 未读明细（可选：宿主没给明细时 prompt 退化为纯计数） */
  unreadMessages?: ReadonlyArray<UnreadMessage>;
};

export type UnreadMessage = {
  text: string;
  at: number;
  /** user = 用户当面交办；ambient = 环境/外部消息 */
  source: "user" | "ambient";
};

export type HealthSenses = {
  failedHealthChecks: number;
};

export type IdleSenses = {
  now: number;
  lastActionAt?: number;
};

/** 记忆库的健康感官：来源见 apps/cli/src/memory/memory.ts 的 Memory.senses() */
export type MemoryHealthSenses = {
  pendingLines: number;
  brokenLinkCount: number;
  stalestDays: number | null;
};

export function respondUnreadDrive<W extends UnreadSenses>(options?: {
  threshold?: number;
  cooldownMs?: number;
  unreadQuota?: number;
  patienceMs?: number;
}): Drive<W> {
  const unreadQuota = options?.unreadQuota ?? 5;
  const patienceMs = options?.patienceMs ?? 10 * 60_000;
  return {
    name: "respond-unread",
    threshold: options?.threshold ?? 0.5,
    cooldownMs: options?.cooldownMs ?? 30_000,
    evaluate: ({ unreadCount, oldestUnreadAt, unreadMessages, now }) => {
      if (unreadCount <= 0) return null;
      const messages = unreadMessages ?? [];
      const userMsgs = messages.filter((m) => m.source === "user");
      const ambientMsgs = messages.filter((m) => m.source === "ambient");
      // 用户交办是必须做而非想做的：不被痛阈过滤（否则单条要熬满 count×age 才触发），
      // 下一 tick 即行动；ambient 保持数量×等待的渐变。
      if (userMsgs.length > 0) {
        return {
          pressure: 1,
          prompt: [
            `${unreadCount} 条未读积压，逐条处理：`,
            ...userMsgs.map((m) => `- [用户交办] ${m.text}`),
            ...ambientMsgs.map((m) => `- [环境] ${m.text}`),
            "先逐条回应用户交办（原话见上），再处理其余环境消息。",
          ].join("\n"),
        };
      }
      const age = oldestUnreadAt === undefined ? 0 : Math.max(0, now - oldestUnreadAt);
      const pressure = clamp01(unreadCount / unreadQuota) * clamp01(age / patienceMs);
      if (pressure <= 0) return null;
      const lines = [
        `${unreadCount} 条未读积压，逐条处理：`,
        ...ambientMsgs.map((m) => `- [环境] ${m.text}`),
        "逐条阅读并回复最重要的问题。",
      ];
      return {
        pressure,
        prompt: lines.join("\n"),
      };
    },
  };
}

export function selfCheckDrive<W extends HealthSenses = HealthSenses>(options?: {
  threshold?: number;
  cooldownMs?: number;
}): Drive<W> {
  return {
    name: "self-check",
    threshold: options?.threshold ?? 0.8,
    cooldownMs: options?.cooldownMs ?? 60_000,
    evaluate: ({ failedHealthChecks }) => {
      if (failedHealthChecks <= 0) return null;
      return {
        pressure: 1,
        prompt: `检测到 ${failedHealthChecks} 项健康检查失败，排查原因并尝试修复。`,
      };
    },
  };
}

export function selfMaintenanceDrive<W extends IdleSenses = IdleSenses>(options?: {
  threshold?: number;
  cooldownMs?: number;
  idleFullMs?: number;
}): Drive<W> {
  const idleFullMs = options?.idleFullMs ?? 120 * 60_000;
  return {
    name: "self-maintenance",
    threshold: options?.threshold ?? 0.6,
    cooldownMs: options?.cooldownMs ?? 6 * 60 * 60_000,
    evaluate: ({ lastActionAt, now }) => {
      const elapsed = lastActionAt === undefined
        ? idleFullMs
        : Math.min(Math.max(0, now - lastActionAt), idleFullMs);
      const pressure = clamp01(elapsed / idleFullMs);
      if (pressure <= 0) return null;
      return {
        pressure,
        prompt: [
          "已空闲较久，做一件小的自我维护，按优先级选其一：",
          "1) git status/diff 核对工作区是否有未提交或半成品改动，验证后处置；",
          "2) 记忆库巡检：rg 查 inbox.md 积压与 [[断链]]，核对 index 与条目一致；",
          "3) 复核 wiki 里 verified 最旧的条目，对照现实刷新或修正；",
          "4) 都正常则刷新 state.md 巡检记录，或做一个小的自我改进。",
        ].join("\n"),
      };
    },
  };
}

/**
 * 记忆整理驱力：pending 有积压或 wiki 有断链时产生压力，空闲时也会缓慢累积。
 * 行动 prompt 只给方向，具体 wiki 操作由模型用文件工具自主完成。
 */
export function memoryGroomingDrive<W extends MemoryHealthSenses = MemoryHealthSenses>(options?: {
  threshold?: number;
  cooldownMs?: number;
  /** 闲置多久后哪怕没有明显问题也主动整理一次（毫秒） */
  idleFullMs?: number;
}): Drive<W & { now: number; lastActionAt?: number }> {
  const threshold = options?.threshold ?? 0.5;
  const cooldownMs = options?.cooldownMs ?? 30 * 60_000;
  const idleFullMs = options?.idleFullMs ?? 12 * 60 * 60_000;
  return {
    name: "memory-grooming",
    threshold,
    cooldownMs,
    evaluate: ({ pendingLines, brokenLinkCount, stalestDays, lastActionAt, now }) => {
      const problems = Math.min(1, (pendingLines / 20) * 0.5 + (brokenLinkCount / 5) * 0.5);
      const elapsed = lastActionAt === undefined
        ? idleFullMs
        : Math.min(Math.max(0, now - lastActionAt), idleFullMs);
      const idle = elapsed / idleFullMs;
      const stale = stalestDays === null ? 0 : Math.min(1, stalestDays / 14);
      const pressure = Math.max(problems, idle, stale);
      if (pressure < 0.05) return null;
      const parts: Array<string> = [];
      if (pendingLines > 0) parts.push(`PENDING 积压 ${pendingLines} 行`);
      if (brokenLinkCount > 0) parts.push(`${brokenLinkCount} 个断链`);
      if (stalestDays !== null && stalestDays >= 7) parts.push(`最旧条目 ${stalestDays} 天未验证`);
      const reason = parts.length > 0 ? parts.join("、") : "例行整理";
      return {
        pressure,
        prompt: `记忆整理（${reason}）：读取记忆目录 index.md，把 inbox.md 的摘要消化成条目或并入现有条目，rg 排查 [[断链]]，新条目前先检索防重复，更新相关 updated/verified。`,
      };
    },
  };
}
