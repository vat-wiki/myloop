import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentResult } from "../../src/agent/types.js";
import { createAgentSession } from "../../src/agent/session.js";

class ScriptedAgent implements Agent {
  readonly name: string;
  messages: Array<string> = [];

  #responses: Array<string>;

  constructor(name: string, responses: Array<string>) {
    this.name = name;
    this.#responses = responses;
  }

  async run(input: string): Promise<AgentResult> {
    this.messages.push(input);
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error(`unexpected ${this.name} call`);
    }
    return {
      answer: response,
      response: { stopReason: "end", content: [] },
    };
  }

  abort(): void {}

  reset(): void {
    this.messages = [];
  }
}

class DeferredOnceAgent implements Agent {
  readonly name: string;

  #calls = 0;
  #release?: (answer: string) => void;

  constructor(name: string) {
    this.name = name;
  }

  async run(): Promise<AgentResult> {
    this.#calls += 1;
    if (this.#calls > 1) {
      return {
        answer: "final response",
        response: { stopReason: "end", content: [] },
      };
    }

    return new Promise((resolve) => {
      this.#release = (answer) => resolve({
        answer,
        response: { stopReason: "end", content: [] },
      });
    });
  }

  release(answer: string): void {
    this.#release?.(answer);
  }

  abort(): void {}
}

describe("AgentSession", () => {
  it("uses persistent perception, brain and hand runtimes for delegated work", async () => {
    const perception = new ScriptedAgent("perception", [
      "The user wants a summary of repository activity.",
      "Here is the final user-facing summary.",
    ]);
    const brain = new ScriptedAgent("brain", [
      JSON.stringify({
        action: "delegate",
        delegations: [{ worker: "hand", input: "summarize repository activity" }],
      }),
      JSON.stringify({ action: "finish", answer: "Repository activity increased." }),
    ]);
    const hand = new ScriptedAgent("hand", ["Commits increased by 20%."]);
    const session = createAgentSession({
      name: "organism",
      perception,
      brain,
      hands: [{ name: "hand", description: "analyzes repositories", agent: hand }],
    });

    const result = await session.send("What changed in the repository?");

    expect(result).toMatchObject({
      name: "organism",
      input: "What changed in the repository?",
      perception: "The user wants a summary of repository activity.",
      answer: "Here is the final user-facing summary.",
      delegations: [{
        worker: "hand",
        input: "summarize repository activity",
        output: "Commits increased by 20%.",
      }],
    });
    expect(perception.messages).toEqual([
      "What changed in the repository?",
      expect.stringContaining("Repository activity increased."),
    ]);
    expect(brain.messages).toHaveLength(2);
    expect(hand.messages).toEqual(["summarize repository activity"]);
  });

  it("keeps agents alive across messages and clears them only on reset", async () => {
    const perception = new ScriptedAgent("perception", [
      "First perception",
      "First response",
      "Second perception",
      "Second response",
    ]);
    const brain = new ScriptedAgent("brain", [
      JSON.stringify({ action: "finish", answer: "first working answer" }),
      JSON.stringify({ action: "finish", answer: "second working answer" }),
    ]);
    const hand = new ScriptedAgent("hand", []);
    const session = createAgentSession({
      name: "organism",
      perception,
      brain,
      hands: [{ name: "hand", description: "worker", agent: hand }],
    });

    await session.send("first");
    await session.send("second");

    expect(perception.messages).toHaveLength(4);
    expect(brain.messages).toHaveLength(2);
    expect(session.status).toBe("active");

    session.reset();
    expect(perception.messages).toEqual([]);
    expect(brain.messages).toEqual([]);
  });

  it("guards lifecycle and delegation budget", async () => {
    const perception = new ScriptedAgent("perception", []);
    const brain = new ScriptedAgent("brain", []);
    const hand = new ScriptedAgent("hand", []);
    const session = createAgentSession({
      name: "organism",
      perception,
      brain,
      hands: [{ name: "hand", description: "worker", agent: hand }],
      maxDelegations: 1,
    });

    await expect(session.send(" ")).rejects.toThrow("agent session input is required");

    session.close();
    await expect(session.send("hello")).rejects.toThrow("agent session is closed");
  });

  it("supports registering and unregistering hands between messages", async () => {
    const perception = new ScriptedAgent("perception", [
      "I need the tester.",
      "Testing is complete.",
    ]);
    const brain = new ScriptedAgent("brain", [
      JSON.stringify({
        action: "delegate",
        delegations: [{ worker: "tester", input: "run the tests" }],
      }),
      JSON.stringify({ action: "finish", answer: "Tests passed." }),
    ]);
    const tester = new ScriptedAgent("tester", ["All tests passed."]);
    const session = createAgentSession({
      name: "organism",
      perception,
      brain,
    });

    expect(session.hands).toEqual([]);
    session.registerHand({
      name: "tester",
      description: "runs tests",
      agent: tester,
    });
    expect(session.hasHand("tester")).toBe(true);

    const result = await session.send("run tests");
    expect(result.delegations).toEqual([{
      worker: "tester",
      input: "run the tests",
      output: "All tests passed.",
    }]);

    expect(session.unregisterHand("tester")).toBe(true);
    expect(session.hasHand("tester")).toBe(false);
  });

  it("locks the hand roster while processing", async () => {
    const perception = new DeferredOnceAgent("perception");
    const brain = new ScriptedAgent("brain", [
      JSON.stringify({ action: "finish", answer: "done" }),
    ]);
    const session = createAgentSession({
      name: "organism",
      perception,
      brain,
    });

    const pending = session.send("hello");
    expect(session.processing).toBe(true);
    expect(() => session.registerHand({
      name: "late",
      description: "late hand",
      agent: new ScriptedAgent("late", []),
    })).toThrow("cannot change agent session hands while processing");
    expect(() => session.unregisterHand("late")).toThrow("cannot change agent session hands while processing");

    perception.release("perceived");
    await pending;
  });
});
