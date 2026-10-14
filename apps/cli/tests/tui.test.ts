import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline/promises";
import { createLineOutput, createSpinner, formatInteractivePrompt } from "../src/tui.js";

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

function setupRegion(rows = 6) {
  const input = new PassThrough();
  const chunks: Array<string> = [];
  const stream = new PassThrough();
  stream.on("data", (chunk) => chunks.push(String(chunk)));
  const rl = createInterface({ input, output: stream, terminal: true, prompt: "> " }) as unknown as Interface;
  const out = createLineOutput(stream, { rows: () => rows });
  out.attach(rl);
  return { input, rl, out, rendered: () => chunks.join("") };
}

function setupWrappedRegion(rows = 6, columns = 5) {
  const input = new PassThrough();
  const chunks: Array<string> = [];
  const stream = new PassThrough();
  stream.on("data", (chunk) => chunks.push(String(chunk)));
  const rl = createInterface({ input, output: stream, terminal: true, prompt: "> " }) as unknown as Interface;
  const out = createLineOutput(stream, { rows: () => rows, columns: () => columns });
  out.attach(rl);
  return { input, rl, out, rendered: () => chunks.join("") };
}

async function waitForRender(
  rendered: () => string,
  isReady: (text: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 100;
  let text = rendered();
  while (!isReady(text)) {
    if (Date.now() > deadline) throw new Error("readline did not repaint in time");
    await new Promise((resolve) => setTimeout(resolve, 1));
    text = rendered();
  }
  return text;
}

describe("tui", () => {
  it("pins the prompt below the append-only log region", () => {
    const { rendered } = setupRegion(6);
    expect(rendered()).toContain("\x1b[5;1H\x1b[2K\n\x1b[1;4r\x1b[4;1H\x1b[2K\x1b[6;1H");
  });

  it("appends stream fragments directly while keeping the prompt visible", () => {
    const { out, rendered } = setupRegion(6);
    out.stream("你好");
    out.stream("，世界");
    const text = rendered();
    expect(text).toContain("\x1b7\x1b[4;1H你好，世界");
    expect(text).not.toContain("你好，世界\n你好");
    expect(text).not.toContain("你好\x1b[2K");
    out.stream("\n");
    expect(rendered()).toContain("你好，世界\r\n");
  });

  it("keeps the input cursor on the prompt across stream fragments", () => {
    const { out, rendered } = setupWrappedRegion();
    out.stream("1234");
    out.stream("5");
    out.stream("67");
    const text = rendered();
    expect(text).toContain("\x1b7\x1b[4;1H1234\x1b8");
    expect(text).toContain("\x1b7\x1b[4;5H5\x1b8");
    expect(text).toContain("\x1b7\x1b[4;5H67\x1b8");
    expect((text.match(/\x1b7/g) ?? []).length).toBe(3);
    expect((text.match(/\x1b8/g) ?? []).length).toBe(3);
  });

  it("keeps readline active while stream fragments are appending", async () => {
    const { input, out, rendered } = setupWrappedRegion();
    out.stream("hello");
    await new Promise((resolve) => setTimeout(resolve, 10));
    input.write("typed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rendered()).toContain("\x1b8typed");
    out.stream("!");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const text = rendered();
    expect(text).toContain("\x1b[4;5H!");
    expect(text.endsWith("\x1b8")).toBe(true);
  });

  it("writes logs into the region and restores the prompt cursor", async () => {
    const { out, rendered } = setupRegion(6);
    out.write("log\n");
    expect(rendered()).toContain("\x1b7\x1b[4;1Hlog\r\n\x1b8");
    await waitForRender(rendered, (text) => text.endsWith("\x1b[1G\x1b[0J> \x1b[3G"));
  });

  it("composes a home-abbreviated prompt", () => {
    expect(formatInteractivePrompt("/tmp/project", "/tmp")).toBe("~/project ❯ ");
  });

  it("passes through when no readline is attached", () => {
    const stream = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const out = createLineOutput(stream);
    out.write("hello\n");
    expect(stream.write).toHaveBeenCalledWith("hello\n");
  });

  it("lifts the prompt line before writing a log chunk", async () => {
    const { input, out, rendered, rl } = setup();
    input.write("hi");
    rl.prompt(true);
    await waitForRender(rendered, (text) => text.includes("> hi"));

    out.write("[log] something happened");

    expect(rendered()).toContain("\x1b[1G\x1b[0J[log] something happened\r\n\x1b[1G\x1b[0J> hi");
  });

  it("does not double-newline chunks that already end with one", async () => {
    const { out, rendered } = setup();
    out.write("a\n");
    await waitForRender(rendered, (text) => /^\x1b\[1G\x1b\[0Ja\r\n\x1b\[1G\x1b\[0J> /.test(text));
  });

  it("preserves multi-line logs as separate terminal lines", () => {
    const { out, rendered } = setup();
    out.write("one\ntwo\n");
    expect(rendered()).toContain("one\r\ntwo\r\n");
  });

  it("appends stream fragments once without replaying prior output", async () => {
    const { out, rendered } = setup();
    const line = "这行中文会自动换行并且不能重复";
    out.stream(line);
    out.stream("!");
    out.stream("\n");
    const text = await waitForRender(rendered, (current) =>
      current.includes(`${line}!\r\n\x1b[1G\x1b[0J> `),
    );
    expect(text).toContain(`${line}!`);
    expect(text).not.toContain(`${line}!${line}`);
    expect(text).not.toContain("\x1b7");
    expect(text).toContain(`${line}!\r\n\x1b[1G\x1b[0J> `);
  });

  it("parks spinner frames below the prompt line without scrolling", () => {
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
  });

  it("renders parked frames in place when no readline is attached", () => {
    const stream = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const out = createLineOutput(stream);
    out.parkFrame("⠋ x");
    expect(stream.write).toHaveBeenCalledWith("\r⠋ x\x1b[K");
    out.parkFrame(undefined);
    expect(stream.write).toHaveBeenCalledWith("\r\x1b[K");
  });

  it("streams fragments in place and hands the row back on a trailing newline", async () => {
    const { out, rendered } = setup();
    out.stream("Hel");
    out.stream("lo ");
    out.stream("world");
    expect(rendered()).toContain("\x1b[1G\x1b[0JHel");
    expect(rendered()).toContain("Hello world");
    out.stream("\n");
    await waitForRender(rendered, (text) =>
      text.includes("Hello world\r\n") && text.endsWith("> \x1b[3G"),
    );
  });

  it("clears fragments and repaints the prompt when a write interrupts the stream", () => {
    const { out, rendered } = setup();
    out.stream("partial");
    out.write("[log]\n");
    const text = rendered();
    expect(text).toContain("\x1b[1G\x1b[0J[log]\r\n");
  });
});
