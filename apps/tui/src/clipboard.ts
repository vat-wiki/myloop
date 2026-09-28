import { createHostClipboard } from "@opentui/core";

const decoder = new TextDecoder();

export async function readClipboardText(): Promise<string> {
  const clipboard = createHostClipboard({ maxReadBytes: 1024 * 1024, timeoutMs: 250 });
  try {
    const result = await clipboard.read({ preferredTypes: ["text/plain"] });
    return result.status === "read" ? decoder.decode(result.representation.bytes) : "";
  } finally {
    await clipboard.dispose();
  }
}
