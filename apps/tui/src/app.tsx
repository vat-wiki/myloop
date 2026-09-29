import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { SingleAgent } from "myanne/agent";
import type { TuiLogger } from "./logging.js";
import type { RuntimeSessionStore } from "myanne/runtime";
import { TuiApp } from "./ui.js";

export type TuiAppOptions = {
  agent: SingleAgent;
  protocol: string;
  model: string;
  logger?: TuiLogger;
  sessionStore?: RuntimeSessionStore;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
};

export async function runTuiApp({
  agent,
  protocol,
  model,
  logger,
  sessionStore,
  input = process.stdin,
  output = process.stdout,
}: TuiAppOptions): Promise<void> {
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  let renderer: CliRenderer | undefined;
  let interrupt: (() => void) | undefined;
  let clearInput: (() => void) | undefined;
  let completeCommand: (() => boolean) | undefined;
  let selectCommand: ((direction: 1 | -1) => boolean) | undefined;
  let submitCommand: (() => boolean) | undefined;
  let pasteClipboard: (() => Promise<boolean>) | undefined;
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
    activeRenderer._internalKeyInput.onInternal("keypress", (event: { ctrl?: boolean; shift?: boolean; name?: string; stopPropagation?: () => void }) => {
      if (event.name === "escape") {
        event.stopPropagation?.();
        interrupt?.();
        return;
      }
      if (event.ctrl && event.name === "u") {
        event.stopPropagation?.();
        clearInput?.();
        return;
      }
      if (event.ctrl && event.name === "v") {
        event.stopPropagation?.();
        void pasteClipboard?.().catch(() => {});
        return;
      }
      if (event.name === "tab") {
        if (event.shift && selectCommand?.(-1)) {
          event.stopPropagation?.();
          return;
        }
        event.stopPropagation?.();
        if (completeCommand?.()) {
          return;
        }
      }
      if (
        (event.name === "return" || event.name === "kpenter") &&
        !event.shift &&
        submitCommand?.()
      ) {
        event.stopPropagation?.();
        return;
      }
      if (
        (event.name === "up" || event.name === "down") &&
        selectCommand?.(event.name === "up" ? -1 : 1)
      ) {
        event.stopPropagation?.();
        return;
      }
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
          sessionStore={sessionStore}
          onExit={() => resolveClosed?.()}
          registerInterrupt={(handler) => {
            interrupt = handler;
          }}
          registerClearInput={(handler) => {
            clearInput = handler;
          }}
          registerCompleteCommand={(handler) => {
            completeCommand = handler;
          }}
          registerSelectCommand={(handler) => {
            selectCommand = handler;
          }}
          registerSubmitCommand={(handler) => {
            submitCommand = handler;
          }}
          registerPasteClipboard={(handler) => {
            pasteClipboard = handler;
          }}
        />
      ),
      renderer,
    );
    await closedPromise;
  } finally {
    renderer?.destroy();
  }
}
