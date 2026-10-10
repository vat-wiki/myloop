import { describe, expect, it } from "vitest";
import {
  defineDrive,
  respondUnreadDrive,
  selfCheckDrive,
  selfMaintenanceDrive,
  type Drive,
} from "../../src/bot/drives.js";

const NOW = 1_000_000;

type DemoWorld = UnreadSenses & HealthSenses & IdleSenses;
type UnreadSenses = { now: number; unreadCount: number; oldestUnreadAt?: number };
type HealthSenses = { failedHealthChecks: number };
type IdleSenses = { now: number; lastActionAt?: number };

describe("respondUnreadDrive", () => {
  it("returns null when there is nothing unread", () => {
    const drive = respondUnreadDrive<DemoWorld>();
    expect(drive.evaluate({ now: NOW, unreadCount: 0, failedHealthChecks: 0 })).toBeNull();
  });

  it("pressure scales with backlog and age", () => {
    const drive = respondUnreadDrive<DemoWorld>();

    const freshFew = drive.evaluate({ now: NOW, unreadCount: 2, oldestUnreadAt: NOW - 60_000, failedHealthChecks: 0 });
    const staleMany = drive.evaluate({ now: NOW, unreadCount: 5, oldestUnreadAt: NOW - 10 * 60_000, failedHealthChecks: 0 });

    expect(freshFew?.pressure ?? 0).toBeGreaterThan(0);
    expect(staleMany?.pressure).toBe(1);
    expect(staleMany?.pressure).toBeGreaterThan(freshFew?.pressure ?? 0);
    expect(staleMany?.prompt).toContain("5");
  });
});

describe("selfCheckDrive", () => {
  it("fires at full pressure only when checks fail", () => {
    const drive = selfCheckDrive();
    expect(drive.evaluate({ failedHealthChecks: 0 })).toBeNull();
    const outcome = drive.evaluate({ failedHealthChecks: 3 });
    expect(outcome?.pressure).toBe(1);
    expect(outcome?.prompt).toContain("3");
  });
});

describe("selfMaintenanceDrive", () => {
  it("idle time builds pressure toward 1", () => {
    const drive = selfMaintenanceDrive<IdleSenses>({ idleFullMs: 60_000 });
    expect(drive.evaluate({ now: NOW, lastActionAt: NOW })).toBeNull();
    const outcome = drive.evaluate({ now: NOW, lastActionAt: NOW - 60_000 });
    expect(outcome?.pressure).toBe(1);
  });
});

describe("defineDrive (custom drives)", () => {
  it("declares only the senses it needs", () => {
    // 只关心 heat 一个字段的世界——不需要知道全貌
    type HeatWorld = { heat: number };
    const heatDrive: Drive<HeatWorld> = defineDrive({
      name: "heat",
      threshold: 0.5,
      cooldownMs: 60_000,
      evaluate: (world) => {
        if (world.heat <= 80) return null;
        return { pressure: 1, prompt: "cool down" };
      },
    });

    expect(heatDrive.evaluate({ heat: 90 })?.prompt).toBe("cool down");
    expect(heatDrive.evaluate({ heat: 20 })).toBeNull();
  });
});
