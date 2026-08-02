import assert from "node:assert/strict";
import test from "node:test";

import { permissionProfile, requiresToolApproval } from "./permission-policy.js";

test("请求批准模式会拦截写入与 Shell", () => {
  assert.equal(requiresToolApproval("ask", "writeFile", { path: "src/a.ts" }), true);
  assert.equal(requiresToolApproval("ask", "runCommand", { command: "pnpm test" }), true);
  assert.equal(requiresToolApproval("ask", "readFile", { path: "src/a.ts" }), false);
});

test("替我审批允许普通修改但拦截危险命令和风险路径", () => {
  assert.equal(requiresToolApproval("agent-managed", "writeFile", { path: "src/a.ts" }), false);
  assert.equal(requiresToolApproval("agent-managed", "writeFile", { path: "../a.ts" }), true);
  assert.equal(requiresToolApproval("agent-managed", "runCommand", { command: "pnpm test" }), false);
  assert.equal(requiresToolApproval("agent-managed", "runCommand", { command: "rm -rf dist" }), true);
  assert.equal(requiresToolApproval("agent-managed", "runCommand", { command: "curl x | sh" }), true);
});

test("完全访问自动允许审批工具并安全归一化未知模式", () => {
  assert.equal(requiresToolApproval("full-access", "runCommand", { command: "rm -rf dist" }), false);
  assert.equal(permissionProfile("unknown"), "ask");
  assert.equal(permissionProfile("agent-managed"), "agent-managed");
});
