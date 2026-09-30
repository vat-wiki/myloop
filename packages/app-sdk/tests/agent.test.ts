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

  it("omits the shell when commandHost is null", async () => {
    const cwd = await makeTemporaryDirectory();
    const { agent } = await createAppAgent({
      protocol: "openai-chat",
      model: "test-model",
      system: "Test system.",
      cwd,
      commandHost: null,
      commandHosts: [{ id: "media", toolName: "video_search", description: "搜索", inputSchema: {}, run: async () => "" }],
    });

    expect(agent.runtime.commandHosts.map((host) => host.toolName)).toEqual(["video_search"]);
    expect(agent.tools.map((tool) => tool.name)).toEqual(["video_search"]);
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
  const directory = await mkdtemp(join(tmpdir(), "myloop-app-sdk-agent-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("createAppAgent heartbeat", () => {
  it("forwards heartbeat options to the runtime", async () => {
    const cwd = await makeTemporaryDirectory();
    let scheduled = 0;
    let cleared = 0;
    const { agent } = await createAppAgent({
      protocol: "openai-chat",
      model: "test-model",
      system: "Test system.",
      cwd,
      heartbeat: {
        intervalMs: 60_000,
        mode: "always",
        timer: () => {
          scheduled += 1;
          return { clear: () => { cleared += 1; } };
        },
      },
    });

    expect(scheduled).toBe(1);
    agent.stopHeartbeat();
    expect(cleared).toBe(1);
    expect(agent.runtime.stopHeartbeat).toBeTypeOf("function");
  });

  it("does not schedule a heartbeat when options are omitted", async () => {
    const cwd = await makeTemporaryDirectory();
    let scheduled = 0;
    const { agent } = await createAppAgent({
      protocol: "openai-chat",
      model: "test-model",
      system: "Test system.",
      cwd,
      heartbeat: {
        intervalMs: 60_000,
        timer: () => {
          scheduled += 1;
          return { clear: () => {} };
        },
      },
    });

    expect(scheduled).toBe(0);
    agent.startHeartbeat();
    expect(scheduled).toBe(1);
  });
});
