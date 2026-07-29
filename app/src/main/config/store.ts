/**
 * Canonical MCP configuration: the single list the user edits once, which
 * ./projection.ts then translates into each core's native dialect.
 *
 * Stored at `<userData>/config/mcp.json`. Never inside a user dotfile — the
 * app owns this file and rewrites it wholesale.
 */

import { app } from "electron";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { McpServerDefinition } from "@shared/contracts";

/** Bumped only when the on-disk shape changes incompatibly. */
export const MCP_STORE_VERSION = 1;

interface McpStoreFile {
  version: number;
  servers: McpServerDefinition[];
}

/** Why the last load lost data, surfaced so the UI can warn instead of guess. */
export interface StoreLoadIssue {
  kind: "unreadable" | "invalid-root" | "invalid-entry";
  detail: string;
  /** Where the original file was preserved, when one was kept. */
  backupPath?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (typeof entry !== "string") return undefined;
    out[key] = entry;
  }
  return out;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

/** Narrows unvalidated JSON (or IPC payloads) into a definition. */
export function parseServerDefinition(value: unknown): McpServerDefinition | null {
  if (!isRecord(value)) return null;
  const { id, name, enabled, transport } = value;
  if (typeof id !== "string" || id.trim() === "") return null;
  if (typeof name !== "string") return null;
  if (typeof enabled !== "boolean") return null;
  if (!isRecord(transport)) return null;

  if (transport["type"] === "stdio") {
    const command = transport["command"];
    if (typeof command !== "string") return null;
    const args = asStringArray(transport["args"] ?? []);
    if (args === undefined) return null;
    const rawEnv = transport["env"];
    const env = rawEnv === undefined ? undefined : asStringRecord(rawEnv);
    if (rawEnv !== undefined && env === undefined) return null;
    return { id, name, enabled, transport: { type: "stdio", command, args, ...(env ? { env } : {}) } };
  }

  if (transport["type"] === "http") {
    const url = transport["url"];
    if (typeof url !== "string") return null;
    const rawHeaders = transport["headers"];
    const headers = rawHeaders === undefined ? undefined : asStringRecord(rawHeaders);
    if (rawHeaders !== undefined && headers === undefined) return null;
    return { id, name, enabled, transport: { type: "http", url, ...(headers ? { headers } : {}) } };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class McpConfigStore {
  readonly filePath: string;

  #servers: McpServerDefinition[] | null = null;
  #issues: StoreLoadIssue[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Problems from the most recent load; empty when the file was clean. */
  get loadIssues(): readonly StoreLoadIssue[] {
    this.#ensureLoaded();
    return this.#issues;
  }

  listServers(): McpServerDefinition[] {
    this.#ensureLoaded();
    return structuredClone(this.#servers ?? []);
  }

  getServer(id: string): McpServerDefinition | undefined {
    const found = this.listServers().find((server) => server.id === id);
    return found;
  }

  /** Inserts or replaces by id, preserving position for an existing entry. */
  upsertServer(definition: McpServerDefinition): McpServerDefinition {
    const parsed = parseServerDefinition(definition);
    if (parsed === null) {
      throw new TypeError(`Invalid MCP server definition for id ${JSON.stringify(definition.id)}`);
    }
    this.#ensureLoaded();
    const servers = this.#servers ?? [];
    const index = servers.findIndex((server) => server.id === parsed.id);
    if (index === -1) servers.push(parsed);
    else servers[index] = parsed;
    this.#servers = servers;
    this.#persist();
    return structuredClone(parsed);
  }

  /** Returns false when no server had that id. */
  removeServer(id: string): boolean {
    this.#ensureLoaded();
    const servers = this.#servers ?? [];
    const index = servers.findIndex((server) => server.id === id);
    if (index === -1) return false;
    servers.splice(index, 1);
    this.#servers = servers;
    this.#persist();
    return true;
  }

  /** Returns false when no server had that id. */
  setEnabled(id: string, enabled: boolean): boolean {
    this.#ensureLoaded();
    const servers = this.#servers ?? [];
    const current = servers.find((server) => server.id === id);
    if (current === undefined) return false;
    if (current.enabled === enabled) return true;
    current.enabled = enabled;
    this.#persist();
    return true;
  }

  /** Drops the in-memory copy so the next read hits disk. */
  reload(): void {
    this.#servers = null;
    this.#issues = [];
  }

  #ensureLoaded(): void {
    if (this.#servers !== null) return;
    const { servers, issues } = this.#load();
    this.#servers = servers;
    this.#issues = issues;
  }

  #load(): { servers: McpServerDefinition[]; issues: StoreLoadIssue[] } {
    const issues: StoreLoadIssue[] = [];

    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (error) {
      // A missing file is the normal first-run case, not an issue.
      if (isNotFound(error)) return { servers: [], issues };
      issues.push({ kind: "unreadable", detail: describe(error) });
      return { servers: [], issues };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // Corrupt config must never crash startup; keep the evidence, start empty.
      const backupPath = this.#moveAside();
      issues.push({ kind: "invalid-root", detail: describe(error), ...(backupPath ? { backupPath } : {}) });
      return { servers: [], issues };
    }

    if (!isRecord(parsed) || !Array.isArray(parsed["servers"])) {
      const backupPath = this.#moveAside();
      issues.push({
        kind: "invalid-root",
        detail: "Expected an object with a `servers` array.",
        ...(backupPath ? { backupPath } : {}),
      });
      return { servers: [], issues };
    }

    const servers: McpServerDefinition[] = [];
    const seen = new Set<string>();
    let dropped = 0;
    for (const raw of parsed["servers"]) {
      const server = parseServerDefinition(raw);
      if (server === null || seen.has(server.id)) {
        dropped += 1;
        continue;
      }
      seen.add(server.id);
      servers.push(server);
    }

    if (dropped > 0) {
      // Salvage the readable entries but keep the original around, because the
      // dropped ones are the user's data.
      const backupPath = this.#copyAside();
      issues.push({
        kind: "invalid-entry",
        detail: `Dropped ${String(dropped)} malformed server entr${dropped === 1 ? "y" : "ies"}.`,
        ...(backupPath ? { backupPath } : {}),
      });
    }

    return { servers, issues };
  }

  #persist(): void {
    const payload: McpStoreFile = {
      version: MCP_STORE_VERSION,
      servers: this.#servers ?? [],
    };
    writeJsonAtomicSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  #backupPath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${this.filePath}.corrupt-${stamp}`;
  }

  #moveAside(): string | undefined {
    const target = this.#backupPath();
    try {
      renameSync(this.filePath, target);
      return target;
    } catch {
      return undefined;
    }
  }

  #copyAside(): string | undefined {
    const target = this.#backupPath();
    try {
      copyFileSync(this.filePath, target);
      return target;
    } catch {
      return undefined;
    }
  }
}

/**
 * Synchronous twin of projection.ts's atomic write. Kept separate on purpose:
 * projection.ts must stay import-free so the test runner can load it directly,
 * and store writes happen on IPC handlers where sync is simpler than a queue.
 */
function writeJsonAtomicSync(targetPath: string, contents: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  // 0o600: server env blocks routinely hold API tokens.
  const fd = openSync(tempPath, "w", 0o600);
  try {
    writeSync(fd, contents, null, "utf8");
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
    throw error;
  }
  closeSync(fd);

  try {
    renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Default instance
// ---------------------------------------------------------------------------

let defaultStore: McpConfigStore | null = null;

/** `<userData>/config/mcp.json` — app-owned, never a user dotfile. */
export function defaultMcpConfigPath(): string {
  return join(app.getPath("userData"), "config", "mcp.json");
}

export function getMcpStore(): McpConfigStore {
  defaultStore ??= new McpConfigStore(defaultMcpConfigPath());
  return defaultStore;
}

export function listServers(): McpServerDefinition[] {
  return getMcpStore().listServers();
}

export function upsertServer(definition: McpServerDefinition): McpServerDefinition {
  return getMcpStore().upsertServer(definition);
}

export function removeServer(id: string): boolean {
  return getMcpStore().removeServer(id);
}

export function setEnabled(id: string, enabled: boolean): boolean {
  return getMcpStore().setEnabled(id, enabled);
}
