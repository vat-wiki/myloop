import { describe, expect, it } from "vitest";
import { formatInteractivePrompt } from "../src/tui.js";

describe("formatInteractivePrompt", () => {
  it("abbreviates the home directory", () => {
    expect(formatInteractivePrompt("/Users/dev/projects/myloop", "/Users/dev")).toBe("~/projects/myloop ❯ ");
  });

  it("keeps paths outside home intact", () => {
    expect(formatInteractivePrompt("/var/log", "/Users/dev")).toBe("/var/log ❯ ");
  });
});
