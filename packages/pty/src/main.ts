#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { runPtyCommand } from "./pty.js";

export type PtyCliOptions = {
  command: Array<string>;
  cols: number;
  cwd?: string;
  idleTimeout: number;
  rows: number;
  timeout: number;
};

const defaultPtyOptions = {
  cols: 120,
  idleTimeout: 30_000,
  rows: 32,
  timeout: 120_000,
};

export function parsePtyArgs(argv: ReadonlyArray<string>): PtyCliOptions {
  const options: PtyCliOptions = {
    command: [] as Array<string>,
    ...defaultPtyOptions,
  };
  let separatorSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (separatorSeen) {
      options.command.push(argument);
      continue;
    }
    if (argument === "--") {
      separatorSeen = true;
      continue;
    }
    if (argument === "--cwd") {
      options.cwd = requiredValue(argv, ++index, argument);
    } else if (argument === "--timeout") {
      options.timeout = positiveInteger(requiredValue(argv, ++index, argument), argument);
    } else if (argument === "--idle-timeout") {
      options.idleTimeout = positiveInteger(requiredValue(argv, ++index, argument), argument);
    } else if (argument === "--cols") {
      options.cols = positiveInteger(requiredValue(argv, ++index, argument), argument);
    } else if (argument === "--rows") {
      options.rows = positiveInteger(requiredValue(argv, ++index, argument), argument);
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      throw new Error(`expected -- before command: ${argument}`);
    }
  }

  if (options.command.length === 0) throw new Error("command is required after --");
  return options;
}

export function formatPtyHelp(): string {
  return [
    "Usage: mcpty [options] -- <command> [args...]",
    "",
    "Options:",
    "  --cwd <directory>          working directory",
    "  --timeout <milliseconds>   hard timeout (default: 120000)",
    "  --idle-timeout <ms>        no-output timeout (default: 30000)",
    "  --cols <number>            PTY columns (default: 120)",
    "  --rows <number>            PTY rows (default: 32)",
    "  --help                     show this help",
  ].join("\n");
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help")) {
    process.stdout.write(`${formatPtyHelp()}\n`);
    return 0;
  }

  let options: PtyCliOptions;
  try {
    options = parsePtyArgs(argv);
  } catch (error) {
    process.stderr.write(`mcpty: ${errorMessage(error)}\n\n${formatPtyHelp()}\n`);
    return 2;
  }

  try {
    const snapshot = await runPtyCommand({
      command: options.command[0] ?? "",
      args: options.command.slice(1),
      cols: options.cols,
      cwd: options.cwd,
      idleTimeout: options.idleTimeout,
      rows: options.rows,
      timeout: options.timeout,
    });
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`mcpty: ${errorMessage(error)}\n`);
    return 1;
  }
}

function requiredValue(argv: ReadonlyArray<string>, index: number, option: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`mcpty: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
