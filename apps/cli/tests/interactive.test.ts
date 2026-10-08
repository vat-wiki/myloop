import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInteractiveLoop } from "../src/interactive.js";
import type { SingleAgent } from "myloop/agent";

function createAgent({ running = false }: { running?: boolean } = {}): SingleAgent {
  return {
    running,
    abort: vi.fn(),
  } as unknown as SingleAgent;
}

describe("interactive loop", () => {
  let submit: ReturnType<typeof vi.fn>;
  let output: Array<string>;

  beforeEach(() => {
    submit = vi.fn().mockResolvedValue(undefined);
    output = [];
  });

  function createLoop(agent: SingleAgent) {
    return createInteractiveLoop({
      agent,
      submit,
      write: (text) => output.push(text),
    });
  }

  it("runs submitted input immediately when idle", async () => {
    const loop = createLoop(createAgent());
    loop.handleLine("hello");
    await loop.drain();

    expect(submit).toHaveBeenCalledWith("hello");
    expect(loop.isStopped()).toBe(false);
  });

  it("handles exit and help commands without calling submit", async () => {
    const loop = createLoop(createAgent());
    loop.handleLine("/help");
    loop.handleLine("/exit");
    await loop.drain();

    expect(submit).not.toHaveBeenCalled();
    expect(output).toContainEqual("Commands: /exit · Ctrl+C interrupts, second Ctrl+C exits\n");
    expect(loop.isStopped()).toBe(true);
  });

  it("does not discard input while the agent is running", async () => {
    const agent = createAgent({ running: true });
    const loop = createLoop(agent);
    loop.handleLine("queued task");
    await loop.drain();

    expect(submit).not.toHaveBeenCalled();
    expect(output).toContainEqual("agent is running — input queued\n");
    expect(loop.isStopped()).toBe(false);
  });

  it("aborts a running agent on interrupt and discards queued input", async () => {
    const agent = createAgent({ running: true });
    (agent.abort as ReturnType<typeof vi.fn>).mockImplementation(() => {
      (agent as { running: boolean }).running = false;
    });
    const loop = createLoop(agent);
    loop.handleLine("queued task");
    await loop.drain();

    loop.interrupt();
    expect(agent.abort).toHaveBeenCalledTimes(1);
    expect(loop.isStopped()).toBe(false);

    loop.handleLine("next task");
    await loop.drain();
    expect(submit).toHaveBeenCalledWith("next task");
  });

  it("stops the loop on interrupt when the agent is idle", () => {
    const loop = createLoop(createAgent());
    loop.interrupt();
    expect(loop.isStopped()).toBe(true);
  });
});
