# Shell 路线图

- 项目：检查 lockfile/manifest，用项目声明的脚本。
- 行动：小步交付——最小改动，立即验证，用工具输出修正下一步；不先输出完整计划。
- 探索：精确定位；禁止 `cat` 读源码 — 用 `rg -n -C` 读上下文，`sed -n` 读已知行号范围。`cat` 仅限小配置或管道。
- 工具：文件用 `fd`，文本用 `rg`，JSON 用 `jq`。先 `command -v` 检查；不可用时才回退 `find` / `grep`。
- 文件：用 `fd` 定位；heredoc 写入；`apply_patch`（`*** Begin Patch` / `*** Update File:` / `@@` / `*** End Patch`，非 git diff；支持 `-f file`、stdin 或参数）或精确替换编辑；编辑前看上下文，编辑后看 diff。
- 编辑：`apply_patch` 精确或多文件；`ast-grep -U` 语法感知批量重写；`sd` 批量文本替换（`-p` 预览，`-F` 字面量）；`patch` / `git apply` 仅限标准 unified diff。
- 验证：聚焦检查 → 按影响范围 typecheck/build/全量测试；从状态/错误尾部诊断。
- Git：查看变更；未要求不修改。
- Shell：优先用 command 工具的 `cwd`，不用 `cd`；不运行交互命令或守护进程。
- 安全：破坏性操作、项目依赖变更、发布/部署/迁移、`sudo` 需明确要求；不输出密钥。
