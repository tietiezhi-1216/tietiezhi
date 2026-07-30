/**
 * Session persistence: one directory per session, an append-only JSONL of
 * messages plus a small metadata file.
 *
 * Append-only because a turn can be long and can crash: rewriting a whole
 * transcript on every message means a crash mid-write loses the conversation,
 * while appending means the worst case is one torn trailing line, which the
 * reader skips. The old core kept a SQLite index mirroring the same data and the
 * two could disagree; there is deliberately only one source of truth here.
 */

import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Message, ModelRef, Usage } from "./types.js";

export interface SessionMeta {
  id: string;
  /** Absolute directory the agent is rooted at. */
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Last model used, so reopening a session keeps the user's choice. */
  provider: ModelRef["provider"] | null;
  model: string | null;
  /** Running total across all turns in this session. */
  usage: Usage | null;
}

export interface Session {
  meta: SessionMeta;
  messages: Message[];
}

const META_FILE = "session.json";
const LOG_FILE = "messages.jsonl";

/** Where sessions live. Injected so tests do not touch the real profile. */
let rootDir: string | null = null;

export function setSessionRoot(dir: string): void {
  rootDir = dir;
}

function root(): string {
  if (rootDir === null) {
    throw new Error("会话存储目录未初始化：请先调用 setSessionRoot()");
  }
  return rootDir;
}

function sessionDir(id: string): string {
  // Ids are generated here, never taken from callers, so no traversal check is
  // needed — but reject anything that would escape anyway, cheaply.
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`会话 id 不合法：${id}`);
  }
  return join(root(), id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMeta(value: unknown, fallbackId: string): SessionMeta {
  const record = isRecord(value) ? value : {};
  const str = (key: string, or = ""): string =>
    typeof record[key] === "string" ? (record[key] as string) : or;
  const num = (key: string, or = 0): number =>
    typeof record[key] === "number" ? (record[key] as number) : or;
  const provider = str("provider");
  return {
    id: str("id", fallbackId),
    cwd: str("cwd"),
    title: str("title", "新会话"),
    createdAt: num("createdAt"),
    updatedAt: num("updatedAt"),
    provider:
      provider === "anthropic" || provider === "openai" || provider === "google" ? provider : null,
    model: str("model") === "" ? null : str("model"),
    usage: isRecord(record["usage"]) ? (record["usage"] as unknown as Usage) : null,
  };
}

/**
 * Validates a persisted message enough to replay it.
 *
 * `providerData` is passed through untouched: it holds the provider's opaque
 * reasoning signature, and normalizing or re-encoding it would invalidate it.
 */
function readMessage(value: unknown): Message | null {
  if (!isRecord(value)) return null;
  const role = value["role"];
  if (role !== "user" && role !== "assistant") return null;
  const content = value["content"];
  if (!Array.isArray(content)) return null;

  const parts = content.filter((part): part is Message["content"][number] => {
    if (!isRecord(part)) return false;
    switch (part["type"]) {
      case "text":
      case "reasoning":
        return typeof part["text"] === "string";
      case "tool-call":
        return typeof part["callId"] === "string" && typeof part["toolName"] === "string";
      case "tool-result":
        return typeof part["callId"] === "string" && typeof part["toolName"] === "string";
      default:
        return false;
    }
  });
  return parts.length === 0 ? null : { role, content: parts };
}

async function writeMetaAtomic(id: string, meta: SessionMeta): Promise<void> {
  const dir = sessionDir(id);
  await mkdir(dir, { recursive: true });
  // Unique temp name per call: a shared one lets two writers truncate each
  // other's file and publish a half-written document.
  const temp = join(dir, `${META_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await rename(temp, join(dir, META_FILE));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function createSession(options: {
  cwd: string;
  title?: string;
  provider?: ModelRef["provider"];
  model?: string;
}): Promise<SessionMeta> {
  const now = Date.now();
  const meta: SessionMeta = {
    id: randomUUID(),
    cwd: options.cwd,
    title: options.title ?? "新会话",
    createdAt: now,
    updatedAt: now,
    provider: options.provider ?? null,
    model: options.model ?? null,
    usage: null,
  };
  await mkdir(sessionDir(meta.id), { recursive: true });
  await writeFile(join(sessionDir(meta.id), LOG_FILE), "", "utf8");
  await writeMetaAtomic(meta.id, meta);
  return meta;
}

/** Appends one message. The only write on the hot path of a turn. */
export async function appendMessage(id: string, message: Message): Promise<void> {
  const dir = sessionDir(id);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, LOG_FILE), `${JSON.stringify(message)}\n`, "utf8");
}

export async function loadSession(id: string): Promise<Session | null> {
  const dir = sessionDir(id);
  const rawMeta = await readFile(join(dir, META_FILE), "utf8").catch(() => null);
  if (rawMeta === null) return null;

  let meta: SessionMeta;
  try {
    meta = readMeta(JSON.parse(rawMeta), id);
  } catch {
    return null;
  }

  const log = await readFile(join(dir, LOG_FILE), "utf8").catch(() => "");
  const messages: Message[] = [];
  for (const line of log.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = readMessage(JSON.parse(line));
      if (parsed !== null) messages.push(parsed);
    } catch {
      // A torn trailing line is the expected cost of append-only writes; the
      // rest of the transcript is still good, so skip rather than fail.
    }
  }
  return { meta, messages };
}

export async function updateMeta(
  id: string,
  patch: Partial<Omit<SessionMeta, "id" | "createdAt">>,
): Promise<SessionMeta | null> {
  const existing = await loadSession(id);
  if (existing === null) return null;
  const next: SessionMeta = { ...existing.meta, ...patch, updatedAt: Date.now() };
  await writeMetaAtomic(id, next);
  return next;
}

export async function listSessions(): Promise<SessionMeta[]> {
  const entries = await readdir(root(), { withFileTypes: true }).catch(() => []);
  const metas: SessionMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = await readFile(join(root(), entry.name, META_FILE), "utf8").catch(() => null);
    if (raw === null) continue;
    try {
      metas.push(readMeta(JSON.parse(raw), entry.name));
    } catch {
      continue;
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSession(id: string): Promise<boolean> {
  const dir = sessionDir(id);
  const existed = (await readFile(join(dir, META_FILE), "utf8").catch(() => null)) !== null;
  await rm(dir, { recursive: true, force: true });
  return existed;
}

/**
 * Derives a title from the first user message, so the list is readable without
 * spending a model call on naming.
 */
export function deriveTitle(messages: Message[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.content) {
      if (part.type !== "text") continue;
      const line = part.text.trim().split("\n")[0] ?? "";
      if (line !== "") return line.length > 40 ? `${line.slice(0, 40)}…` : line;
    }
  }
  return null;
}
