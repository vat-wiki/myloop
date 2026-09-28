import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  createTerminalTool,
  runPty,
  runShell,
} from "../../src/runtime/terminal.js";

describe("runShell", () => {
  it("runs commands without a PTY by default", async () => {
    const output = await runShell({
      command: "node -p 'Boolean(process.stdout.isTTY)'",
      timeout: 1_000,
    });

    expect(output).toContain("false");
  });

  it("captures stdout and stderr separately", async () => {
    const output = await runShell({
      command: "echo out; echo error >&2; exit 7",
      timeout: 1_000,
      idleTimeout: 1_000,
    });

    expect(output).toContain("exit:7");
    expect(output).toContain("stdout:\nout");
    expect(output).toContain("stderr:\nerror");
  });

  it("honors a shell override", async () => {
    const previousShell = process.env.MYCODER_SHELL;
    process.env.MYCODER_SHELL = "/bin/sh";

    try {
      const output = await runShell({
        command: "ps -p $$ -o comm=; true",
        timeout: 1_000,
      });

      expect(output).toContain("sh");
    } finally {
      if (previousShell === undefined) delete process.env.MYCODER_SHELL;
      else process.env.MYCODER_SHELL = previousShell;
    }
  });

  it("returns partial output after the idle timeout", async () => {
    const output = await runShell({
      command: "echo before-idle; sleep 10",
      timeout: 1_000,
      idleTimeout: 50,
    });

    expect(output).toContain("timeout");
    expect(output).toContain("before-idle");
  });

  it("kills background children with the process group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mycoder-shell-"));
    const pidFile = join(directory, "child.pid");

    try {
      await runShell({
        command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
        timeout: 200,
        idleTimeout: 5_000,
      });

      const childPid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isInteger(childPid)).toBe(true);

      let childExited = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch {
          childExited = true;
          break;
        }
      }
      expect(childExited).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("runPty", () => {
  it("runs commands in a PTY", async () => {
    const output = await runPty({
      command: "node -p 'String(process.stdout.isTTY)'",
      timeout: 1_000,
    });

    expect(output).toContain("true");
  });

  it("returns partial output after the idle timeout", async () => {
    const output = await runPty({
      command: "echo before-idle; sleep 10",
      timeout: 1_000,
      idleTimeout: 50,
    });

    expect(output).toContain("timeout");
    expect(output).toContain("before-idle");
  });

  it("reports the exit code", async () => {
    const output = await runPty({
      command: "echo failed; exit 7",
      timeout: 1_000,
      idleTimeout: 1_000,
    });

    expect(output).toContain("exit:7");
    expect(output).toContain("failed");
  });

  it("kills background children with the process group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mycoder-pty-"));
    const pidFile = join(directory, "child.pid");

    try {
      await runPty({
        command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
        timeout: 200,
        idleTimeout: 5_000,
      });

      const childPid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isInteger(childPid)).toBe(true);

      let childExited = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch {
          childExited = true;
          break;
        }
      }
      expect(childExited).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("createTerminalTool", () => {
  it("exposes a one-shot command tool", () => {
    const tool = createTerminalTool();

    expect(tool.name).toBe("bash");
    expect(tool.parameters.required).toEqual(["command"]);
    expect(tool.parameters.properties).toHaveProperty("tty");
    expect(tool.parameters.properties).not.toHaveProperty("sessionId");
    expect(tool.parameters.properties).not.toHaveProperty("action");
  });
});
