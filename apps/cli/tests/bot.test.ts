import { describe, expect, it } from "vitest";
import { createBotHost, type CliWorld } from "../src/bot/host.js";
import type { SingleAgent } from "myloop/agent";
import type { DriveArbiterDeps } from "../src/bot/arbiter.js";

type HeartbeatEvent = { tick: number; at: number; running: boolean };

function createCollectOutput(): { output: { write: (chunk: string) => void }; lines: Array<string> } {
  const lines: Array<string> = [];
  return { output: { write: (chunk) => lines.push(chunk) }, lines };
}

function createBotAgent(running = false): {
  agent: SingleAgent;
  listeners: Map<string, Array<(event: never) => void>>;
  runs: Array<string>;
} {
  const listeners = new Map<string, Array<(event: never) => void>>();
  const runs: Array<string> = [];
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
    abort(): void {},
    reset(): void {},
    system: "test",
    tools: [],
    run(input: string): Promise<{ answer: string; response: { stopReason: "end" } }> {
      runs.push(input);
      return Promise.resolve({ answer: "ok", response: { stopReason: "end" } });
    },
    saveSession(): Promise<void> {
      return Promise.resolve();
    },
  };
  return {
    agent: agent as unknown as SingleAgent,
    listeners,
    runs,
  };
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

describe("createBotHost", () => {
  it("builds a world snapshot from unread queue and probes", async () => {
    const harness = createBotAgent();
    const pending = [{ text: "hello", at: 1_000, source: "user" as const }];
    const { deps } = createBotHost({
      agent: harness.agent,
      color: false,
      unread: () => pending,
      probes: [() => true, () => false],
      now: () => 5_000,
    });

    const world = await deps.evaluate(3) as CliWorld;
    expect(world).toMatchObject({
      now: 5_000,
      tick: 3,
      unreadCount: 1,
      oldestUnreadAt: 1_000,
      unreadMessages: pending,
      failedHealthChecks: 1,
    });
  });

  it("act runs the prompt through the agent and records the action time", async () => {
    const harness = createBotAgent();
    const { output, lines } = createCollectOutput();
    let markedAt: number | undefined;
    const { deps } = createBotHost({
      agent: harness.agent,
      color: false,
      output,
      unread: () => [],
      markAction: (at) => {
        markedAt = at;
      },
      now: () => 42_000,
    });

    await deps.act({ drive: { name: "respond-unread", requires: [], threshold: 0.5, cooldownMs: 0, evaluate: () => null }, outcome: { pressure: 1, prompt: "go" } });
    expect(harness.runs).toEqual(["[respond-unread] go"]);
    expect(markedAt).toBe(42_000);
    expect(lines.join("")).toContain("♥ [respond-unread] go");
  });

  it("wires agent heartbeat to arbiter ticks (host-driven loop)", async () => {
    const harness = createBotAgent();
    const { output } = createCollectOutput();
    let markedAt: number | undefined;
    const { deps, drives } = createBotHost({
      agent: harness.agent,
      color: false,
      output,
      unread: () => [],
      markAction: (at) => {
        markedAt = at;
      },
      now: () => 1_000,
      drives: [{
        name: "always",
        requires: [],
        threshold: 0.5,
        cooldownMs: 0,
        evaluate: () => ({ pressure: 1, prompt: "tick work" }),
      }],
    });
    const arbiter = new (await import("../src/bot/arbiter.js")).DriveArbiter<CliWorld>({
      drives,
    });
    const off = harness.agent.on("heartbeat", (event) => {
      void arbiter.tick((event as unknown as HeartbeatEvent).tick, deps as DriveArbiterDeps<CliWorld>);
    });

    emitHeartbeat(harness.listeners, { tick: 1, at: Date.now(), running: false });
    await settle();
    expect(harness.runs).toEqual(["[always] tick work"]);
    expect(markedAt).toBeDefined();
    off();
  });
});
