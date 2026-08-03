import { randomUUID } from "node:crypto";

import type {
  AppendMessageInput,
  Conversation,
  ConversationDetail,
  CreateConversationInput,
  Message,
} from "@shared/contracts";

import { AppDatabase } from "../infrastructure/database.js";

export class ConversationService {
  constructor(private readonly database: AppDatabase) {}

  list(workspaceId?: string): Conversation[] {
    return this.database.listConversations(workspaceId);
  }

  create(input: CreateConversationInput): ConversationDetail {
    const workspace = this.database.workspace(input.workspaceId);
    if (!workspace) throw new Error("Workspace 不存在");
    const now = Date.now();
    const conversation: Conversation = {
      id: randomUUID(),
      workspaceId: workspace.id,
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
