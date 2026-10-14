import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  ShellCommandHost,
  formatCommandResult,
  runPty,
  runShell,
} from "../../src/command/shell/index.js";

describe("runShell", () => {
  it("describes the output truncation contract", () => {
    const description = new ShellCommandHost().description;

    expect(description).toContain("超过 10k 字符");
    expect(description).toContain("尾部≤200行");
    expect(description).toContain("output_truncated:true");
  });

  it("runs commands without a PTY by default", async () => {
    const output = await runShell({
      command: "node -p 'Boolean(process.stdout.isTTY)'",
      timeout: 1_000,
    });

    expect(output).toContain("false");
  });

  it("returns complete small output without truncation metadata", async () => {
    const output = await runShell({
      command: "echo small-output",
      timeout: 1_000,
    });

    expect(output).toContain("small-output");
    expect(output).not.toContain("output_truncated:");
  });

  it("returns complete output below the inline limit", async () => {
    const output = await runShell({
      command: "node -e 'for (let i = 0; i < 120; i++) console.log(\"medium \" + i);'",
      timeout: 1_000,
    });

    expect(output).not.toContain("output_truncated:");
    expect(output).toContain("medium 0");
    expect(output).toContain("medium 119");
  });

  it("marks large output and returns a bounded tail", async () => {
    const output = await runShell({
      command: "node -e 'for (let i = 0; i < 5000; i++) console.log(\"out \" + i);'",
      timeout: 1_000,
    });

    expect(output).toContain("output_truncated:true");
    expect(output).toContain("total_chars:");
    expect(output).toContain("returned_chars:");
    expect(output).toContain("out 4999");
  });

  it("caps long single-line output by characters", async () => {
    const output = await runShell({
      command: 'node -e \'console.log("x".repeat(20_000)); console.log("END");\'',
      timeout: 1_000,
    });

    expect(output).toContain("output_truncated:true");
    expect(output).toContain("END");
    expect(output.length).toBeLessThanOrEqual(12_000);
  });

  it("combines stdout and stderr in arrival order", async () => {
    const output = await runShell({
      command: `node -e 'const fs = require("node:fs"); const newline = String.fromCharCode(10); fs.writeSync(1, "out 1" + newline); fs.writeSync(2, "err 1" + newline); setTimeout(() => { fs.writeSync(1, "out 2" + newline); for (let i = 1; i <= 120; i++) console.log("filler " + i); }, 50);'`,
      timeout: 1_000,
    });

    expect(output).toContain("out 1\nerr 1\nout 2");
  });

  it("marks large PTY output as truncated", async () => {
    const output = await runPty({
      command: "node -e 'for (let i = 0; i < 5000; i++) console.log(\"pty \" + i);'",
      timeout: 5_000,
    });

    expect(output).toContain("output_truncated:true");
    expect(output).toContain("total_chars:");
    expect(output).toContain("pty 4999");
  });

  it("captures stdout and stderr separately", async () => {
    const output = await runShell({
      command: "echo out; echo error >&2; exit 7",
      timeout: 1_000,
      idleTimeout: 1_000,
    });

    expect(output).toContain("exit:7");
    expect(output).toContain("output:\nout\nerror");
  });

  it("keeps the last 200 lines and failing stderr", () => {
    const stdout = Array.from({ length: 5_000 }, (_, index) => `stdout ${index}`).join("\n");
    const output = formatCommandResult({
      status: "exited",
      exitCode: 1,
      signal: null,
      output: `${stdout}\nimportant failure`,
      outputChars: stdout.length + "important failure".length,
      outputTruncated: true,
    });

    expect(output.length).toBeLessThanOrEqual(12_000);
    expect(output).not.toContain("stdout 0");
    expect(output).toContain("stdout 4801");
    expect(output).toContain("stdout 4999");
    expect(output).not.toContain("stdout 4800\n");
    expect(output).toContain("important failure");
  });

  it("honors a shell override", async () => {
    const previousShell = process.env.MYLOOP_SHELL;
    process.env.MYLOOP_SHELL = "/bin/sh";

    try {
      const output = await runShell({
        command: "ps -p $$ -o comm=; true",
        timeout: 1_000,
      });

      expect(output).toContain("sh");
    } finally {
      if (previousShell === undefined) delete process.env.MYLOOP_SHELL;
      else process.env.MYLOOP_SHELL = previousShell;
    }
  });

  it("rejects an unusable shell override instead of spawning it", async () => {
    const previousShell = process.env.MYLOOP_SHELL;
    process.env.MYLOOP_SHELL = "/path/to/missing-shell";

    try {
      await expect(runShell({
        command: "true",
        timeout: 1_000,
      })).rejects.toThrow("MYLOOP_SHELL is not executable: /path/to/missing-shell");
    } finally {
      if (previousShell === undefined) delete process.env.MYLOOP_SHELL;
      else process.env.MYLOOP_SHELL = previousShell;
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
    const directory = await mkdtemp(join(tmpdir(), "myloop-shell-"));
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
    const directory = await mkdtemp(join(tmpdir(), "myloop-pty-"));
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
