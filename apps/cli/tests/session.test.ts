import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCliSessionId, FileSessionStore } from "../src/session.js";

describe("CLI session store", () => {
  it("saves and loads an atomic session snapshot", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "myloop-cli-"));
    const store = new FileSessionStore({ cwd });
    const sessionId = createCliSessionId();
    const snapshot = { version: 1 as const, messages: [] };

    await store.save(sessionId, snapshot);

    const stored = await store.load(sessionId);
    const createdAt = new Date(sessionId.slice(8, 32).replace(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      "$1T$2:$3:$4.$5Z",
    )).toISOString();
    expect(stored).toMatchObject({ ...snapshot, createdAt });
    expect(JSON.parse(await readFile(store.sessionPath(sessionId), "utf8"))).toMatchObject({ ...snapshot, createdAt });
  });

  it("rejects unsafe session ids", () => {
    const store = new FileSessionStore({ cwd: "." });

    expect(() => store.sessionPath("../escape")).toThrow("session id");
  });

  it("finds the session created most recently", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "myloop-cli-"));
    const store = new FileSessionStore({ cwd });
    const snapshot = { version: 1 as const, messages: [] };

    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "one" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "two" }] },
    ];
    await store.save("older-id", { ...snapshot, messages, createdAt: "2026-01-01T00:00:01.000Z" });
    await store.save("newer-id", { ...snapshot, messages, createdAt: "2026-01-01T00:00:00.000Z" });

    expect(await store.latest()).toBe("older-id");
  });

  it("lists sessions newest first", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "myloop-cli-"));
    const store = new FileSessionStore({ cwd });

    await store.save("older-id", {
      version: 1,
      messages: [
        { role: "user", content: [{ type: "text", text: "one" }] },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.save("newer-id", {
      version: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "one" }] }, { role: "assistant", content: [{ type: "text", text: "two" }] }],
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await store.save("request-only-id", {
      version: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "unanswered" }] }],
      createdAt: "2026-01-01T00:00:02.000Z",
    });

    expect(await store.listSessions()).toEqual([
      { sessionId: "newer-id", createdAt: "2026-01-01T00:00:01.000Z", messageCount: 2 },
      { sessionId: "older-id", createdAt: "2026-01-01T00:00:00.000Z", messageCount: 2 },
    ]);
    expect(await store.latest()).toBe("newer-id");
  });
});
