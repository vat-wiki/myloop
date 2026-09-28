import { describe, expect, it } from "vitest";
import {
  errorText,
  formatTuiHelp,
  getTuiCommandSuggestions,
  stringifyResult,
  stripControlCharacters,
} from "../src/state.js";

describe("TUI state", () => {
  it("formats scalar results and errors", () => {
    expect(stringifyResult("done")).toBe("done");
    expect(stringifyResult({ ok: true })).toBe('{"ok":true}');
    expect(stringifyResult(undefined)).toBe("");
    expect(stringifyResult(null)).toBe("");
    expect(errorText(new Error("failed"))).toBe("failed");
    expect(errorText("string error")).toBe("string error");
  });

  it("strips control characters and ANSI escape sequences", () => {
    expect(stripControlCharacters("hello\r\nworld")).toBe("hello\nworld");
    expect(stripControlCharacters("\u001b[31mred\u001b[0m")).toBe("red");
    expect(stripControlCharacters("clean text")).toBe("clean text");
  });

  it("formats TUI help", () => {
    expect(formatTuiHelp()).toContain("/help");
    expect(formatTuiHelp()).toContain("/sessions");
    expect(formatTuiHelp()).toContain("/usage");
    expect(formatTuiHelp()).toContain("/reset");
    expect(formatTuiHelp()).toContain("/exit");
  });

  it("suggests commands while input starts with a slash", () => {
    expect(getTuiCommandSuggestions("/").map(({ command }) => command)).toEqual([
      "/sessions",
      "/help",
      "/usage",
      "/reset",
      "/exit",
      "/quit",
    ]);
    expect(getTuiCommandSuggestions("/u").map(({ command }) => command)).toEqual(["/usage"]);
    expect(getTuiCommandSuggestions("/usage extra")).toEqual([]);
    expect(getTuiCommandSuggestions("task /u")).toEqual([]);
  });
});
