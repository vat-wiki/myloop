# myloop CLI

一个零 UI 依赖的极简终端 Agent。非交互模式把最终结果写入 `stdout`，运行状态写入 `stderr`；交互模式使用 Node 内置 `readline`。

```sh
npm run build --workspace apps/cli

# 一次执行（会自动构建 CLI）
npm run cli -- --model gpt-test "fix the tests"

# 交互模式
npm run cli -- --model gpt-test
```

`--bot` 开启 bot 模式：复用运行时心跳（默认 60s 一次，`config.heartbeat.intervalMs` 可调），agent 空闲时每个 tick 自动以心跳提示词触发一轮任务，让 CLI 持续自主运行直到 Ctrl+C。`config.botPrompt` 可自定义心跳提示词。

`--log=off|events|errors` 控制模型和工具审计日志，默认 `events`；`--log` 等价于 `--log=events`。事件文件在 `.agents/myloop/logs/`，运行时异常写入同目录的 `diagnostics-*.jsonl`。会话文件保存在 `.agents/myloop/sessions/`。

CLI 默认在启动或一次性任务前打印最终系统提示词和工具声明，`--no-print-prompts` 可关闭。这些内容写入 `stderr`，不会影响最终结果输出。

终端执行顺序是 Unix `bash > sh`，Windows `pwsh > powershell > ComSpec`；这样优先保证命令兼容性。需要强制指定时设置 `MYLOOP_SHELL=/path/to/shell`。

`-l, --list-sessions` 按创建时间倒序列出会话；`-c, --continue` 继续最近创建的会话。
恢复会话时先回显用户、助手、命令和工具结果。

状态和流式内容写入 `stderr`，TTY 下用颜色区分：思考为品红，正文为蓝色，工具为青色，成功为绿色，失败为红色；分割线独占一行，每一轮用 `*` 分割。设置 `NO_COLOR` 或输出不是 TTY 时自动禁用颜色。

CLI 复用 TUI 配置文件。它会读取 `~/.agents/myloop.json`，再从当前目录向上查找 `.agents/myloop.json`；项目配置覆盖全局配置，命令行参数覆盖配置文件。

系统提示词按显式路径、从当前目录向上查找的 `.agents/myloop/system.md`、全局 `~/.agents/myloop/system.md`、内置提示词的顺序加载。
