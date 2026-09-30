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

    expect(await store.load(sessionId)).toEqual(snapshot);
    expect(JSON.parse(await readFile(store.sessionPath(sessionId), "utf8"))).toEqual(snapshot);
  });

  it("rejects unsafe session ids", () => {
    const store = new FileSessionStore({ cwd: "." });

    expect(() => store.sessionPath("../escape")).toThrow("session id");
  });
});
