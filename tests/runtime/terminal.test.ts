import { describe, expect, it } from "vitest";
import { runPty } from "../../src/runtime/terminal.js";

describe("runPty", () => {
  it("runs commands in a PTY", async () => {
    const output = await runPty({
      command: "node -p 'String(process.stdout.isTTY)'",
      timeout: 1_000,
    });

    expect(output).toContain("true");
  });
});
