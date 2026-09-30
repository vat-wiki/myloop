# ModelClient

ModelClient 接收 Agent 的内部消息格式，并返回规范化响应。模型连接、模型名和请求参数由 ModelClient 管理；Runtime 只使用自己的内部消息格式。

## 内置客户端

| Client | 协议 | 说明 |
| --- | --- | --- |
| `Anthropic` | Anthropic Messages | 支持 image/document 映射，默认额外预留 20,000 上下文 tokens |
| `OpenAIChat` | Chat Completions | 映射 `tool_call` 到 `tool_calls` |
| `OpenAIResponses` | Responses API | 映射到 `function_call` / `function_call_output` |

`protocol` 只描述 API 协议；`model` 必须通过配置、CLI 或环境变量提供，SDK 不维护模型列表。

## HTTP Transport、Timeout 和 Retry

所有内置 ModelClient 默认通过同一个 HTTP transport 请求模型 API。默认实现使用原生 `fetch`，默认超时 60 秒，默认最多请求 6 次；未提供 `Retry-After` 时按 5 秒起步、60 秒封顶的指数间隔重试。

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
    initialDelayMs: 5_000,
    maxDelayMs: 60_000,
  },
});
```

也可以替换成 axios、undici 或其他 HTTP 工具：

```ts
import axios from "axios";
import type { HttpTransport } from "myloop";

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

## 自定义 ModelClient

```ts
import type { ModelClient } from "myloop";

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
