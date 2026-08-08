import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import { AppDatabase } from "../infrastructure/database.js";
import { AgentProfileService } from "./agent-profile-service.js";
import { AgentGroupService } from "./agent-group-service.js";
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
  const agentProfiles = new AgentProfileService(database, join(root, "agents"));
  const agentGroups = new AgentGroupService(database, agentProfiles);
  const conversations = new ConversationService(database, agentProfiles, agentGroups);
  return { root, database, workspaces, agentProfiles, agentGroups, conversations };
}

test("项目 Workspace 会持久化，并可包含多个对话", async (t) => {
  const { root, workspaces, conversations } = await fixture(t);
  const projectPath = join(root, "project");
  await mkdir(projectPath);

  const workspace = await workspaces.registerProject(projectPath);
  const first = conversations.create({ workspaceId: workspace.id, title: "第一条对话" });
  const second = conversations.create({ workspaceId: workspace.id, title: "第二条对话" });

  assert.equal(workspace.kind, "project");
  assert.equal(
    conversations.list(workspace.id).find((item) => item.id === first.conversation.id)?.messageCount,
    0,
  );
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

test("智能体使用预设创建独立身份，并可绑定私聊", async (t) => {
  const { workspaces, agentProfiles, conversations } = await fixture(t);
  const agent = agentProfiles.create({
    presetId: "engineer",
    name: "代码工程师",
    role: "软件开发",
  });
  const workspace = await workspaces.createTemporary();
  const detail = conversations.create({
    workspaceId: workspace.id,
    agentId: agent.id,
  });

  assert.equal(agent.role, "软件开发");
  assert.equal(agentProfiles.list()[0]?.id, agent.id);
  assert.equal(detail.conversation.agentId, agent.id);
  assert.equal(conversations.load(detail.conversation.id).conversation.agentId, agent.id);
});

test("群聊至少包含两个智能体，并将主智能体绑定到对话", async (t) => {
  const { workspaces, agentProfiles, agentGroups, conversations } = await fixture(t);
  const first = agentProfiles.create({ presetId: "principal", name: "主理人", role: "任务协调" });
  const second = agentProfiles.create({ presetId: "reviewer", name: "审查员", role: "质量审查" });
  const group = agentGroups.create({
    name: "发布小组",
    description: "一起检查发布任务",
    agentIds: [first.id, second.id],
  });
  const workspace = await workspaces.createTemporary();
  const detail = conversations.create({ workspaceId: workspace.id, groupId: group.id });

  assert.deepEqual(agentGroups.list()[0]?.agentIds, [first.id, second.id]);
  assert.equal(detail.conversation.groupId, group.id);
  assert.equal(detail.conversation.agentId, first.id);
});
