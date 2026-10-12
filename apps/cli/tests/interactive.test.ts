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
    expect(output).toContainEqual("Commands: /exit · /cancel multiline · trailing \\ continues · Esc interrupts · Ctrl+C interrupts, second Ctrl+C exits\n");
    expect(loop.isStopped()).toBe(true);
  });

  it("rejects input while the agent is running", async () => {
    const agent = createAgent({ running: true });
    const loop = createLoop(agent);
    loop.handleLine("new task");
    await loop.drain();

    expect(submit).not.toHaveBeenCalled();
    expect(output).toContainEqual("agent is running — press Esc to interrupt\n");
    expect(output.some((line) => line.includes("new task"))).toBe(false);
    expect(loop.isStopped()).toBe(false);
  });

  it("aborts a running agent on interrupt and accepts new input afterwards", async () => {
    const agent = createAgent({ running: true });
    (agent.abort as ReturnType<typeof vi.fn>).mockImplementation(() => {
      (agent as { running: boolean }).running = false;
    });
    const loop = createLoop(agent);
    loop.interrupt();
    expect(agent.abort).toHaveBeenCalledTimes(1);
    expect(loop.isStopped()).toBe(false);

    loop.handleLine("next task");
    await loop.drain();
    expect(submit).toHaveBeenCalledWith("next task");
  });

  it("shows help while the agent is running", () => {
    const loop = createLoop(createAgent({ running: true }));
    loop.handleLine("/help");

    expect(submit).not.toHaveBeenCalled();
    expect(output.some((line) => line.startsWith("Commands:"))).toBe(true);
  });

  it("collects multiline input with a trailing backslash", async () => {
    const prompts: Array<boolean> = [];
    const loop = createInteractiveLoop({
      agent: createAgent(),
      submit,
      write: (text) => output.push(text),
      onPromptChange: (continuing) => prompts.push(continuing),
    });

    loop.handleLine("first \\");
    expect(loop.isContinuing()).toBe(true);
    expect(prompts).toEqual([true]);

    loop.handleLine("second \\");
    loop.handleLine("third");
    await loop.drain();

    expect(submit).toHaveBeenCalledWith("first \nsecond \nthird");
    expect(loop.isContinuing()).toBe(false);
    expect(prompts).toEqual([true, false]);
  });

  it("cancels multiline input and restores the normal prompt", () => {
    const prompts: Array<boolean> = [];
    const loop = createInteractiveLoop({
      agent: createAgent(),
      submit,
      write: (text) => output.push(text),
      onPromptChange: (continuing) => prompts.push(continuing),
    });

    loop.handleLine("first \\");
    loop.handleLine("/cancel");

    expect(loop.isContinuing()).toBe(false);
    expect(prompts).toEqual([true, false]);
    expect(output).toContainEqual("multiline input cancelled\n");
  });

  it("stops the loop on interrupt when the agent is idle", () => {
    const loop = createLoop(createAgent());
    loop.interrupt();
    expect(loop.isStopped()).toBe(true);
  });

  it("aborts a running agent on escape", () => {
    const agent = createAgent({ running: true });
    const onEscape = vi.fn();
    const loop = createInteractiveLoop({ agent, submit, write: (t) => output.push(t), onEscape });
    loop.handleEscape();
    expect(agent.abort).toHaveBeenCalledTimes(1);
    expect(output).toContainEqual("interrupted\n");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("ignores escape while the agent is idle", () => {
    const agent = createAgent();
    const loop = createInteractiveLoop({ agent, submit, write: (t) => output.push(t) });

    loop.handleEscape();
    expect(agent.abort).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });
});
