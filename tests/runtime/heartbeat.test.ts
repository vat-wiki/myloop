import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../src/runtime/agent.js";
import { Heartbeat } from "../../src/runtime/heartbeat.js";
import type { AgentEventMap } from "../../src/runtime/events.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../../src/runtime/model-client.js";
import { textBlock } from "../../src/runtime/messages.js";

type HeartbeatEvent = AgentEventMap["heartbeat"];

function response(): ModelResponse {
  return { stopReason: "end", content: [textBlock("done")] };
}

function deferredModelClient(): {
  client: ModelClient;
  calls: Array<(r: ModelResponse) => void>;
} {
  const calls: Array<(r: ModelResponse) => void> = [];
  const client: ModelClient = {
    complete(_request: ModelRequest): Promise<ModelResponse> {
      return new Promise<ModelResponse>((resolve) => {
        calls.push(resolve);
      });
    },
  };
  return { client, calls };
}

describe("AgentRuntime heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks during run() and stops automatically when run finishes", async () => {
    const { client, calls } = deferredModelClient();
    const runtime = new AgentRuntime({
      modelClient: client,
      heartbeat: { intervalMs: 100 },
    });
    const ticks: Array<HeartbeatEvent> = [];
    runtime.on("heartbeat", (event) => ticks.push(event));

    const runPromise = runtime.run("hello");
    await vi.advanceTimersByTimeAsync(350);

    expect(ticks.map((tick) => tick.tick)).toEqual([1, 2, 3]);
    expect(ticks.every((tick) => tick.running)).toBe(true);

    calls[0]?.(response());
    await runPromise;

    const count = ticks.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks.length).toBe(count);
  });

  it("restarts the clock on the next run after finishing", async () => {
    const { client, calls } = deferredModelClient();
    const runtime = new AgentRuntime({
      modelClient: client,
      heartbeat: { intervalMs: 100 },
    });
    const ticks: Array<HeartbeatEvent> = [];
    runtime.on("heartbeat", (event) => ticks.push(event));

    const first = runtime.run("first");
    await vi.advanceTimersByTimeAsync(150);
    calls[0]?.(response());
    await first;

    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toHaveLength(1);

    const second = runtime.run("second");
    await vi.advanceTimersByTimeAsync(150);
    calls[1]?.(response());
    await second;

    expect(ticks.map((tick) => tick.tick)).toEqual([1, 2]);
  });

  it("keeps ticking after run() with mode: always until stopHeartbeat()", async () => {
    const { client, calls } = deferredModelClient();
    const runtime = new AgentRuntime({
      modelClient: client,
      heartbeat: { intervalMs: 100, mode: "always" },
    });
    const ticks: Array<HeartbeatEvent> = [];
    runtime.on("heartbeat", (event) => ticks.push(event));

    await vi.advanceTimersByTimeAsync(250);
    expect(ticks.map((tick) => tick.running)).toEqual([false, false]);

    const runPromise = runtime.run("hello");
    await vi.advanceTimersByTimeAsync(150);
    expect(ticks.slice(2).every((tick) => tick.running)).toBe(true);
    expect(ticks.at(-1)?.running).toBe(true);

    calls[0]?.(response());
    await runPromise;

    const count = ticks.length;
    await vi.advanceTimersByTimeAsync(150);
    expect(ticks.length).toBeGreaterThan(count);

    runtime.stopHeartbeat();
    const stopped = ticks.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks.length).toBe(stopped);
  });

  it("startHeartbeat() revives a stopped clock", async () => {
    const { client, calls } = deferredModelClient();
    const runtime = new AgentRuntime({
      modelClient: client,
      heartbeat: { intervalMs: 100, mode: "always" },
    });
    const ticks: Array<HeartbeatEvent> = [];
    runtime.on("heartbeat", (event) => ticks.push(event));

    await vi.advanceTimersByTimeAsync(100);
    runtime.stopHeartbeat();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toHaveLength(1);

    runtime.startHeartbeat();
    await vi.advanceTimersByTimeAsync(100);
    expect(ticks).toHaveLength(2);
    expect(ticks[1]?.tick).toBe(2);

    calls[0]?.(response());
  });

  it("emits monotonic ticks with timestamps", async () => {
    vi.setSystemTime(1000);
    const { client, calls } = deferredModelClient();
    const runtime = new AgentRuntime({
      modelClient: client,
      heartbeat: { intervalMs: 100 },
    });
    const ticks: Array<HeartbeatEvent> = [];
    runtime.on("heartbeat", (event) => ticks.push(event));

    const runPromise = runtime.run("hello");
    await vi.advanceTimersByTimeAsync(200);
    calls[0]?.(response());
    await runPromise;

    expect(ticks.map((tick) => tick.at)).toEqual([1100, 1200]);
  });

  it("uses an injectable timer factory", async () => {
    const { client, calls } = deferredModelClient();
    const timers: Array<{ callback: () => void; cleared: boolean }> = [];
    const runtime = new AgentRuntime({
      modelClient: client,
      heartbeat: {
        intervalMs: 100,
        timer: (callback) => {
          const handle = { callback, cleared: false };
          timers.push(handle);
          return { clear: () => { handle.cleared = true; } };
        },
      },
    });
    const ticks: Array<HeartbeatEvent> = [];
    runtime.on("heartbeat", (event) => ticks.push(event));

    const runPromise = runtime.run("hello");
    await vi.advanceTimersByTimeAsync(0);

    expect(timers).toHaveLength(1);
    expect(timers[0]?.cleared).toBe(false);

    timers[0]?.callback();
    expect(ticks.map((tick) => tick.tick)).toEqual([1]);
    expect(timers).toHaveLength(2);

    calls[0]?.(response());
    await runPromise;

    expect(timers[1]?.cleared).toBe(true);
    expect(timers).toHaveLength(2);
  });

  it("does not tick when heartbeat is not configured", async () => {
    const { client, calls } = deferredModelClient();
    const runtime = new AgentRuntime({ modelClient: client });
    const ticks: Array<HeartbeatEvent> = [];
    runtime.on("heartbeat", (event) => ticks.push(event));

    const runPromise = runtime.run("hello");
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toHaveLength(0);

    calls[0]?.(response());
    await runPromise;
  });

  it("rejects invalid heartbeat intervals", () => {
    const { client } = deferredModelClient();
    expect(() => new AgentRuntime({
      modelClient: client,
      heartbeat: { intervalMs: 0 },
    })).toThrow("heartbeat intervalMs must be a positive number");
    expect(() => new AgentRuntime({
      modelClient: client,
      heartbeat: { intervalMs: -5 },
    })).toThrow("heartbeat intervalMs must be a positive number");
    expect(() => new AgentRuntime({
      modelClient: client,
      heartbeat: { intervalMs: Number.NaN },
    })).toThrow("heartbeat intervalMs must be a positive number");
  });
});

describe("Heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function captureHooks(running = false) {
    const ticks: Array<{ tick: number; at: number; running: boolean }> = [];
    return {
      ticks,
      hooks: {
        isBusy: () => running,
        onTick: (event: { tick: number; at: number; running: boolean }) => ticks.push(event),
      },
    };
  }

  it("ticks repeatedly until stopped", () => {
    const { ticks, hooks } = captureHooks();
    const heartbeat = new Heartbeat({ intervalMs: 50 }, hooks);
    heartbeat.resume();

    vi.advanceTimersByTime(150);
    expect(ticks.map((tick) => tick.tick)).toEqual([1, 2, 3]);

    heartbeat.stop();
    vi.advanceTimersByTime(500);
    expect(ticks).toHaveLength(3);
  });

  it("start() after stop() resets the stopped flag without resetting tick", () => {
    const { ticks, hooks } = captureHooks();
    const heartbeat = new Heartbeat({ intervalMs: 50 }, hooks);
    heartbeat.resume();

    vi.advanceTimersByTime(100);
    heartbeat.stop();
    vi.advanceTimersByTime(100);
    expect(ticks).toHaveLength(2);

    heartbeat.start();
    vi.advanceTimersByTime(50);
    expect(ticks.map((tick) => tick.tick)).toEqual([1, 2, 3]);
  });

  it("pause()/resume() in running mode round-trips", () => {
    const { ticks, hooks } = captureHooks();
    const heartbeat = new Heartbeat({ intervalMs: 50, mode: "running" }, hooks);
    heartbeat.resume();

    vi.advanceTimersByTime(50);
    heartbeat.pause();
    vi.advanceTimersByTime(500);
    expect(ticks).toHaveLength(1);

    heartbeat.resume();
    vi.advanceTimersByTime(50);
    expect(ticks).toHaveLength(2);
  });

  it("pause() is a no-op in always mode", () => {
    const { ticks, hooks } = captureHooks();
    const heartbeat = new Heartbeat({ intervalMs: 50, mode: "always" }, hooks);

    heartbeat.pause();
    vi.advanceTimersByTime(100);
    expect(ticks).toHaveLength(2);
  });

  it("reports running via isBusy hook", () => {
    const { ticks, hooks } = captureHooks(true);
    const heartbeat = new Heartbeat({ intervalMs: 50 }, hooks);
    heartbeat.resume();
    vi.advanceTimersByTime(50);
    expect(ticks[0]?.running).toBe(true);
  });

  it("uses the injected timer factory and honors clear()", () => {
    const { hooks } = captureHooks();
    const handles: Array<{ fired: boolean; cleared: boolean }> = [];
    const heartbeat = new Heartbeat(
      {
        intervalMs: 50,
        timer: (callback) => {
          const handle = { callback, fired: false, cleared: false };
          handles.push(handle);
          return { clear: () => { handle.cleared = true; } };
        },
      },
      hooks,
    );
    heartbeat.resume();

    expect(handles).toHaveLength(1);
    handles[0]!.callback();
    heartbeat.stop();
    expect(handles.at(-1)?.cleared).toBe(true);
  });

  it("rejects invalid intervals", () => {
    const { hooks } = captureHooks();
    expect(() => new Heartbeat({ intervalMs: 0 }, hooks)).toThrow("heartbeat intervalMs must be a positive number");
  });
});
