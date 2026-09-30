# API 概览

`myloop` 的导出面如下：

## 包入口

```ts
import {
  // Agent
  SingleAgent,
  CompositeAgent,
  createCompositeAgent,
  AgentSession,
  createAgentSession,
  // Runtime
  AgentRuntime,
  createAgentRuntime,
  EventBus,
  // Terminal
  createTerminalTool,
  runPty,
  runShell,
  // Skills
  composeSystem,
  parseSkill,
  parseSkillFile,
  parseSkillContents,
  // ModelClients
  Anthropic,
  OpenAIChat,
  OpenAIResponses,
  // 工具
  imageBlock,
  documentBlock,
  InMemoryArtifactStore,
  sumTokenCounts,
} from "myloop";
```

## 子路径导出

| 子路径 | 内容 |
| --- | --- |
| `myloop` | 全部公共 API（root） |
| `myloop/agent` | `SingleAgent`、`CompositeAgent`、`AgentSession`、UserInput 相关 |
| `myloop/runtime` | `AgentRuntime`、事件、terminal、messages 等 |
| `myloop/messages` | 内部消息/block 格式 |
| `myloop/terminal` | `createTerminalTool`、`runPty`、`runShell` |
| `myloop/clients/anthropic` | `Anthropic` |
| `myloop/clients/openai-chat` | `OpenAIChat` |
| `myloop/clients/openai-responses` | `OpenAIResponses` |
| `myloop/skills` | `composeSystem`、`parseSkill` |
| `myloop/composite` | `CompositeAgent` |
| `myloop/session` | `AgentSession` |
| `myloop/agent/context`、`myloop/runtime/context` | 上下文压力估算与 fallback |

## Agent 接口

```ts
interface Agent {
  readonly name: string;
  run(input: UserInput): Promise<AgentResult>;
  abort(reason?: unknown): void;
  reset?(): void;
}
```

`SingleAgent` 在 `Agent` 之上暴露运行时状态和事件订阅：

```ts
declare class SingleAgent implements Agent {
  readonly name: string;
  readonly runtime: AgentRuntime;
  readonly messages: AgentMessage[];
  readonly running: boolean;
  run(input: UserInput): Promise<AgentResult>;
  on<K extends keyof AgentEventMap>(type: K, listener: EventListener<AgentEventMap[K]>): () => void;
  once<K extends keyof AgentEventMap>(type: K, listener: EventListener<AgentEventMap[K]>): () => void;
  off<K extends keyof AgentEventMap>(type: K, listener: EventListener<AgentEventMap[K]>): void;
  compact(): Promise<CompactionResult>;
  abort(reason?: unknown): void;
  reset(): void;
}
```

关键约束：

- `run()` 必须逐次 `await`，同一个 Agent 不能并发运行。
- `reset()` 清空会话；运行中调用会抛错。
- `abort()` 取消模型请求并终止正在运行的 terminal 命令。

## ModelClient 接口

```ts
interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
  context?: {
    contextWindowTokens: number;
    reservedOutputTokens: number;
    safetyTokens?: number;
    estimateRequestTokens(request: ModelRequest): number;
  };
}

interface ModelResponse {
  stopReason: "end" | "tool_call";
  content: ContentBlock[];
  usage?: ModelUsage;
}
```

## 常用类型

| 类型 | 说明 |
| --- | --- |
| `UserInput` | `string \| UserContentBlock \| UserInputPart \| Array<...>` |
| `AgentResult` | 一次 `run()` 的统一结果（含 `answer`） |
| `ModelUsage` | 单次模型调用的 token 用量 |
| `AgentExtension` | Runtime 外部扩展点 |
| `Skill` | `{ name, description, instructions }` |
| `HttpTransport` | 可替换的 HTTP 请求函数 |
| `ArtifactStore` | artifact 存取接口，默认 `InMemoryArtifactStore` |

完整类型定义见仓库 `dist/**/*.d.ts`。
