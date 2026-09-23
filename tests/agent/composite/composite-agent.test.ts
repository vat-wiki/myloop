import { describe, expect, it, vi } from "vitest";
import { SingleAgent } from "../../../src/agent/single.js";
import { createCompositeAgent } from "../../../src/agent/composite.js";
import { textBlock } from "../../../src/runtime/messages.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../../../src/runtime/model-client.js";

function response(content: ModelResponse["content"]): ModelResponse {
  return { stopReason: "end", content };
}

function modelClientWith(complete: ModelClient["complete"]): ModelClient {
  return { complete };
}

function agentWithSequence(name: string, responses: Array<ModelResponse>): SingleAgent {
  return new SingleAgent({
    name,
    modelClient: modelClientWith(vi.fn().mockImplementation(() => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected modelClient call");
      return Promise.resolve(next);
    })),
  });
}

describe("createCompositeAgent", () => {
  it("validates options", () => {
    const coordinator = agentWithSequence("coordinator", []);
    const worker = agentWithSequence("worker", []);

    expect(() => createCompositeAgent({ name: " ", coordinator, workers: [] })).toThrow("composite agent name is required");
    expect(() => createCompositeAgent({ name: "team", coordinator, workers: [] })).toThrow("composite agent requires at least one worker");
    expect(() => createCompositeAgent({
      name: "team",
      coordinator,
      workers: [{ name: "same", description: "", agent: worker }, { name: "same", description: "", agent: worker }],
    })).toThrow("duplicate worker name: same");
  });

  it("delegates to workers and returns the final coordinator answer", async () => {
    const coordinator = agentWithSequence("coordinator", [
      response([textBlock(JSON.stringify({
        action: "delegate",
        delegations: [{ worker: "researcher", input: "find the answer" }],
      }))]),
      response([textBlock("Task complete.")]),
    ]);
    const workerModelClient = vi.fn(async (request: ModelRequest): Promise<ModelResponse> => {
      const input = request.messages[0]?.content[0];
      if (input?.type !== "text") throw new Error("expected text input");
      return response([textBlock(`answer to ${input.text}`)]);
    });
    const worker = new SingleAgent({ name: "researcher", modelClient: modelClientWith(workerModelClient) });

    const composite = createCompositeAgent({
      name: "team",
      coordinator,
      workers: [{ name: "researcher", description: "finds answers", agent: worker }],
    });
    const result = await composite.run("solve the task");

    expect(result).toMatchObject({
      name: "team",
      input: "solve the task",
      answer: "Task complete.",
      delegations: [{
        worker: "researcher",
        input: "find the answer",
        output: "answer to find the answer",
      }],
    });
    expect(workerModelClient).toHaveBeenCalledTimes(1);
    expect(composite.coordinator.runtime.messages).toHaveLength(4);
    expect((composite.workers[0]?.agent as SingleAgent).runtime.messages).toHaveLength(2);
  });

  it("validates input and delegation budget", async () => {
    const coordinator = agentWithSequence("coordinator", []);
    const worker = agentWithSequence("worker", []);
    const composite = createCompositeAgent({
      name: "team",
      coordinator,
      workers: [{ name: "worker", description: "", agent: worker }],
      maxDelegations: 1,
    });

    await expect(composite.run(" ")).rejects.toThrow("composite agent input is required");
  });
});
