import { describe, expect, it } from "vitest";
import { formatPtyHelp, main, parsePtyArgs } from "../src/main.js";

describe("pty CLI", () => {
  it("parses command options after the separator", () => {
    expect(parsePtyArgs([
      "--cwd",
      "/tmp",
      "--timeout",
      "1000",
      "--idle-timeout",
      "500",
      "--cols",
      "80",
      "--rows",
      "24",
      "--",
      "/bin/sh",
      "-c",
      "true",
    ])).toEqual({
      command: ["/bin/sh", "-c", "true"],
      cols: 80,
      cwd: "/tmp",
      idleTimeout: 500,
      rows: 24,
      timeout: 1000,
    });
  });

  it("requires a command", () => {
    expect(() => parsePtyArgs(["--cwd", "/tmp"])).toThrow("command is required after --");
    expect(() => parsePtyArgs(["--"])).toThrow("command is required after --");
  });

  it("shows help", async () => {
    process.stdout.write(`${formatPtyHelp()}\n`);
    expect(await main(["--help"])).toBe(0);
  });

  it("runs a command and returns a snapshot JSON document", async () => {
    const writes: Array<string> = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const exitCode = await main([
        "--timeout",
        "1000",
        "--idle-timeout",
        "1000",
        "--cols",
        "80",
        "--rows",
        "24",
        "--",
        "/bin/sh",
        "-c",
        "printf ready; exit 7",
      ]);
      const snapshot = JSON.parse(writes.join("")) as { exitCode: number | null; rows: number };

      expect(exitCode).toBe(0);
      expect(snapshot.exitCode).toBe(7);
      expect(snapshot.rows).toBe(24);
      expect(writes.join("")).toContain("ready");
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
