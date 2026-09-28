import { createHostClipboard } from "@opentui/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readClipboardText } from "../src/clipboard.js";

vi.mock("@opentui/core", () => ({
  createHostClipboard: vi.fn(),
}));

const createHostClipboardMock = vi.mocked(createHostClipboard);

describe("clipboard", () => {
  beforeEach(() => {
    createHostClipboardMock.mockReset();
  });

  it("reads and decodes clipboard text", async () => {
    const dispose = vi.fn();
    const read = vi.fn().mockResolvedValue({
      status: "read",
      representation: {
        mimeType: "text/plain;charset=utf-8",
        bytes: new TextEncoder().encode("pasted text"),
      },
    });
    createHostClipboardMock.mockReturnValue({ read, dispose } as never);

    await expect(readClipboardText()).resolves.toBe("pasted text");
    expect(read).toHaveBeenCalledWith({ preferredTypes: ["text/plain"] });
    expect(dispose).toHaveBeenCalled();
  });

  it("returns empty text when the clipboard cannot be read", async () => {
    const dispose = vi.fn();
    const read = vi.fn().mockResolvedValue({ status: "unsupported" });
    createHostClipboardMock.mockReturnValue({ read, dispose } as never);

    await expect(readClipboardText()).resolves.toBe("");
    expect(dispose).toHaveBeenCalled();
  });
});
