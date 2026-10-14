import { describe, expect, it } from "vitest";
import { readSensors } from "../../src/bot/sensors.js";

describe("bot sensors", () => {
  it("builds a sensor snapshot from host state", () => {
    const snapshot = readSensors({
      now: 10_000,
      tick: 3,
      lastActionAt: 8_000,
      unread: [{ text: "hello", at: 9_000, source: "user" }],
      failedHealthChecks: 2,
      memorySenses: () => ({
        now: 10_000,
        pendingLines: 4,
        brokenLinkCount: 1,
        stalestDays: 8,
      }),
    });

    expect(snapshot["runtime.idle"]).toEqual({
      lastActionAt: 8_000,
      idleMs: 2_000,
    });
    expect(snapshot["terminal.unread"]).toMatchObject({ count: 1, ageMs: 1_000 });
    expect(snapshot["host.health"]).toEqual({ failedChecks: 2 });
    expect(snapshot["memory.health"]).toEqual({
      now: 10_000,
      pendingLines: 4,
      brokenLinkCount: 1,
      stalestDays: 8,
    });
  });
});
