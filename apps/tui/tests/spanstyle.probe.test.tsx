import { testRender } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { it } from "vitest";

function App() {
  const long = "我执行了4条命令都是通过 bash 工具跑的比如 /home/dev/mycoder/node_modules/@opentui/core/dist/index.js 这个长路径 然后 git show e5e1d71 --stat";
  return (
    <box flexDirection="column" paddingLeft={2}>
      <text fg="#e2e8f0" wrapMode="word">
        <span>我执行了4条命令都是通过 </span>
        <span style={{fg:"#facc15"}}>/home/dev/mycoder/node_modules/@opentui/core/dist/index.js</span>
        <span> 这个长路径 然后 </span>
        <span style={{fg:"#facc15"}}>git show e5e1d71 --stat</span>
      </text>
      <text fg="#e2e8f0" wrapMode="word">
        <span style={{fg:"#64748b"}}>• </span>
        <span style={{bold:true}}>确认当前目录</span>
        <span> 是 </span>
        <span style={{fg:"#facc15"}}>/home/dev/mycoder</span>
      </text>
    </box>
  );
}

function hex(fg){return fg?`#${fg.r.toString(16).padStart(2,'0')}${fg.g.toString(16).padStart(2,'0')}${fg.b.toString(16).padStart(2,'0')}`:"-";}
it("probe", async () => {
  const setup = await testRender(() => App(), { width: 70, height: 10 });
  await setup.renderOnce();
  const spans = setup.captureSpans().lines.flatMap(l => l.spans);
  for (const s of spans) if (s.text.trim()) console.log(hex(s.fg), s.attributes&TextAttributes.BOLD?"B":" ", JSON.stringify(s.text));
  console.log("frame:\n"+setup.captureCharFrame());
  await setup.renderer.destroy();
});
