import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 记忆库：名词的库，写给继任者——每个会话是一任新班次，船连续、水手轮换。
 * handover 是事件（压缩、会话收尾那一刻的交接动作），产物流进这个库；记法见 index.md 约定。
 * 内容完全由模型用文件工具（fd/rg/heredoc）自主维护，代码只做三件薄事——
 * 脚手架与约定、索引注入、压缩摘要进待办、健康信号给驱力。
 */
export type MemorySenses = {
  now: number;
  /** inbox.md 未消化行数 */
  pendingLines: number;
  /** 指向不存在条目的 [[wikilink]] 数 */
  brokenLinkCount: number;
  /** 最老条目 updated/created 距今天数；null = 空库 */
  stalestDays: number | null;
};

const INDEX_NAME = "index.md";
const STATE_NAME = "state.md";
const PENDING_NAME = "inbox.md";

export const INDEX_TEMPLATE = `## Memory Index

记忆库门户：写给来接手的人（每个会话都是一任新班次），此索引进心理解全库。每行一条：
- [[条目名]] 一句话说明

约定（由你维护，无专门代码）：
- 条目是本目录下 <条目名>.md，frontmatter 含 title/type(reference|decision|lesson)/tags/created/updated/verified
- 正文用 [[条目名]] 关联相关条目；反链用 rg 查
- 新建条目前先 rg 本目录找相似主题——更新已有条目，不要另起新条目
- 以继任者为读者：没见过本仓库历史的人也能读懂；环境事实引用前对照现实验证并更新 verified
- state.md 是交班条（此刻停在哪），会话收尾刷新；inbox.md 是待消化摘要，整理成条目后删除对应行
`;

export const STATE_TEMPLATE = `# State（交班条）

<!-- 写给下一个会话的继任者。每次会话收尾刷新；只反映"现在"，历史沉淀进条目。 -->

## 此刻状态

## 进行中

## 下一步
`;

export type MemoryOptions = {
  cwd?: string;
  home?: string;
  now?: () => number;
};

export class Memory {
  readonly #dir: string;
  readonly #now: () => number;

  constructor({
    cwd = process.cwd(),
    home = process.env.HOME,
    now = Date.now,
  }: MemoryOptions = {}) {
    this.#dir = join(resolveBase(cwd, home), "memory");
    this.#now = now;
  }

  get dir(): string {
    return this.#dir;
  }

  /** 首次使用时落脚手架；已存在则不动模型维护的内容 */
  ensureScaffold(): void {
    mkdirSync(this.#dir, { recursive: true });
    if (!existsSync(join(this.#dir, INDEX_NAME))) {
      writeFileSync(join(this.#dir, INDEX_NAME), INDEX_TEMPLATE, "utf8");
    }
    if (!existsSync(join(this.#dir, STATE_NAME))) {
      writeFileSync(join(this.#dir, STATE_NAME), STATE_TEMPLATE, "utf8");
    }
    if (!existsSync(join(this.#dir, PENDING_NAME))) {
      writeFileSync(join(this.#dir, PENDING_NAME), "", "utf8");
    }
  }

  readIndex(): string {
    return this.#read(INDEX_NAME);
  }

  /** 压缩摘要收进待办，一行一条；由记忆整理驱力消化 */
  appendPending(text: string): void {
    const line = text.trim().replace(/\s*\n+\s*/g, " ");
    if (!line) return;
    mkdirSync(this.#dir, { recursive: true });
    appendFileSync(join(this.#dir, PENDING_NAME), `- ${line}\n`, "utf8");
  }

  /** 驱力感官：纯读，不动文件 */
  senses(): MemorySenses {
    const nowMs = this.#now();
    if (!existsSync(this.#dir)) {
      return { now: nowMs, pendingLines: 0, brokenLinkCount: 0, stalestDays: null };
    }
    const files = readdirSync(this.#dir).filter((f) => f.endsWith(".md"));
    const slugs = new Set(files.map((f) => f.replace(/\.md$/, "")));
    let broken = 0;
    let oldestMs: number | undefined;
    for (const file of files) {
      const raw = this.#read(file);
      for (const match of raw.matchAll(/\[\[([a-z0-9-]+)\]\]/g)) {
        if (!slugs.has(match[1] ?? "")) broken += 1;
      }
      const stamp = /^updated:\s*(.+)$/m.exec(raw) ?? /^created:\s*(.+)$/m.exec(raw);
      const ms = stamp ? Date.parse(stamp[1]?.trim() ?? "") : NaN;
      if (Number.isFinite(ms)) oldestMs = oldestMs === undefined ? ms : Math.min(oldestMs, ms);
    }
    const pendingLines = this.#read(PENDING_NAME).split("\n").filter((l) => l.trim()).length;
    return {
      now: nowMs,
      pendingLines,
      brokenLinkCount: broken,
      stalestDays: oldestMs === undefined ? null : Math.floor((nowMs - oldestMs) / 86_400_000),
    };
  }

  #read(name: string): string {
    try {
      return readFileSync(join(this.#dir, name), "utf8");
    } catch {
      return "";
    }
  }
}

/** system prompt 注入段：位置 + 门户索引；wiki 约定在 index.md 内，模型整理时自会读到 */
export function renderMemorySection({ dir, index }: { dir: string; index: string }): string {
  return [
    "",
    "# 长期记忆",
    "",
    `记忆库目录：${dir}（写给继任者：每个会话是一任新班次。index.md 是门户索引，条目是同目录 md 文件，用文件工具自主维护）`,
    "",
    index.trim(),
    "",
  ].join("\n");
}

/** 项目内向上找 .agents/myloop，找不到回落全局 ~/.agents/myloop（与 skills 查找同规则） */
function resolveBase(cwd: string, home?: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".agents", "myloop"))) return join(dir, ".agents", "myloop");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (home) return join(resolve(home), ".agents", "myloop");
  return join(resolve(cwd), ".agents", "myloop");
}
