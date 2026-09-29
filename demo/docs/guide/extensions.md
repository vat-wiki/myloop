# Agent Extension

`AgentExtension` 是 Runtime 的外部扩展点，用来承载横切能力，例如请求审计、日志脱敏、token 用量统计或 terminal 命令包装。

```ts
import type { AgentExtension } from "myanne";

const auditExtension: AgentExtension = {
  name: "audit",
  beforeModelCall(request) {
    console.log("modelClient request messages:", request.messages.length);
    return request;
  },
  afterModelResponse({ response }) {
    console.log("modelClient response blocks:", response.content.length);
    return response;
  },
  wrapToolCall({ name, handler }) {
    if (name !== "bash") return;

    return async (input, context) => {
      console.log("bash input:", input);
      const output = await handler(input, context);
      console.log("bash output:", output);
      return output;
    };
  },
};

const agent = new SingleAgent({
  name: "audited-agent",
  modelClient,
  extensions: [auditExtension],
});
```

扩展可以检查或改写 ModelClient 请求、检查或改写 ModelClient 响应、以及包装内置 terminal 工具调用，但不能新增工具或替换 terminal 执行语义。

## 扩展顺序

扩展顺序遵循中间件约定：

```text
beforeModelCall: extension 1 -> extension 2 -> modelClient
afterModelResponse: modelClient -> extension 2 -> extension 1
wrapToolCall: outer extension wraps inner extension
```

上下文压缩是 Runtime 核心能力；`AgentExtension` 更适合审计、缓存标记和日志脱敏这类通用 middleware。
