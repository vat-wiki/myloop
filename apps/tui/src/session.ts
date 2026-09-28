import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RuntimeSessionStore, RuntimeSessionSnapshot } from "mycoder/runtime";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidTuiSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function createTuiSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `session-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function assertTuiSessionId(value: string, name = "session id"): void {
  if (!isValidTuiSessionId(value)) {
    throw new Error(`${name} must contain 1-128 letters, numbers, dots, underscores, or hyphens`);
  }
}

export type FileSessionStoreOptions = {
  cwd?: string;
  directory?: string;
};

export class FileSessionStore implements RuntimeSessionStore {
  readonly directory: string;

  constructor({
    cwd = process.cwd(),
    directory = join(".agents", "mycoder", "sessions"),
  }: FileSessionStoreOptions = {}) {
    this.directory = resolve(cwd, directory);
  }

  async save(sessionId: string, snapshot: RuntimeSessionSnapshot): Promise<void> {
    assertTuiSessionId(sessionId);
    const path = this.sessionPath(sessionId);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  async load(sessionId: string): Promise<RuntimeSessionSnapshot | undefined> {
    assertTuiSessionId(sessionId);
    try {
      const content = await readFile(this.sessionPath(sessionId), "utf8");
      return JSON.parse(content) as RuntimeSessionSnapshot;
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      if (error instanceof SyntaxError) {
        throw new Error(`invalid session file: ${this.sessionPath(sessionId)}`);
      }
      throw error;
    }
  }

  async list(): Promise<Array<string>> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .sort();
  }

  sessionPath(sessionId: string): string {
    assertTuiSessionId(sessionId);
    return join(this.directory, `${sessionId}.json`);
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
