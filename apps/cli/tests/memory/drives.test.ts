import { describe, expect, it } from "vitest";
import { memoryGroomingDrive } from "../../src/bot/drives.js";

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

function world(overrides?: Partial<Parameters<ReturnType<typeof memoryGroomingDrive>["evaluate"]>[0]>) {
  return { pendingLines: 0, brokenLinkCount: 0, stalestDays: null, now: NOW, lastActionAt: NOW, ...overrides };
}

describe("memoryGroomingDrive", () => {
  it("stays quiet on a healthy memory wiki", () => {
    expect(memoryGroomingDrive().evaluate(world())).toBeNull();
  });

  it("ramps pressure with pending backlog and broken links", () => {
    const outcome = memoryGroomingDrive().evaluate(world({ pendingLines: 20, brokenLinkCount: 5 }));
    expect(outcome).not.toBeNull();
    expect(outcome?.pressure).toBe(1);
    expect(outcome?.prompt).toContain("PENDING 积压 20 行");
    expect(outcome?.prompt).toContain("5 个断链");
  });

  it("flags stale entries older than a week", () => {
    const outcome = memoryGroomingDrive().evaluate(world({ stalestDays: 10 }));
    expect(outcome?.prompt).toContain("10 天未验证");
  });

  it("falls back to routine grooming when idle long enough", () => {
    const drive = memoryGroomingDrive({ idleFullMs: DAY });
    const outcome = drive.evaluate(world({ lastActionAt: NOW - DAY, stalestDays: 3 }));
    expect(outcome?.prompt).toContain("例行整理");
  });

  it("idle routine pressure can cross the default threshold", () => {
    const drive = memoryGroomingDrive({ idleFullMs: DAY });
    const outcome = drive.evaluate(world({ lastActionAt: NOW - DAY }));
    expect(outcome?.pressure).toBe(1);
  });
});
