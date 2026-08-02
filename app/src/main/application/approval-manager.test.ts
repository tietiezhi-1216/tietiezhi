import assert from "node:assert/strict";
import test from "node:test";

import type { ApprovalRecord } from "@shared/contracts";

import { ApprovalManager, type ApprovalStore } from "./approval-manager.js";

class MemoryApprovalStore implements ApprovalStore {
  readonly records = new Map<string, ApprovalRecord>();

  approvals(conversationId?: string): ApprovalRecord[] {
    return [...this.records.values()].filter(
      (record) => conversationId === undefined || record.conversationId === conversationId,
    );
  }

  saveApproval(approval: ApprovalRecord): void {
    this.records.set(approval.id, approval);
  }
}

function request(manager: ApprovalManager, signal: AbortSignal) {
  return manager.request(
    {
      id: "approval-1",
      runId: "run-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      toolCallId: "call-1",
      toolName: "writeFile",
      description: "写入 example.txt",
      input: { path: "example.txt" },
      risk: "medium",
    },
    signal,
  );
}

test("审批请求可查询并支持本轮允许", async () => {
  const store = new MemoryApprovalStore();
  const manager = new ApprovalManager(store);
  const pending = request(manager, new AbortController().signal);
  assert.equal(manager.list("conversation-1")[0]?.status, "pending");
  manager.resolve("approval-1", "allow-for-run");
  assert.equal(await pending, "allow-for-run");
  assert.equal(manager.list()[0]?.status, "approved");
});

test("取消任务会关闭审批且不能再次响应", async () => {
  const store = new MemoryApprovalStore();
  const manager = new ApprovalManager(store);
  const controller = new AbortController();
  const pending = request(manager, controller.signal);
  controller.abort();
  await assert.rejects(pending, /操作已取消/);
  assert.equal(manager.list()[0]?.status, "cancelled");
  assert.throws(() => manager.resolve("approval-1", "allow-once"), /不存在或已经结束/);
});

test("自动审批会写入可审计的已批准记录", () => {
  const store = new MemoryApprovalStore();
  const manager = new ApprovalManager(store);
  manager.recordAutomatic(
    {
      id: "auto-1",
      runId: "run-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      toolCallId: "tool-1",
      toolName: "writeFile",
      description: "写入 src/a.ts",
      input: { path: "src/a.ts" },
      risk: "medium",
    },
    "由智能审批自动允许",
  );
  const approval = manager.list("conversation-1")[0];
  assert.equal(approval?.status, "approved");
  assert.equal(approval?.decision, "allow-once");
  assert.equal(approval?.reason, "由智能审批自动允许");
});
