import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAppSessionId,
  createAppSessionId,
  FileSessionStore,
  isValidAppSessionId,
} from "../src/index.js";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("app session store", () => {
  it("saves, loads, lists, and rejects unsafe ids", async () => {
    const cwd = await makeTemporaryDirectory();
    const store = new FileSessionStore({ cwd });
    const snapshot = { version: 1 as const, messages: [] };

    await store.save("work-2", snapshot);
    await store.save("work-1", snapshot);

    expect(store.sessionPath("work-1")).toBe(join(cwd, ".agents", "mycoder", "sessions", "work-1.json"));
    await expect(store.load("work-1")).resolves.toEqual(snapshot);
    await expect(store.list()).resolves.toEqual(["work-1", "work-2"]);
    expect(isValidAppSessionId("work.1_2")).toBe(true);
    expect(() => assertAppSessionId("../escape")).toThrow("session id");
  });

  it("reports corrupt snapshots atomically written to disk", async () => {
    const cwd = await makeTemporaryDirectory();
    const store = new FileSessionStore({ cwd });
    await store.save("broken", { version: 1, messages: [] });
    await writeFile(store.sessionPath("broken"), "{not-json", "utf8");

    await expect(store.load("broken")).rejects.toThrow("invalid session file");
  });

  it("generates unique safe ids", () => {
    const first = createAppSessionId();
    const second = createAppSessionId();

    expect(isValidAppSessionId(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^session-/);
  });

  it("writes snapshots through a temporary file", async () => {
    const cwd = await makeTemporaryDirectory();
    const store = new FileSessionStore({ cwd });
    const snapshot = { version: 1 as const, messages: [] };

    await store.save("safe", snapshot);

    expect(JSON.parse(await readFile(store.sessionPath("safe"), "utf8"))).toEqual(snapshot);
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mycoder-app-sdk-session-"));
  temporaryDirectories.push(directory);
  return directory;
}
