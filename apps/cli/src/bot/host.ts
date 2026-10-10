import type { SingleAgent } from "myloop/agent";
import { DriveArbiter, type DriveArbiterDeps, type DriveSelection } from "./arbiter.js";
import {
  respondUnreadDrive,
  selfCheckDrive,
  selfMaintenanceDrive,
  type Drive,
} from "./drives.js";
import { runTask } from "../run.js";

/** CLI bot 的世界：arbiter 每次心跳会向宿主要一份这样的快照 */
export type CliWorld = {
  now: number;
  tick: number;
  unreadCount: number;
  oldestUnreadAt?: number;
  lastActionAt?: number;
  failedHealthChecks: number;
};

export type BotHostOptions = {
  agent: SingleAgent;
  color: boolean;
  width?: number;
  /** bot 模式下 readline 收到、因 agent 忙而未处理的用户输入 */
  unread: () => Array<{ text: string; at: number }>;
  /** act 成功后由宿主回写，供 self-maintenance 计算空闲 */
  markAction?: (at: number) => void;
  probes?: Array<() => boolean>;
  drives?: ReadonlyArray<Drive<CliWorld>>;
  now?: () => number;
};

/**
 * 宿主实现：眼睛（evaluate）和手（act）。
 * DriveArbiter 决策，这里执行——轻任务纯代码处理，重任务才调模型。
 */
export function createBotHost(options: BotHostOptions): {
  deps: DriveArbiterDeps<CliWorld>;
  drives: ReadonlyArray<Drive<CliWorld>>;
} {
  const { agent } = options;
  const now = options.now ?? Date.now;
  const probes = options.probes ?? [];

  const drives = options.drives ?? [
    respondUnreadDrive<CliWorld>(),
    selfCheckDrive<CliWorld>(),
    selfMaintenanceDrive<CliWorld>(),
  ];

  let lastActionAt: number | undefined;

  const deps: DriveArbiterDeps<CliWorld> = {
    isBusy: () => agent.running,

    evaluate: (tick): CliWorld => {
      const pending = options.unread();
      return {
        now: now(),
        tick,
        unreadCount: pending.length,
        oldestUnreadAt: pending[0]?.at,
        lastActionAt: lastActionAt,
        failedHealthChecks: probes.filter((probe) => !probe()).length,
      };
    },

    act: async (selection: DriveSelection) => {
      const prompt = `[${selection.drive.name}] ${selection.outcome.prompt}`;
      const handled = await actWithModel({ agent, prompt, color: options.color, width: options.width });
      if (handled) {
        lastActionAt = now();
        options.markAction?.(lastActionAt);
      }
    },
  };

  return { deps, drives };
}

async function actWithModel({ agent, prompt, color, width }: {
  agent: SingleAgent;
  prompt: string;
  color: boolean;
  width?: number;
}): Promise<boolean> {
  process.stderr.write(`\n♥ ${prompt.split("]")[0]}]\n`);
  try {
    await runTask({
      agent,
      input: prompt,
      saveSession: () => agent.saveSession(),
      output: process.stdout,
      status: (message) => process.stderr.write(`${message}\n`),
      trace: (text) => process.stderr.write(text),
      color,
      width,
    });
    return true;
  } catch {
    return false;
  }
}
