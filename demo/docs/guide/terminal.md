# Terminal 工具

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

## 安全提示

::: warning
这个工具允许模型在宿主机 shell 中执行任意命令。生产环境或不可信任务里，必须用容器、VM、sandbox、用户白名单或人工审批来控制风险。SDK 目前没有内置轮数限制；是否继续多轮由模型和 ModelClient 协议决定。
:::
