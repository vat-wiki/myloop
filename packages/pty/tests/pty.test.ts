import { describe, expect, it } from "vitest";
import { runPtyCommand } from "../src/pty.js";

describe("runPtyCommand", () => {
  it("captures screen output and exit code for a successful command", async () => {
    const snapshot = await runPtyCommand({
      command: "/bin/sh",
      args: ["-c", "printf ready; exit 0"],
      cols: 80,
      rows: 24,
      timeout: 5_000,
      idleTimeout: 5_000,
    });

    expect(snapshot.status).toBe("exited");
    expect(snapshot.busy).toBe(false);
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.signal === null || snapshot.signal === 0).toBe(true);
    expect(snapshot.screen).toContain("ready");
    expect(snapshot.tail).toEqual(["ready"]);
    expect(snapshot.bufferType).toBe("normal");
    expect(snapshot.cols).toBe(80);
    expect(snapshot.rows).toBe(24);
    expect(snapshot.cursor.x).toBeGreaterThan(0);
    expect(snapshot.lastOutputAt).toBeGreaterThan(0);
  });

  it("reports a non-zero exit code without treating it as a failure status", async () => {
    const snapshot = await runPtyCommand({
      command: "/bin/sh",
      args: ["-c", "echo out; exit 3"],
      timeout: 5_000,
      idleTimeout: 5_000,
    });

    expect(snapshot.status).toBe("exited");
    expect(snapshot.exitCode).toBe(3);
    expect(snapshot.screen).toContain("out");
  });

  it("terminates long-running commands with the hard timeout", async () => {
    const snapshot = await runPtyCommand({
      command: "/bin/sh",
      args: ["-c", "echo started; sleep 30"],
      timeout: 500,
      idleTimeout: 5_000,
    });

    expect(snapshot.status).toBe("timeout");
    expect(snapshot.busy).toBe(false);
    expect(snapshot.screen).toContain("started");
  });

  it("terminates quiet commands with the idle timeout", async () => {
    const snapshot = await runPtyCommand({
      command: "/bin/sh",
      args: ["-c", "echo ready; sleep 30"],
      timeout: 10_000,
      idleTimeout: 500,
    });

    expect(snapshot.status).toBe("timeout");
    expect(snapshot.signal).toBe(15);
  });

  it("aborts an in-flight command through the signal", async () => {
    const controller = new AbortController();
    const running = runPtyCommand({
      command: "/bin/sh",
      args: ["-c", "echo waiting; sleep 30"],
      timeout: 10_000,
      idleTimeout: 10_000,
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();

    const snapshot = await running;
    expect(snapshot.status).toBe("aborted");
    expect(snapshot.screen).toContain("waiting");
  });

  it("returns an empty tail for a silent command", async () => {
    const snapshot = await runPtyCommand({
      command: "/bin/sh",
      args: ["-c", "true"],
      timeout: 5_000,
      idleTimeout: 5_000,
    });

    expect(snapshot.status).toBe("exited");
    expect(snapshot.tail).toEqual([]);
    expect(snapshot.exitCode).toBe(0);
  });
});
