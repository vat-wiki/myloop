import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/runtime/events.js";

type TestEvents = {
  value: { value: number };
};

describe("EventBus", () => {
  it("invokes listeners and supports unsubscription", () => {
    const events = new EventBus<TestEvents>();
    const listener = vi.fn();

    const unsubscribe = events.on("value", listener);
    events.emit("value", { value: 1 });
    unsubscribe();
    events.emit("value", { value: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ value: 1 });
  });

  it("removes once listeners after first event", () => {
    const events = new EventBus<TestEvents>();
    const listener = vi.fn();

    events.once("value", listener);
    events.emit("value", { value: 1 });
    events.emit("value", { value: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not mutate the active listener list while emitting", () => {
    const events = new EventBus<TestEvents>();
    const first = vi.fn(() => events.off("value", second));
    const second = vi.fn();

    events.on("value", first);
    events.on("value", second);
    events.emit("value", { value: 1 });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
