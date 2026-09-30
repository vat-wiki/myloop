# Skills

Skill 是上层的领域说明和操作手册。它不新增执行通道，也不改变 Agent 内核；宿主应用负责选择 Skill，并把它们组合成最终的 system prompt。

依赖方向是 `skills -> agent/runtime`，而不是 `agent/runtime -> skills`。

## 定义与组合 Skill

```ts
import { composeSystem, type Skill } from "myloop/skills";

const repoSkill: Skill = {
  name: "repo",
  description: "分析当前仓库",
  instructions: `
仓库根目录是 ${process.cwd()}。
优先读取 README.md、package.json 和 src。
不要进入 node_modules。
修改代码前先理解现有结构。
使用 npm test 或 npm run build 验证。
`,
};

const agent = new SingleAgent({
  name: "coder",
  modelClient,
  system: composeSystem({
    base: "你是终端Agent，通过bash工具完成用户任务。",
    skills: [repoSkill],
  }),
});
```

## 解析 SKILL.md

`SKILL.md` 也可以直接解析为 `Skill`。`parseSkill` 接受文件路径或 Markdown 内容；以 `---` 开头的输入会按内容解析，否则按路径读取。

```ts
import { parseSkill } from "myloop/skills";

const skill = await parseSkill(".agents/skills/repo/SKILL.md");

const inlineSkill = await parseSkill([
  "---",
  "name: repo",
  "description: 分析当前仓库",
  "---",
  "",
  "优先读取 README.md、package.json 和 src。",
].join("\n"));
```

frontmatter 必须位于文件开头，支持基本的 `key: value` 和引号值。按文件路径解析时，`name` 可以省略并回退为 skill 目录名；按内容解析时需要显式提供 `name`。
