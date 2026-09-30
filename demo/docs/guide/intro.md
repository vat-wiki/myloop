# 设计模型

`myloop` 是一个 TypeScript SDK，不是一个命令行工具。它负责维护 Agent 会话、调用 ModelClient、执行工具循环，并把运行过程以事件形式暴露给调用方。

当前内置了一个 `bash` terminal 工具和 `Anthropic`、`OpenAIChat`、`OpenAIResponses` 三个 ModelClient。模型连接、模型名和请求参数由 ModelClient 管理；Runtime 只使用自己的内部消息格式。

## 分层架构

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

- `Agent` 是可独立执行的个体。`SingleAgent` 是单上下文个体，`CompositeAgent` 是由多个 Agent 组成的个体。
- 底层执行系统是 `AgentRuntime`：它维护消息、调用 ModelClient、执行工具循环、处理事件和上下文压缩。
- `UserInput` 是统一的用户输入协议。Runtime 拥有 `user-input` 边界适配器，负责把文本、图片、文档、本地文件和远程 URL 归一化为内部消息块。
- `bash` 是 Runtime 的原生能力，而不是可插拔工具。SDK 当前不提供通用工具注入点。
- Skill 是上层的领域说明和操作手册。它不新增执行通道，也不改变 Agent 内核；宿主应用负责选择 Skill，并把它们组合成最终的 system prompt。
- Agent 层依赖 Runtime；Runtime 不依赖 Skill 层。Skill 层不新增工具或执行通道。

## 安装和构建

```bash
npm install
npm run build
npm test
```

`npm test` 运行 Vitest 测试套件（含 TUI workspace）。`npm run typecheck` 执行严格 TypeScript 类型检查。`npm run build` 把 `src/` 和 TUI 编译到 `dist/`。

## 项目结构

```text
src/
├── index.ts              # 公共导出入口
├── agent/
│   ├── types.ts          # Agent 抽象和统一结果
│   ├── single.ts         # SingleAgent
│   ├── composite.ts      # CompositeAgent
│   ├── session.ts        # AgentSession 多轮会话封装
│   └── index.ts
├── runtime/
│   ├── agent.ts          # AgentRuntime 编排和工具循环
│   ├── context.ts        # 确定性上下文 fallback 和压力估算
│   ├── events.ts         # 事件系统
│   ├── extension.ts      # Runtime 外部扩展点
│   ├── messages.ts       # 内部消息/block 格式
│   ├── artifacts.ts      # artifact 存储（InMemoryArtifactStore）
│   ├── user-input.ts     # UserInput 边界适配器
│   ├── model-client.ts   # 通用 ModelClient 接口
│   ├── terminal.ts       # bash terminal 工具
│   └── index.ts
├── clients/
│   ├── anthropic.ts      # Anthropic 协议转换层
│   ├── openai-chat.ts    # OpenAI Chat Completions 协议客户端
│   ├── openai-responses.ts # OpenAI Responses 协议客户端
│   ├── openai-common.ts  # OpenAI 共享 HTTP 和参数工具
│   ├── http.ts           # 共享 HTTP transport、timeout 和 retry
│   └── index.ts
├── skills/
│   ├── compose.ts        # Skill 到 system prompt 的组合层
│   ├── parse.ts          # SKILL.md 解析
│   └── index.ts
```
