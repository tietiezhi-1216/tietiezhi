/**
 * Projects the canonical MCP configuration into each core's native dialect.
 *
 * ACP does not standardise configuration, so "configure once, works in every
 * core" has to be implemented here: one canonical list in, one vendor-shaped
 * file out. See ./README.md for the field mapping and its sources.
 *
 * This module deliberately has no relative imports and no Electron import: the
 * test runner loads it directly with Node's type stripping, which does not
 * resolve extensionless specifiers. Keep it self-contained.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type {
  McpConfigFormat,
  McpServerDefinition,
  ProjectionResult,
} from "@shared/contracts";

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Writes `contents` so a reader never observes a partial file: the data lands
 * in a sibling temp file, is flushed, then replaces the target with a single
 * rename. A crash mid-write leaves the previous config intact.
 */
export async function writeFileAtomic(
  targetPath: string,
  contents: string,
): Promise<void> {
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const tempPath = `${targetPath}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;

  let handle: FileHandle | undefined;
  try {
    // 0o600: projected configs carry API tokens in env/headers.
    handle = await open(tempPath, "w", 0o600);
    await handle.writeFile(contents, "utf8");
    // rename is atomic for readers, but on a crash an unflushed rename can
    // surface a zero-length file on some filesystems.
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await handle.close();

  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Minimal TOML serialiser
// ---------------------------------------------------------------------------

export type TomlValue = string | number | boolean | readonly string[] | TomlTable;

export interface TomlTable {
  readonly [key: string]: TomlValue | undefined;
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

const TOML_ESCAPES: Readonly<Record<string, string>> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

/** Escapes a TOML basic string per the v1.0.0 grammar. */
function escapeTomlString(value: string): string {
  let out = "";
  // Iterating by code point keeps surrogate pairs (emoji) intact.
  for (const char of value) {
    const mapped = TOML_ESCAPES[char];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += char;
  }
  return out;
}

function formatTomlKey(key: string): string {
  return TOML_BARE_KEY.test(key) ? key : `"${escapeTomlString(key)}"`;
}

function isTomlTable(value: TomlValue): value is TomlTable {
  return typeof value === "object" && !Array.isArray(value);
}

function formatTomlScalar(value: string | number | boolean | readonly string[]): string {
  if (typeof value === "string") return `"${escapeTomlString(value)}"`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError(`TOML cannot represent the number ${String(value)}`);
    }
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  return `[${value.map((item) => `"${escapeTomlString(item)}"`).join(", ")}]`;
}

function emitTomlTable(table: TomlTable, path: readonly string[], lines: string[]): void {
  const scalars: Array<[string, string | number | boolean | readonly string[]]> = [];
  const subTables: Array<[string, TomlTable]> = [];

  for (const key of Object.keys(table)) {
    const value = table[key];
    if (value === undefined) continue;
    if (isTomlTable(value)) subTables.push([key, value]);
    else scalars.push([key, value]);
  }

  // A header-less parent is valid when sub-tables spell out the full path;
  // an empty leaf still needs its header to exist at all.
  const needsHeader =
    path.length > 0 && (scalars.length > 0 || subTables.length === 0);
  if (needsHeader) {
    if (lines.length > 0) lines.push("");
    lines.push(`[${path.map(formatTomlKey).join(".")}]`);
  }
  for (const [key, value] of scalars) {
    lines.push(`${formatTomlKey(key)} = ${formatTomlScalar(value)}`);
  }
  for (const [key, value] of subTables) {
    emitTomlTable(value, [...path, key], lines);
  }
}

/** Serialises a table tree of strings, string arrays and nested tables. */
export function stringifyToml(table: TomlTable): string {
  const lines: string[] = [];
  emitTomlTable(table, [], lines);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SkippedServer {
  id: string;
  reason: string;
}

/** Rendered config text plus everything that did not make it in. */
export interface RenderedProjection {
  /** `null` when the format writes no file at all. */
  text: string | null;
  skipped: SkippedServer[];
}

export interface ProjectMcpOptions {
  /** Core id recorded in the result; defaults to the format's usual core. */
  coreId?: string;
}

const DEFAULT_CORE_ID: Readonly<Record<McpConfigFormat, string>> = {
  "claude-json": "claude-code",
  "codex-toml": "codex",
  "gemini-json": "gemini",
  none: "",
};

/**
 * Server names Claude Code reserves for its built-in servers; it refuses to
 * load a user server that shadows one of them.
 */
const CLAUDE_RESERVED_NAMES: readonly string[] = [
  "workspace",
  "claude-in-chrome",
  "computer-use",
  "claude preview",
  "claude browser",
];

interface Selection {
  usable: McpServerDefinition[];
  skipped: SkippedServer[];
}

/**
 * Drops disabled servers silently (they are not failures) and records every
 * other rejection, so the UI can explain why a server is missing from a core
 * instead of the user discovering it at runtime.
 */
function selectProjectable(
  servers: readonly McpServerDefinition[],
  format: McpConfigFormat,
): Selection {
  const usable: McpServerDefinition[] = [];
  const skipped: SkippedServer[] = [];
  const seen = new Set<string>();

  for (const server of servers) {
    if (!server.enabled) continue;

    const id = server.id;
    if (id.trim() === "") {
      skipped.push({ id, reason: "Server id is empty." });
      continue;
    }
    if (seen.has(id)) {
      skipped.push({ id, reason: `Duplicate server id "${id}"; the first definition wins.` });
      continue;
    }

    if (format === "claude-json" && CLAUDE_RESERVED_NAMES.includes(id.toLowerCase())) {
      skipped.push({
        id,
        reason: `Claude Code reserves the server name "${id}" for a built-in server.`,
      });
      continue;
    }

    const transport = server.transport;
    if (transport.type === "stdio") {
      if (transport.command.trim() === "") {
        skipped.push({ id, reason: "stdio transport has an empty command." });
        continue;
      }
    } else {
      const urlError = validateHttpUrl(transport.url);
      if (urlError !== null) {
        skipped.push({ id, reason: urlError });
        continue;
      }
    }

    seen.add(id);
    usable.push(server);
  }

  return { usable, skipped };
}

function validateHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `http transport has a malformed url ${JSON.stringify(raw)}.`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `http transport only supports http(s), got "${parsed.protocol}".`;
  }
  return null;
}

function nonEmptyRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (record === undefined) return undefined;
  return Object.keys(record).length === 0 ? undefined : { ...record };
}

function nonEmptyArgs(args: readonly string[]): string[] | undefined {
  return args.length === 0 ? undefined : [...args];
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

type ClaudeEntry =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

type GeminiEntry =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { httpUrl: string; headers?: Record<string, string> };

function renderClaudeEntries(
  servers: readonly McpServerDefinition[],
): Record<string, ClaudeEntry> {
  const entries: Record<string, ClaudeEntry> = {};
  for (const server of servers) {
    const transport = server.transport;
    entries[server.id] =
      transport.type === "stdio"
        ? {
            type: "stdio",
            command: transport.command,
            args: nonEmptyArgs(transport.args),
            env: nonEmptyRecord(transport.env),
          }
        : {
            // An entry with a url but no type is a hard error in Claude Code.
            type: "http",
            url: transport.url,
            headers: nonEmptyRecord(transport.headers),
          };
  }
  return entries;
}

function renderGeminiEntries(
  servers: readonly McpServerDefinition[],
): Record<string, GeminiEntry> {
  const entries: Record<string, GeminiEntry> = {};
  for (const server of servers) {
    const transport = server.transport;
    entries[server.id] =
      transport.type === "stdio"
        ? {
            command: transport.command,
            args: nonEmptyArgs(transport.args),
            env: nonEmptyRecord(transport.env),
          }
        : {
            // `url` would select the legacy SSE transport; `httpUrl` selects
            // streamable HTTP, which is what our canonical http type means.
            httpUrl: transport.url,
            headers: nonEmptyRecord(transport.headers),
          };
  }
  return entries;
}

function renderCodexDocument(servers: readonly McpServerDefinition[]): TomlTable {
  const mcpServers: Record<string, TomlTable> = {};
  for (const server of servers) {
    const transport = server.transport;
    mcpServers[server.id] =
      transport.type === "stdio"
        ? {
            command: transport.command,
            args: nonEmptyArgs(transport.args),
            env: nonEmptyRecord(transport.env),
          }
        : {
            url: transport.url,
            http_headers: nonEmptyRecord(transport.headers),
          };
  }
  return { mcp_servers: mcpServers };
}

/**
 * Replaces only the `mcpServers` key, so state the core itself writes into the
 * same file (Claude Code's project list, Gemini's UI settings) survives a
 * re-projection.
 */
function mergeIntoExistingJson(
  existingText: string | null,
  mcpServers: Record<string, unknown>,
): string {
  let root: Record<string, unknown> = {};
  if (existingText !== null && existingText.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(existingText);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // An unparsable target is ours to regenerate; the core would reject it too.
    }
  }
  root["mcpServers"] = mcpServers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

const CODEX_HEADER = [
  "# Generated by Tietiezhi from the canonical MCP configuration.",
  "# Edits are overwritten on the next projection.",
].join("\n");

/**
 * Pure rendering half of {@link projectMcp}. `existingText` is the current
 * content of the target file, used to preserve unrelated keys in JSON dialects.
 */
export function renderMcpConfig(
  servers: readonly McpServerDefinition[],
  format: McpConfigFormat,
  existingText: string | null = null,
): RenderedProjection {
  if (format === "none") {
    return {
      text: null,
      skipped: servers
        .filter((server) => server.enabled)
        .map((server) => ({
          id: server.id,
          reason: "This core does not read a projected MCP config.",
        })),
    };
  }

  const { usable, skipped } = selectProjectable(servers, format);

  switch (format) {
    case "claude-json":
      return { text: mergeIntoExistingJson(existingText, renderClaudeEntries(usable)), skipped };
    case "gemini-json":
      return { text: mergeIntoExistingJson(existingText, renderGeminiEntries(usable)), skipped };
    case "codex-toml": {
      const body = stringifyToml(renderCodexDocument(usable));
      return { text: `${CODEX_HEADER}\n${body === "" ? "" : `\n${body}`}`, skipped };
    }
    default: {
      const exhaustive: never = format;
      throw new TypeError(`Unknown MCP config format: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Writes the canonical servers into `targetPath` in `format`'s dialect.
 *
 * `targetPath` must be inside the app-managed config directory — never a real
 * user dotfile. Callers point the core at that directory with its own env var
 * (CLAUDE_CONFIG_DIR, CODEX_HOME, ...).
 */
export async function projectMcp(
  servers: readonly McpServerDefinition[],
  format: McpConfigFormat,
  targetPath: string,
  options: ProjectMcpOptions = {},
): Promise<ProjectionResult> {
  const coreId = options.coreId ?? DEFAULT_CORE_ID[format];

  if (format === "none") {
    const { skipped } = renderMcpConfig(servers, format);
    return { coreId, format, path: "", skipped };
  }

  if (!isAbsolute(targetPath)) {
    throw new TypeError(`Projection target must be an absolute path, got ${JSON.stringify(targetPath)}`);
  }

  let existingText: string | null = null;
  if (format === "claude-json" || format === "gemini-json") {
    existingText = await readFile(targetPath, "utf8").catch(() => null);
  }

  const rendered = renderMcpConfig(servers, format, existingText);
  if (rendered.text === null) {
    return { coreId, format, path: "", skipped: rendered.skipped };
  }

  await writeFileAtomic(targetPath, rendered.text);
  return { coreId, format, path: targetPath, skipped: rendered.skipped };
}
