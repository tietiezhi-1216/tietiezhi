/**
 * Unit tests for the agent diff algorithm.
 *
 * Run: pnpm test:diff
 *
 * Loaded through Vite rather than compiled, matching the other check-* scripts:
 * the module under test is TypeScript and the renderer has no test runner, so
 * node:assert plus one SSR load is the whole harness.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  logLevel: "silent",
  server: { middlewareMode: true },
});

let failures = 0;
const test = (name, body) => {
  try {
    body();
    console.log(`✔ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`✘ ${name}\n  ${error?.message ?? error}`);
  }
};

/** Flattens sections back to lines so assertions do not care about folding. */
const flatten = (diff) => diff.sections.flatMap((section) => section.lines);
const texts = (diff, change) =>
  flatten(diff)
    .filter((line) => line.change === change)
    .map((line) => line.text);

try {
  const { computeFileDiff, parseFileChange, MAX_DIFF_LINES } = await server.ssrLoadModule(
    "/src/features/agent/diff.ts",
  );

  test("无变化：没有增删，且标记为相同", () => {
    const source = "a\nb\nc\n";
    const diff = computeFileDiff("f.ts", source, source);
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 0);
    assert.equal(diff.identical, true);
    assert.equal(diff.created, false);
    assert.equal(diff.degraded, false);
    assert.deepEqual(
      flatten(diff).map((line) => line.change),
      ["context", "context", "context"],
    );
  });

  test("纯新增：只有 add 行，原有行的行号不变", () => {
    const diff = computeFileDiff("f.ts", "a\nb\n", "a\nx\ny\nb\n");
    assert.equal(diff.removed, 0);
    assert.deepEqual(texts(diff, "add"), ["x", "y"]);
    const kept = flatten(diff).filter((line) => line.change === "context");
    assert.deepEqual(
      kept.map((line) => [line.beforeLine, line.afterLine]),
      [
        [1, 1],
        [2, 4],
      ],
    );
    const added = flatten(diff).filter((line) => line.change === "add");
    assert.deepEqual(
      added.map((line) => [line.beforeLine, line.afterLine]),
      [
        [null, 2],
        [null, 3],
      ],
    );
  });

  test("纯删除：只有 remove 行", () => {
    const diff = computeFileDiff("f.ts", "a\nb\nc\nd\n", "a\nd\n");
    assert.equal(diff.added, 0);
    assert.deepEqual(texts(diff, "remove"), ["b", "c"]);
    assert.deepEqual(
      flatten(diff)
        .filter((line) => line.change === "remove")
        .map((line) => line.beforeLine),
      [2, 3],
    );
  });

  test("中间修改：同一行被替换为一删一增", () => {
    const diff = computeFileDiff("f.ts", "a\nb\nc\n", "a\nB\nc\n");
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    assert.deepEqual(texts(diff, "remove"), ["b"]);
    assert.deepEqual(texts(diff, "add"), ["B"]);
    // Deletion before insertion, so a replacement reads top-to-bottom.
    const changes = flatten(diff).map((line) => line.change);
    assert.deepEqual(changes, ["context", "remove", "add", "context"]);
  });

  test("首尾相同行被剥离：万行文件里改一行不会退化", () => {
    // Without stripping the middle would be 5001x5001 cells, far past the LCS
    // budget, and `degraded` would be true. It staying false *is* the assertion.
    const head = Array.from({ length: 5000 }, (_, index) => `head-${index}`);
    const tail = Array.from({ length: 5000 }, (_, index) => `tail-${index}`);
    const before = [...head, "middle", ...tail].join("\n");
    const after = [...head, "MIDDLE", ...tail].join("\n");

    const started = Date.now();
    const diff = computeFileDiff("big.ts", before, after);
    const elapsed = Date.now() - started;

    assert.equal(diff.degraded, false, "剥离首尾后应该走精确 LCS");
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    assert.deepEqual(texts(diff, "remove"), ["middle"]);
    assert.equal(
      flatten(diff).find((line) => line.change === "remove").beforeLine,
      5001,
      "行号必须是原文件里的绝对行号",
    );
    assert.ok(elapsed < 2000, `剥离后应该很快，实际 ${elapsed}ms`);
    assert.equal(diff.truncated, false, "折叠后可见行很少，不该被行数上限截断");
  });

  test("未改动的大段落被折叠，且折叠块保留原行", () => {
    const before = [...Array.from({ length: 40 }, (_, i) => `l${i}`), "old"].join("\n");
    const after = [...Array.from({ length: 40 }, (_, i) => `l${i}`), "new"].join("\n");
    const diff = computeFileDiff("f.ts", before, after);
    const folds = diff.sections.filter((section) => section.kind === "fold");
    assert.equal(folds.length, 1, "开头 40 行未改动应折叠为一块");
    assert.equal(folds[0].lines.length, 37, "折叠块外应保留 3 行上下文");
    assert.ok(
      folds[0].lines.every((line) => line.change === "context"),
      "折叠块里只能是未改动行",
    );
    // Nothing is lost by folding: flattening restores every line.
    assert.equal(flatten(diff).length, 42);
  });

  test("超大改动降级为逐行粗略对比，而不是卡死", () => {
    const before = Array.from({ length: 3000 }, (_, index) => `before-${index}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, index) => `after-${index}`).join("\n");

    const started = Date.now();
    const diff = computeFileDiff("huge.ts", before, after);
    const elapsed = Date.now() - started;

    assert.equal(diff.degraded, true, "9M 单元格必须降级");
    assert.ok(elapsed < 2000, `降级路径应该很快，实际 ${elapsed}ms`);
    // The cap still applies: 6000 changed lines cannot all be rendered. Stats
    // stay complete so the header does not lie about the size of the change.
    assert.equal(diff.truncated, true);
    assert.equal(flatten(diff).length, MAX_DIFF_LINES);
    assert.equal(diff.added, 3000);
    assert.equal(diff.removed, 3000);
    const first = flatten(diff).slice(0, 2);
    assert.deepEqual(
      first.map((line) => [line.change, line.text]),
      [
        ["remove", "before-0"],
        ["add", "after-0"],
      ],
    );
  });

  test("新建文件：before 为 null 时全部算新增", () => {
    const diff = computeFileDiff("new.ts", null, "a\nb\n");
    assert.equal(diff.created, true);
    assert.equal(diff.removed, 0);
    assert.equal(diff.added, 2);
    assert.deepEqual(texts(diff, "add"), ["a", "b"]);
    assert.equal(diff.identical, false);
  });

  test("空新建文件不报错", () => {
    const diff = computeFileDiff("empty.ts", null, "");
    assert.equal(diff.created, true);
    assert.equal(diff.added, 0);
    assert.deepEqual(flatten(diff), []);
  });

  test("行尾换行差异不产生幽灵空行", () => {
    const diff = computeFileDiff("f.ts", "a\nb", "a\nb\n");
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 0);
    assert.equal(diff.identical, false, "文本不同，但没有整行变化");
  });

  test("parseFileChange 只接受核心真正发出的形状", () => {
    assert.equal(parseFileChange(null), null);
    assert.equal(parseFileChange("nope"), null);
    assert.equal(parseFileChange({ path: "a.ts" }), null, "缺 kind 应拒绝");
    assert.equal(
      parseFileChange({ kind: "file-change", path: "a.ts", before: 1, after: "x" }),
      null,
      "before 类型不对应拒绝",
    );
    assert.deepEqual(
      parseFileChange({ kind: "file-change", path: "a.ts", before: null, after: "x" }),
      { kind: "file-change", path: "a.ts", before: null, after: "x" },
    );
    assert.deepEqual(
      parseFileChange({
        kind: "file-change-skipped",
        path: "big.bin",
        reason: "too-large",
        bytes: 300000,
      }),
      { kind: "file-change-skipped", path: "big.bin", reason: "too-large", bytes: 300000 },
    );
    // The read tool's detail must not be mistaken for a diff.
    assert.equal(parseFileChange({ path: "a.ts", totalLines: 10 }), null);
  });
} finally {
  await server.close();
}

if (failures > 0) {
  console.error(`\n${failures} 个断言失败`);
  process.exit(1);
}
console.log("\ndiff 算法检查通过");
