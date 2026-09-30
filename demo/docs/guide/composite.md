# Composite Agent

当一个任务需要更大的注意力范围时，可以把多个 `Agent` 组合成一个 `CompositeAgent`。`CompositeAgent` 本身仍然是一个 Agent；它对内由 coordinator 动态决定是否委派任务、委派给谁、以及何时结束。

```ts
import { CompositeAgent } from "myloop/agent";

const compositeAgent = new CompositeAgent({
  name: "repo-agent",
  coordinator,
  workers: [
    {
      name: "coder",
      description: "负责阅读和修改代码",
      agent: coder,
    },
    {
      name: "tester",
      description: "负责运行测试并总结结果",
      agent: tester,
    },
  ],
  maxDelegations: 10,
});

const result = await compositeAgent.run("修复这个 bug 并验证");
```

`CompositeAgent` 不是固定 workflow。它把任务交给 coordinator，coordinator 每轮返回一个 JSON 指令：

```json
{"action":"delegate","delegations":[{"worker":"coder","input":"定位并修复这个问题"}]}
```

一轮也可以同时委派多个不同 worker：

```json
{
  "action": "delegate",
  "delegations": [
    {"worker": "coder", "input": "修复这个问题"},
    {"worker": "reviewer", "input": "分析相关调用链"}
  ]
}
```

worker 执行后，Composite Agent 会把输出交回 coordinator。coordinator 可以继续委派，也可以返回：

```json
{"action":"finish","answer":"修复完成，测试通过。"}
```

## 委派规则

- 同一轮中每个 worker 只能被委派一次，因为单个 `SingleAgent` 不能并发运行。
- Worker 之间不直接通信；所有委派和结果回传都经过 Composite Agent。这样每个 worker 仍拥有独立的上下文，用来扩大整体注意力范围。
- 工作区写入冲突由 coordinator 在委派时负责避免；CompositeAgent 只负责并行执行互不相同的 worker。
- `maxDelegations` 是宿主设置的硬预算，用来防止无限委派。Composite Agent 会把剩余预算告诉 coordinator；coordinator 负责在这个预算内决定每轮委派几个 worker、是否继续委派、以及何时结束。
