import { describe, expect, it } from "vitest";
import {
  createAssistantMessage,
  createUserMessage,
  documentBlock,
  imageBlock,
  normalizeContent,
  textBlock,
  toolCallBlock,
  toolResultBlock,
} from "../../src/runtime/messages.js";

describe("message helpers", () => {
  it("normalizes string content", () => {
    expect(normalizeContent("hello")).toEqual([textBlock("hello")]);
    expect(createUserMessage("hello")).toEqual({
      role: "user",
      content: [textBlock("hello")],
    });
    expect(createAssistantMessage([textBlock("answer")])).toEqual({
      role: "assistant",
      content: [textBlock("answer")],
    });
  });

  it("creates binary and tool blocks", () => {
    const source = { type: "base64", data: "abc" } as const;

    expect(imageBlock("image/png", source)).toEqual({
      type: "image",
      mediaType: "image/png",
      source,
    });
    expect(documentBlock(source, "Spec")).toEqual({
      type: "document",
      mediaType: "application/pdf",
      title: "Spec",
      source,
    });
    expect(toolCallBlock("call-1", "bash", { command: "pwd" })).toEqual({
      type: "tool_call",
      id: "call-1",
      name: "bash",
      arguments: { command: "pwd" },
    });
    expect(toolResultBlock("call-1", "ok", true)).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      content: "ok",
      isError: true,
    });
  });
});
