import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTuiLogger } from "../src/logging.js";

describe("TUI logger", () => {
  const temporaryDirectories: Array<string> = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })));
  });

  it("appends serialized events under .agents/myloop/logs", async () => {
    const cwd = await makeTemporaryDirectory();
    const logger = await createTuiLogger({
      cwd,
      protocol: "openai-chat",
      model: "test-model",
    });

    await logger.log("custom", { value: 1 });

    const events = await readEvents(logger.path);
    expect(events.map((event) => event.type)).toEqual(["session_start", "custom"]);
    expect(events[0]).toMatchObject({
      protocol: "openai-chat",
      model: "test-model",
      cwd,
    });
    expect(events[1]).toMatchObject({ value: 1 });
    expect(events[1]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("records tool start, completion, duration, and failures", async () => {
    const cwd = await makeTemporaryDirectory();
    const logger = await createTuiLogger({ cwd, protocol: "test", model: "test-model" });
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
    expect(events.filter((event) => event.type === "tool_start")).toEqual([
      expect.objectContaining({ name: "bash", input: { command: "echo done" } }),
      expect.objectContaining({ name: "bash", input: { command: "exit 1" } }),
    ]);
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

  it("writes runtime diagnostics to a separate JSONL file", async () => {
    const cwd = await makeTemporaryDirectory();
    const logger = await createTuiLogger({
      cwd,
      protocol: "openai-chat",
      model: "test-model",
    });

    await logger.diagnostic("error", "agent run failed", { input: "hello" });

    expect(await readFile(logger.path, "utf8").then((content) => content.split("\n").length)).toBe(2);
    const events = await readEvents(logger.diagnosticsPath);
    expect(events).toEqual([expect.objectContaining({
      level: "error",
      message: "agent run failed",
      data: { input: "hello" },
    })]);
  });

  async function makeTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "myloop-logging-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});

async function readEvents(path: string): Promise<Array<Record<string, any>>> {
  const content = await readFile(path, "utf8");
  return content.trimEnd().split("\n").map((line) => JSON.parse(line));
}
