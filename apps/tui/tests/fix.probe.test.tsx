import { testRender, extend } from "@opentui/solid";
import { TextRenderable, BoxRenderable, TextAttributes } from "@opentui/core";
import { afterEach, it } from "vitest";
import { createSignal } from "solid-js";

// Probe: compare row-of-text (buggy) vs single-text-with-span (fixed)
function App() {
  const long = "我执行了4条命令都是通过 bash 工具跑的比如这个比较长的路径 /home/dev/mycoder/node_modules/@opentui/core/dist/index.js 然后还有另一个 git show e5e1d71 --stat 组合在一起";
  return (
    <box flexDirection="column" paddingLeft={2}>
      <text fg="#22d3ee" attributes={TextAttributes.BOLD}>ROW OF TEXT (buggy):</text>
      {/* current approach: box row of text segments */}
      <box flexDirection="row">
        <text fg="#e2e8f0">我执行了4条命令都是通过 </text>
        <text fg="#facc15">/home/dev/mycoder/node_modules/@opentui/core/dist/index.js</text>
        <text fg="#e2e8f0"> 然后还有另一个 </text>
        <text fg="#facc15">git show e5e1d71 --stat</text>
        <text fg="#e2e8f0"> 组合在一起</text>
      </box>
      <text fg="#22d3ee" attributes={TextAttributes.BOLD}>SINGLE TEXT + SPAN (fixed):</text>
      {/* fixed approach: one text, spans inside stay in same flow */}
      <text fg="#e2e8f0" wrapMode="word">
        <span>我执行了4条命令都是通过 </span>
        <span fg="#facc15">/home/dev/mycoder/node_modules/@opentui/core/dist/index.js</span>
        <span> 然后还有另一个 </span>
        <span fg="#facc15">git show e5e1d71 --stat</span>
        <span> 组合在一起</span>
      </text>
    </box>
  );
}

it("probe", async () => {
  const setup = await testRender(() => App(), { width: 80, height: 30 });
  const dispose = () => setup.renderer.destroy();
  await setup.renderOnce();
  console.log("=====FRAME=====");
  console.log(setup.captureCharFrame());
  console.log("=====END=====");
  await dispose();
});
