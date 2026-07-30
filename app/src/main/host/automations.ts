/**
 * Automation workflows — the Electron port of `commands/automations.rs` and the
 * `automation::{model,store,validate,runtime}` modules behind it.
 *
 * Storage layout is byte-compatible with the Tauri build, because users already
 * have workflows on disk:
 *
 *   <userData>/automations/index.json                  { version, automations[] }
 *   <userData>/automations/<id>/draft.json             the editable document
 *   <userData>/automations/<id>/published.json         snapshot taken at publish
 *   <userData>/automations/<id>/runs/<runId>.json      one record per run
 *   <userData>/automations/<id>/runs/<runId>/workspace  managed run workspace
 *
 * Two deliberate departures from the Rust original:
 *
 * - Execution. The Tauri build handed the whole published workflow to a Codex
 *   thread (`launch_automation_turn`) and polled that thread for completion. The
 *   host does not own agent threads, so the same prompt is handed to an
 *   injectable {@link AutomationRunner}; the built-in runner drives the user's
 *   configured chat provider directly. Whoever wires an ACP core into the host
 *   replaces it with {@link setAutomationRunner} instead of editing this file.
 * - Node-level semantics stay out of here on purpose. The Rust build never
 *   interpreted `condition`/`merge`/`code` nodes either — it described them to
 *   the model — so inventing an interpreter here would invent behaviour the
 *   user's saved workflows were never authored against.
 *
 * Secrets referenced by `secretRef` bindings are deliberately *not* resolved
 * into the prompt: the prompt is sent to a model provider, and a credential in
 * it would leave the machine. Only their presence is reported, as a warning.
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { app, type WebContents } from "electron";

import {
  broadcastEvent,
  closeChannel,
  emitChannel,
  parseChannelId,
  registerCommands,
  requireInvocation,
} from "../bridge/index.js";
import { dataPath, writeJsonAtomic } from "./paths.js";
import { providerHttpError, readSettings, resolveProvider } from "./settings.js";
import type { ResolvedProvider } from "./settings.js";
import { effectiveWireApi } from "./settings-models.js";
import type { ModelWireApi } from "./settings-models.js";
import { getSecret } from "./settings-secrets.js";

// ---------------------------------------------------------------------------
// Shapes (serde `rename_all = "camelCase"`; must match desktop/src/lib/api.ts)
// ---------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ValueBinding =
  | { kind: "literal"; value: JsonValue }
  | { kind: "triggerInput"; path: string }
  | { kind: "nodeOutput"; nodeId: string; path: string }
  | { kind: "secretRef"; credentialId: string; key: string };

export interface AutomationPosition {
  x: number;
  y: number;
}

export interface AutomationNode {
  id: string;
  type: string;
  typeVersion: number;
  name: string;
  position: AutomationPosition;
  disabled: boolean;
  /**
   * `serde_json::Value` in Rust, not a map: `validate` reports a non-object as
   * `invalid_node_config`, so the parser must be able to carry one through.
   */
  config: JsonValue;
  inputs: Record<string, ValueBinding>;
}

export interface AutomationEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

export type MissedSchedulePolicy = "skip" | "runLatest";

export interface AutomationSettings {
  timezone: string;
  maxDurationMs: number;
  maxConcurrency: number;
  onMissedSchedule: MissedSchedulePolicy;
  projectRoot: string | null;
}

export interface AutomationDocument {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  revision: number;
  nodes: AutomationNode[];
  edges: AutomationEdge[];
  settings: AutomationSettings;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationMeta {
  id: string;
  name: string;
  description: string;
  revision: number;
  nodeCount: number;
  triggerType: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number;
  publishedRevision: number;
  paused: boolean;
  lastRunAt: number;
  nextRunAt: number;
  lastRunStatus: string;
}

export type AutomationRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AutomationRun {
  id: string;
  automationId: string;
  revision: number;
  trigger: string;
  status: AutomationRunStatus;
  input: JsonValue;
  threadId: string;
  turnId: string;
  workspacePath: string;
  startedAt: number;
  finishedAt: number;
  output: string | null;
  error: string | null;
}

export interface AutomationValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

interface AutomationIndex {
  version: number;
  automations: AutomationMeta[];
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function nowMs(): number {
  return Date.now();
}

/** Code points, like Rust's `chars().count()` — not UTF-16 units. */
function charCount(value: string): number {
  return [...value].length;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

// ---------------------------------------------------------------------------
// Argument coercion
// ---------------------------------------------------------------------------

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`参数 ${key} 必须是字符串`);
  return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`参数 ${key} 必须是字符串`);
  return value;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") throw new Error(`参数 ${key} 必须是布尔值`);
  return value;
}

function optionalBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`参数 ${key} 必须是布尔值`);
  return value;
}

function optionalCountArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`参数 ${key} 必须是非负整数`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// JSON coercion
// ---------------------------------------------------------------------------

function fieldError(path: string, expectation: string): Error {
  return new Error(`Automation 字段 ${path} ${expectation}`);
}

/**
 * Structured-clone values reach handlers with types JSON cannot hold. Rejecting
 * them beats silently rewriting them: a `config` that round-trips to something
 * different is a workflow that stops doing what its author saw in the editor.
 */
function toJsonValue(value: unknown, path: string): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw fieldError(path, "不是合法的 JSON 数值");
      return value;
    case "object":
      break;
    default:
      throw fieldError(path, "不是合法的 JSON 值");
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toJsonValue(item, `${path}[${index}]`));
  }
  if (!isRecord(value)) throw fieldError(path, "不是合法的 JSON 值");
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    // `JSON.stringify` drops undefined entries; mirror that rather than fail.
    if (item === undefined) continue;
    out[key] = toJsonValue(item, `${path}.${key}`);
  }
  return out;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw fieldError(path, "必须是对象");
  return value;
}

function requireString(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string") throw fieldError(`${path}${key}`, "必须是字符串");
  return value;
}

function requireNumber(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== "number") throw fieldError(`${path}${key}`, "必须是数字");
  return value;
}

/** Rust's unsigned integer fields: a fraction or a negative is a parse error. */
function requireUint(source: Record<string, unknown>, key: string, path: string): number {
  const value = requireNumber(source, key, path);
  if (!Number.isInteger(value) || value < 0) throw fieldError(`${path}${key}`, "必须是非负整数");
  return value;
}

function requireBoolean(source: Record<string, unknown>, key: string, path: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") throw fieldError(`${path}${key}`, "必须是布尔值");
  return value;
}

function requireArray(source: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw fieldError(`${path}${key}`, "必须是数组");
  return value;
}

function optionalString(source: Record<string, unknown>, key: string, path: string): string | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw fieldError(`${path}${key}`, "必须是字符串");
  return value;
}

function uintField(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return fallback;
  return value;
}

// ---------------------------------------------------------------------------
// Parsing (mirrors what serde accepts, with locatable Chinese errors)
// ---------------------------------------------------------------------------

function parseBinding(value: unknown, path: string): ValueBinding {
  const record = requireRecord(value, path);
  const kind = requireString(record, "kind", `${path}.`);
  switch (kind) {
    case "literal": {
      if (!("value" in record)) throw fieldError(`${path}.value`, "不能缺失");
      return { kind: "literal", value: toJsonValue(record["value"], `${path}.value`) };
    }
    case "triggerInput":
      return { kind: "triggerInput", path: requireString(record, "path", `${path}.`) };
    case "nodeOutput":
      return {
        kind: "nodeOutput",
        nodeId: requireString(record, "nodeId", `${path}.`),
        path: requireString(record, "path", `${path}.`),
      };
    case "secretRef":
      return {
        kind: "secretRef",
        credentialId: requireString(record, "credentialId", `${path}.`),
        // `#[serde(default)]`: an absent key is the empty string.
        key: optionalString(record, "key", `${path}.`) ?? "",
      };
    default:
      throw fieldError(`${path}.kind`, `不是受支持的绑定类型：${kind}`);
  }
}

function parseNode(value: unknown, path: string): AutomationNode {
  const record = requireRecord(value, path);
  const position = requireRecord(record["position"], `${path}.position`);
  const inputsRaw = record["inputs"];
  const inputs: Record<string, ValueBinding> = {};
  if (inputsRaw !== undefined && inputsRaw !== null) {
    const map = requireRecord(inputsRaw, `${path}.inputs`);
    for (const key of Object.keys(map)) {
      inputs[key] = parseBinding(map[key], `${path}.inputs.${key}`);
    }
  } else {
    throw fieldError(`${path}.inputs`, "必须是对象");
  }
  return {
    id: requireString(record, "id", `${path}.`),
    type: requireString(record, "type", `${path}.`),
    typeVersion: requireUint(record, "typeVersion", `${path}.`),
    name: requireString(record, "name", `${path}.`),
    position: {
      x: requireNumber(position, "x", `${path}.position.`),
      y: requireNumber(position, "y", `${path}.position.`),
    },
    disabled: requireBoolean(record, "disabled", `${path}.`),
    config: "config" in record ? toJsonValue(record["config"], `${path}.config`) : {},
    inputs,
  };
}

function parseEdge(value: unknown, path: string): AutomationEdge {
  const record = requireRecord(value, path);
  return {
    id: requireString(record, "id", `${path}.`),
    sourceNodeId: requireString(record, "sourceNodeId", `${path}.`),
    sourcePort: requireString(record, "sourcePort", `${path}.`),
    targetNodeId: requireString(record, "targetNodeId", `${path}.`),
    targetPort: requireString(record, "targetPort", `${path}.`),
  };
}

function parseSettings(value: unknown, path: string): AutomationSettings {
  const record = requireRecord(value, path);
  const policy = requireString(record, "onMissedSchedule", `${path}.`);
  if (policy !== "skip" && policy !== "runLatest") {
    throw fieldError(`${path}.onMissedSchedule`, "只能是 skip 或 runLatest");
  }
  return {
    timezone: requireString(record, "timezone", `${path}.`),
    maxDurationMs: requireUint(record, "maxDurationMs", `${path}.`),
    maxConcurrency: requireUint(record, "maxConcurrency", `${path}.`),
    onMissedSchedule: policy,
    projectRoot: optionalString(record, "projectRoot", `${path}.`),
  };
}

export function parseAutomationDocument(value: unknown): AutomationDocument {
  const record = requireRecord(value, "automation");
  return {
    schemaVersion: requireUint(record, "schemaVersion", ""),
    id: requireString(record, "id", ""),
    name: requireString(record, "name", ""),
    description: requireString(record, "description", ""),
    revision: requireUint(record, "revision", ""),
    nodes: requireArray(record, "nodes", "").map((node, index) => parseNode(node, `nodes[${index}]`)),
    edges: requireArray(record, "edges", "").map((edge, index) => parseEdge(edge, `edges[${index}]`)),
    settings: parseSettings(record["settings"], "settings"),
    createdAt: requireUint(record, "createdAt", ""),
    updatedAt: requireUint(record, "updatedAt", ""),
  };
}

function parseMeta(value: unknown, path: string): AutomationMeta {
  const record = requireRecord(value, path);
  const paused = record["paused"];
  return {
    id: requireString(record, "id", `${path}.`),
    name: requireString(record, "name", `${path}.`),
    description: requireString(record, "description", `${path}.`),
    revision: requireUint(record, "revision", `${path}.`),
    nodeCount: requireUint(record, "nodeCount", `${path}.`),
    triggerType: requireString(record, "triggerType", `${path}.`),
    createdAt: requireUint(record, "createdAt", `${path}.`),
    updatedAt: requireUint(record, "updatedAt", `${path}.`),
    archivedAt: uintField(record, "archivedAt", 0),
    publishedRevision: uintField(record, "publishedRevision", 0),
    // `#[serde(default = "default_paused")]`: an absent flag means paused.
    paused: typeof paused === "boolean" ? paused : true,
    lastRunAt: uintField(record, "lastRunAt", 0),
    nextRunAt: uintField(record, "nextRunAt", 0),
    lastRunStatus: optionalString(record, "lastRunStatus", `${path}.`) ?? "",
  };
}

function parseIndex(value: unknown): AutomationIndex {
  const record = requireRecord(value, "index");
  const rawList = record["automations"];
  const list = rawList === undefined || rawList === null ? [] : rawList;
  if (!Array.isArray(list)) throw fieldError("automations", "必须是数组");
  return {
    version: uintField(record, "version", 1),
    automations: list.map((item, index) => parseMeta(item, `automations[${index}]`)),
  };
}

function parseRunStatus(value: unknown, path: string): AutomationRunStatus {
  switch (value) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      throw fieldError(path, "不是受支持的运行状态");
  }
}

function parseRun(value: unknown): AutomationRun {
  const record = requireRecord(value, "run");
  return {
    id: requireString(record, "id", ""),
    automationId: requireString(record, "automationId", ""),
    revision: requireUint(record, "revision", ""),
    trigger: requireString(record, "trigger", ""),
    status: parseRunStatus(record["status"], "status"),
    input: "input" in record ? toJsonValue(record["input"], "input") : {},
    threadId: requireString(record, "threadId", ""),
    turnId: requireString(record, "turnId", ""),
    workspacePath: requireString(record, "workspacePath", ""),
    startedAt: requireUint(record, "startedAt", ""),
    finishedAt: requireUint(record, "finishedAt", ""),
    output: optionalString(record, "output", ""),
    error: optionalString(record, "error", ""),
  };
}

// ---------------------------------------------------------------------------
// Serialization (field order and omissions follow the Rust structs)
// ---------------------------------------------------------------------------

function serializeBinding(binding: ValueBinding): JsonValue {
  switch (binding.kind) {
    case "literal":
      return { kind: "literal", value: binding.value };
    case "triggerInput":
      return { kind: "triggerInput", path: binding.path };
    case "nodeOutput":
      return { kind: "nodeOutput", nodeId: binding.nodeId, path: binding.path };
    case "secretRef":
      // `skip_serializing_if = "String::is_empty"` on `key`.
      return binding.key === ""
        ? { kind: "secretRef", credentialId: binding.credentialId }
        : { kind: "secretRef", credentialId: binding.credentialId, key: binding.key };
  }
}

function serializeNode(node: AutomationNode): JsonValue {
  const inputs: Record<string, JsonValue> = {};
  // Rust holds `inputs` in a `BTreeMap`, so the file is written key-sorted.
  for (const key of Object.keys(node.inputs).sort()) {
    const binding = node.inputs[key];
    if (binding) inputs[key] = serializeBinding(binding);
  }
  return {
    id: node.id,
    type: node.type,
    typeVersion: node.typeVersion,
    name: node.name,
    position: { x: node.position.x, y: node.position.y },
    disabled: node.disabled,
    config: node.config,
    inputs,
  };
}

function serializeDocument(document: AutomationDocument): JsonValue {
  return {
    schemaVersion: document.schemaVersion,
    id: document.id,
    name: document.name,
    description: document.description,
    revision: document.revision,
    nodes: document.nodes.map(serializeNode),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      sourcePort: edge.sourcePort,
      targetNodeId: edge.targetNodeId,
      targetPort: edge.targetPort,
    })),
    settings: {
      timezone: document.settings.timezone,
      maxDurationMs: document.settings.maxDurationMs,
      maxConcurrency: document.settings.maxConcurrency,
      onMissedSchedule: document.settings.onMissedSchedule,
      projectRoot: document.settings.projectRoot,
    },
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function serializeMeta(meta: AutomationMeta): JsonValue {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    revision: meta.revision,
    nodeCount: meta.nodeCount,
    triggerType: meta.triggerType,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    archivedAt: meta.archivedAt,
    publishedRevision: meta.publishedRevision,
    paused: meta.paused,
    lastRunAt: meta.lastRunAt,
    nextRunAt: meta.nextRunAt,
    lastRunStatus: meta.lastRunStatus,
  };
}

function serializeRun(run: AutomationRun): JsonValue {
  return {
    id: run.id,
    automationId: run.automationId,
    revision: run.revision,
    trigger: run.trigger,
    status: run.status,
    input: run.input,
    threadId: run.threadId,
    turnId: run.turnId,
    workspacePath: run.workspacePath,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    output: run.output,
    error: run.error,
  };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const UUID_HYPHENATED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_SIMPLE = /^[0-9a-fA-F]{32}$/;

function isUuid(value: string): boolean {
  return UUID_HYPHENATED.test(value) || UUID_SIMPLE.test(value);
}

/**
 * Ids become path segments, so this is the traversal guard as much as a format
 * check: nothing matching the UUID shape can contain `/`, `\` or `..`.
 */
function assertId(id: string): void {
  if (!isUuid(id)) throw new Error("Automation ID 无效");
}

function automationsRoot(): string {
  return dataPath("automations");
}

function indexPath(): string {
  return join(automationsRoot(), "index.json");
}

function draftPath(id: string): string {
  assertId(id);
  return join(automationsRoot(), id, "draft.json");
}

function publishedPath(id: string): string {
  assertId(id);
  return join(automationsRoot(), id, "published.json");
}

function runsRoot(automationId: string): string {
  assertId(automationId);
  return join(automationsRoot(), automationId, "runs");
}

function runPath(automationId: string, runId: string): string {
  assertId(runId);
  return join(runsRoot(automationId), `${runId}.json`);
}

function runWorkspacePath(automationId: string, runId: string): string {
  assertId(automationId);
  assertId(runId);
  return join(automationsRoot(), automationId, "runs", runId, "workspace");
}

// ---------------------------------------------------------------------------
// Store: one queue for every read-modify-write
// ---------------------------------------------------------------------------

/**
 * The Rust build guarded the whole store with a single mutex. The same applies
 * here for the same reason: `index.json` is rewritten from a snapshot, so two
 * interleaved mutations lose one of them — a freshly created automation that
 * vanishes, or a `paused` flag that springs back.
 *
 * Every entry point below wraps *one* `withStore` call and only ever calls the
 * `…Unlocked` helpers from inside it. Nesting `withStore` would deadlock.
 */
let storeQueue: Promise<unknown> = Promise.resolve();

function withStore<T>(task: () => Promise<T>): Promise<T> {
  const next = storeQueue.then(task, task);
  // Keep the chain alive after a rejection so one failure cannot wedge it.
  storeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readIndexUnlocked(): Promise<AutomationIndex> {
  let raw: string;
  try {
    raw = await readFile(indexPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, automations: [] };
    }
    throw new Error(`读取自动化列表失败：${messageOf(error)}`);
  }
  // Deliberately not `readJson(path, fallback)`: falling back to an empty index
  // on a corrupt file would rewrite it on the next mutation and erase every
  // automation the user has.
  try {
    return parseIndex(JSON.parse(raw));
  } catch (error) {
    throw new Error(`自动化列表文件损坏：${messageOf(error)}`);
  }
}

async function writeIndexUnlocked(index: AutomationIndex): Promise<void> {
  try {
    await writeJsonAtomic(indexPath(), {
      version: index.version,
      automations: index.automations.map(serializeMeta),
    });
  } catch (error) {
    throw new Error(`保存自动化失败：${messageOf(error)}`);
  }
}

async function readDocumentUnlocked(path: string, corruptPrefix: string): Promise<AutomationDocument> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Automation 不存在或已被删除");
    }
    throw new Error(`读取 Automation 失败：${messageOf(error)}`);
  }
  try {
    return parseAutomationDocument(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${corruptPrefix}${messageOf(error)}`);
  }
}

async function writeDocumentUnlocked(path: string, document: AutomationDocument): Promise<void> {
  try {
    await writeJsonAtomic(path, serializeDocument(document));
  } catch (error) {
    throw new Error(`保存自动化失败：${messageOf(error)}`);
  }
}

async function readRunUnlocked(path: string): Promise<AutomationRun> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`读取运行记录失败：${messageOf(error)}`);
  }
  try {
    return parseRun(JSON.parse(raw));
  } catch (error) {
    throw new Error(`运行记录损坏：${messageOf(error)}`);
  }
}

async function writeRunUnlocked(run: AutomationRun): Promise<void> {
  try {
    await writeJsonAtomic(runPath(run.automationId, run.id), serializeRun(run));
  } catch (error) {
    throw new Error(`保存运行记录失败：${messageOf(error)}`);
  }
}

function metaFromDocument(document: AutomationDocument, existing: AutomationMeta | null): AutomationMeta {
  const trigger = document.nodes.find(
    (node) => node.type === "manualTrigger" || node.type === "scheduleTrigger",
  );
  return {
    id: document.id,
    name: document.name,
    description: document.description,
    revision: document.revision,
    nodeCount: document.nodes.length,
    triggerType: trigger?.type ?? "",
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    archivedAt: existing?.archivedAt ?? 0,
    publishedRevision: existing?.publishedRevision ?? 0,
    paused: existing?.paused ?? true,
    lastRunAt: existing?.lastRunAt ?? 0,
    nextRunAt: existing?.nextRunAt ?? 0,
    lastRunStatus: existing?.lastRunStatus ?? "",
  };
}

function normalizedName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "未命名自动化";
  if (charCount(trimmed) > 80) throw new Error("名称不能超过 80 个字符");
  return trimmed;
}

const RUN_SCAN_LIMIT = 500;

function isActiveStatus(status: AutomationRunStatus): boolean {
  return status === "queued" || status === "running";
}

// --- store entry points ----------------------------------------------------

function storeList(includeArchived: boolean): Promise<AutomationMeta[]> {
  return withStore(async () => {
    const items = (await readIndexUnlocked()).automations.filter(
      (item) => includeArchived || item.archivedAt === 0,
    );
    // `sort_by_key(Reverse(updated_at))` — a stable descending sort.
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items;
  });
}

function storeLoad(id: string): Promise<AutomationDocument> {
  return withStore(() => readDocumentUnlocked(draftPath(id), "Automation 草稿损坏："));
}

function storeLoadPublished(id: string): Promise<AutomationDocument> {
  return withStore(async () => {
    const path = publishedPath(id);
    try {
      await stat(path);
    } catch {
      throw new Error("Automation 尚未发布");
    }
    return readDocumentUnlocked(path, "Automation 发布版本损坏：");
  });
}

function storeCreate(rawName: string): Promise<AutomationDocument> {
  const name = normalizedName(rawName);
  return withStore(async () => {
    const timestamp = nowMs();
    const id = randomUUID();
    const document: AutomationDocument = {
      schemaVersion: 1,
      id,
      name,
      description: "",
      revision: 0,
      nodes: [
        {
          id: randomUUID(),
          type: "manualTrigger",
          typeVersion: 1,
          name: "手动触发",
          position: { x: 96, y: 180 },
          disabled: false,
          config: {},
          inputs: {},
        },
      ],
      edges: [],
      settings: {
        timezone: "Asia/Shanghai",
        maxDurationMs: 300_000,
        maxConcurrency: 4,
        onMissedSchedule: "skip",
        projectRoot: null,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await writeDocumentUnlocked(draftPath(id), document);

    const index = await readIndexUnlocked();
    index.version = 1;
    index.automations.push(metaFromDocument(document, null));
    try {
      await writeIndexUnlocked(index);
    } catch (error) {
      // An automation the index does not know about is unreachable; roll back.
      await rm(join(automationsRoot(), id), { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return document;
  });
}

function storeSave(input: AutomationDocument): Promise<AutomationDocument> {
  assertId(input.id);
  const name = normalizedName(input.name);
  return withStore(async () => {
    const path = draftPath(input.id);
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      throw new Error("Automation 不存在或已被删除");
    }
    const document: AutomationDocument = { ...input, name };
    const issues = await validateDocument(document, false);
    const first = issues[0];
    if (first) throw new Error(first.message);

    const index = await readIndexUnlocked();
    const existing = index.automations.find((item) => item.id === document.id);
    if (!existing) throw new Error("自动化索引与草稿不一致");
    document.createdAt = existing.createdAt;
    document.updatedAt = nowMs();
    await writeDocumentUnlocked(path, document);
    const slot = index.automations.findIndex((item) => item.id === document.id);
    if (slot >= 0) index.automations[slot] = metaFromDocument(document, existing);
    await writeIndexUnlocked(index);
    return document;
  });
}

function storeArchive(id: string, archived: boolean): Promise<AutomationMeta> {
  assertId(id);
  return withStore(async () => {
    const index = await readIndexUnlocked();
    const item = index.automations.find((entry) => entry.id === id);
    if (!item) throw new Error("Automation 不存在或已被删除");
    item.archivedAt = archived ? nowMs() : 0;
    await writeIndexUnlocked(index);
    return { ...item };
  });
}

function storeDelete(id: string): Promise<null> {
  assertId(id);
  return withStore(async () => {
    const index = await readIndexUnlocked();
    if (!index.automations.some((item) => item.id === id)) {
      throw new Error("Automation 不存在或已被删除");
    }
    index.automations = index.automations.filter((item) => item.id !== id);
    await writeIndexUnlocked(index);
    try {
      await rm(join(automationsRoot(), id), { recursive: true, force: true });
    } catch (error) {
      throw new Error(`删除 Automation 文件失败：${messageOf(error)}`);
    }
    return null;
  });
}

function storePublish(id: string, nextRunAt: number): Promise<AutomationMeta> {
  return withStore(async () => {
    const document = await readDocumentUnlocked(draftPath(id), "Automation 草稿损坏：");
    const issues = await validateDocument(document, true);
    const first = issues[0];
    if (first) throw new Error(first.message);
    const index = await readIndexUnlocked();
    const slot = index.automations.findIndex((item) => item.id === id);
    const existing = index.automations[slot];
    if (!existing) throw new Error("Automation 不存在或已被删除");
    document.revision = Math.max(document.revision + 1, 1);
    document.updatedAt = nowMs();
    await writeDocumentUnlocked(draftPath(id), document);
    await writeDocumentUnlocked(publishedPath(id), document);
    const meta = metaFromDocument(document, existing);
    meta.publishedRevision = document.revision;
    meta.paused = false;
    meta.nextRunAt = nextRunAt;
    index.automations[slot] = meta;
    await writeIndexUnlocked(index);
    return { ...meta };
  });
}

function storeSetPaused(id: string, paused: boolean, nextRunAt: number): Promise<AutomationMeta> {
  assertId(id);
  return withStore(async () => {
    const index = await readIndexUnlocked();
    const item = index.automations.find((entry) => entry.id === id);
    if (!item) throw new Error("Automation 不存在或已被删除");
    if (item.publishedRevision === 0) throw new Error("Automation 尚未发布");
    item.paused = paused;
    item.nextRunAt = paused ? 0 : nextRunAt;
    await writeIndexUnlocked(index);
    return { ...item };
  });
}

function storeSaveRun(run: AutomationRun): Promise<null> {
  return withStore(async () => {
    const index = await readIndexUnlocked();
    if (!index.automations.some((item) => item.id === run.automationId)) {
      throw new Error("Automation 不存在或已被删除");
    }
    await writeRunUnlocked(run);
    return null;
  });
}

function storeLoadRun(automationId: string, runId: string): Promise<AutomationRun> {
  return withStore(() => readRunUnlocked(runPath(automationId, runId)));
}

function storeListRuns(automationId: string | undefined, limit: number): Promise<AutomationRun[]> {
  if (automationId !== undefined) assertId(automationId);
  return withStore(async () => {
    const index = await readIndexUnlocked();
    const ids = index.automations
      .filter((item) => automationId === undefined || item.id === automationId)
      .map((item) => item.id);
    const runs: AutomationRun[] = [];
    for (const id of ids) {
      let entries;
      try {
        entries = await readdir(runsRoot(id), { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(`读取运行记录目录失败：${messageOf(error)}`);
      }
      for (const entry of entries) {
        if (!entry.name.endsWith(".json")) continue;
        try {
          runs.push(await readRunUnlocked(join(runsRoot(id), entry.name)));
        } catch {
          // A single corrupt record must not hide the rest of the history.
        }
      }
    }
    runs.sort((a, b) => b.startedAt - a.startedAt);
    return runs.slice(0, Math.min(Math.max(limit, 1), 500));
  });
}

function storeFinishRun(
  automationId: string,
  runId: string,
  status: AutomationRunStatus,
  output: string | null,
  error: string | null,
): Promise<AutomationRun> {
  return withStore(async () => {
    const path = runPath(automationId, runId);
    const run = await readRunUnlocked(path);
    run.status = status;
    run.finishedAt = nowMs();
    run.output = output;
    run.error = error;
    await writeRunUnlocked(run);
    const index = await readIndexUnlocked();
    const item = index.automations.find((entry) => entry.id === automationId);
    if (item) {
      item.lastRunAt = run.finishedAt;
      item.lastRunStatus = status;
      await writeIndexUnlocked(index);
    }
    return run;
  });
}

function storeUpdateRunIdentity(
  automationId: string,
  runId: string,
  threadId: string,
  turnId: string,
): Promise<null> {
  return withStore(async () => {
    const run = await readRunUnlocked(runPath(automationId, runId));
    run.threadId = threadId;
    run.turnId = turnId;
    await writeRunUnlocked(run);
    return null;
  });
}

function storeUpdateNextRun(automationId: string, nextRunAt: number): Promise<null> {
  return withStore(async () => {
    const index = await readIndexUnlocked();
    const item = index.automations.find((entry) => entry.id === automationId);
    if (!item) throw new Error("Automation 不存在或已被删除");
    item.nextRunAt = nextRunAt;
    await writeIndexUnlocked(index);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Validation — hand-written against shared/automation/v1/workflow.schema.json
// ---------------------------------------------------------------------------

const TRIGGER_TYPES: readonly string[] = ["manualTrigger", "scheduleTrigger"];

const BUILTIN_TYPES: readonly string[] = [
  "manualTrigger",
  "scheduleTrigger",
  "model",
  "agent",
  "skill",
  "mcpTool",
  "builtinTool",
  "code",
  "condition",
  "merge",
  "approval",
  "output",
];

function issue(code: string, message: string): AutomationValidationIssue {
  return { code, message };
}

function nodeIssue(code: string, message: string, nodeId: string): AutomationValidationIssue {
  return { code, message, nodeId };
}

function edgeIssue(code: string, message: string, edgeId: string): AutomationValidationIssue {
  return { code, message, edgeId };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isGitWorkTree(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: path, windowsHide: true },
      (error, stdout) => resolve(!error && stdout.trim() === "true"),
    );
  });
}

/**
 * Kahn's algorithm over every node, disabled included — the same graph the Rust
 * check walked.
 *
 * Duplicate node ids collapse into one map entry, so a document with duplicates
 * also trips this check. That is the Rust behaviour, and it is harmless: the
 * `duplicate_node_id` issue is reported first and callers surface issue #0.
 */
function hasCycle(document: AutomationDocument): boolean {
  const indegree = new Map<string, number>();
  for (const node of document.nodes) indegree.set(node.id, 0);
  const outgoing = new Map<string, string[]>();

  for (const edge of document.edges) {
    if (!indegree.has(edge.sourceNodeId)) continue;
    const target = indegree.get(edge.targetNodeId);
    if (target === undefined) continue;
    indegree.set(edge.targetNodeId, target + 1);
    const list = outgoing.get(edge.sourceNodeId);
    if (list) list.push(edge.targetNodeId);
    else outgoing.set(edge.sourceNodeId, [edge.targetNodeId]);
  }

  const queue: string[] = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      const degree = indegree.get(target);
      if (degree === undefined) continue;
      const next = degree - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  return visited !== document.nodes.length;
}

/** Port of `automation::validate::validate`. Issue codes and texts are verbatim. */
export async function validateDocument(
  document: AutomationDocument,
  publish: boolean,
): Promise<AutomationValidationIssue[]> {
  const issues: AutomationValidationIssue[] = [];

  if (document.schemaVersion !== 1) {
    issues.push(issue("schema_version", "仅支持 Automation schemaVersion 1"));
  }
  if (!isUuid(document.id)) {
    issues.push(issue("invalid_id", "Automation ID 必须是有效 UUID"));
  }
  if (document.name.trim() === "" || charCount(document.name) > 80) {
    issues.push(issue("invalid_name", "名称不能为空且不能超过 80 个字符"));
  }
  if (charCount(document.description) > 500) {
    issues.push(issue("invalid_description", "描述不能超过 500 个字符"));
  }
  if (document.settings.timezone.trim() === "") {
    issues.push(issue("invalid_timezone", "时区不能为空"));
  }
  if (document.settings.maxDurationMs < 1_000 || document.settings.maxDurationMs > 86_400_000) {
    issues.push(issue("invalid_max_duration", "最大执行时间必须在 1 秒到 24 小时之间"));
  }
  if (document.settings.maxConcurrency < 1 || document.settings.maxConcurrency > 64) {
    issues.push(issue("invalid_concurrency", "最大并发数必须在 1 到 64 之间"));
  }
  const projectRoot = document.settings.projectRoot?.trim();
  if (projectRoot !== undefined && projectRoot !== "") {
    if (!isAbsolute(projectRoot) || !(await isDirectory(projectRoot))) {
      issues.push(issue("invalid_project_root", "项目目录必须是已存在的绝对目录"));
    } else if (publish && !(await isGitWorkTree(projectRoot))) {
      issues.push(
        issue(
          "project_root_not_git",
          "发布到项目目录的 Automation 必须指向 Git 仓库根目录或其工作目录",
        ),
      );
    }
  }

  const nodeIds = new Set<string>();
  for (const node of document.nodes) {
    if (node.id.trim() === "" || nodeIds.has(node.id)) {
      issues.push(nodeIssue("duplicate_node_id", "节点 ID 不能为空且不能重复", node.id));
    } else {
      nodeIds.add(node.id);
    }
    if (node.name.trim() === "" || charCount(node.name) > 80) {
      issues.push(nodeIssue("invalid_node_name", "节点名称不能为空且不能超过 80 个字符", node.id));
    }
    if (node.typeVersion === 0) {
      issues.push(nodeIssue("invalid_node_version", "节点类型版本必须大于 0", node.id));
    }
    if (!BUILTIN_TYPES.includes(node.type) && !node.type.startsWith("custom.")) {
      issues.push(nodeIssue("unknown_node_type", "节点类型不存在或尚未安装", node.id));
    }
    if (!isRecord(node.config)) {
      issues.push(nodeIssue("invalid_node_config", "节点配置必须是 JSON 对象", node.id));
    }
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
      issues.push(nodeIssue("invalid_position", "节点位置必须是有限数字", node.id));
    }
    for (const key of Object.keys(node.inputs)) {
      const binding = node.inputs[key];
      if (!binding || binding.kind !== "nodeOutput") continue;
      if (binding.nodeId === node.id) {
        issues.push(nodeIssue("self_binding", "节点输入不能引用自身输出", node.id));
      } else if (!document.nodes.some((candidate) => candidate.id === binding.nodeId)) {
        issues.push(nodeIssue("missing_binding_node", "节点输入引用了不存在的上游节点", node.id));
      }
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    if (edge.id.trim() === "" || edgeIds.has(edge.id)) {
      issues.push(edgeIssue("duplicate_edge_id", "连线 ID 不能为空且不能重复", edge.id));
    } else {
      edgeIds.add(edge.id);
    }
    if (edge.sourceNodeId === edge.targetNodeId) {
      issues.push(edgeIssue("self_edge", "节点不能连接到自身", edge.id));
    }
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      issues.push(edgeIssue("dangling_edge", "连线引用了不存在的节点", edge.id));
    }
    if (edge.sourcePort.trim() === "" || edge.targetPort.trim() === "") {
      issues.push(edgeIssue("invalid_edge_port", "连线端口不能为空", edge.id));
    }
  }

  if (hasCycle(document)) {
    issues.push(issue("cycle", "工作流不能包含任意图环"));
  }

  if (publish) {
    const triggers = document.nodes.filter(
      (node) => !node.disabled && TRIGGER_TYPES.includes(node.type),
    ).length;
    if (triggers !== 1) {
      issues.push(issue("trigger_count", "发布版本必须且只能包含一个启用的触发器"));
    }
    if (!document.nodes.some((node) => !node.disabled && node.type === "output")) {
      issues.push(issue("missing_output", "发布版本至少需要一个输出节点"));
    }
    for (const node of document.nodes) {
      if (node.disabled || node.type !== "approval") continue;
      issues.push(
        nodeIssue(
          "interactive_approval_forbidden",
          "无人值守 Automation 不能包含人工审批节点；需要审批的工具会在 approvalPolicy=never 下失败",
          node.id,
        ),
      );
    }
    for (const node of document.nodes) {
      if (node.disabled || node.type !== "scheduleTrigger") continue;
      const cron = isRecord(node.config) ? node.config["cron"] : undefined;
      if (typeof cron !== "string" || cron.trim() === "") {
        issues.push(nodeIssue("missing_cron", "定时触发器必须配置 Cron 表达式", node.id));
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

interface CronField {
  values: number[];
  wildcard: boolean;
}

interface CronExpression {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  weekday: CronField;
}

function parseCronNumber(raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Cron 数字无效：${raw}`);
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) throw new Error(`Cron 数字超出范围：${raw}`);
  return value;
}

function parseCronField(raw: string, min: number, max: number, sundayAlias: boolean): CronField {
  const wildcard = raw === "*";
  const values: number[] = [];
  for (const segment of raw.split(",")) {
    const slash = segment.indexOf("/");
    const range = slash < 0 ? segment : segment.slice(0, slash);
    // Rust's `step.parse().unwrap_or_default()`: a non-numeric step becomes 0,
    // which the check below then rejects.
    const rawStep = slash < 0 ? "1" : segment.slice(slash + 1);
    const step = /^\d+$/.test(rawStep) ? Number.parseInt(rawStep, 10) : 0;
    if (step === 0) throw new Error(`Cron 步长无效：${segment}`);
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else {
      const dash = range.indexOf("-");
      if (dash >= 0) {
        start = parseCronNumber(range.slice(0, dash), min, max);
        end = parseCronNumber(range.slice(dash + 1), min, max);
      } else {
        start = parseCronNumber(range, min, max);
        end = start;
      }
    }
    if (start > end) throw new Error(`Cron 范围无效：${segment}`);
    for (let value = start; value <= end; value += step) {
      values.push(sundayAlias && value === 7 ? 0 : value);
    }
  }
  values.sort((a, b) => a - b);
  return { values: [...new Set(values)], wildcard };
}

function parseCron(expression: string): CronExpression {
  const fields = expression.split(/\s+/).filter((field) => field !== "");
  if (fields.length !== 5) {
    throw new Error("Cron 必须包含 minute hour day month weekday 五个字段");
  }
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  return {
    minute: parseCronField(minute, 0, 59, false),
    hour: parseCronField(hour, 0, 23, false),
    day: parseCronField(day, 1, 31, false),
    month: parseCronField(month, 1, 12, false),
    weekday: parseCronField(weekday, 0, 7, true),
  };
}

interface ZonedParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * `Intl` replaces `chrono_tz`: the IANA database ships with the runtime, so the
 * user's `Asia/Shanghai` keeps resolving without adding a dependency.
 */
function zoneFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      weekday: "short",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    throw new Error(`无效时区：${timezone}`);
  }
  zoneFormatters.set(timezone, formatter);
  return formatter;
}

function zonedParts(formatter: Intl.DateTimeFormat, ms: number): ZonedParts | null {
  let minute = -1;
  let hour = -1;
  let day = -1;
  let month = -1;
  let weekday = -1;
  for (const part of formatter.formatToParts(new Date(ms))) {
    switch (part.type) {
      case "minute":
        minute = Number.parseInt(part.value, 10);
        break;
      case "hour":
        hour = Number.parseInt(part.value, 10);
        break;
      case "day":
        day = Number.parseInt(part.value, 10);
        break;
      case "month":
        month = Number.parseInt(part.value, 10);
        break;
      case "weekday":
        weekday = WEEKDAY_INDEX[part.value] ?? -1;
        break;
      default:
        break;
    }
  }
  if (minute < 0 || hour < 0 || day < 0 || month < 0 || weekday < 0) return null;
  return { minute, hour, day, month, weekday };
}

function fieldContains(field: CronField, value: number): boolean {
  return field.values.includes(value);
}

/** The date half of a cron match — true for every minute of that local day. */
function cronDateMatches(cron: CronExpression, parts: ZonedParts): boolean {
  if (!fieldContains(cron.month, parts.month)) return false;
  const day = fieldContains(cron.day, parts.day);
  const weekday = fieldContains(cron.weekday, parts.weekday);
  if (cron.day.wildcard && cron.weekday.wildcard) return true;
  if (cron.day.wildcard) return weekday;
  if (cron.weekday.wildcard) return day;
  // Standard cron: with both restricted, either one matching is enough.
  return day || weekday;
}

function cronMatches(cron: CronExpression, parts: ZonedParts): boolean {
  return (
    fieldContains(cron.minute, parts.minute) &&
    fieldContains(cron.hour, parts.hour) &&
    cronDateMatches(cron, parts)
  );
}

const YEAR_MS = 366 * 24 * 60 * 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;

/**
 * Slack left at the end of a skipped day, in minutes.
 *
 * Skipping a whole non-matching local day is only sound if the jump cannot
 * land past that day's midnight, and the jump is measured in absolute minutes
 * while the target is a *local* boundary — a DST transition inside the jump
 * moves it. No zone has ever shifted by more than two hours in one transition,
 * so six is slack enough to keep the landing inside the excluded day.
 */
const DAY_SKIP_MARGIN_MINUTES = 6 * 60;

/**
 * Next fire time strictly after `afterMs`, or null when the workflow has no
 * enabled schedule trigger. Throws on a malformed cron or timezone.
 */
export function nextScheduleMs(document: AutomationDocument, afterMs: number): number | null {
  const trigger = document.nodes.find((node) => !node.disabled && node.type === "scheduleTrigger");
  if (!trigger) return null;
  const config = isRecord(trigger.config) ? trigger.config : {};
  const expression = config["cron"];
  if (typeof expression !== "string") throw new Error("定时触发器缺少 Cron 表达式");
  const declared = config["timezone"];
  const timezone =
    typeof declared === "string" && declared.trim() !== "" ? declared : document.settings.timezone;
  const formatter = zoneFormatter(timezone);
  const cron = parseCron(expression);

  let minute = (Math.floor(afterMs / 60_000) + 1) * 60_000;
  const end = minute + YEAR_MS;
  while (minute <= end) {
    const parts = zonedParts(formatter, minute);
    if (!parts) break;
    if (cronMatches(cron, parts)) return minute;
    if (cronDateMatches(cron, parts)) {
      minute += 60_000;
      continue;
    }
    // Nothing in this local day can match, so stepping through its remaining
    // 1439 minutes would be pure cost: a yearly cron would burn half a million
    // formatter calls and freeze the main process for over a second.
    const remaining = MINUTES_PER_DAY - (parts.hour * 60 + parts.minute);
    minute += Math.max(1, remaining - DAY_SKIP_MARGIN_MINUTES) * 60_000;
  }
  throw new Error("Cron 在未来 366 天内没有可执行时间");
}

// ---------------------------------------------------------------------------
// Execution prompt
// ---------------------------------------------------------------------------

/** Port of `runtime::topological_order`, over enabled nodes only. */
function topologicalOrder(document: AutomationDocument): string[] {
  const indegree = new Map<string, number>();
  const first = new Map<string, AutomationNode>();
  for (const node of document.nodes) {
    if (node.disabled) continue;
    indegree.set(node.id, 0);
    if (!first.has(node.id)) first.set(node.id, node);
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of document.edges) {
    if (!indegree.has(edge.sourceNodeId) || !indegree.has(edge.targetNodeId)) continue;
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
    const list = outgoing.get(edge.sourceNodeId);
    if (list) list.push(edge.targetNodeId);
    else outgoing.set(edge.sourceNodeId, [edge.targetNodeId]);
  }
  const queue: string[] = [];
  for (const node of document.nodes) {
    if (!node.disabled && indegree.get(node.id) === 0) queue.push(node.id);
  }
  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const node = first.get(id);
    if (node) result.push(`${node.name} [${node.type}]`);
    for (const target of outgoing.get(id) ?? []) {
      const degree = indegree.get(target);
      if (degree === undefined) continue;
      const next = degree - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (result.length !== indegree.size) throw new Error("Automation DAG contains a cycle");
  return result;
}

/**
 * Port of `runtime::execution_prompt`, kept word for word: it is the contract
 * between the stored workflow and whatever agent carries the run out.
 */
export function executionPrompt(
  document: AutomationDocument,
  trigger: string,
  input: JsonValue,
): string {
  const order = topologicalOrder(document);
  const workflow = JSON.stringify(serializeDocument(document), null, 2);
  const rendered = JSON.stringify(input, null, 2);
  return (
    `Execute published Automation \`${document.name}\` revision ${document.revision} as an unattended run.\n` +
    `Trigger: ${trigger}\n` +
    `Topological node order: ${order.join(" -> ")}\n` +
    `\n` +
    `Rules:\n` +
    `- Execute enabled nodes in the declared DAG order and honor every edge, input binding, condition branch, merge strategy and output node.\n` +
    `- Use only capabilities declared by the workflow. Do not invent missing credentials, tools, paths or user answers.\n` +
    `- Never ask for user input or approval. The runtime uses approvalPolicy=never; report a blocked step instead of bypassing it.\n` +
    `- Keep all filesystem changes inside the current Local workspace and finish with a concise run result.\n` +
    `\n` +
    `Trigger input:\n${rendered}\n` +
    `\n` +
    `Published workflow:\n${workflow}`
  );
}

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

/** Event name the renderer can `listen()` on for live run progress. */
export const AUTOMATION_RUN_EVENT = "automation://run";

export interface AutomationRunProgress {
  automationId: string;
  runId: string;
  status: AutomationRunStatus;
  message: string;
  at: number;
  /** The full record, present on the terminal transition only. */
  run: JsonValue | null;
}

export interface ProgressSink {
  emit(progress: AutomationRunProgress): void;
  close(): void;
}

/**
 * Broadcasts to every window, and additionally to the caller's `Channel` when
 * one was passed. The channel is always closed, otherwise the renderer-side
 * callback is never released.
 */
function createProgressSink(target: WebContents | null, channelId: string | null): ProgressSink {
  let closed = false;
  return {
    emit(progress) {
      broadcastEvent(AUTOMATION_RUN_EVENT, progress);
      if (!closed && target && channelId !== null) emitChannel(target, channelId, progress);
    },
    close() {
      if (closed) return;
      closed = true;
      if (target && channelId !== null) closeChannel(target, channelId);
    },
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface AutomationRunContext {
  readonly automationId: string;
  readonly runId: string;
  readonly document: AutomationDocument;
  readonly trigger: string;
  readonly input: JsonValue;
  /** The unattended-run prompt built by {@link executionPrompt}. */
  readonly prompt: string;
  readonly workspacePath: string;
  /** Aborted on user cancel, on the `maxDurationMs` deadline, and on quit. */
  readonly signal: AbortSignal;
  /** Records core-side ids on the run so history can link back to them. */
  setIdentity(threadId: string, turnId: string): Promise<void>;
  /** Pushes one progress line to the renderer. */
  report(message: string): void;
}

export interface AutomationRunOutcome {
  status: "completed" | "failed" | "cancelled";
  output?: string | null;
  error?: string | null;
}

export interface AutomationRunner {
  execute(context: AutomationRunContext): Promise<AutomationRunOutcome>;
}

const UNATTENDED_INSTRUCTIONS =
  "You are the Tietiezhi automation runtime carrying out one unattended workflow run. " +
  "Follow the workflow exactly, never request user input or approval, and answer with the run result only.";

type WireApi = Exclude<ModelWireApi, "auto">;

function wireApiForModel(provider: ResolvedProvider, modelId: string): WireApi {
  if (provider.wireApi !== "auto") return provider.wireApi;
  const model = provider.models.find((entry) => entry.id === modelId);
  const resolved = model ? effectiveWireApi(model) : null;
  return resolved !== null && resolved !== "auto" ? resolved : "chatCompletions";
}

function apiUrl(baseUrl: string, path: string): string {
  let base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/v1beta")) base = base.slice(0, -7);
  else if (base.endsWith("/v1")) base = base.slice(0, -3);
  return `${base}/v1/${path.replace(/^\/+/, "")}`;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(providerHttpError("Automation", response.status, text));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Automation 模型服务返回的不是合法 JSON");
  }
}

function pathValue(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function firstItem(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

/** Flattens the several shapes "content" takes across the wire APIs. */
function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).join("");
  if (isRecord(value)) {
    const text = value["text"];
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * Mirrors `suggestions.ts`'s per-wire-API completion. Duplicated rather than
 * shared because that module keeps the helper private and this file may not
 * modify it.
 */
async function completeText(
  provider: ResolvedProvider,
  model: string,
  key: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  switch (wireApiForModel(provider, model)) {
    case "chatCompletions": {
      const payload = await postJson(
        apiUrl(provider.baseUrl, "chat/completions"),
        { authorization: `Bearer ${key}` },
        {
          model,
          messages: [
            { role: "system", content: UNATTENDED_INSTRUCTIONS },
            { role: "user", content: prompt },
          ],
          stream: false,
        },
        signal,
      );
      return collectText(pathValue(firstItem(pathValue(payload, ["choices"])), ["message", "content"]));
    }
    case "anthropicMessages": {
      const payload = await postJson(
        apiUrl(provider.baseUrl, "messages"),
        { "x-api-key": key, "anthropic-version": "2023-06-01", authorization: `Bearer ${key}` },
        {
          model,
          max_tokens: 4096,
          system: UNATTENDED_INSTRUCTIONS,
          messages: [{ role: "user", content: prompt }],
        },
        signal,
      );
      return collectText(pathValue(payload, ["content"]));
    }
    case "geminiGenerateContent": {
      const root = apiUrl(provider.baseUrl, "").replace(/\/v1\/$/, "");
      const payload = await postJson(
        `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": key },
        {
          systemInstruction: { parts: [{ text: UNATTENDED_INSTRUCTIONS }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        },
        signal,
      );
      return collectText(
        pathValue(firstItem(pathValue(payload, ["candidates"])), ["content", "parts"]),
      );
    }
    case "responses": {
      const payload = await postJson(
        apiUrl(provider.baseUrl, "responses"),
        { authorization: `Bearer ${key}` },
        {
          model,
          instructions: UNATTENDED_INSTRUCTIONS,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
          ],
          stream: false,
        },
        signal,
      );
      const shortcut = collectText(pathValue(payload, ["output_text"]));
      if (shortcut !== "") return shortcut;
      const output = pathValue(payload, ["output"]);
      return Array.isArray(output)
        ? output.map((item) => collectText(pathValue(item, ["content"]))).join("")
        : "";
    }
  }
}

/** Keychain account for a workflow credential, in this host's naming style. */
export function automationCredentialAccount(credentialId: string): string {
  return `automation-credential-${credentialId}`;
}

/**
 * Reports credentials the workflow references but the machine does not have.
 * The values themselves stay out of the prompt — see the file header.
 */
async function missingCredentials(document: AutomationDocument): Promise<string[]> {
  const ids = new Set<string>();
  for (const node of document.nodes) {
    if (node.disabled) continue;
    for (const key of Object.keys(node.inputs)) {
      const binding = node.inputs[key];
      if (binding?.kind === "secretRef") ids.add(binding.credentialId);
    }
  }
  const missing: string[] = [];
  for (const id of ids) {
    if ((await getSecret(automationCredentialAccount(id))) === null) missing.push(id);
  }
  return missing;
}

/**
 * Default runner: one unattended turn against the user's configured chat model.
 *
 * It has no tools and no workspace access, so a workflow that needs those will
 * report itself blocked rather than pretend — which is the intended behaviour
 * until an ACP-backed runner is injected.
 */
export const providerAutomationRunner: AutomationRunner = {
  async execute(context) {
    const settings = await readSettings();
    const providerId = settings.chatProviderId.trim();
    const model = settings.chatModel.trim();
    if (providerId === "" || model === "") {
      throw new Error("请先在「设置」中选择对话模型后再运行 Automation");
    }
    const provider = await resolveProvider(providerId);
    if (provider.key === null || provider.key === "") {
      throw new Error("请先在「设置」中配置所选供应商的 API Key");
    }

    const missing = await missingCredentials(context.document);
    if (missing.length > 0) {
      context.report(`以下凭据尚未配置，相关节点可能失败：${missing.join("、")}`);
    }

    context.report(`使用模型 ${model} 执行 Automation`);
    const text = await completeText(provider, model, provider.key, context.prompt, context.signal);
    if (text.trim() === "") {
      return { status: "failed", error: "automation turn returned no output" };
    }
    return { status: "completed", output: text };
  },
};

let runner: AutomationRunner = providerAutomationRunner;

/**
 * Replaces the runner, e.g. with one that drives an ACP core. Passing null
 * restores the provider-backed default.
 */
export function setAutomationRunner(next: AutomationRunner | null): void {
  runner = next ?? providerAutomationRunner;
}

// ---------------------------------------------------------------------------
// Run engine
// ---------------------------------------------------------------------------

type StopReason = "cancel" | "timeout" | "shutdown";

interface ActiveRun {
  automationId: string;
  runId: string;
  controller: AbortController;
  reason: StopReason | null;
  sink: ProgressSink;
  done: Promise<void>;
}

const activeRuns = new Map<string, ActiveRun>();

function runKey(automationId: string, runId: string): string {
  return `${automationId}/${runId}`;
}

function emitProgress(
  sink: ProgressSink,
  run: AutomationRun,
  message: string,
  terminal: boolean,
): void {
  sink.emit({
    automationId: run.automationId,
    runId: run.id,
    status: run.status,
    message,
    at: nowMs(),
    run: terminal ? serializeRun(run) : null,
  });
}

async function prepareWorkspace(document: AutomationDocument, runId: string): Promise<string> {
  const projectRoot = document.settings.projectRoot?.trim();
  if (projectRoot !== undefined && projectRoot !== "") {
    if (!(await isDirectory(projectRoot))) {
      throw new Error("项目目录必须是已存在的绝对目录");
    }
    return projectRoot;
  }
  const managed = runWorkspacePath(document.id, runId);
  try {
    await mkdir(managed, { recursive: true });
  } catch (error) {
    throw new Error(`创建 Automation 本地工作目录失败：${messageOf(error)}`);
  }
  return managed;
}

async function finishAndAnnounce(
  entry: ActiveRun,
  status: AutomationRunStatus,
  output: string | null,
  error: string | null,
  message: string,
): Promise<void> {
  try {
    const run = await storeFinishRun(entry.automationId, entry.runId, status, output, error);
    emitProgress(entry.sink, run, message, true);
  } catch (writeError) {
    // The record may be gone (automation deleted mid-run); the run is over
    // either way, so this must not turn into an unhandled rejection.
    console.error(`[automation:${entry.automationId}] finish ${entry.runId}:`, writeError);
  } finally {
    entry.sink.close();
  }
}

function supervise(entry: ActiveRun, context: AutomationRunContext, maxDurationMs: number): Promise<void> {
  const deadline = setTimeout(() => {
    entry.reason ??= "timeout";
    entry.controller.abort();
  }, maxDurationMs);

  return (async () => {
    try {
      const outcome = await runner.execute(context);
      // Quit already aborted this: leave the record non-terminal so the next
      // launch reports it exactly like the Rust build's recovery pass did.
      if (entry.reason === "shutdown") return;
      if (outcome.status === "completed") {
        await finishAndAnnounce(entry, "completed", outcome.output ?? null, null, "运行完成");
      } else if (outcome.status === "cancelled") {
        await finishAndAnnounce(
          entry,
          "cancelled",
          null,
          outcome.error ?? "automation turn interrupted",
          "运行已取消",
        );
      } else {
        await finishAndAnnounce(
          entry,
          "failed",
          outcome.output ?? null,
          outcome.error ?? "automation turn failed",
          "运行失败",
        );
      }
    } catch (error) {
      if (entry.reason === "shutdown") return;
      if (entry.reason === "timeout") {
        await finishAndAnnounce(
          entry,
          "failed",
          null,
          `maximum duration exceeded: ${maxDurationMs} ms`,
          "运行超时",
        );
      } else if (entry.reason === "cancel" || isAbortError(error)) {
        await finishAndAnnounce(entry, "cancelled", null, "cancelled by user", "运行已取消");
      } else {
        await finishAndAnnounce(entry, "failed", null, messageOf(error), "运行失败");
      }
    } finally {
      clearTimeout(deadline);
      if (activeRuns.get(runKey(entry.automationId, entry.runId)) === entry) {
        activeRuns.delete(runKey(entry.automationId, entry.runId));
      }
    }
  })();
}

/** Port of `runtime::start_run`. Returns as soon as the run is in flight. */
export async function startRun(
  automationId: string,
  trigger: string,
  input: JsonValue,
  sink: ProgressSink = createProgressSink(null, null),
): Promise<AutomationRun> {
  let run: AutomationRun | null = null;
  try {
    const document = await storeLoadPublished(automationId);
    const running = (await storeListRuns(automationId, RUN_SCAN_LIMIT)).filter((item) =>
      isActiveStatus(item.status),
    ).length;
    if (running >= document.settings.maxConcurrency) {
      throw new Error(`Automation 已达到最大并发数 ${document.settings.maxConcurrency}`);
    }

    const runId = randomUUID();
    run = {
      id: runId,
      automationId,
      revision: document.revision,
      trigger,
      status: "queued",
      input,
      threadId: "",
      turnId: "",
      workspacePath: runWorkspacePath(automationId, runId),
      startedAt: nowMs(),
      finishedAt: 0,
      output: null,
      error: null,
    };
    await storeSaveRun(run);
    emitProgress(sink, run, "运行已排队", false);

    // From here on a failure is a *run* failure: it belongs in the record.
    let workspacePath: string;
    let prompt: string;
    try {
      workspacePath = await prepareWorkspace(document, runId);
      prompt = executionPrompt(document, trigger, run.input);
    } catch (error) {
      const message = messageOf(error);
      const failed = await storeFinishRun(automationId, runId, "failed", null, message);
      emitProgress(sink, failed, "运行失败", true);
      throw new Error(message);
    }

    run = { ...run, workspacePath, status: "running", threadId: randomUUID(), turnId: randomUUID() };
    await storeSaveRun(run);
    emitProgress(sink, run, "运行已开始", false);

    const controller = new AbortController();
    const entry: ActiveRun = {
      automationId,
      runId,
      controller,
      reason: null,
      sink,
      done: Promise.resolve(),
    };
    activeRuns.set(runKey(automationId, runId), entry);

    const context: AutomationRunContext = {
      automationId,
      runId,
      document,
      trigger,
      input: run.input,
      prompt,
      workspacePath,
      signal: controller.signal,
      setIdentity: (threadId, turnId) =>
        storeUpdateRunIdentity(automationId, runId, threadId, turnId).then(() => undefined),
      report: (message) => {
        const current = run;
        if (current) emitProgress(sink, current, message, false);
      },
    };
    entry.done = supervise(entry, context, document.settings.maxDurationMs);
    return run;
  } catch (error) {
    // Nothing is in flight, so the channel would never be closed otherwise.
    if (!run || !activeRuns.has(runKey(automationId, run.id))) sink.close();
    throw error;
  }
}

/** Port of `runtime::cancel_run`; the abort actually interrupts the work. */
export async function cancelRun(automationId: string, runId: string): Promise<AutomationRun> {
  const run = await storeLoadRun(automationId, runId);
  if (!isActiveStatus(run.status)) return run;

  const entry = activeRuns.get(runKey(automationId, runId));
  if (entry) {
    entry.reason ??= "cancel";
    entry.controller.abort();
    // Bounded: a runner that ignores its signal must not hang the caller.
    await Promise.race([
      entry.done.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }

  const current = await storeLoadRun(automationId, runId).catch(() => null);
  if (current && !isActiveStatus(current.status)) return current;
  return storeFinishRun(automationId, runId, "cancelled", null, "cancelled by user");
}

/** Port of `runtime::delete`: stop what is running, then drop the files. */
async function deleteAutomation(automationId: string): Promise<null> {
  assertId(automationId);
  for (const run of await storeListRuns(automationId, RUN_SCAN_LIMIT)) {
    if (!isActiveStatus(run.status)) continue;
    await cancelRun(automationId, run.id).catch(() => undefined);
  }
  return storeDelete(automationId);
}

/**
 * Port of `runtime::recover_incomplete_runs`. A record left `running` by a crash
 * or a quit has no supervisor any more, so it would sit active forever and keep
 * the concurrency slot occupied.
 */
export async function recoverIncompleteRuns(): Promise<void> {
  for (const run of await storeListRuns(undefined, RUN_SCAN_LIMIT)) {
    if (!isActiveStatus(run.status)) continue;
    await storeFinishRun(
      run.automationId,
      run.id,
      "failed",
      null,
      "应用重启前运行未完成；对应 Thread、Turn 与 Rollout 已保留，可从运行历史检查",
    ).catch((error: unknown) => {
      console.error(`[automation:${run.automationId}] recover ${run.id}:`, error);
    });
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const SCHEDULER_POLL_MS = 30_000;
const MISSED_GRACE_MS = 90_000;

let schedulerTimer: NodeJS.Timeout | null = null;
let ticking = false;

/** Port of `runtime::tick`. */
async function tick(): Promise<void> {
  const now = nowMs();
  const due = (await storeList(false)).filter(
    (item) =>
      item.publishedRevision > 0 &&
      !item.paused &&
      item.triggerType === "scheduleTrigger" &&
      item.nextRunAt > 0 &&
      item.nextRunAt <= now,
  );
  for (const automation of due) {
    const document = await storeLoadPublished(automation.id);
    await storeUpdateNextRun(automation.id, nextScheduleMs(document, now) ?? 0);
    const missed = now - automation.nextRunAt > MISSED_GRACE_MS;
    if (missed && document.settings.onMissedSchedule === "skip") continue;
    try {
      await startRun(automation.id, "schedule", {
        scheduledAt: automation.nextRunAt,
        startedAt: now,
      });
    } catch (error) {
      console.error(`[automation:${automation.id}]`, messageOf(error));
    }
  }
}

export function startAutomationScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void tick()
      .catch((error: unknown) => {
        console.error("[automation] scheduler:", messageOf(error));
      })
      .finally(() => {
        ticking = false;
      });
  }, SCHEDULER_POLL_MS);
  // The poll must never be the reason the process stays alive.
  schedulerTimer.unref();
}

/**
 * Stops the poll and interrupts everything in flight. Safe to call twice.
 *
 * Terminal records are deliberately *not* written here: the process is going
 * away, and `recoverIncompleteRuns()` marks these on the next launch with the
 * same message the Tauri build used.
 */
export async function stopAutomationRuntime(): Promise<void> {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  const entries = [...activeRuns.values()];
  activeRuns.clear();
  for (const entry of entries) {
    entry.reason ??= "shutdown";
    entry.controller.abort();
    entry.sink.close();
  }
  await Promise.allSettled(entries.map((entry) => entry.done));
}

let shutdownHooked = false;

/**
 * `before-quit` is already claimed (and deferred) by the main entry point, so
 * this only does the synchronous part: aborting the controllers is what keeps
 * fetches and future child processes from outliving the window.
 */
function installShutdownHook(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  app.on("before-quit", () => {
    void stopAutomationRuntime();
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Reads the caller's `Channel` argument, if the renderer passed one. */
function progressSinkFromArgs(args: Record<string, unknown>): ProgressSink {
  for (const key of ["onProgress", "onEvent", "channel"]) {
    const raw = args[key];
    if (typeof raw !== "string" || parseChannelId(raw) === null) continue;
    return createProgressSink(requireInvocation().sender, raw);
  }
  return createProgressSink(null, null);
}

export interface AutomationRegistrationOptions {
  /** Poll schedule triggers. Off for tests and headless tooling. */
  scheduler?: boolean;
  /** Sweep runs left active by the previous process. */
  recover?: boolean;
}

/** Registers the twelve automation commands. */
export function registerAutomationCommands(options: AutomationRegistrationOptions = {}): void {
  registerCommands({
    list_automations: (args) => storeList(optionalBooleanArg(args, "includeArchived") ?? false),

    load_automation: (args) => storeLoad(stringArg(args, "id")),

    create_automation: (args) => storeCreate(optionalStringArg(args, "name") ?? "未命名自动化"),

    save_automation: (args) => storeSave(parseAutomationDocument(args["automation"])),

    validate_automation: (args) =>
      validateDocument(
        parseAutomationDocument(args["automation"]),
        optionalBooleanArg(args, "publish") ?? false,
      ),

    archive_automation: (args) =>
      storeArchive(stringArg(args, "id"), booleanArg(args, "archived")),

    delete_automation: (args) => deleteAutomation(stringArg(args, "id")),

    publish_automation: async (args) => {
      const id = stringArg(args, "id");
      // The next fire time is computed from the draft about to be published,
      // exactly like `runtime::publish` does.
      const document = await storeLoad(id);
      return storePublish(id, nextScheduleMs(document, nowMs()) ?? 0);
    },

    pause_automation: async (args) => {
      const id = stringArg(args, "id");
      const paused = booleanArg(args, "paused");
      if (paused) return storeSetPaused(id, true, 0);
      const document = await storeLoadPublished(id);
      return storeSetPaused(id, false, nextScheduleMs(document, nowMs()) ?? 0);
    },

    run_automation: (args) => {
      const sink = progressSinkFromArgs(args);
      try {
        const input = args["input"];
        return startRun(
          stringArg(args, "id"),
          "manual",
          input === undefined || input === null ? {} : toJsonValue(input, "input"),
          sink,
        );
      } catch (error) {
        // A rejected argument means no run and therefore no `startRun` to close
        // the channel; leaving it open would pin the renderer's callback.
        sink.close();
        throw error;
      }
    },

    cancel_automation_run: (args) =>
      cancelRun(stringArg(args, "automationId"), stringArg(args, "runId")),

    list_automation_runs: (args) =>
      storeListRuns(optionalStringArg(args, "automationId"), optionalCountArg(args, "limit") ?? 100),
  });

  installShutdownHook();

  if (options.recover !== false) {
    void recoverIncompleteRuns().catch((error: unknown) => {
      console.error("[automation] recover:", messageOf(error));
    });
  }
  if (options.scheduler !== false) startAutomationScheduler();
}
