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

### 出错要追溯怎么办

完整日志写入 `.agents/mycoder/logs/*.jsonl`。日志包含任务文本、命令和输出；不要把 `.agents` 提交到公共仓库。

### 想继续上次的会话怎么办

TUI 默认每次启动都开启新会话，并在第一轮对话后写入 `.agents/mycoder/sessions/`。只有通过 `--session-id work-1` 或配置里的 `sessionId` 指定时，启动才会恢复该会话。运行中输入 `/sessions` 可以列出并切换已有会话。`/reset` 会清空当前会话文件。

会话文件包含任务和回复；不要把 `.agents` 提交到公共仓库。

### 想中途打断怎么办

`Esc` 随时打断，与看不看过程无关。

### 怎么退出

`Ctrl+C` 退出，`/exit` 也可以。

## 命令

TUI 启动时会读取从文件系统根到当前目录的 `AGENTS.md`，并注入系统提示。深层文件的约定覆盖浅层文件的冲突约定。

### 系统提示词

内置提示词是默认 Profile，不是固定约定。TUI 按下面的优先级加载可替换提示词：

1. `--system-prompt <file>`
2. 当前目录及祖先目录的 `.agents/mycoder/system.md`
3. `~/.agents/mycoder/system.md`
4. 内置 `system.md`

配置文件里的 `"systemPrompt": "./team.md"` 等价于指定自定义文件；`"systemPrompt": false` 关闭可替换提示词。`--no-system-prompt` 优先于文件和配置。`AGENTS.md` 与 Skills 的加载方式不受该开关影响。

| 命令 | 说明 |
|------|------|
| `/sessions` | 列出并切换会话 |
| `/help` | 显示命令列表 |
| `/usage` | 显示最近一次模型调用用量 |
| `/reset` | 重置会话和用量 |
| `/exit` | 退出 |

输入 `/` 时显示命令候选。`↑/↓` 或 `Shift+Tab` 选择，`Enter` 执行选中命令，`Tab` 只补全。

`Ctrl+V` 读取系统剪贴板并插入输入框；粘贴内容不会因为换行而发送。

## 架构

TUI 基于 [@opentui/solid](https://github.com/opentui/opentui) 构建，事件驱动、声明式渲染。UI 层不维护消息模型，只消费 `SingleAgent` 暴露的事件流：

- `tool_start` → 更新步骤计数和描述
- `assistant_message` → 缓存最终结果文本
- `model_response` → 更新 header 中最近一次调用的用量计数
- `text_delta` → **有意忽略**（不渲染流式文本）
- `tool_end` → **有意忽略**（不渲染工具输出）

状态由 `ui.tsx` 内的 Solid signals 管理，`state.ts` 提供纯函数工具（光标编辑、文本清理、格式化）。

## 运行

```sh
cd apps/tui
npm install
npm run build
npm start -- --protocol anthropic --model claude-sonnet-4-20250514
```

需要设置 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY` 环境变量。
