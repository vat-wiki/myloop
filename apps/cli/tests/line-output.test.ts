import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline/promises";
import { createLineOutput } from "../src/line-output.js";

function setup() {
  const input = new PassThrough();
  const chunks: Array<string> = [];
  const stream = new PassThrough();
  stream.on("data", (chunk) => chunks.push(String(chunk)));
  const rl = createInterface({ input, output: stream, terminal: true, prompt: "> " }) as unknown as Interface;
  const out = createLineOutput(stream);
  out.attach(rl);
  return { input, rl, out, rendered: () => chunks.join("") };
}

describe("line-output", () => {
  it("passes through when no readline is attached", () => {
    const stream = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const out = createLineOutput(stream);
    out.write("hello\n");
    expect(stream.write).toHaveBeenCalledWith("hello\n");
  });

  it("lifts the prompt line before writing a log chunk", async () => {
    const { input, out, rendered } = setup();
    input.write("hi");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = rendered();

    out.write("[log] something happened");

    const after = rendered();
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe("\x1b[1G\x1b[0J[log] something happened\r\n\x1b[1G\x1b[0J> hi\x1b[5G");
  });

  it("does not double-newline chunks that already end with one", () => {
    const { out, rendered } = setup();
    out.write("a\n");
    expect(rendered()).toMatch(/^\x1b\[1G\x1b\[0Ja\r\n\x1b\[1G\x1b\[0J> (\x1b\[7m\x1b\[\d+G\x1b\[27m|\x1b\[\d+G)?$/);
  });

  it("preserves multi-line logs as separate terminal lines", () => {
    const { out, rendered } = setup();
    out.write("one\ntwo\n");
    expect(rendered()).toContain("one\r\ntwo\r\n");
  });

  it("parks a spinner frame below the prompt line without scrolling", () => {
    const { out, rendered } = setup();
    out.parkFrame("⠋ thinking…");
    expect(rendered()).toContain("\n\r⠋ thinking…\x1b[K\x1b[1A\x1b[");
    out.parkFrame("⠙ thinking…");
    expect(rendered()).toContain("\x1b[1B\r⠙ thinking…\x1b[K\x1b[1A\x1b[");
    out.parkFrame(undefined);
    expect(rendered()).toContain("\x1b[1B\r\x1b[2K\x1b[1A\x1b[");
    expect((rendered().match(/\n\r/g) ?? []).length).toBe(1);
  });

  it("reparks the parked frame below the prompt after a log write", () => {
    const { out, rendered } = setup();
    out.parkFrame("⠋ x");
    out.write("log line\n");
    const text = rendered();
    expect(text).toContain("\x1b[1G\x1b[0Jlog line\r\n");
    expect(text.indexOf("log line")).toBeLessThan(text.lastIndexOf("⠋ x"));
    out.parkFrame("⠙ x");
    out.parkFrame("⠹ x");
    expect((rendered().match(/\n\r/g) ?? []).length).toBe(2);
  });

  it("renders parked frames in place when no readline is attached", () => {
    const stream = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const out = createLineOutput(stream);
    out.parkFrame("⠋ x");
    expect(stream.write).toHaveBeenCalledWith("\r⠋ x\x1b[K");
    out.parkFrame(undefined);
    expect(stream.write).toHaveBeenCalledWith("\r\x1b[K");
  });
});
