import { describe, expect, it } from "vitest";
import { createHeartbeatDriver } from "../src/main.js";
import type { SingleAgent } from "myloop/agent";

type HeartbeatEvent = { tick: number; at: number; running: boolean };

function createBotAgent(running = false): {
  agent: SingleAgent;
  listeners: Map<string, Array<(event: never) => void>>;
} {
  const listeners = new Map<string, Array<(event: never) => void>>();
  const agent = {
    on(type: string, listener: (event: never) => void): () => void {
      const queue = listeners.get(type) ?? [];
      queue.push(listener);
      listeners.set(type, queue);
      return () => {
        const queue = listeners.get(type) ?? [];
        const index = queue.indexOf(listener);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    get running(): boolean {
      return running;
    },
    saveSession(): Promise<void> {
      return Promise.resolve();
    },
  };
  return { agent: agent as unknown as SingleAgent, listeners };
}

function emitHeartbeat(
  listeners: Map<string, Array<(event: never) => void>>,
  event: HeartbeatEvent,
): void {
  for (const listener of listeners.get("heartbeat") ?? []) {
    (listener as (event: HeartbeatEvent) => void)(event);
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("createHeartbeatDriver", () => {
  it("runs a heartbeat task per idle tick and serializes overlapping ticks", async () => {
    const harness = createBotAgent();
    let release: (() => void) | undefined;
    const runs: Array<string> = [];
    const agent = harness.agent as unknown as {
      run(input: string): Promise<{ answer: string }>;
    };
    agent.run = (input: string) => {
      runs.push(input);
      return new Promise<{ answer: string }>((resolve) => {
        release = () => resolve({ answer: "ok" });
      });
    };

    const driver = createHeartbeatDriver({
      agent: harness.agent,
      botPrompt: "keep going",
      color: false,
    });

    emitHeartbeat(harness.listeners, { tick: 1, at: Date.now(), running: false });
    await settle();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("heartbeat #1");
    expect(runs[0]).toContain("keep going");

    emitHeartbeat(harness.listeners, { tick: 2, at: Date.now(), running: false });
    await settle();
    expect(runs).toHaveLength(1);

    release?.();
    await settle();

    emitHeartbeat(harness.listeners, { tick: 3, at: Date.now(), running: false });
    await settle();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toContain("heartbeat #3");
  });

  it("skips ticks while the agent is busy and calls onDone after each task", async () => {
    const harness = createBotAgent(true);
    const runs: Array<string> = [];
    const done: Array<number> = [];
    const agent = harness.agent as unknown as {
      run(input: string): Promise<{ answer: string }>;
    };
    agent.run = (input: string) => {
      runs.push(input);
      return Promise.resolve({ answer: "ok" });
    };

    const driver = createHeartbeatDriver({
      agent: harness.agent,
      botPrompt: "check",
      color: false,
      onDone: () => done.push(runs.length),
    });

    emitHeartbeat(harness.listeners, { tick: 1, at: Date.now(), running: false });
    await settle();
    expect(runs).toHaveLength(0);
    expect(done).toHaveLength(0);

    driver();
  });

  it("does not fire again after the returned unsubscribe", async () => {
    const harness = createBotAgent();
    const runs: Array<string> = [];
    const agent = harness.agent as unknown as {
      run(input: string): Promise<{ answer: string }>;
    };
    agent.run = (input: string) => {
      runs.push(input);
      return Promise.resolve({ answer: "ok" });
    };

    const driver = createHeartbeatDriver({
      agent: harness.agent,
      botPrompt: "check",
      color: false,
    });
    driver();

    emitHeartbeat(harness.listeners, { tick: 1, at: Date.now(), running: false });
    await settle();
    expect(runs).toHaveLength(0);
  });
});
