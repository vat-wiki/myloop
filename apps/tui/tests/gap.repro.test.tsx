import { testRender } from "@opentui/solid";
import { afterEach, it } from "vitest";
import { TuiApp } from "../src/ui.js";
import type { SingleAgent } from "mycoder/agent";

type AgentHandler = (event: any) => void;
type AgentStub = SingleAgent & { emitAgentEvent: (event: string, payload: any) => void };

function createAgentStub(runFn?: (emit: AgentStub["emitAgentEvent"]) => Promise<void>): AgentStub {
  const handlers = new Map<string, AgentHandler>();
  return {
    emitAgentEvent: (event, payload) => handlers.get(event)?.(payload),
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
    reset() {},
    async run() { await runFn?.((e, p) => handlers.get(e)?.(p)); },
  } as unknown as AgentStub;
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map((d) => d())); });

function dump(name: string, content: string, width: number) {
  it(name, async () => {
    const agent = createAgentStub(async (emit) => {
      emit("assistant_message", { message: { content: [{ type: "text", text: content }] } });
    });
    const setup = await testRender(
      () => TuiApp({ agent, protocol: "test", model: "m", onExit: () => {} }),
      { width, height: 30 },
    );
    disposers.push(async () => setup.renderer.destroy());
    await setup.renderOnce();
    for (const c of "go") setup.mockInput.pressKey(c);
    setup.mockInput.pressEnter();
    await setup.flush();
    console.log(`\n=====FRAME[${name} w=${width}]=====`);
    console.log(setup.captureCharFrame());
    console.log("=====END=====");
  });
}

// 长行 + 行内多段 inline code，会超过 80 列触发换行
dump("long-line-wrap",
  "我执行了 4 条命令都是通过 bash 工具跑的比如这个比较长的路径 `/home/dev/mycoder/node_modules/@opentui/core/dist/index.js` 然后还有另一个 `git show e5e1d71 --stat` 组合在一起",
  80);

// 用户原始场景：编号列表 + 行内代码
dump("numbered",
  "1. **`pwd && git log --oneline -5`**\n   - 确认当前目录是 `/home/dev/mycoder`，并查看最近 5 条提交，发现有 2 个 commit：`6c01dce` 和 `e5e1d71`\n\n2. **`git show HEAD --stat`**\n   - 看当前版本（`6c01dce`）的改动统计",
  80);
