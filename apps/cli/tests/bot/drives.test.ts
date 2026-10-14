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
type UnreadSenses = {
  now: number;
  unreadCount: number;
  oldestUnreadAt?: number;
  unreadMessages?: ReadonlyArray<{ text: string; at: number; source: "user" | "ambient" }>;
};
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

  it("prompt distinguishes user-assigned from ambient messages", () => {
    const drive = respondUnreadDrive<DemoWorld>();
    const outcome = drive.evaluate({
      now: NOW,
      unreadCount: 2,
      oldestUnreadAt: NOW - 60_000,
      unreadMessages: [
        { text: "把报告发我", at: NOW - 60_000, source: "user" },
        { text: "服务 ping 失败", at: NOW - 30_000, source: "ambient" },
      ],
      failedHealthChecks: 0,
    });
    expect(outcome?.pressure).toBe(1);
    expect(outcome?.prompt).toContain("[用户交办] 把报告发我");
    expect(outcome?.prompt).toContain("[环境] 服务 ping 失败");
    expect(outcome?.prompt).toContain("先逐条回应用户交办");
  });

  it("a single queued user message fires immediately without waiting for pressure buildup", () => {
    const drive = respondUnreadDrive<DemoWorld>();
    const outcome = drive.evaluate({
      now: NOW,
      unreadCount: 1,
      oldestUnreadAt: NOW,
      unreadMessages: [{ text: "插队交办", at: NOW, source: "user" }],
      failedHealthChecks: 0,
    });
    expect(outcome?.pressure).toBe(1);
  });

  it("prompt falls back to count-only when host provides no message details", () => {
    const drive = respondUnreadDrive<DemoWorld>();
    const outcome = drive.evaluate({ now: NOW, unreadCount: 2, oldestUnreadAt: NOW - 60_000, failedHealthChecks: 0 });
    expect(outcome?.prompt).toContain("2 条未读积压");
    expect(outcome?.prompt).not.toContain("[用户交办]");
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
      requires: [],
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
