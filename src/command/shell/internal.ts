import process from "node:process";

export const DEFAULT_HARD_TIMEOUT = 120_000;
export const DEFAULT_IDLE_TIMEOUT = 30_000;
export const KILL_GRACE_MS = 2_000;

export function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}
