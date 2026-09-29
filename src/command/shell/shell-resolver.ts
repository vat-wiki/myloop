import os from "node:os";
import process from "node:process";
import { basename, delimiter as pathDelimiter, join } from "node:path";
import { access, constants } from "node:fs/promises";

export type ResolvedShell = {
  command: string;
  args: Array<string>;
};

export async function resolveShell(command: string): Promise<ResolvedShell> {
  const override = process.env.MYCODER_SHELL?.trim();
  if (override) {
    const shellName = basename(override).toLowerCase();
    const executable = override.includes("/") || override.includes("\\")
      ? override
      : await findExecutableInPath(override) ?? override;
    return { command: executable, args: shellInvocationArgs(shellName, command) };
  }

  if (os.platform() === "win32") {
    for (const filename of ["pwsh.exe", "powershell.exe"]) {
      const powerShell = await findExecutableInPath(filename);
      if (powerShell) return { command: powerShell, args: windowsPowerShellArgs(command) };
    }

    const comspec = process.env.ComSpec?.trim() || "cmd.exe";
    return { command: comspec, args: ["/d", "/s", "/c", command] };
  }

  for (const shellName of ["bash", "sh"]) {
    const candidates = [
      `/bin/${shellName}`,
      `/usr/bin/${shellName}`,
      `/usr/local/bin/${shellName}`,
      `/opt/homebrew/bin/${shellName}`,
      await findExecutableInPath(shellName),
    ];

    for (const candidate of candidates) {
      if (candidate && await isExecutable(candidate)) {
        return { command: candidate, args: ["-c", command] };
      }
    }
  }

  throw new Error("no compatible shell found: expected bash or sh");
}

function shellInvocationArgs(shellName: string, command: string): Array<string> {
  if (shellName === "cmd" || shellName === "cmd.exe") return ["/d", "/s", "/c", command];
  if (shellName === "powershell" || shellName === "powershell.exe" || shellName === "pwsh" || shellName === "pwsh.exe") {
    return windowsPowerShellArgs(command);
  }
  return ["-c", command];
}

function windowsPowerShellArgs(command: string): Array<string> {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(command, "utf16le").toString("base64"),
  ];
}

export async function findExecutableInPath(filename: string): Promise<string | undefined> {
  const directories = (process.env.PATH ?? "")
    .split(pathDelimiter)
    .map((directory) => directory.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  for (const directory of directories) {
    const candidate = join(directory, filename);
    if (await isExecutable(candidate)) return candidate;
  }

  return undefined;
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
