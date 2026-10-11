# myloop CLI

一个零 UI 依赖的极简终端 Agent。非交互模式把最终结果写入 `stdout`，运行状态写入 `stderr`；交互模式使用 Node 内置 `readline`。

```sh
npm run build --workspace apps/cli

# 一次执行（会自动构建 CLI）
npm run cli -- --model gpt-test "fix the tests"

# 交互模式
npm run cli -- --model gpt-test
```

`--bot` 开启 bot 模式：复用运行时心跳（默认 60s 一次，`config.heartbeat.intervalMs` 可调），每个 tick 由驱力系统（respond-unread / self-check / self-maintenance / memory-grooming）评估是否行动，没驱力过阈就静默跳过（0 模型调用）；agent 忙时用户输入会记为未读，由驱力稍后处理。设计细节见 `src/bot/DESIGN.md`。

bot 模式带记忆库：`.agents/myloop/memory/`（项目内找不到则回落 `~/.agents/myloop/memory/`）。`index.md` 是唯一常驻注入 system prompt 的门户索引，`state.md` 是交班条（此刻停在哪，handover 事件的落地），条目由模型用文件工具自主维护（`[[wikilink]]` 关联、pending.md 待消化摘要），代码只负责脚手架、压缩摘要进 pending 和健康信号（积压/断链/陈旧）——记忆库本身没有硬编码结构，由 memory-grooming 驱力整理。详见 `src/memory/memory.ts`。

`--log=off|events|errors` 控制模型和工具审计日志，默认 `events`；`--log` 等价于 `--log=events`。事件文件在 `.agents/myloop/logs/`，运行时异常写入同目录的 `diagnostics-*.jsonl`。会话文件保存在 `.agents/myloop/sessions/`。

CLI 默认在启动或一次性任务前打印最终系统提示词和工具声明，`--no-print-prompts` 可关闭。这些内容写入 `stderr`，不会影响最终结果输出。

终端执行顺序是 Unix `bash > sh`，Windows `pwsh > powershell > ComSpec`；这样优先保证命令兼容性。需要强制指定时设置 `MYLOOP_SHELL=/path/to/shell`。

`-l, --list-sessions` 按创建时间倒序列出会话；`-c, --continue` 继续最近创建的会话。
恢复会话时先回显用户、助手、命令和工具结果。

状态和流式内容写入 `stderr`，TTY 下用颜色区分：思考为品红，正文为蓝色，工具为青色，成功为绿色，失败为红色；分割线独占一行，每一轮用 `*` 分割。设置 `NO_COLOR` 或输出不是 TTY 时自动禁用颜色。

CLI 复用 TUI 配置文件。它会读取 `~/.agents/myloop.json`，再从当前目录向上查找 `.agents/myloop.json`；项目配置覆盖全局配置，命令行参数覆盖配置文件。

系统提示词按显式路径、从当前目录向上查找的 `.agents/myloop/system.md`、全局 `~/.agents/myloop/system.md`、内置提示词的顺序加载。
 
## 设计要点

1. **驱动力系统**：不用一个宏大目标，而用几个"驱力"（drives）：
   - 好奇心：主动探索信息差（哪个领域我还不懂）
   - 维护欲：让"领地"保持健康（监控、修复、整理）
   - 创造欲：周期性产出（写、建、教）
   - 服务欲：响应他人请求
   这类似动物的本能，比单一宏大目标更能产生持续行为。

2. **目标层级**：
   - 宪法层（不变）：价值观、边界、身份
   - 常驻目标（长期）：如"维护一个知识库并让它每天更有用"
   - 生成目标（自产）：由驱力 + 反思自动产生任务
   - 执行任务（短期）：具体行动

3. **生命循环（perception → think → act → reflect）**：
   - 事件唤醒（有人说话/系统事件/定时心跳）
   - 心跳调度器：每隔 N 分钟触发一次"自省"：我现在该做什么？产出下一批任务
   - 记忆：短期上下文 + 长期记忆库（向量/文件）
   - 反思：每天总结，更新目标和记忆

4. 宏大目标候选（如果真要一个）：
   - "让 X 变得更好"——开放永不完成：维护一个服务/社区/知识库
   - "理解世界并留下记录"——持续学习+输出
   - "陪伴用户成长"——长期陪伴型
   关键特征：开放性（永远做不完）、可分解（每天都有具体事）、外部性（有真实世界的反
  回路）
---

## 已实现：驱力循环（`src/`）

```
heartbeat tick → DriveArbiter.tick(tick, deps)
  → deps.evaluate(tick)         // 宿主把真实状态翻译成 DriveState
  → 每个 drive.evaluate(state)  // 压力评估器，返回 0~1
  → 过滤: pressure >= threshold 且不在 cooldown
  → 取最高压力（tick 抖动破同分）
  → deps.act(selection)         // 宿主拿 outcome.prompt 去 runtime.run()
```

- `src/bot/drives.ts` — `Drive` 接口 + 三个内置驱力：`respondUnreadDrive`（未读积压）、`selfCheckDrive`（健康检查）、`selfMaintenanceDrive`（空闲无聊）。
- `src/bot/arbiter.ts` — `DriveArbiter`：busy/min-interval/threshold/cooldown 门控，选最疼的驱力。

宿主（如 CLI 的 `createBotHost`，见 `src/bot/host.ts`）负责把 `outcome.prompt` 交给 agent 执行；arbiter 纯逻辑不依赖 myloop，可单测。

```bash
npm test --workspace @myloop/cli
```
