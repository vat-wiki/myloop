import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RuntimeSessionSnapshot, RuntimeSessionStore } from "mycoder/runtime";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidCliSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function createCliSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `session-${timestamp}-${randomUUID().slice(0, 8)}`;
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
    assertSessionId(sessionId);
    const path = this.sessionPath(sessionId);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  async load(sessionId: string): Promise<RuntimeSessionSnapshot | undefined> {
    assertSessionId(sessionId);
    try {
      return JSON.parse(await readFile(this.sessionPath(sessionId), "utf8")) as RuntimeSessionSnapshot;
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      if (error instanceof SyntaxError) {
        throw new Error(`invalid session file: ${this.sessionPath(sessionId)}`);
      }
      throw error;
    }
  }

  sessionPath(sessionId: string): string {
    assertSessionId(sessionId);
    return join(this.directory, `${sessionId}.json`);
  }
}

function assertSessionId(value: string): void {
  if (!isValidCliSessionId(value)) {
    throw new Error("session id must contain 1-128 letters, numbers, dots, underscores, or hyphens");
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
