import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";

import type {
  AgentDefinition,
  AgentGroup,
  AgentPreset,
  AgentAvailability,
  Conversation,
  Message,
  MessagePart,
  MessageRole,
  MessageStatus,
  Workspace,
  WorkspaceKind,
} from "@shared/contracts";

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`数据库字段 ${key} 无效`);
  return value;
}

function optionalText(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`数据库字段 ${key} 无效`);
  return value;
}

function optionalInteger(row: Row, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" ? value : undefined;
}

function parseParts(value: unknown): MessagePart[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as MessagePart[]) : [];
  } catch {
    return [];
  }
}

function changes(result: StatementResultingChanges): number {
  return Number(result.changes);
}

export class AppDatabase {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#migrate();
  }

  #migrate(): void {
    // These tables intentionally coexist with the legacy AI SDK tables. The
    // new Workspace core never reads or mutates the old conversation data.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('project', 'temporary')),
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        description TEXT NOT NULL,
        avatar TEXT,
        default_model_id TEXT
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        description TEXT NOT NULL,
        avatar TEXT,
        model_id TEXT,
        system_prompt TEXT NOT NULL,
        home_path TEXT NOT NULL UNIQUE,
        availability TEXT NOT NULL DEFAULT 'idle'
          CHECK (availability IN ('idle', 'working', 'offline')),
        is_built_in INTEGER NOT NULL DEFAULT 0,
        preset_id TEXT REFERENCES agent_presets(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agents_updated ON agents(updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_group_members (
        group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS agent_group_members_agent
        ON agent_group_members(agent_id);

      CREATE TABLE IF NOT EXISTS workspace_conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspace_conversations_workspace_updated
        ON workspace_conversations(workspace_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL
          REFERENCES workspace_conversations(id) ON DELETE CASCADE,
        parent_message_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        status TEXT NOT NULL
          CHECK (status IN ('completed', 'streaming', 'failed', 'cancelled')),
        parts_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_conversation_created
      ON conversation_messages(conversation_id, created_at);
    `);
    this.#addColumnIfMissing("workspace_conversations", "agent_id", "TEXT REFERENCES agents(id) ON DELETE SET NULL");
    this.#addColumnIfMissing("workspace_conversations", "group_id", "TEXT REFERENCES agent_groups(id) ON DELETE SET NULL");
  }

  #addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((row) => row["name"] === column)) return;
    this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listWorkspaces(): Workspace[] {
    return (this.#db.prepare("SELECT * FROM workspaces ORDER BY updated_at DESC").all() as Row[])
      .map((row) => this.#workspace(row));
  }

  workspace(id: string): Workspace | null {
    const row = this.#db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? this.#workspace(row) : null;
  }

  workspaceByPath(path: string): Workspace | null {
    const row = this.#db.prepare("SELECT * FROM workspaces WHERE root_path = ?").get(path) as
      | Row
      | undefined;
    return row ? this.#workspace(row) : null;
  }

  saveWorkspace(workspace: Workspace): void {
    this.#db.prepare(`
      INSERT INTO workspaces (id, kind, name, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(root_path) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        updated_at = excluded.updated_at
    `).run(
      workspace.id,
      workspace.kind,
      workspace.name,
      workspace.path,
      workspace.createdAt,
      workspace.updatedAt,
    );
  }

  touchWorkspace(id: string, updatedAt: number): void {
    this.#db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(updatedAt, id);
  }

  removeWorkspace(id: string): boolean {
    return changes(this.#db.prepare("DELETE FROM workspaces WHERE id = ?").run(id)) > 0;
  }

  listAgentPresets(): AgentPreset[] {
    return (this.#db.prepare("SELECT * FROM agent_presets ORDER BY name").all() as Row[])
      .map((row) => this.#agentPreset(row));
  }

  saveAgentPreset(preset: AgentPreset): void {
    this.#db.prepare(`
      INSERT INTO agent_presets (id, name, role, description, avatar, default_model_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        description = excluded.description,
        avatar = excluded.avatar,
        default_model_id = excluded.default_model_id
    `).run(
      preset.id,
      preset.name,
      preset.role,
      preset.description,
      preset.avatar ?? null,
      preset.defaultModelId ?? null,
    );
  }

  listAgents(): AgentDefinition[] {
    return (this.#db.prepare("SELECT * FROM agents ORDER BY updated_at DESC").all() as Row[])
      .map((row) => this.#agent(row));
  }

  agent(id: string): AgentDefinition | null {
    const row = this.#db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? this.#agent(row) : null;
  }

  agentSystemPrompt(id: string): string | null {
    const row = this.#db.prepare("SELECT system_prompt FROM agents WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? text(row, "system_prompt") : null;
  }

  saveAgent(agent: AgentDefinition, systemPrompt: string, homePath: string): void {
    this.#db.prepare(`
      INSERT INTO agents (
        id, name, role, description, avatar, model_id, system_prompt,
        home_path, availability, is_built_in, preset_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        description = excluded.description,
        avatar = excluded.avatar,
        model_id = excluded.model_id,
        system_prompt = excluded.system_prompt,
        home_path = excluded.home_path,
        availability = excluded.availability,
        is_built_in = excluded.is_built_in,
        preset_id = excluded.preset_id,
        updated_at = excluded.updated_at
    `).run(
      agent.id,
      agent.name,
      agent.role,
      agent.description,
      agent.avatar ?? null,
      agent.modelId ?? null,
      systemPrompt,
      homePath,
      agent.availability,
      agent.isBuiltIn ? 1 : 0,
      agent.presetId ?? null,
      agent.createdAt,
      agent.updatedAt,
    );
  }

  listAgentGroups(): AgentGroup[] {
    const groups = this.#db.prepare(
      "SELECT * FROM agent_groups ORDER BY updated_at DESC, rowid DESC",
    ).all() as Row[];
    const members = this.#db.prepare(
      "SELECT group_id, agent_id FROM agent_group_members ORDER BY rowid",
    ).all() as Row[];
    const agentIdsByGroup = new Map<string, string[]>();
    for (const row of members) {
      const groupId = text(row, "group_id");
      const agentIds = agentIdsByGroup.get(groupId) ?? [];
      agentIds.push(text(row, "agent_id"));
      agentIdsByGroup.set(groupId, agentIds);
    }
    return groups.map((row) => this.#agentGroup(row, agentIdsByGroup.get(text(row, "id")) ?? []));
  }

  saveAgentGroup(group: AgentGroup): void {
    this.#db.prepare(`
      INSERT INTO agent_groups (id, name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        updated_at = excluded.updated_at
    `).run(group.id, group.name, group.description, group.createdAt, group.updatedAt);
    this.#db.prepare("DELETE FROM agent_group_members WHERE group_id = ?").run(group.id);
    const insert = this.#db.prepare(
      "INSERT INTO agent_group_members (group_id, agent_id) VALUES (?, ?)",
    );
    for (const agentId of group.agentIds) insert.run(group.id, agentId);
  }

  removeAgentGroup(id: string): boolean {
    return changes(this.#db.prepare("DELETE FROM agent_groups WHERE id = ?").run(id)) > 0;
  }

  listConversations(workspaceId?: string): Conversation[] {
    const rows = workspaceId
      ? this.#db.prepare(
          `SELECT c.*, COUNT(m.id) AS message_count
           FROM workspace_conversations c
           LEFT JOIN conversation_messages m ON m.conversation_id = c.id
           WHERE c.workspace_id = ?
           GROUP BY c.id
           ORDER BY c.updated_at DESC`,
        ).all(workspaceId)
      : this.#db.prepare(
          `SELECT c.*, COUNT(m.id) AS message_count
           FROM workspace_conversations c
           LEFT JOIN conversation_messages m ON m.conversation_id = c.id
           GROUP BY c.id
           ORDER BY c.updated_at DESC`,
        ).all();
    return (rows as Row[]).map((row) => this.#conversation(row));
  }

  conversation(id: string): Conversation | null {
    const row = this.#db.prepare("SELECT * FROM workspace_conversations WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? this.#conversation(row) : null;
  }

  saveConversation(conversation: Conversation): void {
    this.#db.prepare(`
      INSERT INTO workspace_conversations (id, workspace_id, agent_id, group_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent_id = excluded.agent_id,
        group_id = excluded.group_id,
        title = excluded.title,
        updated_at = excluded.updated_at
    `).run(
      conversation.id,
      conversation.workspaceId,
      conversation.agentId ?? null,
      conversation.groupId ?? null,
      conversation.title,
      conversation.createdAt,
      conversation.updatedAt,
    );
  }

  removeConversation(id: string): boolean {
    return changes(
      this.#db.prepare("DELETE FROM workspace_conversations WHERE id = ?").run(id),
    ) > 0;
  }

  messages(conversationId: string): Message[] {
    return (this.#db.prepare(`
      SELECT * FROM conversation_messages
      WHERE conversation_id = ?
      ORDER BY created_at, rowid
    `).all(conversationId) as Row[]).map((row) => this.#message(row));
  }

  saveMessage(message: Message): void {
    this.#db.prepare(`
      INSERT INTO conversation_messages (
        id, conversation_id, parent_message_id, role, status,
        parts_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        parts_json = excluded.parts_json,
        updated_at = excluded.updated_at
    `).run(
      message.id,
      message.conversationId,
      message.parentMessageId ?? null,
      message.role,
      message.status,
      JSON.stringify(message.parts),
      message.createdAt,
      message.updatedAt,
    );
  }

  close(): void {
    this.#db.close();
  }

  #workspace(row: Row): Workspace {
    return {
      id: text(row, "id"),
      kind: text(row, "kind") as WorkspaceKind,
      name: text(row, "name"),
      path: text(row, "root_path"),
      createdAt: integer(row, "created_at"),
      updatedAt: integer(row, "updated_at"),
    };
  }

  #agentPreset(row: Row): AgentPreset {
    return {
      id: text(row, "id"),
      name: text(row, "name"),
      role: text(row, "role"),
      description: text(row, "description"),
      avatar: optionalText(row, "avatar"),
      defaultModelId: optionalText(row, "default_model_id"),
    };
  }

  #agent(row: Row): AgentDefinition {
    return {
      id: text(row, "id"),
      name: text(row, "name"),
      role: text(row, "role"),
      description: text(row, "description"),
      avatar: optionalText(row, "avatar"),
      modelId: optionalText(row, "model_id"),
      availability: text(row, "availability") as AgentAvailability,
      isBuiltIn: integer(row, "is_built_in") === 1,
      presetId: optionalText(row, "preset_id"),
      createdAt: integer(row, "created_at"),
      updatedAt: integer(row, "updated_at"),
    };
  }

  #agentGroup(row: Row, agentIds: string[]): AgentGroup {
    return {
      id: text(row, "id"),
      name: text(row, "name"),
      description: text(row, "description"),
      agentIds,
      createdAt: integer(row, "created_at"),
      updatedAt: integer(row, "updated_at"),
    };
  }

  #conversation(row: Row): Conversation {
    return {
      id: text(row, "id"),
      workspaceId: text(row, "workspace_id"),
      agentId: optionalText(row, "agent_id"),
      groupId: optionalText(row, "group_id"),
      title: text(row, "title"),
      messageCount: optionalInteger(row, "message_count"),
      createdAt: integer(row, "created_at"),
      updatedAt: integer(row, "updated_at"),
    };
  }

  #message(row: Row): Message {
    return {
      id: text(row, "id"),
      conversationId: text(row, "conversation_id"),
      parentMessageId: optionalText(row, "parent_message_id"),
      role: text(row, "role") as MessageRole,
      status: text(row, "status") as MessageStatus,
      parts: parseParts(row["parts_json"]),
      createdAt: integer(row, "created_at"),
      updatedAt: integer(row, "updated_at"),
    };
  }
}
