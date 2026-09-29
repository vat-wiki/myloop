import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppAgent } from "../src/index.js";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("createAppAgent", () => {
  it("creates an agent with shared session storage and command host", async () => {
    const cwd = await makeTemporaryDirectory();
    const { agent, logger, sessionStore } = await createAppAgent({
      protocol: "openai-chat",
      model: "test-model",
      system: "Test system.",
      sessionId: "work-1",
      cwd,
    });

    expect(agent.name).toBe("app-agent");
    expect(agent.system).toBe("Test system.");
    expect(agent.sessionId).toBe("work-1");
    expect(agent.runtime.commandHost?.toolName).toBe("command");
    expect(logger).toBeUndefined();
    expect(sessionStore).toBe(agent.runtime.sessionStore);
  });

  it("enables logging only when requested", async () => {
    const cwd = await makeTemporaryDirectory();
    const { logger } = await createAppAgent({
      protocol: "anthropic",
      model: "test-model",
      system: "Test system.",
      cwd,
      logger: true,
    });

    expect(logger?.extension.name).toBe("runtime-logger");
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mycoder-app-sdk-agent-"));
  temporaryDirectories.push(directory);
  return directory;
}
