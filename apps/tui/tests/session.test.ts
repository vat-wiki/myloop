import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTuiSessionId, FileSessionStore, isValidTuiSessionId } from "../src/session.js";

describe("TUI file session store", () => {
  const temporaryDirectories: Array<string> = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })));
  });

  it("saves and loads JSON snapshots under the sessions directory", async () => {
    const cwd = await makeTemporaryDirectory();
    const store = new FileSessionStore({ cwd });

    await store.save("work-1", { version: 1, messages: [] });
    await store.save("work-1", {
      version: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });

    expect(store.sessionPath("work-1")).toBe(join(cwd, ".agents", "myloop", "sessions", "work-1.json"));
    await expect(store.load("work-1")).resolves.toEqual({
      version: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
  });

  it("returns undefined for missing sessions and rejects unsafe ids", async () => {
    const cwd = await makeTemporaryDirectory();
    const store = new FileSessionStore({ cwd });

    await expect(store.load("missing")).resolves.toBeUndefined();
    expect(isValidTuiSessionId("work.1_2")).toBe(true);
    await expect(store.save("../escape", { version: 1, messages: [] })).rejects.toThrow("session id");
  });

  it("generates unique safe ids for new sessions", () => {
    const first = createTuiSessionId();
    const second = createTuiSessionId();

    expect(isValidTuiSessionId(first)).toBe(true);
    expect(isValidTuiSessionId(second)).toBe(true);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^session-/);
  });

  it("reports corrupt session files instead of silently dropping history", async () => {
    const cwd = await makeTemporaryDirectory();
    const store = new FileSessionStore({ cwd });
    const path = store.sessionPath("broken");
    await store.save("broken", { version: 1, messages: [] });
    await writeFile(path, "{not-json", "utf8");

    await expect(store.load("broken")).rejects.toThrow("invalid session file");
  });

  it("lists persisted session ids", async () => {
    const cwd = await makeTemporaryDirectory();
    const store = new FileSessionStore({ cwd });

    await store.save("work-2", { version: 1, messages: [] });
    await store.save("work-1", { version: 1, messages: [] });

    await expect(store.list()).resolves.toEqual(["work-1", "work-2"]);
  });

  async function makeTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "myloop-tui-session-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});
