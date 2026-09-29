# myanne CLI

一个零 UI 依赖的极简终端 Agent。非交互模式把最终结果写入 `stdout`，运行状态写入 `stderr`；交互模式使用 Node 内置 `readline`。

```sh
npm run build --workspace apps/cli

# 一次执行（会自动构建 CLI）
npm run cli -- --model gpt-test "fix the tests"

# 交互模式
npm run cli -- --model gpt-test
```

`--log` 会把模型和工具调用写入 `.agents/myanne/logs/`；默认不写日志。会话文件保存在 `.agents/myanne/sessions/`。

终端执行顺序是 Unix `bash > sh`，Windows `pwsh > powershell > ComSpec`；这样优先保证命令兼容性。需要强制指定时设置 `MYANNE_SHELL=/path/to/shell`。

状态和流式内容写入 `stderr`，TTY 下用颜色区分：思考为品红，正文为蓝色，工具为青色，成功为绿色，失败为红色；分割线独占一行，每一轮用 `*` 分割。设置 `NO_COLOR` 或输出不是 TTY 时自动禁用颜色。

CLI 复用 TUI 配置文件。它会读取 `~/.agents/myanne.json`，再从当前目录向上查找 `.agents/myanne.json`；项目配置覆盖全局配置，命令行参数覆盖配置文件。
