import { describe, expect, it, vi } from "vitest";
import { SingleAgent } from "../../src/agent/single.js";
import { textBlock } from "../../src/runtime/messages.js";
import type { ModelClient, ModelResponse } from "../../src/runtime/model-client.js";

function response(content: ModelResponse["content"]): ModelResponse {
  return { stopReason: "end", content };
}

describe("SingleAgent", () => {
  it("requires a name and returns a unified agent result", async () => {
    const complete = vi.fn().mockResolvedValue(response([textBlock("done")]));
    const modelClient: ModelClient = { complete };
    const agent = new SingleAgent({ name: "worker", modelClient });

    expect(() => new SingleAgent({ name: " ", modelClient })).toThrow("single agent name is required");

    const result = await agent.run("hello");

    expect(agent.name).toBe("worker");
    expect(result.answer).toBe("done");
    expect(result.response).toEqual(response([textBlock("done")]));
    expect(agent.messages).toHaveLength(2);
    expect(agent.running).toBe(false);
  });

  it("explains an empty answer truncated by max_tokens", async () => {
    const modelClient: ModelClient = {
      complete: async () => ({ stopReason: "max_tokens", content: [] }),
    };
    const agent = new SingleAgent({ name: "worker", modelClient });

    await expect(agent.run("hello")).rejects.toThrow(
      "model reached max_tokens before producing a text answer",
    );
  });
});
