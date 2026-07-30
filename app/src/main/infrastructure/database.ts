import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";

import { app } from "electron";

import type {
  AppMessage,
  Conversation,
  ConversationDetail,
  MediaArtifact,
  MediaJob,
  MessagePart,
  ProviderAccount,
  UsageInfo,
} from "@shared/contracts";

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function optionalText(row: Row, key: string): string | undefined {
  const value = text(row, key);
  return value === "" ? undefined : value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function parseJSON<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function changes(result: StatementResultingChanges): number {
  return Number(result.changes);
}

export class AppDatabase {
  readonly #db: DatabaseSync;

  constructor(path = join(app.getPath("userData"), "tietiezhi.sqlite3")) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#migrate();
    this.recoverInterruptedRuns();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_accounts (
        id TEXT PRIMARY KEY,
        provider_type TEXT NOT NULL,
        display_name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        models_json TEXT NOT NULL,
        model_metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        active_engine_id TEXT NOT NULL,
        active_model_id TEXT,
        provider_account_id TEXT,
        workspace TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        parent_message_id TEXT,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        parts_json TEXT NOT NULL,
        engine_id TEXT,
        model_id TEXT,
        run_id TEXT,
        usage_json TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_created
        ON messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        engine_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        finish_reason TEXT,
        usage_json TEXT,
        error_json TEXT
      );
      CREATE TABLE IF NOT EXISTS media_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        aspect_ratio TEXT,
        result_count INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error_json TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    try {
      this.#db.exec("ALTER TABLE media_jobs ADD COLUMN aspect_ratio TEXT");
    } catch {
      // Column already exists.
    }
    try {
      this.#db.exec("ALTER TABLE media_jobs ADD COLUMN result_count INTEGER NOT NULL DEFAULT 1");
    } catch {
      // Column already exists.
    }
    try {
      this.#db.exec(
        "ALTER TABLE provider_accounts ADD COLUMN model_metadata_json TEXT NOT NULL DEFAULT '{}'",
      );
    } catch {
      // Column already exists.
    }
  }

  recoverInterruptedRuns(): void {
    const now = Date.now();
    this.#db
      .prepare(
        `UPDATE runs
         SET status = 'failed', completed_at = ?, finish_reason = 'error',
             error_json = ?
         WHERE status = 'running'`,
      )
      .run(
        now,
        JSON.stringify({
          code: "APP_RESTARTED",
          message: "应用在任务完成前退出",
          retryable: true,
        }),
      );
    this.#db
      .prepare(
        `UPDATE messages
         SET status = 'failed'
         WHERE status IN ('pending', 'streaming')`,
      )
      .run();
    this.#db
      .prepare(
        `UPDATE media_jobs
         SET status = 'failed', updated_at = ?, error_json = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(
        now,
        JSON.stringify({
          code: "APP_RESTARTED",
          message: "应用在图片生成完成前退出",
          retryable: true,
        }),
      );
  }

  listProviders(): ProviderAccount[] {
    return (this.#db.prepare("SELECT * FROM provider_accounts ORDER BY created_at").all() as Row[]).map(
      (row) => ({
        id: text(row, "id"),
        providerType: text(row, "provider_type") as ProviderAccount["providerType"],
        displayName: text(row, "display_name"),
        baseURL: text(row, "base_url"),
        credentialRef: text(row, "credential_ref"),
        enabled: integer(row, "enabled") === 1,
        models: parseJSON<string[]>(row["models_json"], []),
        modelMetadata: parseJSON<ProviderAccount["modelMetadata"]>(
          row["model_metadata_json"],
          {},
        ),
        builtIn: text(row, "id") === "builtin-official",
      }),
    );
  }

  provider(id: string): ProviderAccount | null {
    return this.listProviders().find((provider) => provider.id === id) ?? null;
  }

  saveProvider(provider: ProviderAccount): void {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO provider_accounts (
          id, provider_type, display_name, base_url, credential_ref,
          enabled, models_json, model_metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider_type = excluded.provider_type,
          display_name = excluded.display_name,
          base_url = excluded.base_url,
          credential_ref = excluded.credential_ref,
          enabled = excluded.enabled,
          models_json = excluded.models_json,
          model_metadata_json = excluded.model_metadata_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        provider.id,
        provider.providerType,
        provider.displayName,
        provider.baseURL,
        provider.credentialRef,
        provider.enabled ? 1 : 0,
        JSON.stringify(provider.models),
        JSON.stringify(provider.modelMetadata),
        now,
        now,
      );
  }

  removeProvider(id: string): boolean {
    return changes(this.#db.prepare("DELETE FROM provider_accounts WHERE id = ?").run(id)) > 0;
  }

  listConversations(): Conversation[] {
    return (this.#db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all() as Row[]).map(
      (row) => ({
        id: text(row, "id"),
        title: text(row, "title"),
        createdAt: integer(row, "created_at"),
        updatedAt: integer(row, "updated_at"),
        activeEngineId: text(row, "active_engine_id"),
        activeModelId: optionalText(row, "active_model_id"),
        providerAccountId: optionalText(row, "provider_account_id"),
        workspace: optionalText(row, "workspace"),
      }),
    );
  }

  conversation(id: string): Conversation | null {
    return this.listConversations().find((conversation) => conversation.id === id) ?? null;
  }

  saveConversation(conversation: Conversation): void {
    this.#db
      .prepare(
        `INSERT INTO conversations (
          id, title, created_at, updated_at, active_engine_id,
          active_model_id, provider_account_id, workspace
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          updated_at = excluded.updated_at,
          active_engine_id = excluded.active_engine_id,
          active_model_id = excluded.active_model_id,
          provider_account_id = excluded.provider_account_id,
          workspace = excluded.workspace`,
      )
      .run(
        conversation.id,
        conversation.title,
        conversation.createdAt,
        conversation.updatedAt,
        conversation.activeEngineId,
        conversation.activeModelId ?? null,
        conversation.providerAccountId ?? null,
        conversation.workspace ?? null,
      );
  }

  removeConversation(id: string): boolean {
    return changes(this.#db.prepare("DELETE FROM conversations WHERE id = ?").run(id)) > 0;
  }

  messages(conversationId: string): AppMessage[] {
    const rows = this.#db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid")
      .all(conversationId) as Row[];
    return rows.map((row) => ({
      id: text(row, "id"),
      conversationId: text(row, "conversation_id"),
      parentMessageId: optionalText(row, "parent_message_id"),
      role: text(row, "role") as AppMessage["role"],
      createdAt: integer(row, "created_at"),
      status: text(row, "status") as AppMessage["status"],
      parts: parseJSON<MessagePart[]>(row["parts_json"], []),
      engineId: optionalText(row, "engine_id"),
      modelId: optionalText(row, "model_id"),
      runId: optionalText(row, "run_id"),
      usage: parseJSON<UsageInfo | undefined>(row["usage_json"], undefined),
    }));
  }

  detail(id: string): ConversationDetail | null {
    const conversation = this.conversation(id);
    return conversation ? { conversation, messages: this.messages(id) } : null;
  }

  saveMessage(message: AppMessage): void {
    this.#db
      .prepare(
        `INSERT INTO messages (
          id, conversation_id, parent_message_id, role, created_at, status,
          parts_json, engine_id, model_id, run_id, usage_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          parts_json = excluded.parts_json,
          usage_json = excluded.usage_json`,
      )
      .run(
        message.id,
        message.conversationId,
        message.parentMessageId ?? null,
        message.role,
        message.createdAt,
        message.status,
        JSON.stringify(message.parts),
        message.engineId ?? null,
        message.modelId ?? null,
        message.runId ?? null,
        message.usage === undefined ? null : JSON.stringify(message.usage),
      );
  }

  startRun(input: {
    id: string;
    conversationId: string;
    messageId: string;
    engineId: string;
    modelId: string;
    startedAt: number;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO runs (
          id, conversation_id, message_id, engine_id, model_id, started_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(
        input.id,
        input.conversationId,
        input.messageId,
        input.engineId,
        input.modelId,
        input.startedAt,
      );
  }

  finishRun(
    id: string,
    status: "completed" | "failed" | "cancelled",
    finishReason: string,
    usage?: UsageInfo,
    error?: unknown,
  ): void {
    this.#db
      .prepare(
        `UPDATE runs SET
          completed_at = ?, status = ?, finish_reason = ?, usage_json = ?, error_json = ?
         WHERE id = ?`,
      )
      .run(
        Date.now(),
        status,
        finishReason,
        usage === undefined ? null : JSON.stringify(usage),
        error === undefined ? null : JSON.stringify(error),
        id,
      );
  }

  saveMediaJob(job: MediaJob): void {
    this.#db
      .prepare(
        `INSERT INTO media_jobs (
          id, type, provider_id, model_id, prompt, aspect_ratio, result_count,
          status, created_at, updated_at, error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at,
          error_json = excluded.error_json`,
      )
      .run(
        job.id,
        job.type,
        job.providerId,
        job.modelId,
        job.prompt,
        job.aspectRatio ?? null,
        job.count,
        job.status,
        job.createdAt,
        job.updatedAt,
        job.error === undefined ? null : JSON.stringify(job.error),
      );
    for (const artifact of job.artifacts) this.saveArtifact(artifact);
  }

  saveArtifact(artifact: MediaArtifact): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO artifacts (
          id, job_id, type, file_path, mime_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.jobId,
        artifact.type,
        artifact.filePath,
        artifact.mimeType,
        artifact.createdAt,
      );
  }

  listMediaJobs(): MediaJob[] {
    const artifacts = this.#db.prepare("SELECT * FROM artifacts ORDER BY created_at").all() as Row[];
    const byJob = new Map<string, MediaArtifact[]>();
    for (const row of artifacts) {
      const artifact: MediaArtifact = {
        id: text(row, "id"),
        jobId: text(row, "job_id"),
        type: "image",
        filePath: text(row, "file_path"),
        mimeType: text(row, "mime_type"),
        createdAt: integer(row, "created_at"),
      };
      byJob.set(artifact.jobId, [...(byJob.get(artifact.jobId) ?? []), artifact]);
    }
    return (this.#db.prepare("SELECT * FROM media_jobs ORDER BY created_at DESC").all() as Row[]).map(
      (row) => ({
        id: text(row, "id"),
        type: "image",
        providerId: text(row, "provider_id"),
        modelId: text(row, "model_id"),
        prompt: text(row, "prompt"),
        aspectRatio: optionalText(row, "aspect_ratio") as `${number}:${number}` | undefined,
        count: Math.max(1, integer(row, "result_count")),
        status: text(row, "status") as MediaJob["status"],
        createdAt: integer(row, "created_at"),
        updatedAt: integer(row, "updated_at"),
        artifacts: byJob.get(text(row, "id")) ?? [],
        error: parseJSON<MediaJob["error"]>(row["error_json"], undefined),
      }),
    );
  }

  removeMediaJob(id: string): boolean {
    return changes(this.#db.prepare("DELETE FROM media_jobs WHERE id = ?").run(id)) > 0;
  }
}
