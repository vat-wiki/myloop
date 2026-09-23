# mycoder 软件架构

```mermaid
flowchart TB
    user["用户任务<br/>文本 / 图片 / 文档 / URL"]
    host["宿主应用 / App"]
    user --> host

    subgraph composition["任务配置层"]
        skills["Skills<br/>composeSystem()"]
        modelConfig["ModelClient 配置<br/>API Key / model / maxTokens"]
        extensionsConfig["AgentExtension 配置<br/>审计 / 脱敏 / 统计 / bash 包装"]
        workersConfig["Worker 配置<br/>多个独立 Agent"]
    end

    host -->|"选择 Skill、ModelClient、Extension 或 Worker"| composition
    skills -->|"组装 system prompt"| singleAgent

    subgraph agentLayer["Agent 层"]
        singleAgent["SingleAgent<br/>单上下文可执行个体"]
        userInputAdapter["UserInputAdapter<br/>本地文件 / URL / base64 / Artifact<br/>大小与安全策略"]
        compositeAgent["CompositeAgent<br/>coordinator + workers"]
        coordinator["Coordinator Agent"]
        workerAgents["Worker Agents"]
    end

    host --> singleAgent
    host --> compositeAgent
    compositeAgent -->|"生成 JSON 委派指令"| coordinator
    compositeAgent -->|"并行运行互不相同的 worker"| workerAgents
    coordinator -.->|"Agent 接口"| singleAgent
    workerAgents -.->|"Agent 接口"| singleAgent
    singleAgent --> userInputAdapter

    subgraph runtimeLayer["AgentRuntime 执行层"]
        runtime["AgentRuntime<br/>run / compact / abort / reset"]
        messages["Messages<br/>user / assistant / tool"]
        context["Context Compaction<br/>压力检测 + 确定性 fallback"]
        extensionChain["Extension Chain<br/>beforeModelCall / afterModelResponse<br/>wrapToolCall(AgentTool)"]
        toolLoop["Tool Loop<br/>stopReason 判断 + tool_call 解析"]
        eventBus["EventBus<br/>message / text / tool / context / end / error"]
        terminal["bash Tool<br/>内置 terminal 能力"]
        pty["Node PTY<br/>bash / cmd.exe"]
    end

    userInputAdapter -->|"RunInput"| runtime
    runtime --> messages
    messages -->|"估算 tokens 与上下文压力"| context
    context -->|"截断输出 / 安全丢弃早期消息"| messages
    messages -->|"ModelRequest"| extensionChain
    extensionsConfig -->|"注册中间件"| extensionChain
    extensionChain -->|"ModelRequest"| modelClient
    modelClient -->|"ModelResponse"| extensionChain
    extensionChain -->|"response"| toolLoop

    subgraph modelLayer["ModelClient 适配层"]
        modelClient["ModelClient 接口<br/>complete(request) / context"]
        anthropic["Anthropic Client"]
        openaiChat["OpenAI Chat Client"]
        openaiResponses["OpenAI Responses Client"]
        openaiCommon["OpenAI 公共层<br/>HTTP / 媒体 / tool arguments"]
    end

    modelConfig --> modelClient
    modelClient --> anthropic
    modelClient --> openaiChat
    modelClient --> openaiResponses
    openaiChat --> openaiCommon
    openaiResponses --> openaiCommon

    subgraph providers["外部模型服务"]
        anthropicAPI["Anthropic API"]
        openaiAPI["OpenAI / OpenAI-compatible API"]
    end

    anthropic -->|"HTTP / JSON"| anthropicAPI
    openaiChat -->|"HTTP / JSON"| openaiAPI
    openaiResponses -->|"HTTP / JSON"| openaiAPI

    toolLoop -->|"tool_call"| terminal
    extensionChain -->|"包装 AgentTool"| toolLoop
    terminal -->|"command / cwd / timeout"| pty
    pty -->|"exit code + stdout/stderr"| toolLoop
    toolLoop -->|"tool_result"| messages
    runtime --> eventBus
    eventBus -->|"订阅运行过程"| host

    subgraph external["外部运行环境"]
        hostFS["工作区文件系统"]
        artifactStore["ArtifactStore<br/>InMemory 或宿主自定义"]
    end

    pty --> hostFS
    userInputAdapter --> hostFS
    userInputAdapter --> artifactStore
    openaiCommon --> artifactStore

    toolLoop -->|"stopReason=end"| runtime
    runtime -->|"ModelResponse"| singleAgent
    singleAgent -->|"AgentResult"| host
```

## 关键依赖方向

- `Skills -> Agent/Runtime`：Skill 只生成声明式 system prompt，不新增执行通道。
- `Agent -> Runtime`：Agent 是对外抽象；Runtime 负责消息、模型调用、扩展和工具循环。
- `Runtime -> ModelClient`：Runtime 使用统一请求/响应格式；适配器负责模型协议转换。
- `Extension -> Runtime 请求/响应/工具链`：扩展按中间件顺序工作，但不能新增工具。
- `CompositeAgent -> Coordinator/Workers`：委派与结果都由 CompositeAgent 汇聚，worker 之间互不通信。
- `UserInputAdapter -> ArtifactStore`：本地输入默认进入受大小限制约束的 Artifact 引用，模型适配器再按协议转换。
