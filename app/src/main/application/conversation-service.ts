import { randomUUID } from "node:crypto";

import type {
  AppendMessageInput,
  Conversation,
  ConversationDetail,
  CreateConversationInput,
  Message,
} from "@shared/contracts";

import { AgentProfileService } from "./agent-profile-service.js";
import { AgentGroupService } from "./agent-group-service.js";
import { AppDatabase } from "../infrastructure/database.js";

export class ConversationService {
  constructor(
    private readonly database: AppDatabase,
    private readonly agentProfiles?: AgentProfileService,
    private readonly agentGroups?: AgentGroupService,
  ) {}

  list(workspaceId?: string): Conversation[] {
    return this.database.listConversations(workspaceId);
  }

  create(input: CreateConversationInput): ConversationDetail {
    const workspace = this.database.workspace(input.workspaceId);
    if (!workspace) throw new Error("Workspace 不存在");
    if (input.agentId) {
      if (!this.agentProfiles) throw new Error("智能体服务尚未初始化");
      this.agentProfiles.require(input.agentId);
    }
    const group = input.groupId
      ? this.agentGroups?.require(input.groupId)
      : undefined;
    if (input.groupId && !group) throw new Error("群聊服务尚未初始化");
    if (group && input.agentId && !group.agentIds.includes(input.agentId)) {
      throw new Error("智能体不属于该群聊");
    }
    const agentId = input.agentId ?? group?.agentIds[0];
    const now = Date.now();
    const conversation: Conversation = {
      id: randomUUID(),
      workspaceId: workspace.id,
      agentId,
      groupId: group?.id,
      title: input.title?.trim().slice(0, 120) || "新对话",
      createdAt: now,
      updatedAt: now,
    };
    this.database.transaction(() => {
      this.database.saveConversation(conversation);
      this.database.touchWorkspace(workspace.id, now);
    });
    return { conversation, workspace: { ...workspace, updatedAt: now }, messages: [] };
  }

  load(id: string): ConversationDetail {
    const conversation = this.database.conversation(id);
    if (!conversation) throw new Error("对话不存在");
    const workspace = this.database.workspace(conversation.workspaceId);
    if (!workspace) throw new Error("对话绑定的 Workspace 不存在");
    return {
      conversation,
      workspace,
      messages: this.database.messages(id),
    };
  }

  appendMessage(input: AppendMessageInput): Message {
    const conversation = this.database.conversation(input.conversationId);
    if (!conversation) throw new Error("对话不存在");
    if (input.parts.length === 0) throw new Error("消息内容不能为空");
    const now = Date.now();
    const previous = this.database.messages(conversation.id).at(-1);
    const message: Message = {
      id: randomUUID(),
      conversationId: conversation.id,
      parentMessageId: input.parentMessageId ?? previous?.id,
      role: input.role,
      status: "completed",
      parts: input.parts,
      createdAt: now,
      updatedAt: now,
    };
    this.database.transaction(() => {
      this.database.saveMessage(message);
      this.database.saveConversation({ ...conversation, updatedAt: now });
      this.database.touchWorkspace(conversation.workspaceId, now);
    });
    return message;
  }

  rename(id: string, title: string): Conversation {
    const conversation = this.database.conversation(id);
    if (!conversation) throw new Error("对话不存在");
    const normalized = title.trim();
    if (!normalized) throw new Error("对话名称不能为空");
    const updated = { ...conversation, title: normalized.slice(0, 120), updatedAt: Date.now() };
    this.database.saveConversation(updated);
    return updated;
  }

  remove(id: string): void {
    if (!this.database.removeConversation(id)) throw new Error("对话不存在");
  }
}
