import { describe, expect, it } from "vitest";
import { TuiPresenter } from "../src/presenter.js";

describe("TuiPresenter", () => {
  it("formats event lines by kind", () => {
    const presenter = new TuiPresenter();
    const timestamp = new Date("2026-01-01T00:00:00Z");

    presenter.push("user", "hello", timestamp);
    presenter.pushEvent({
      type: "tool_start",
      name: "bash",
      input: { command: "pwd" },
    }, timestamp);
    presenter.pushEvent({ type: "assistant_text", text: "done" }, timestamp);

    const rendered = stripAnsi(presenter.renderFrom(0));
    expect(rendered).toContain("hello");
    expect(rendered).toContain("▶ bash {\"command\":\"pwd\"}");
    expect(rendered).toContain("done");
  });

  it("formats usage and error events", () => {
    const presenter = new TuiPresenter();
    presenter.pushEvent({ type: "usage", inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    presenter.pushEvent({ type: "error", error: new Error("failed") });

    expect(presenter.lines.map((line) => line.text)).toEqual([
      "tokens · in 12 · out 3 · total 15",
      "failed",
    ]);
  });

  it("keeps a bounded transcript", () => {
    const presenter = new TuiPresenter(2);
    presenter.push("user", "one");
    presenter.push("user", "two");
    presenter.push("user", "three");

    expect(presenter.lines.map((line) => line.text)).toEqual(["two", "three"]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}
