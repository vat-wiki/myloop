import type { UnreadMessage } from "./drives.js";
import type { MemorySenses } from "../memory/memory.js";

export type SensorDefinition<T> = {
  id: string;
  read(context: BotSensorContext): T | Promise<T>;
};

export type BotSensorContext = {
  cwd?: string;
  now: number;
  tick: number;
  lastActionAt?: number;
  unread: ReadonlyArray<UnreadMessage>;
  failedHealthChecks: number;
  memorySenses?: () => MemorySenses | undefined;
};

export type SensorSnapshot = Record<string, unknown>;

export type SensorRegistryOptions = {
  sensors: ReadonlyArray<SensorDefinition<unknown>>;
  onError?: (sensorId: string, error: unknown) => void;
};

export type SensorRegistry = {
  keys(): ReadonlyArray<string>;
  read(context: BotSensorContext): Promise<SensorSnapshot>;
};

export const ClockSensor: SensorDefinition<{ now: number; tick: number }> = {
  id: "runtime.clock",
  read: ({ now, tick }) => ({ now, tick }),
};

export const UnreadSensor: SensorDefinition<{
  count: number;
  oldestAt?: number;
  ageMs: number;
  messages: ReadonlyArray<UnreadMessage>;
}> = {
  id: "terminal.unread",
  read: ({ now, unread }) => ({
    count: unread.length,
    oldestAt: unread[0]?.at,
    ageMs: unread[0] === undefined ? 0 : Math.max(0, now - unread[0].at),
    messages: unread,
  }),
};

export const HealthSensor: SensorDefinition<{ failedChecks: number }> = {
  id: "host.health",
  read: ({ failedHealthChecks }) => ({ failedChecks: failedHealthChecks }),
};

export const IdleSensor: SensorDefinition<{ lastActionAt?: number; idleMs: number }> = {
  id: "runtime.idle",
  read: ({ now, lastActionAt }) => ({
    lastActionAt,
    idleMs: lastActionAt === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, now - lastActionAt),
  }),
};

export const MemoryHealthSensor: SensorDefinition<MemorySenses> = {
  id: "memory.health",
  read: ({ now, memorySenses }) =>
    memorySenses?.() ?? {
      now,
      pendingLines: 0,
      brokenLinkCount: 0,
      stalestDays: null,
    },
};

export const builtInSensors: ReadonlyArray<SensorDefinition<unknown>> = [
  ClockSensor,
  UnreadSensor,
  HealthSensor,
  IdleSensor,
  MemoryHealthSensor,
];

export function createSensorRegistry({
  sensors,
  onError,
}: SensorRegistryOptions): SensorRegistry {
  return {
    keys: () => sensors.map((sensor) => sensor.id),
    read: async (context) => {
      const snapshot: SensorSnapshot = {};
      await Promise.all(sensors.map(async (sensor) => {
        try {
          snapshot[sensor.id] = await sensor.read(context);
        } catch (error) {
          onError?.(sensor.id, error);
        }
      }));
      return snapshot;
    },
  };
}

export function readSensors(context: BotSensorContext): SensorSnapshot {
  const snapshot: SensorSnapshot = {};
  for (const sensor of builtInSensors) {
    snapshot[sensor.id] = sensor.read(context);
  }
  return snapshot;
}
