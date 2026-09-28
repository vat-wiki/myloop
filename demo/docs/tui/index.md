# mycoder TUI

一个极简终端 Agent 界面。只展示进度和结果，不渲染过程。

## 设计理念

大多数 Agent TUI 把所有中间过程——流式 token、工具调用的完整 JSON、模型用量——全部塞进一个滚动列表。这继承了聊天应用的展示习惯，但在终端里代价高、收益低：终端渲染成本高、信息噪音大，而用户绝大多数时间在等结果，不在读过程。

我们选择反着做。

### 只关心结果

用户发一个任务，想知道的是两件事：**还在跑吗**，以及**结果是什么**。过程本身不重要——看十次工具调用的 JSON 不会让你更信任 Agent，十次正确交付才会。

信任来自结果质量的历史记录，不来自过程透明。

### 沉默地干活，出声时一定有值得说的

这和 `make` 的哲学一致：默认只告诉你进度和结果，出错才展开。Agent 应该一样。

### 终端的优势是信息密度可控

不是渲染丰富。一个滚动列表里塞满 Markdown、JSON 和 ANSI 转义序列，不如一行清晰的状态描述有价值。

## 界面

运行中只显示一行状态：

```
❯ 帮我重构 auth 模块

  ● step 3 · ls src/auth/        12s
```

完成后展示结果：

```
❯ 帮我重构 auth 模块

  ✓ 2m 14s
  重构完成。修改了 3 个文件，所有测试通过。
```

出错时：

```
❯ do something

  ✕ 3s
  Error: connection refused
```

没有滚动的过程日志。没有流式 token 重绘。没有工具 JSON dump。

最终结果支持 Markdown 渲染：标题、粗体、斜体、行内代码、代码块、列表、链接、表格。语法标记（如 `**`）自动隐藏。

## 命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示命令列表 |
| `/usage` | 显示最近一次模型调用用量 |
| `/reset` | 重置会话和用量 |
| `/exit` | 退出 |

- `Esc` 随时打断当前任务，与看不看过程无关。
- `Ctrl+C` 退出，`/exit` 也可以。
- 出错要追溯时，完整日志写入 `.agents/mycoder/logs/*.jsonl`；不要把 `.agents` 提交到公共仓库。

## 配置文件

TUI 使用 OpenTUI 和 Solid 构建。运行入口要求 Node.js 26.4.0 或更新版本，并启用 Node FFI。

`mycoder-tui` 会自动读取 JSON 配置文件。全局配置是 `~/.agents/mycoder.json`；同时从当前目录向上查找项目配置 `.agents/mycoder.json`。配置合并很简单：project 字段直接覆盖全局同名字段。最终优先级是：CLI 参数 > project 配置 > 全局配置 > 环境变量和内置默认值。

```json
{
  "protocol": "anthropic",
  "model": "claude-sonnet-4-5",
  "baseURL": "https://api.anthropic.com/v1",
  "apiKey": "local-development-key-only",
  "allowLocalFiles": true,
  "contextWindowTokens": 131072
}
```

`apiKey` 可以直接写入本地开发配置，但不要提交包含真实 key 的配置文件；不配置时默认读取 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`。

`contextWindowTokens` 用于覆盖协议默认上下文窗口：`openai-chat` 和 `openai-responses` 默认 `128000`，`anthropic` 默认 `200000`。CLI 也可用 `--context-window-tokens` 覆盖。
