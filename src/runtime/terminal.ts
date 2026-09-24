import os from "node:os";
import { spawn } from "node-pty";
import type { ToolDefinition } from "./messages.js";

export type RunPtyOptions = {
  command: string;
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
};

export function runPty({
  command,
  cwd = process.cwd(),
  timeout = 120_000,
  signal,
}: RunPtyOptions): Promise<string> {
  return new Promise((resolve) => {
    const shell = os.platform() === "win32" ? "cmd.exe" : "bash";
    const terminal = spawn(shell, ["-c", command], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd,
      env: cleanEnv(),
    });

    let output = "";
    const timer = setTimeout(() => terminal.kill(), timeout);
    const onAbort = () => terminal.kill();
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(`exit:${exitCode}\n${output}`.slice(0, 30_000));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function createTerminalTool(): ToolDefinition {
  return {
    name: "bash",
    description: "在pty终端中执行shell命令并返回输出",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["command"],
    },
  };
}

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}
