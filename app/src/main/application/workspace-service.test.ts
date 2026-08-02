import assert from "node:assert/strict";
import test from "node:test";

import { parseGitDiff, parseGitNumstat } from "./workspace-git.js";

test("解析 Git numstat 与二进制统计", () => {
  const result = parseGitNumstat("12\t3\tsrc/a.ts\0-\t-\timage.png\0");
  assert.deepEqual(result.get("src/a.ts"), { additions: 12, deletions: 3 });
  assert.deepEqual(result.get("image.png"), { additions: null, deletions: null });
});

test("解析统一 Diff 的行号和增删类型", () => {
  const diff = parseGitDiff(
    "src/a.ts",
    false,
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
    ].join("\n"),
    false,
  );
  assert.equal(diff.lines.find((line) => line.kind === "deletion")?.oldLine, 2);
  assert.equal(diff.lines.find((line) => line.kind === "addition")?.newLine, 2);
  assert.equal(diff.binary, false);
});

test("识别二进制和截断 Diff", () => {
  const diff = parseGitDiff("image.png", false, "Binary files differ", true);
  assert.equal(diff.binary, true);
  assert.equal(diff.truncated, true);
});
