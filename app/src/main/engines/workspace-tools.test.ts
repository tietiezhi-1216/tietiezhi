import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertCommandStaysInWorkspace, resolveWorkspacePath } from "./workspace-tools.js";

test("允许解析 Workspace 内路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "tietiezhi-workspace-"));
  await mkdir(join(root, "src"));
  const canonicalRoot = await realpath(root);
  assert.equal(
    await resolveWorkspacePath(root, "src/example.ts", true),
    join(canonicalRoot, "src/example.ts"),
  );
});

test("拒绝通过相对路径逃出 Workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "tietiezhi-workspace-"));
  await assert.rejects(resolveWorkspacePath(root, "../outside.txt"), /超出 Workspace/);
});

test("拒绝通过符号链接逃出 Workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "tietiezhi-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "tietiezhi-outside-"));
  await symlink(outside, join(root, "escape"));
  await assert.rejects(
    resolveWorkspacePath(root, "escape/created/file.txt", true),
    /符号链接超出 Workspace/,
  );
});

test("Shell 拒绝明显越过 Workspace 的路径", () => {
  assert.doesNotThrow(() => assertCommandStaysInWorkspace("pnpm test"));
  assert.doesNotThrow(() => assertCommandStaysInWorkspace("rm -rf dist"));
  assert.throws(() => assertCommandStaysInWorkspace("cat /etc/passwd"), /越过 Workspace/);
  assert.throws(() => assertCommandStaysInWorkspace("cd ../other"), /越过 Workspace/);
  assert.throws(() => assertCommandStaysInWorkspace("cat $HOME/.ssh/config"), /越过 Workspace/);
});
