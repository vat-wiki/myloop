# 快速开始

```ts
import { SingleAgent, Anthropic } from "myloop";

const modelClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-sonnet-4-5",
  maxTokens: 8192,
});

const agent = new SingleAgent({
  name: "terminal-agent",
  modelClient,
  system: "你是终端Agent，用bash工具执行命令完成任务，用中文简洁回答。",
});

agent.on("text", ({ text }) => {
  console.log(text);
});

agent.on("tool_end", ({ name, input, output }) => {
  console.log(`[${name}]`, input, output);
});

const result = await agent.run("查看当前目录结构");
console.log(result.answer);
```

如果你的项目直接引用本仓库，也可以这样导入：

```ts
import { SingleAgent, Anthropic } from "./dist/index.js";
```

## 多轮会话

同一个 `Agent` 实例会保留完整 `messages`。第二次调用 `run()` 时不需要手动传历史记录。

```ts
await agent.run("查看当前目录");
await agent.run("刚才哪个目录里有哪些 TypeScript 文件？");
```

约束：

- `run()` 必须逐次 `await`，同一个 Agent 不能并发运行。
- `agent.messages` 是当前会话状态。
- `agent.reset()` 会清空会话；运行中调用会抛错。

`run()` 的输入可以是纯文本、内部内容块、输入描述符，或者它们组成的数组：

```ts
type UserInput =
  | string
  | UserContentBlock
  | UserInputPart
  | Array<string | UserContentBlock | UserInputPart>;
```

## 中断

Agent 内部管理 `AbortController`。调用 `abort()` 会取消模型请求，并终止正在运行的 terminal 命令。

```ts
setTimeout(() => agent.abort(), 10_000);

try {
  await agent.run("执行一个耗时任务");
} catch (error) {
  if (error.name === "AbortError") {
    console.log("已中断");
  }
}
```
