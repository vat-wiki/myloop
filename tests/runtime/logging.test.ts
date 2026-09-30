import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentLogger } from "../../src/runtime/logging.js";

describe("runtime logger", () => {
  const temporaryDirectories: Array<string> = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })));
  });

  it("creates a JSONL log and serializes custom events", async () => {
    const cwd = await makeTemporaryDirectory();
    const logger = await createAgentLogger({
      cwd,
      directory: ".logs",
      metadata: { protocol: "openai-chat", model: "test-model" },
    });

    await logger.log("custom", { value: 1n });

    const events = await readEvents(logger.path);
    expect(events.map((event) => event.type)).toEqual(["session_start", "custom"]);
    expect(events[0]).toMatchObject({
      cwd,
      protocol: "openai-chat",
      model: "test-model",
    });
    expect(events[1]).toMatchObject({ value: "1" });
    expect(events[1]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("records tool completion, duration, and failures", async () => {
    const cwd = await makeTemporaryDirectory();
    const logger = await createAgentLogger({ cwd, directory: ".logs" });
    const tool = {
      name: "bash",
      definition: {
        name: "bash",
        description: "test",
        parameters: { type: "object", properties: {}, required: [] },
      },
      handler: async () => "done",
    };
    const handler = logger.extension.wrapToolCall?.(tool);
    await handler?.({ command: "echo done" }, {});

    const failingTool = { ...tool, handler: async () => { throw new Error("failed"); } };
    const failingHandler = logger.extension.wrapToolCall?.(failingTool);
    await expect(failingHandler?.({ command: "exit 1" }, {})).rejects.toThrow("failed");

    const events = await readEvents(logger.path);
    expect(events.find((event) => event.type === "tool_start")).toMatchObject({
      name: "bash",
      input: { command: "echo done" },
    });
    expect(events.find((event) => event.type === "tool_end")).toMatchObject({
      output: "done",
      ok: true,
    });
    expect(events.find((event) => event.type === "tool_error")).toMatchObject({
      level: "error",
      error: { message: "failed" },
      ok: false,
    });
  });

  it("records only error events in errors mode and keeps diagnostics separate", async () => {
    const cwd = await makeTemporaryDirectory();
    const logger = await createAgentLogger({
      cwd,
      directory: ".logs",
      level: "errors",
    });
    const tool = {
      name: "bash",
      definition: { name: "bash", description: "test", parameters: {} },
      handler: async () => "done",
    };
    const handler = logger.extension.wrapToolCall?.(tool);
    await handler?.({ command: "echo done" }, {});

    const failingTool = { ...tool, handler: async () => { throw new Error("failed"); } };
    const failingHandler = logger.extension.wrapToolCall?.(failingTool);
    await expect(failingHandler?.({ command: "exit 1" }, {})).rejects.toThrow("failed");
    await logger.diagnostic("error", "runtime failed", { reason: "test" });

    const events = await readEvents(logger.path);
    expect(events.map((event) => event.type)).toEqual(["session_start", "tool_error"]);
    expect(events[1]).toMatchObject({
      level: "error",
      name: "bash",
      input: { command: "exit 1" },
      error: { message: "failed" },
    });

    const diagnostics = await readEvents(logger.diagnosticsPath);
    expect(diagnostics).toEqual([expect.objectContaining({
      level: "error",
      message: "runtime failed",
      data: { reason: "test" },
    })]);
  });

  async function makeTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "myloop-runtime-logging-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});

async function readEvents(path: string): Promise<Array<Record<string, any>>> {
  const content = await readFile(path, "utf8");
  return content.trimEnd().split("\n").map((line) => JSON.parse(line));
}
