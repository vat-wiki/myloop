import { testRender } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { it } from "vitest";
import { TuiApp } from "../src/ui.js";
import type { SingleAgent } from "mycoder/agent";
type AH = (e:any)=>void; type AS = SingleAgent & { emitAgentEvent:(e:string,p:any)=>void };
function stub(runFn?:(e:AS["emitAgentEvent"])=>Promise<void>): AS {
  const h = new Map<string,AH>();
  return { emitAgentEvent:(e,p)=>h.get(e)?.(p), on:(e,f)=>{h.set(e,f);return()=>h.delete(e);}, reset(){},
    async run(){ await runFn?.((e,p)=>h.get(e)?.(p)); } } as unknown as AS;
}
const hex=(f:any)=>f?`#${f.r.toString(16).padStart(2,'0')}${f.g.toString(16).padStart(2,'0')}${f.b.toString(16).padStart(2,'0')}`:"-";
it("dump markdown spans", async () => {
  const agent = stub(async (emit) => {
    emit("assistant_message", { message: { content: [{ type:"text", text:"## Summary\n\n**3 files** changed with `npm test` passing." }] } });
  });
  const setup = await testRender(() => TuiApp({ agent, protocol:"test", model:"m", onExit:()=>{} }), { width:80, height:30 });
  await setup.renderOnce();
  for (const c of "check") for (const x of c) setup.mockInput.pressKey(x);
  setup.mockInput.pressEnter();
  await setup.flush();
  const spans = setup.captureSpans().lines.flatMap(l=>l.spans);
  for (const s of spans) if (s.text.trim()) console.log(hex(s.fg), (s.attributes&TextAttributes.BOLD)?"B":" ", JSON.stringify(s.text));
  console.log(setup.captureCharFrame());
  await setup.renderer.destroy();
});
