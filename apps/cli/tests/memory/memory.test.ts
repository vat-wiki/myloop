import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Memory, renderMemorySection } from "../../src/memory/memory.js";

const dirs: Array<string> = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Memory", () => {
  it("creates scaffold once and does not clobber model-maintained index", () => {
    const root = tempRoot();
    const memory = new Memory({ cwd: root, home: tempRoot() });
    memory.ensureScaffold();
    expect(memory.readIndex()).toContain("# Memory Index");
    expect(readFileSync(join(memory.dir, "state.md"), "utf8")).toContain("# State（交班条）");

    writeFileSync(join(memory.dir, "index.md"), "- [[cli-bot]] 驱力仲裁者");
    memory.ensureScaffold();
    expect(memory.readIndex()).toBe("- [[cli-bot]] 驱力仲裁者");
  });

  it("appends compaction summaries to inbox as single lines", () => {
    const memory = new Memory({ cwd: tempRoot(), home: tempRoot() });
    memory.appendPending("决定用 wikilink\n连接条目");
    memory.appendPending("  ");
    memory.appendPending("第二条");
    const pending = readFileSync(join(memory.dir, "inbox.md"), "utf8");
    expect(pending).toBe("- 决定用 wikilink 连接条目\n- 第二条\n");
  });

  it("senses report pending backlog, broken links and stalest entry", () => {
    const memory = new Memory({ cwd: tempRoot(), home: tempRoot() });
    memory.ensureScaffold();
    expect(memory.senses()).toMatchObject({ pendingLines: 0, brokenLinkCount: 0, stalestDays: null });

    mkdirSync(memory.dir, { recursive: true });
    writeFileSync(join(memory.dir, "inbox.md"), "- a\n- b\n- c\n");
    writeFileSync(join(memory.dir, "old-note.md"), [
      "---",
      "title: 旧闻",
      "type: decision",
      "created: 2026-09-01T00:00:00.000Z",
      "updated: 2026-09-01T00:00:00.000Z",
      "---",
      "关联 [[missing-entry]]",
    ].join("\n"));
    const senses = memory.senses();
    expect(senses.pendingLines).toBe(3);
    expect(senses.brokenLinkCount).toBe(1);
    expect(senses.stalestDays).toBeGreaterThanOrEqual(30);
  });

  it("resolves project .agents/myloop upward, falls back to home", () => {
    const root = tempRoot();
    mkdirSync(join(root, "deep", "nested"), { recursive: true });
    mkdirSync(join(root, ".agents", "myloop"), { recursive: true });
    const inProject = new Memory({ cwd: join(root, "deep", "nested"), home: tempRoot() });
    expect(inProject.dir).toBe(join(root, ".agents", "myloop", "memory"));

    const noProject = new Memory({ cwd: tempRoot(), home: root });
    expect(noProject.dir).toBe(join(root, ".agents", "myloop", "memory"));
  });

  it("renders prompt section with dir and index", () => {
    const memory = new Memory({ cwd: tempRoot(), home: tempRoot() });
    memory.ensureScaffold();
    const section = renderMemorySection({ dir: memory.dir, index: memory.readIndex() });
    expect(section).toContain("## 长期记忆");
    expect(section).toContain(memory.dir);
    expect(section).toContain("[[条目名]]");
  });
});
