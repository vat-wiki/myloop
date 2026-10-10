# 事件

所有事件都是可选的。

| 事件 | 触发时机 |
| --- | --- |
| `message` | 每条内部格式消息被加入会话时 |
| `user_message` | 用户消息加入会话时 |
| `assistant_message` | 模型消息加入会话时 |
| `tool_message` | 工具结果消息加入会话时 |
| `model_response` | 收到 ModelClient 规范化响应及其 usage 时 |
| `text` | 最终响应中的文本合并后触发 |
| `text_delta` | 内置协议 client 解析到流式文本增量时触发 |
| `tool_start` | terminal 工具开始执行前 |
| `tool_end` | terminal 工具执行完成后 |
| `context_pressure` | 每次 ModelClient 调用前上下文压力检查后 |
| `context_compaction_start` | 开始生成上下文摘要时，包含原因、压力和消息数 |
| `context_compaction_summary_delta` | 压缩摘要流式增量 |
| `context_compaction_thinking_delta` | 压缩推理流式增量 |
| `context_compacted` | fallback 压缩改变了消息历史 |
| `end` | 本次 `run()` 正常完成 |
| `error` | 本次 `run()` 抛错 |

## 订阅与取消

```ts
const dispose = agent.on("tool_end", (event) => {
  console.log(event);
});

dispose(); // 取消订阅
```

也可以使用 `agent.once()` 和 `agent.off()`。

## 流式输出

Runtime 会把 `onTextDelta` 回调放进 `ModelRequest`。内置的 Anthropic、OpenAIChat 和 OpenAIResponses client 会请求 SSE 流，并把模型文本增量解析成 Runtime 的 `text_delta` 事件：

```ts
agent.on("text_delta", ({ delta }) => {
  process.stdout.write(delta);
});
```

完整回复仍会在一次模型调用结束后通过 `text` 和 `assistant_message` 事件发出，因此不会重复消费最终结果。工具调用参数必须等到流式 JSON 组装完成后再执行。自定义 `transport` 当前走非流式 fallback；自定义 ModelClient 可以在自己的 `complete()` 中调用 `request.onTextDelta` 来接入同一事件流。

## Token 用量

每个内置 ModelClient 都会把协议返回的 usage 归一化到 `ModelUsage`：

- `Anthropic`：读取 `input_tokens`、`output_tokens`、cache read/create tokens，并计算 `totalTokens`。
- `OpenAIChat`：读取 `prompt_tokens`、`completion_tokens`、`total_tokens`、cached prompt tokens 和 reasoning tokens。
- `OpenAIResponses`：读取 `input_tokens`、`output_tokens`、`total_tokens`、cached input tokens 和 reasoning tokens。

Runtime 不累计 usage，只在每次响应后广播本次调用：

```ts
agent.on("model_response", ({ response }) => {
  console.log(response.usage);
});
```
