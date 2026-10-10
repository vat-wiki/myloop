import { describe, expect, it } from "vitest";
import { memoryGardeningDrive } from "../../src/bot/drives.js";

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

function world(overrides?: Partial<Parameters<ReturnType<typeof memoryGardeningDrive>["evaluate"]>[0]>) {
  return { inboxLines: 0, brokenLinkCount: 0, stalestDays: null, now: NOW, lastActionAt: NOW, ...overrides };
}

describe("memoryGardeningDrive", () => {
  it("stays quiet on a healthy memory wiki", () => {
    expect(memoryGardeningDrive().evaluate(world())).toBeNull();
  });

  it("ramps pressure with inbox backlog and broken links", () => {
    const outcome = memoryGardeningDrive().evaluate(world({ inboxLines: 20, brokenLinkCount: 5 }));
    expect(outcome).not.toBeNull();
    expect(outcome?.pressure).toBe(1);
    expect(outcome?.prompt).toContain("inbox 积压 20 行");
    expect(outcome?.prompt).toContain("5 个断链");
  });

  it("flags stale entries older than a week", () => {
    const outcome = memoryGardeningDrive().evaluate(world({ stalestDays: 10 }));
    expect(outcome?.prompt).toContain("10 天未验证");
  });

  it("falls back to routine gardening when idle long enough", () => {
    const drive = memoryGardeningDrive({ idleFullMs: DAY });
    const outcome = drive.evaluate(world({ lastActionAt: NOW - DAY, stalestDays: 3 }));
    expect(outcome?.prompt).toContain("例行整理");
  });
});
