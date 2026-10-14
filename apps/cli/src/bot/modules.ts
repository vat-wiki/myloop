import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Drive } from "./drives.js";
import { builtInSensors } from "./sensors.js";
import type { SensorDefinition } from "./sensors.js";

export type LoadBotModuleOptions = {
  sensorPaths?: ReadonlyArray<string>;
  drivePaths?: ReadonlyArray<string>;
  cwd?: string;
};

export type LoadedBotModules = {
  sensors: ReadonlyArray<SensorDefinition<unknown>>;
  drives: ReadonlyArray<Drive<Record<string, unknown>>>;
};

export async function loadBotModules(
  options: LoadBotModuleOptions = {},
): Promise<LoadedBotModules> {
  const sensors: Array<SensorDefinition<unknown>> = [];
  const sensorIds = new Set<string>();
  const builtInSensorIds = new Set(builtInSensors.map((sensor) => sensor.id));
  for (const path of options.sensorPaths ?? []) {
    const sensor = await importBotModule<SensorDefinition<unknown>>(path, options.cwd);
    assertSensor(sensor, path);
    if (builtInSensorIds.has(sensor.id)) {
      throw new Error(`sensor id "${sensor.id}" is reserved by a built-in sensor in ${path}`);
    }
    if (sensorIds.has(sensor.id)) {
      throw new Error(`duplicate sensor id "${sensor.id}" in ${path}`);
    }
    sensorIds.add(sensor.id);
    sensors.push(sensor);
  }

  const registeredSensorIds = new Set([...builtInSensorIds, ...sensorIds]);
  const drives: Array<Drive<Record<string, unknown>>> = [];
  const driveNames = new Set<string>();
  for (const path of options.drivePaths ?? []) {
    const drive = await importBotModule<Drive<Record<string, unknown>>>(path, options.cwd);
    assertDrive(drive, path);
    const missingSensor = drive.requires.find((sensorId) => !registeredSensorIds.has(sensorId));
    if (missingSensor !== undefined) {
      throw new Error(`drive "${drive.name}" requires unknown sensor "${missingSensor}" in ${path}`);
    }
    if (driveNames.has(drive.name)) {
      throw new Error(`duplicate drive name "${drive.name}" in ${path}`);
    }
    driveNames.add(drive.name);
    drives.push(drive);
  }

  return { sensors, drives };
}

async function importBotModule<T>(path: string, cwd?: string): Promise<T> {
  const modulePath = resolve(cwd ?? process.cwd(), path);
  const imported = await import(pathToFileURL(modulePath).href) as { default?: unknown };
  if (imported.default === undefined) {
    throw new Error(`bot module must have a default export: ${path}`);
  }
  return imported.default as T;
}

function assertSensor(value: unknown, path: string): asserts value is SensorDefinition<unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`sensor default export must be an object: ${path}`);
  }
  const sensor = value as Record<string, unknown>;
  if (typeof sensor.id !== "string" || !sensor.id.trim()) {
    throw new Error(`sensor id must be a non-empty string: ${path}`);
  }
  if (typeof sensor.read !== "function") {
    throw new Error(`sensor read must be a function: ${path}`);
  }
}

function assertDrive(value: unknown, path: string): asserts value is Drive<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`drive default export must be an object: ${path}`);
  }
  const drive = value as Record<string, unknown>;
  if (typeof drive.name !== "string" || !drive.name.trim()) {
    throw new Error(`drive name must be a non-empty string: ${path}`);
  }
  if (!Array.isArray(drive.requires) || drive.requires.some((item) => typeof item !== "string")) {
    throw new Error(`drive requires must be an array of sensor ids: ${path}`);
  }
  if (typeof drive.threshold !== "number" || !Number.isFinite(drive.threshold) || drive.threshold < 0 || drive.threshold > 1) {
    throw new Error(`drive threshold must be between 0 and 1: ${path}`);
  }
  if (typeof drive.cooldownMs !== "number" || !Number.isInteger(drive.cooldownMs) || drive.cooldownMs < 0) {
    throw new Error(`drive cooldownMs must be a non-negative integer: ${path}`);
  }
  if (typeof drive.evaluate !== "function") {
    throw new Error(`drive evaluate must be a function: ${path}`);
  }
}
