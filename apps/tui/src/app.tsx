import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { SingleAgent } from "mycoder/agent";
import type { TuiLogger } from "./logging.js";
import { TuiApp } from "./ui.js";

export type TuiAppOptions = {
  agent: SingleAgent;
  protocol: string;
  model: string;
  logger?: TuiLogger;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
};

export async function runTuiApp({
  agent,
  protocol,
  model,
  logger,
  input = process.stdin,
  output = process.stdout,
}: TuiAppOptions): Promise<void> {
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  let renderer: CliRenderer | undefined;
  try {
    renderer = await createCliRenderer({
      stdin: input,
      stdout: output,
      exitOnCtrlC: false,
      clearOnShutdown: true,
      maxFps: 30,
    });
    renderer.on("destroy", () => resolveClosed?.());
    const activeRenderer = renderer;
    activeRenderer.keyInput.on("keypress", (event: { ctrl?: boolean; name?: string; stopPropagation?: () => void }) => {
      if (!event.ctrl || event.name !== "c") return;
      event.stopPropagation?.();
      if (activeRenderer.hasSelection) {
        const text = activeRenderer.getSelection()?.getSelectedText() ?? "";
        if (text) activeRenderer.copyToClipboardOSC52(text);
        activeRenderer.clearSelection();
      } else {
        process.nextTick(() => resolveClosed?.());
      }
    });
    await render(
      () => (
        <TuiApp
          agent={agent}
          protocol={protocol}
          model={model}
          logger={logger}
          onExit={() => resolveClosed?.()}
        />
      ),
      renderer,
    );
    await closedPromise;
  } finally {
    renderer?.destroy();
  }
}
