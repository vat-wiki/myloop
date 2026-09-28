# Context Compaction

Runtime 拥有 `messages`，并在每轮 ModelClient 调用前检查上下文压力。物理限制由 ModelClient 暴露；Runtime 不做模型驱动的智能摘要，只在接近物理上限时执行确定性 fallback。

## Fallback 策略

fallback 行为很朴素：

1. 先截断过大的 `tool_result`。
2. 如果仍放不下，从安全边界开始丢弃较早消息。
3. 在被丢弃处插入一条上下文边界说明。
4. 始终保持 `tool_call` / `tool_result` 成对。
5. 如果仍放不下，抛出明确的 context exhausted 错误。

## 手动压缩

```ts
await agent.compact();
```

Runtime 会在每次 ModelClient 调用前触发 `context_pressure`；发生压缩后触发 `context_compacted`。

## 触发时机

压缩触发点不是 context window 的最后一条边界。ModelClient 会提供 `reservedOutputTokens` 和 `safetyTokens`；Agent 用两者预留输出空间和估算误差余量。Anthropic 默认额外预留 20,000 tokens，因此会更早进入确定性 fallback，而不是撞到物理极限才失败。
