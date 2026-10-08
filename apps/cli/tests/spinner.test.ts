import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSpinner } from "../src/spinner.js";

describe("spinner", () => {
  let output: { write: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    output = { write: vi.fn() };
    vi.useFakeTimers();
  });

  it("renders frames on an interval and clears on stop", () => {
    const spinner = createSpinner({ output: output as unknown as NodeJS.WriteStream, intervalMs: 100 });
    spinner.start("working");
    vi.advanceTimersByTime(350);
    spinner.update("still working");
    vi.advanceTimersByTime(100);
    spinner.stop();

    const writes = output.write.mock.calls.map((call) => String(call[0]));
    expect(writes[0]).toContain("working");
    expect(writes.at(-1)).toBe("\r\x1b[K");
    expect(writes.filter((text) => text.includes("⠸")).length).toBeGreaterThan(0);
    expect(writes.every((text) => text.includes("\x1b[K"))).toBe(true);
  });

  it("ignores repeated starts and stops when idle", () => {
    const spinner = createSpinner({ output: output as unknown as NodeJS.WriteStream });
    spinner.stop();
    spinner.start("a");
    spinner.start("b");
    expect(output.write).toHaveBeenCalledTimes(1);
    expect(output.write.mock.calls[0]?.[0]).toContain("a");
    spinner.stop();
    spinner.stop();
    expect(output.write).toHaveBeenCalledTimes(2);
  });
});
