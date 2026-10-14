import type { SingleAgent } from "myloop/agent";
import { DriveArbiter, type DriveArbiterDeps, type DriveSelection } from "./arbiter.js";
import {
  respondUnreadDrive,
  selfCheckDrive,
  selfMaintenanceDrive,
  memoryGroomingDrive,
  type Drive,
  type UnreadMessage,
} from "./drives.js";
import type { MemorySenses } from "../memory/memory.js";
import { runTask, type TaskOutput } from "../run.js";
import {
  builtInSensors,
  createSensorRegistry,
  type SensorDefinition,
  type SensorRegistry,
  type SensorSnapshot,
} from "./sensors.js";

/** CLI bot 的世界：arbiter 每次心跳会向宿主要一份这样的快照 */
export type CliWorld = {
  now: number;
  tick: number;
  unreadCount: number;
  oldestUnreadAt?: number;
  unreadMessages: ReadonlyArray<UnreadMessage>;
  lastActionAt?: number;
  failedHealthChecks: number;
  pendingLines: number;
  brokenLinkCount: number;
  stalestDays: number | null;
  sensors: SensorSnapshot;
};

export type BotHostOptions = {
  agent: SingleAgent;
  color: boolean;
  width?: number;
  /** 终端渲染层（LineOutput）：驱力行动的输出必须走这里，裸写 stdout 会撞上 readline 输入框 */
  output: TaskOutput;
  /** bot 模式下 readline 收到、因 agent 忙而未处理的用户输入 */
  unread: () => ReadonlyArray<UnreadMessage>;
  /** act 成功后由宿主回写，供 self-maintenance 计算空闲 */
  markAction?: (at: number) => void;
  probes?: Array<() => boolean>;
  /** 记忆库健康信号（可选：宿主没配记忆时不产生记忆驱力压力） */
  memorySenses?: () => MemorySenses;
  drives?: ReadonlyArray<Drive<CliWorld>>;
  extensionDrives?: ReadonlyArray<Drive<CliWorld>>;
  extensionSensors?: ReadonlyArray<SensorDefinition<unknown>>;
  sensorRegistry?: SensorRegistry;
  cwd?: string;
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

  const builtInDrives = options.drives ?? [
    respondUnreadDrive<CliWorld>(),
    selfCheckDrive<CliWorld>(),
    selfMaintenanceDrive<CliWorld>(),
    memoryGroomingDrive<CliWorld>(),
  ];
  const drives = [...builtInDrives, ...(options.extensionDrives ?? [])];

  let lastActionAt: number | undefined;
  const sensorRegistry = options.sensorRegistry ?? createSensorRegistry({
    sensors: [...builtInSensors, ...(options.extensionSensors ?? [])],
  });

  const deps: DriveArbiterDeps<CliWorld> = {
    isBusy: () => agent.running,

    evaluate: async (tick): Promise<CliWorld> => {
      const pending = options.unread();
      const memory = options.memorySenses?.();
      const currentTime = now();
      const sensors = await sensorRegistry.read({
        cwd: options.cwd ?? process.cwd(),
        now: currentTime,
        tick,
        lastActionAt,
        unread: pending,
        failedHealthChecks: probes.filter((probe) => {
          try {
            return !probe();
          } catch {
            return true;
          }
        }).length,
        memorySenses: options.memorySenses ? () => memory : undefined,
      });
      return {
        now: currentTime,
        tick,
        unreadCount: pending.length,
        oldestUnreadAt: pending[0]?.at,
        unreadMessages: [...pending],
        lastActionAt: lastActionAt,
        failedHealthChecks: probes.filter((probe) => !probe()).length,
        pendingLines: memory?.pendingLines ?? 0,
        brokenLinkCount: memory?.brokenLinkCount ?? 0,
        stalestDays: memory?.stalestDays ?? null,
        sensors,
      };
    },

    act: async (selection: DriveSelection) => {
      const prompt = `[${selection.drive.name}] ${selection.outcome.prompt}`;
      const handled = await actWithModel({ agent, prompt, color: options.color, width: options.width, output: options.output });
      if (handled) {
        lastActionAt = now();
        options.markAction?.(lastActionAt);
      }
    },
  };

  return { deps, drives };
}

async function actWithModel({ agent, prompt, color, width, output }: {
  agent: SingleAgent;
  prompt: string;
  color: boolean;
  width?: number;
  output: TaskOutput;
}): Promise<boolean> {
  const driveName = prompt.split("]")[0] ?? "";
  const summary = prompt.split("\n")[0]?.replace(/^\[[^\]]+\]\s*/, "") ?? "";
  output.write(`♥ ${driveName}] ${summary}`);
  try {
    await runTask({
      agent,
      input: prompt,
      saveSession: () => agent.saveSession(),
      output,
      status: (message) => output.write(message),
      trace: (text) => output.write(text),
      color,
      width,
    });
    return true;
  } catch {
    return false;
  }
}
