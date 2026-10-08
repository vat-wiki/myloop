import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RuntimeSessionSnapshot, RuntimeSessionStore } from "myloop/runtime";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type StoredAppSessionSnapshot = RuntimeSessionSnapshot & {
  createdAt?: string;
};

export type AppSessionSummary = {
  sessionId: string;
  createdAt: string;
  messageCount: number;
};

export type FileSessionStoreOptions = {
  cwd?: string;
  directory?: string;
};

export function isValidAppSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function assertAppSessionId(value: string, name = "session id"): void {
  if (!isValidAppSessionId(value)) {
    throw new Error(`${name} must contain 1-128 letters, numbers, dots, underscores, or hyphens`);
  }
}

export function createAppSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `session-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export class FileSessionStore implements RuntimeSessionStore {
  readonly directory: string;

  constructor({
    cwd = process.cwd(),
    directory = join(".agents", "myloop", "sessions"),
  }: FileSessionStoreOptions = {}) {
    this.directory = resolve(cwd, directory);
  }

  async save(sessionId: string, snapshot: StoredAppSessionSnapshot): Promise<void> {
    assertAppSessionId(sessionId);
    const path = this.sessionPath(sessionId);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const existing = await this.load(sessionId);
    const providedCreatedAt = [snapshot.createdAt, existing?.createdAt]
      .map((createdAt) => createdAt === undefined ? Number.NaN : Date.parse(createdAt))
      .find(Number.isFinite);
    const storedSnapshot = {
      ...snapshot,
      createdAt: providedCreatedAt === undefined
        ? new Date(await this.#createdAt(sessionId, snapshot)).toISOString()
        : new Date(providedCreatedAt).toISOString(),
    };
    await mkdir(this.directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(storedSnapshot, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  async load(sessionId: string): Promise<StoredAppSessionSnapshot | undefined> {
    assertAppSessionId(sessionId);
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

  async listSessions(): Promise<Array<AppSessionSummary>> {
    const summaries: Array<AppSessionSummary> = [];

    for (const sessionId of await this.list()) {
      if (!isValidAppSessionId(sessionId)) continue;
      const snapshot = await this.load(sessionId);
      if (!snapshot) continue;
      if (!snapshot.messages.some((message) => message.role === "assistant")) continue;
      const createdAtMs = typeof snapshot.createdAt === "string" ? Date.parse(snapshot.createdAt) : Number.NaN;
      summaries.push({
        sessionId,
        createdAt: Number.isFinite(createdAtMs)
          ? new Date(createdAtMs).toISOString()
          : new Date(await this.#createdAt(sessionId, snapshot)).toISOString(),
        messageCount: snapshot.messages.length,
      });
    }

    return summaries.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  async latest(): Promise<string | undefined> {
    const sessions = await this.listSessions();
    return sessions[0]?.sessionId;
  }

  sessionPath(sessionId: string): string {
    assertAppSessionId(sessionId);
    return join(this.directory, `${sessionId}.json`);
  }

  async #createdAt(sessionId: string, snapshot: StoredAppSessionSnapshot): Promise<number> {
    if (snapshot.createdAt !== undefined) {
      const createdAtMs = Date.parse(snapshot.createdAt);
      if (Number.isFinite(createdAtMs)) return createdAtMs;
    }

    const sessionIdCreatedAtMs = parseSessionIdCreatedAt(sessionId);
    if (sessionIdCreatedAtMs !== undefined) return sessionIdCreatedAtMs;

    try {
      return (await stat(this.sessionPath(sessionId))).birthtimeMs;
    } catch {
      return Date.now();
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

function parseSessionIdCreatedAt(sessionId: string): number | undefined {
  const match = sessionId.match(/^session-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}$/);
  if (!match) return undefined;
  const [, date, hour, minute, second, millisecond] = match;
  const createdAtMs = Date.parse(`${date}T${hour}:${minute}:${second}.${millisecond}Z`);
  return Number.isFinite(createdAtMs) ? createdAtMs : undefined;
}
