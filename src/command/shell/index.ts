import type { CommandHost, CommandHostInput, CommandInvocationContext } from "../index.js";
import type { JsonSchemaObject } from "../../runtime/messages.js";
import { runPty } from "./pty.js";
import { runShell } from "./runner.js";

export {
  formatTerminalSnapshot,
  runPty,
  runPtyProcess,
  type RunPtyOptions,
  type TerminalSnapshot,
  type TerminalStatus,
} from "./pty.js";
export {
  formatCommandResult,
  runShell,
  type CommandResult,
  type CommandStatus,
  type RunShellOptions,
} from "./runner.js";

export type ShellCommandInput = {
  command: string;
  cwd?: string;
  timeout?: number;
  idleTimeout?: number;
  tty?: boolean;
};

export class ShellCommandHost implements CommandHost<ShellCommandInput, string> {
  readonly id = "terminal";
  readonly toolName = "command";
  readonly description = `一次性运行命令并等待退出；超时终止进程树并返回输出。默认使用非 TTY 子进程；仅当命令必须检测 TTY、渲染 TUI 或读取 /dev/tty 时设置 tty=true，该模式使用 myanne-pty。长驻服务优先使用项目已有的进程管理方式，临时可恢复会话使用 tmux`;

  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: {
      command: { type: "string", description: "执行的命令；必须自然退出或被超时终止" },
      cwd: { type: "string", description: "命令工作目录" },
      timeout: { type: "number", description: "硬超时毫秒；默认 120000" },
      idleTimeout: { type: "number", description: "无输出超时毫秒；默认 30000" },
      tty: {
        type: "boolean",
        description: "默认 false；仅在命令需要真实 TTY 语义时设为 true",
      },
    },
    required: ["command"],
  };

  async run(input: CommandHostInput, context: CommandInvocationContext): Promise<string> {
    const command = typeof input.command === "string" ? input.command : undefined;
    const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
    const timeout = typeof input.timeout === "number" ? input.timeout : undefined;
    const idleTimeout = typeof input.idleTimeout === "number" ? input.idleTimeout : undefined;
    const tty = input.tty === true;

    if (!command) throw new Error("command is required");
    return tty
      ? runPty({ command, cwd, timeout, idleTimeout, signal: context.signal })
      : runShell({ command, cwd, timeout, idleTimeout, signal: context.signal });
  }
}
