/**
 * Bridges the settings UI's MCP list and the canonical store the cores read.
 *
 * These were two disjoint stores: the settings dialog round-tripped
 * `settings.json.mcpServers` through load_settings/save_settings, while core
 * config projection read `<userData>/config/mcp.json`. A server the user added
 * therefore never reached any core — which is the product's whole premise
 * ("configure once, works on every core").
 *
 * The canonical store is now the single source of truth. `settings.json` keeps
 * a mirror so the Tauri build, which is still shipping during the migration,
 * continues to see the same list.
 *
 * The two sides also disagree on the transport discriminant: the frontend type
 * uses `kind`, the canonical definition uses `type`. Everything crossing this
 * boundary has to be converted, not passed through.
 */

import type { McpServerDefinition } from "@shared/contracts";

import { broadcastEvent } from "../bridge/index.js";
import { listServers, upsertServer, removeServer } from "../config/store.js";
import { projectCoreConfig } from "../core-launcher.js";
import { getCoreProcessManager } from "../cores/process.js";
import { listCores } from "../cores/registry.js";

/** Transport shape used by `desktop/src/lib/api.ts`. */
type FrontendTransport =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { kind: "http"; url: string; headers: Record<string, string> };

interface FrontendMcpServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: FrontendTransport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Frontend shape -> canonical. Returns null for anything unusable. */
export function toCanonical(value: unknown): McpServerDefinition | null {
  if (!isRecord(value)) return null;
  const id = typeof value["id"] === "string" ? value["id"] : "";
  if (id === "") return null;
  const name = typeof value["name"] === "string" ? value["name"] : id;
  const enabled = value["enabled"] !== false;
  const transport = value["transport"];
  if (!isRecord(transport)) return null;

  // Accept either discriminant on the way in: older settings.json documents
  // written by the Tauri build use `kind`, and a round-trip through the
  // canonical store yields `type`.
  const discriminant = transport["kind"] ?? transport["type"];
  if (discriminant === "stdio") {
    const command = typeof transport["command"] === "string" ? transport["command"] : "";
    if (command === "") return null;
    return {
      id,
      name,
      enabled,
      transport: {
        type: "stdio",
        command,
        args: stringArray(transport["args"]),
        env: stringRecord(transport["env"]),
      },
    };
  }
  if (discriminant === "http") {
    const url = typeof transport["url"] === "string" ? transport["url"] : "";
    if (url === "") return null;
    return {
      id,
      name,
      enabled,
      transport: { type: "http", url, headers: stringRecord(transport["headers"]) },
    };
  }
  return null;
}

/** Canonical -> frontend shape. */
export function fromCanonical(definition: McpServerDefinition): FrontendMcpServer {
  const base = { id: definition.id, name: definition.name, enabled: definition.enabled };
  if (definition.transport.type === "stdio") {
    return {
      ...base,
      transport: {
        kind: "stdio",
        command: definition.transport.command,
        args: definition.transport.args,
        env: definition.transport.env ?? {},
      },
    };
  }
  return {
    ...base,
    transport: {
      kind: "http",
      url: definition.transport.url,
      headers: definition.transport.headers ?? {},
    },
  };
}

/** The list `load_settings` should report, read from the canonical store. */
export function mcpServersForSettings(): FrontendMcpServer[] {
  return listServers().map(fromCanonical);
}

/**
 * Applies the settings dialog's list to the canonical store.
 *
 * Returns the ids that changed so the caller can decide whether to re-project
 * and which cores need restarting — every supported CLI reads its config only
 * at startup.
 */
export async function applyMcpServersFromSettings(
  value: unknown,
): Promise<{ changed: boolean; skipped: string[] }> {
  if (!Array.isArray(value)) return { changed: false, skipped: [] };

  const incoming: McpServerDefinition[] = [];
  const skipped: string[] = [];
  for (const entry of value) {
    const definition = toCanonical(entry);
    if (definition) incoming.push(definition);
    else if (isRecord(entry) && typeof entry["id"] === "string") skipped.push(entry["id"]);
  }

  const before = listServers();
  const incomingIds = new Set(incoming.map((server) => server.id));
  let changed = false;

  // Deletions first: an id reused with a different transport in the same save
  // must not see the stale definition.
  for (const existing of before) {
    if (!incomingIds.has(existing.id)) {
      if (removeServer(existing.id)) changed = true;
    }
  }
  for (const definition of incoming) {
    const existing = before.find((server) => server.id === definition.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(definition)) continue;
    upsertServer(definition);
    changed = true;
  }

  return { changed, skipped };
}

/**
 * Re-projects the canonical list into every core's own dialect and tells the
 * renderer which running cores are now stale.
 *
 * Projection failures are reported rather than thrown: one unwritable core
 * config must not fail the user's save.
 */
export async function onMcpServersChanged(): Promise<void> {
  const cores = listCores();
  const results = await Promise.allSettled(cores.map((core) => projectCoreConfig(core.id)));
  const failed = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ coreId: cores[index]?.id ?? "", reason: String(result.reason) }]
      : [],
  );
  broadcastEvent("mcp://projected", {
    failed,
    // Every supported CLI reads its config at startup only, so a running core
    // keeps the old set until it is restarted.
    restartRequired: getCoreProcessManager().runningCoreIds(),
  });
}

/**
 * One-time adoption of a pre-existing `settings.json.mcpServers` list.
 *
 * Only runs while the canonical store is empty, so it can never clobber
 * servers the user configured through the new path.
 */
export async function adoptLegacyMcpServers(value: unknown): Promise<number> {
  if (!Array.isArray(value) || value.length === 0) return 0;
  if (listServers().length > 0) return 0;
  let adopted = 0;
  for (const entry of value) {
    const definition = toCanonical(entry);
    if (!definition) continue;
    upsertServer(definition);
    adopted += 1;
  }
  return adopted;
}
