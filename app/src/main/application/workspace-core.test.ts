import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import { AppDatabase } from "../infrastructure/database.js";
import { ConversationService } from "./conversation-service.js";
import { WorkspaceService } from "./workspace-service.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "tietiezhi-workspace-test-"));
  t.after(async () => {
    const target = resolve(root);
    if (!basename(target).startsWith("tietiezhi-workspace-test-")) {
      throw new Error("拒绝清理非测试目录");
    }
    await rm(target, { recursive: true, force: true });
  });
  const database = new AppDatabase(join(root, "test.sqlite3"));
  t.after(() => database.close());
  const workspaces = new WorkspaceService(database, join(root, "temporary"));
  const conversations = new ConversationService(database);
  return { root, database, workspaces, conversations };
}

test("项目 Workspace 会持久化，并可包含多个对话", async (t) => {
  const { root, workspaces, conversations } = await fixture(t);
  const projectPath = join(root, "project");
  await mkdir(projectPath);

  const workspace = await workspaces.registerProject(projectPath);
  const first = conversations.create({ workspaceId: workspace.id, title: "第一条对话" });
  const second = conversations.create({ workspaceId: workspace.id, title: "第二条对话" });

  assert.equal(workspace.kind, "project");
  assert.deepEqual(
    conversations.list(workspace.id).map((item) => item.id).sort(),
    [first.conversation.id, second.conversation.id].sort(),
  );
});

test("临时任务使用独立 Workspace，并按父消息顺序保存内容", async (t) => {
  const { workspaces, conversations } = await fixture(t);
  const workspace = await workspaces.createTemporary();
  const detail = conversations.create({ workspaceId: workspace.id });
  const user = conversations.appendMessage({
    conversationId: detail.conversation.id,
    role: "user",
    parts: [{ type: "text", text: "先设计本地对话结构" }],
  });
  const assistant = conversations.appendMessage({
    conversationId: detail.conversation.id,
    role: "assistant",
    parts: [{ type: "text", text: "收到" }],
  });
  const loaded = conversations.load(detail.conversation.id);

  assert.equal(workspace.kind, "temporary");
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0]?.id, user.id);
  assert.equal(loaded.messages[1]?.parentMessageId, user.id);
  assert.equal(loaded.messages[1]?.id, assistant.id);
});
