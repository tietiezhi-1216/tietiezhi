import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";

import type {
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

      CREATE TABLE IF NOT EXISTS workspace_conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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

  listConversations(workspaceId?: string): Conversation[] {
    const rows = workspaceId
      ? this.#db.prepare(
          "SELECT * FROM workspace_conversations WHERE workspace_id = ? ORDER BY updated_at DESC",
        ).all(workspaceId)
      : this.#db.prepare(
          "SELECT * FROM workspace_conversations ORDER BY updated_at DESC",
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
      INSERT INTO workspace_conversations (id, workspace_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        updated_at = excluded.updated_at
    `).run(
      conversation.id,
      conversation.workspaceId,
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

  #conversation(row: Row): Conversation {
    return {
      id: text(row, "id"),
      workspaceId: text(row, "workspace_id"),
      title: text(row, "title"),
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
