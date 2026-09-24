# mycoder

`mycoder` 是一个 TypeScript SDK，不是一个命令行工具。它负责维护 Agent 会话、调用 ModelClient、执行工具循环，并把运行过程以事件形式暴露给调用方。

当前内置了一个 `bash` terminal 工具和 `Anthropic`、`OpenAIChat`、`OpenAIResponses` 三个 ModelClient。模型连接、模型名和请求参数由 ModelClient 管理；Runtime 只使用自己的内部消息格式。

## 设计模型

`Agent` 是可独立执行的个体。`SingleAgent` 是单上下文个体，`CompositeAgent` 是由多个 Agent 组成的个体。底层执行系统是 `AgentRuntime`：它维护消息、调用 ModelClient、执行工具循环、处理事件和上下文压缩。

`UserInput` 是统一的用户输入协议。Runtime 拥有 `user-input` 边界适配器，负责把文本、图片、文档、本地文件和远程 URL 归一化为内部消息块，并集中处理 media type、artifact、大小和安全限制。

`bash` 是 Runtime 的原生能力，而不是可插拔工具。SDK 当前不提供通用工具注入点。

Skill 是上层的领域说明和操作手册。它不新增执行通道，也不改变 Agent 内核；宿主应用负责选择 Skill，并把它们组合成最终的 system prompt。

Runtime 也提供 `AgentExtension` 扩展点。扩展可以检查或改写 ModelClient 请求、检查或改写 ModelClient 响应、以及包装内置 terminal 工具调用，但不能新增工具或替换 terminal 执行语义。

```ts
import { composeSystem, type Skill } from "mycoder/skills";

const repoSkill: Skill = {
  name: "repo",
  description: "分析当前仓库",
  instructions: `
仓库根目录是 ${process.cwd()}。
优先读取 README.md、package.json 和 src。
不要进入 node_modules。
修改代码前先理解现有结构。
使用 npm test 或 npm run build 验证。
`,
};

const agent = new SingleAgent({
  name: "coder",
  modelClient,
  system: composeSystem({
    base: "你是终端Agent，通过bash工具完成用户任务。",
    skills: [repoSkill],
  }),
});
```

`SKILL.md` 也可以直接解析为 `Skill`。`parseSkill` 接受文件路径或 Markdown 内容；以 `---` 开头的输入会按内容解析，否则按路径读取。

```ts
import { parseSkill } from "mycoder/skills";

const skill = await parseSkill(".agents/skills/repo/SKILL.md");
const inlineSkill = await parseSkill([
  "---",
  "name: repo",
  "description: 分析当前仓库",
  "---",
  "",
  "优先读取 README.md、package.json 和 src。",
].join("\n"));
```

frontmatter 必须位于文件开头，支持基本的 `key: value` 和引号值。按文件路径解析时，`name` 可以省略并回退为 skill 目录名；按内容解析时需要显式提供 `name`。

依赖方向是 `skills -> agent/runtime`，而不是 `agent/runtime -> skills`。

## Agent Extension

`AgentExtension` 是 Runtime 的外部扩展点，用来承载横切能力，例如请求审计、日志脱敏、token 用量统计或 terminal 命令包装。

```ts
import type { AgentExtension } from "mycoder";

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

扩展顺序遵循中间件约定：

```text
beforeModelCall: extension 1 -> extension 2 -> modelClient
afterModelResponse: modelClient -> extension 2 -> extension 1
wrapToolCall: outer extension wraps inner extension
```

上下文压缩是 Runtime 核心能力，见下一节；`AgentExtension` 更适合审计、缓存标记和日志脱敏这类通用 middleware。

## Context Compaction

Runtime 拥有 `messages`，并在每轮 ModelClient 调用前检查上下文压力。物理限制由 ModelClient 暴露；Runtime 不做模型驱动的智能摘要，只在接近物理上限时执行确定性 fallback。

fallback 行为很朴素：

1. 先截断过大的 `tool_result`。
2. 如果仍放不下，从安全边界开始丢弃较早消息。
3. 在被丢弃处插入一条上下文边界说明。
4. 始终保持 `tool_call` / `tool_result` 成对。
5. 如果仍放不下，抛出明确的 context exhausted 错误。

也可以手动压缩：

```ts
await agent.compact();
```

Runtime 会在每次 ModelClient 调用前触发 `context_pressure`；发生压缩后触发 `context_compacted`。

压缩触发点不是 context window 的最后一条边界。ModelClient 会提供 `reservedOutputTokens` 和 `safetyTokens`；Agent 用两者预留输出空间和估算误差余量。Anthropic 默认额外预留 20,000 tokens，因此会更早进入确定性 fallback，而不是撞到物理极限才失败。

## Composite Agent

当一个任务需要更大的注意力范围时，可以把多个 `Agent` 组合成一个 `CompositeAgent`。`CompositeAgent` 本身仍然是一个 Agent；它对内由 coordinator 动态决定是否委派任务、委派给谁、以及何时结束。

```ts
import { CompositeAgent } from "mycoder/agent";

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

同一轮中每个 worker 只能被委派一次，因为单个 `SingleAgent` 不能并发运行。工作区写入冲突由 coordinator 在委派时负责避免；CompositeAgent 只负责并行执行互不相同的 worker。

Worker 之间不直接通信；所有委派和结果回传都经过 Composite Agent。这样每个 worker 仍拥有独立的上下文，用来扩大整体注意力范围。

`maxDelegations` 是宿主设置的硬预算，用来防止无限委派。Composite Agent 会把剩余预算告诉 coordinator；coordinator 负责在这个预算内决定每轮委派几个 worker、是否继续委派、以及何时结束。

分层如下：

```text
App / 宿主应用
  选择本次任务需要的 Skill
  选择 Agent extensions
  使用 composeSystem() 组合最终 system prompt
  创建并运行 Agent
      ↓
Skill 层
  描述领域规则、工作流和约束
  只生成声明式上下文
      ↓
Agent 层
  定义可独立执行的 Agent 抽象
  SingleAgent 提供单上下文个体
  CompositeAgent 提供多 Agent 个体
      ↓
Runtime 层
  维护会话消息
  运行 Agent extensions
  调用 ModelClient
  执行内置 terminal 工具循环
      ↓
ModelClient 层
  负责模型 API 协议转换
```

Agent 层依赖 Runtime；Runtime 不依赖 Skill 层。Skill 层不新增工具或执行通道。所有实际命令仍然通过 Runtime 原生的 terminal 执行。

## 安装和构建

```bash
npm install
npm run build
npm test
```

`npm test` 当前执行 TypeScript 类型检查。`npm run build` 会把 `src/*.ts` 编译到 `dist/`。

## TUI 配置文件

TUI 使用 OpenTUI 和 Solid 构建。运行入口要求 Node.js 26.4.0 或更新版本，并启用 Node FFI。

`mycoder-tui` 会自动读取 JSON 配置文件。全局配置是 `~/.agents/mycoder.json`；非 production 环境还会从当前目录向上查找 `.agents/mycoder.json`。配置合并很简单：project 字段直接覆盖全局同名字段。最终优先级是：CLI 参数 > project 配置 > 全局配置 > 环境变量和内置默认值。

```json
{
  "protocol": "anthropic",
  "model": "claude-sonnet-4-5",
  "baseURL": "https://api.anthropic.com/v1",
  "apiKey": "local-development-key-only",
  "maxTokens": 8192,
  "timeoutMs": 60000,
  "retryAttempts": 2,
  "allowLocalFiles": true
}
```

`protocol` 只描述 API 协议；`model` 必须通过配置、CLI 或环境变量提供，SDK 不维护模型列表。`apiKey` 可以直接写入本地开发配置，但不要提交包含真实 key 的配置文件；不配置时默认读取 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`。

## 快速开始

```ts
import { SingleAgent, Anthropic } from "mycoder";

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

## 多模态消息

SDK 使用自己的内部 block 格式。用户输入支持 `text`、`image`、`document` 和 `video`。

```ts
import { documentBlock, imageBlock } from "mycoder";

await agent.run([
  { type: "text", text: "请分析这张图和这份 PDF" },
  imageBlock("image/png", {
    type: "base64",
    data: "iVBORw0KGgo...",
  }),
  documentBlock(
    { type: "url", url: "https://example.com/report.pdf" },
    "Quarterly report",
  ),
]);
```

视频可以这样表示：

```ts
await agent.run([
  { type: "text", text: "请理解这段视频" },
  {
    type: "video",
    mediaType: "video/mp4",
    source: { type: "url", url: "https://example.com/demo.mp4" },
  },
]);
```

### User Input Adapter

`SingleAgent` 会先用 User Input Adapter 把用户输入转换成 Runtime 认识的内部 block。默认规则是：

- 普通文本转换成 `text` block。
- `imageUrl` 和 `documentUrl` 保留为 URL source，不会自动下载。
- 本地文件默认禁止，必须显式开启。
- 本地文件会保存为 artifact 引用，不会把 base64 放进消息历史；未配置 `artifactStore` 时默认使用 `InMemoryArtifactStore`。
- URL 只接受 `http:` 和 `https:`。
- `maxLocalFileBytes` 限制单个本地文件；`maxTotalInputBytes` 限制一次输入中二进制内容的总大小。

```ts
const agent = new SingleAgent({
  name: "multimodal-agent",
  modelClient,
  input: {
    allowLocalFiles: true,
    allowRemoteUrls: true,
    maxLocalFileBytes: 20 * 1024 * 1024,
    maxTotalInputBytes: 20 * 1024 * 1024,
    artifactStore, // 建议把同一个 store 传给 modelClient，用于解析 artifact
  },
});

await agent.run([
  "请分析这张本地图和这份远程 PDF",
  { type: "imageFile", path: "./diagram.png" },
  {
    type: "documentUrl",
    url: "https://example.com/report.pdf",
    title: "Quarterly report",
  },
]);
```

### Model Client Input Mapping

Runtime 不做模型输入能力协商，也不代表模型判断某个输入是否受支持。`messages` 会原样交给 ModelClient；每个协议 client 在自己的 `complete()` 中把内部 block 翻译成对应 API 格式。API 不支持某个输入时，由 API 返回错误。

如果本地文件被 User Input Adapter 存成了 artifact，协议 client 必须配置同一个 `artifactStore`，并在翻译请求时自己解析 artifact 引用。Runtime 不会在中间下载 URL 或转换 base64。

如果宿主应用需要完全控制文件读取、远程抓取或鉴权，可以注入自定义 adapter：

```ts
const agent = new SingleAgent({
  name: "multimodal-agent",
  modelClient,
  input: {
    async resolve(input) {
      // 把宿主应用的输入转换为 UserContentBlock 数组。
      return [];
    },
  },
});
```

### HTTP Transport, Timeout 和 Retry

所有内置 ModelClient 默认通过同一个 HTTP transport 请求模型 API。默认实现使用原生 `fetch`，默认超时 60 秒，默认重试 2 次（也就是首次请求加最多一次重试）。

只会重试临时性错误：

- 网络连接失败
- `408`、`425`、`429`
- `500`、`502`、`503`、`504`

`400`、`401`、`403`、`404`、`413`、`422` 这类确定性错误不会重试。用户 abort 也不会重试。

可以调整超时和重试：

```ts
const modelClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-sonnet-4-5",
  timeoutMs: 60_000,
  retry: {
    attempts: 3,
    initialDelayMs: 500,
    maxDelayMs: 8_000,
  },
});
```

也可以替换成 axios、undici 或其他 HTTP 工具：

```ts
import axios from "axios";
import type { HttpTransport } from "mycoder";

const axiosTransport: HttpTransport = async (request) => {
  const response = await axios.request({
    url: request.url,
    method: request.method,
    headers: request.headers,
    data: request.body,
    signal: request.signal,
    responseType: "text",
  });

  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    headers: new Headers(response.headers as Record<string, string>),
    text: String(response.data),
  };
};

const modelClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-sonnet-4-5",
  transport: axiosTransport,
  retry: { attempts: 1 },
});
```

注意：

- Runtime 和 User Input Adapter 默认不会下载 URL；URL 只由协议 client 透传给模型 API。
- `base64` 数据由调用方负责编码。
- 本地文件默认有单文件 20 MB 和单次输入 20 MB 上限，可分别通过 `maxLocalFileBytes` 和 `maxTotalInputBytes` 调整。
- `InMemoryArtifactStore` 是进程内的最小实现，不会持久化；生产应用可以实现自己的 `ArtifactStore`。
- 当前 `Anthropic` 支持 image/document 映射，不支持视频输入；视频应由支持视频的 ModelClient 处理，或调用方先抽帧/转文字。

## Terminal 工具

Agent 当前固定内置一个 `bash` 工具。当模型返回 `tool_call` 时，Agent 会通过 PTY 执行命令，等待工具循环直到模型给出最终回答。

```ts
await agent.run("用 ls 查看当前目录，然后总结文件类型");
```

工具执行过程中会触发事件：

```ts
agent.on("tool_start", ({ name, input }) => {
  console.log("tool start", name, input);
});

agent.on("tool_end", ({ name, input, output }) => {
  console.log("tool end", name, output);
});
```

### 安全提示

这个工具允许模型在宿主机 shell 中执行任意命令。生产环境或不可信任务里，必须用容器、VM、sandbox、用户白名单或人工审批来控制风险。SDK 目前没有内置轮数限制；是否继续多轮由模型和 ModelClient 协议决定。

## 事件

所有事件都是可选的。

| 事件 | 触发时机 |
| --- | --- |
| `message` | 每条内部格式消息被加入会话时 |
| `user_message` | 用户消息加入会话时 |
| `assistant_message` | 模型消息加入会话时 |
| `tool_message` | 工具结果消息加入会话时 |
| `model_response` | 收到 ModelClient 规范化响应时 |
| `model_usage` | 解析本次模型调用 token 用量后 |
| `text` | 最终响应中的文本合并后触发 |
| `text_delta` | 内置协议 client 解析到流式文本增量时触发 |
| `tool_start` | terminal 工具开始执行前 |
| `tool_end` | terminal 工具执行完成后 |
| `context_pressure` | 每次 ModelClient 调用前上下文压力检查后 |
| `context_compacted` | fallback 压缩改变了消息历史 |
| `end` | 本次 `run()` 正常完成 |
| `error` | 本次 `run()` 抛错 |

```ts
const dispose = agent.on("tool_end", (event) => {
  console.log(event);
});

dispose(); // 取消订阅
```

也可以使用 `agent.once()` 和 `agent.off()`。

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

## 自定义 ModelClient

ModelClient 接收 Agent 的内部消息格式，并返回规范化响应。

```ts
import type { ModelClient } from "mycoder";

const modelClient: ModelClient = {
  async complete({ system, messages, tools, signal }) {
    signal?.throwIfAborted();

    // 在这里把内部 messages/tools 转换成目标模型 API 的格式。
    const reply = await callYourModelApi({
      system,
      messages,
      tools,
      signal,
    });

    return {
      stopReason: "end",
      content: [
        {
          type: "text",
          text: reply,
        },
      ],
    };
  },
};

const agent = new AgentRuntime({ modelClient });
```

ModelClient 可以可选地提供模型上下文信息：

```ts
const modelClient: ModelClient = {
  context: {
    contextWindowTokens: 200_000,
    reservedOutputTokens: 8192,
    estimateRequestTokens(request) {
      return Math.ceil(JSON.stringify(request).length / 4);
    },
  },
  async complete(request) {
    // ...
    return {
      stopReason: "end",
      content: [],
      usage: {
        inputTokens: 1024,
        outputTokens: 128,
      },
    };
  },
};
```

`stopReason` 当前有两个值：

- `end`：最终回答完成。
- `tool_call`：模型请求执行工具，Agent 会执行 terminal 命令并继续循环。

转换层负责把内部 block 转成目标模型协议。例如 `Anthropic` 会把内部 `tool_call` 映射为 Anthropic 的 `tool_use`；`OpenAIChat` 映射到 Chat Completions 的 `tool_calls`；`OpenAIResponses` 映射到 Responses API 的 `function_call` / `function_call_output`。

## Streaming Output

Runtime 会把 `onTextDelta` 回调放进 `ModelRequest`。内置的 Anthropic、OpenAIChat 和 OpenAIResponses client 会请求 SSE 流，并把模型文本增量解析成 Runtime 的 `text_delta` 事件：

```ts
agent.on("text_delta", ({ delta }) => {
  process.stdout.write(delta);
});
```

完整回复仍会在一次模型调用结束后通过 `text` 和 `assistant_message` 事件发出，因此不会重复消费最终结果。工具调用参数必须等到流式 JSON 组装完成后再执行。自定义 `transport` 当前走非流式 fallback；自定义 ModelClient 可以在自己的 `complete()` 中调用 `request.onTextDelta` 来接入同一事件流。

## Token Usage

每个内置 ModelClient 都会把协议返回的 usage 归一化到 `ModelUsage`：

- `Anthropic`：读取 `input_tokens`、`output_tokens`、cache read/create tokens，并计算 `totalTokens`。
- `OpenAIChat`：读取 `prompt_tokens`、`completion_tokens`、`total_tokens`、cached prompt tokens 和 reasoning tokens。
- `OpenAIResponses`：读取 `input_tokens`、`output_tokens`、`total_tokens`、cached input tokens 和 reasoning tokens。

Runtime 会把每次调用的 usage 累加到 `agent.usage`，并在每次响应后发出 `model_usage` 事件：

```ts
console.log(agent.usage.inputTokens, agent.usage.outputTokens, agent.usage.totalTokens);

agent.on("model_usage", ({ usage, totalUsage }) => {
  console.log(usage, totalUsage);
});
```

## 项目结构

```text
src/
├── index.ts
├── agent/
│   ├── types.ts          # Agent 抽象和统一结果
│   ├── single.ts         # SingleAgent
│   ├── composite.ts      # CompositeAgent
│   └── index.ts
├── runtime/
│   ├── agent.ts          # AgentRuntime 编排和工具循环
│   ├── context.ts        # 确定性上下文 fallback 和压力估算
│   ├── events.ts         # 事件系统
│   ├── extension.ts      # Runtime 外部扩展点
│   ├── messages.ts       # 内部消息/block 格式
│   ├── model-client.ts      # 通用 ModelClient 接口
│   ├── terminal.ts       # bash terminal 工具
│   └── index.ts
├── clients/
    ├── anthropic.ts    # Anthropic 协议转换层
    ├── openai-chat.ts # OpenAI Chat Completions 协议客户端
    ├── openai-responses.ts # OpenAI Responses 协议客户端
    ├── openai-common.ts # OpenAI 共享 HTTP 和参数工具
    ├── http.ts # 共享 HTTP transport、timeout 和 retry
    └── index.ts
├── skills/
│   ├── compose.ts      # Skill 到 system prompt 的组合层
│   └── index.ts
```
