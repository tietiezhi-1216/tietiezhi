/**
 * Tietiezhi control-center commands: agent config, the Home file tree, the
 * secret vault and the persisted timeline.
 *
 * Ported from `desktop/src-tauri/src/commands/tietiezhi.rs`. The renderer is
 * the unchanged Tauri frontend, so every returned shape has to match what
 * serde produced field for field — including which optional members are
 * emitted as `null` and which are omitted entirely.
 */

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";

import { safeStorage, shell } from "electron";

import { registerCommands } from "../bridge/index.js";

import { dataPath } from "./paths.js";
import { getTietiezhiSecret as legacyTietiezhiSecret } from "./settings-secrets.js";

const CONFIG_VERSION = 1;
const MAX_CONFIG_PROMPT_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TIMELINE_BYTES = 24 * 1024 * 1024;
const MAX_TIMELINE_MESSAGES = 200;
const MAX_LISTED_FILES = 500;
const MAX_PROMPT_DOCUMENT_CHARS = 12_000;

const PROTECTED_FILES = ["SOUL.md", "USER.md", "MEMORY.md"] as const;
const HOME_MARKER = ".tietiezhi-home";
const SESSIONS_DIRECTORY = "sessions";

const ALLOWED_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  "fetch",
  "skill",
  "device_call",
] as const;

const DEFAULT_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  "skill",
  "device_call",
] as const;

const PERMISSION_MODES = ["ask", "auto", "full"] as const;
const TIMELINE_ROLES = ["user", "assistant"] as const;

const SOUL_TEMPLATE = `# 铁铁汁

这里定义铁铁汁稳定的身份、语气和行为边界。

- 自然、直接，不说空泛的宣传语。
- 记住用户明确要求长期保留的信息。
- 执行操作前确认目标，不伪造执行结果。
`;

const USER_TEMPLATE = `# 关于我

在这里记录希望铁铁汁长期了解的个人偏好、称呼和工作习惯。

## 称呼

## 偏好

## 常用设备与工作流
`;

const MEMORY_TEMPLATE = `# 长期记忆

这里保存跨会话仍然有价值的事实、决定和偏好。

## 重要事实

## 长期决定

## 待持续关注
`;

const SECRETS_INDEX_TEMPLATE = `# 密钥库

这里保存密钥的用途和引用，不保存真实密钥值。

在 MCP 环境变量或 HTTP 请求头中使用 \`\${secret:name}\`。Tietiezhi 只会在执行层解析引用，真实值保存在操作系统安全存储中，不会进入提示词或会话记录。
`;

const SECRET_METADATA_START = "<!-- tietiezhi-secret-metadata\n";
const SECRET_METADATA_END = "\n-->";
const SECRET_REFERENCE_PREFIX = "${secret:";

// ---------------------------------------------------------------------------
// Types — these are the wire shapes the renderer already expects.
// ---------------------------------------------------------------------------

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface TietiezhiConfig {
  version: number;
  systemPrompt: string;
  skills: string[];
  mcpServers: string[];
  tools: string[];
  permissionMode: PermissionMode;
  memoryEnabled: boolean;
}

export interface TietiezhiAttachment {
  id: string;
  kind: string | null;
  name: string;
  mimeType: string;
  path: string | null;
  size: number | null;
  textContent: string | null;
  truncated: boolean | null;
}

export interface TietiezhiTimelineMessage {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  /** Omitted entirely when empty, matching `skip_serializing_if`. */
  attachments?: TietiezhiAttachment[];
}

export interface TietiezhiFileEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  protected: boolean;
}

export interface TietiezhiHomeOverview {
  path: string;
  fileCount: number;
  memoryFileCount: number;
  totalSize: number;
  timelineCount: number;
}

export interface TietiezhiSecretMeta {
  name: string;
  label: string;
  description: string;
  updatedAt: number;
  hasValue: boolean;
  reference: string;
}

/** Persisted inside the secret's markdown document, never the value itself. */
interface SecretFileMetadata {
  name: string;
  label: string;
  description: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Unicode scalar count — Rust's `chars().count()`, not UTF-16 length. */
function charCount(value: string): number {
  return [...value].length;
}

function nowMillis(): number {
  return Date.now();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic text write. The timeline and the secret index are rewritten whole on
 * every change; a torn write would cost the user the entire session history.
 */
async function writeTextAtomic(path: string, text: string, mode?: number): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, text, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Home directory
// ---------------------------------------------------------------------------

function homePath(): string {
  return dataPath("tietiezhi");
}

function configPath(): string {
  return dataPath("tietiezhi.json");
}

async function ensureHome(home: string): Promise<void> {
  try {
    await mkdir(home, { recursive: true });
    for (const directory of ["memory", "notes", "uploads", "secrets", SESSIONS_DIRECTORY]) {
      await mkdir(join(home, directory), { recursive: true });
    }
  } catch (error) {
    throw new Error(`创建铁铁汁 Home 失败：${describe(error)}`);
  }

  const marker = join(home, HOME_MARKER);
  if (!(await exists(marker))) {
    try {
      await writeFile(marker, "managed by Tietiezhi\n", "utf8");
    } catch (error) {
      throw new Error(`初始化铁铁汁 Home 标记失败：${describe(error)}`);
    }
  }

  for (const [name, content] of [
    ["SOUL.md", SOUL_TEMPLATE],
    ["USER.md", USER_TEMPLATE],
    ["MEMORY.md", MEMORY_TEMPLATE],
  ] as const) {
    const path = join(home, name);
    if (!(await exists(path))) {
      try {
        await writeFile(path, content, "utf8");
      } catch (error) {
        throw new Error(`初始化 ${name} 失败：${describe(error)}`);
      }
    }
  }

  const secretsIndex = join(home, "secrets", "SECRETS.md");
  if (!(await exists(secretsIndex))) {
    try {
      await writeFile(secretsIndex, SECRETS_INDEX_TEMPLATE, "utf8");
    } catch (error) {
      throw new Error(`初始化密钥索引失败：${describe(error)}`);
    }
  }
}

/** The Tietiezhi Home, created and repaired on every access. */
export async function tietiezhiHome(): Promise<string> {
  const home = homePath();
  await ensureHome(home);
  return home;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/** Home-relative path with `/` separators, the shape the frontend indexes by. */
function relativePath(home: string, path: string): string {
  const value = relative(home, path);
  return value.split(sep).join("/");
}

function looksAbsolute(raw: string): boolean {
  // `Path::has_root()` on Windows also covers drive prefixes; check both forms
  // on every platform so a Windows-shaped path cannot slip through on macOS.
  return isAbsolute(raw) || raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:/.test(raw);
}

/**
 * Resolve a user-supplied path inside the Home.
 *
 * The renderer sends these strings verbatim, so this is the only thing between
 * the control center and arbitrary filesystem read/write: parent components are
 * rejected outright, symlinks anywhere along the chain are refused (they would
 * otherwise be a legal way out of the Home), and the result is re-checked
 * against the Home prefix.
 */
async function resolveHomePath(home: string, relativeInput: string): Promise<string> {
  const raw = relativeInput.trim();
  if (looksAbsolute(raw)) {
    throw new Error("只能使用铁铁汁 Home 内的相对路径");
  }
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return home;

  let resolved = home;
  let first = true;
  for (const part of trimmed.split(/[/\\]/)) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      throw new Error("文件路径不能包含上级目录");
    }
    if (part.includes("\0")) {
      throw new Error("文件路径包含非法字符");
    }
    if (first && part === SESSIONS_DIRECTORY) {
      throw new Error("sessions 是系统管理目录");
    }
    resolved = join(resolved, part);
    let info: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      info = await lstat(resolved);
    } catch {
      // A component that does not exist yet is fine — write may create it.
      info = null;
    }
    if (info !== null && info.isSymbolicLink()) {
      throw new Error("不允许通过软链接访问铁铁汁 Home 外部");
    }
    first = false;
  }

  if (resolved !== home && !resolved.startsWith(home + sep)) {
    throw new Error("只能使用铁铁汁 Home 内的相对路径");
  }
  return resolved;
}

/**
 * Guard the way the filesystem resolves, not the way the string looks.
 *
 * macOS (APFS/HFS+) and Windows are case-insensitive: comparing the raw
 * relative path would let `soul.md` slip past a `SOUL.md` entry and delete the
 * real identity file, and `Secrets/x` past the `secrets/` prefix.
 */
function isProtected(relativeValue: string): boolean {
  const normalized = relativeValue.toLowerCase();
  return (
    (PROTECTED_FILES as readonly string[]).some((name) => name.toLowerCase() === normalized) ||
    normalized === HOME_MARKER.toLowerCase() ||
    normalized.startsWith("secrets/")
  );
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function defaultConfig(): TietiezhiConfig {
  return {
    version: CONFIG_VERSION,
    systemPrompt: "",
    skills: [],
    mcpServers: [],
    tools: [...DEFAULT_TOOLS],
    permissionMode: "ask",
    memoryEnabled: true,
  };
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function readStringArray(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`铁铁汁配置字段 ${field} 必须是字符串数组`);
  }
  return value as string[];
}

/** Lenient like serde's container-level `default`: absent members fall back. */
function parseConfig(value: unknown): TietiezhiConfig {
  if (!isRecord(value)) {
    throw new Error("铁铁汁配置格式不正确");
  }
  const base = defaultConfig();

  const version = value["version"];
  const systemPrompt = value["systemPrompt"];
  const permissionMode = value["permissionMode"];
  const memoryEnabled = value["memoryEnabled"];

  if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt !== "string") {
    throw new Error("铁铁汁配置字段 systemPrompt 必须是字符串");
  }
  if (permissionMode !== undefined && permissionMode !== null && typeof permissionMode !== "string") {
    throw new Error("铁铁汁配置字段 permissionMode 必须是字符串");
  }
  if (memoryEnabled !== undefined && memoryEnabled !== null && typeof memoryEnabled !== "boolean") {
    throw new Error("铁铁汁配置字段 memoryEnabled 必须是布尔值");
  }

  return {
    version: typeof version === "number" && Number.isFinite(version) ? Math.trunc(version) : base.version,
    systemPrompt: typeof systemPrompt === "string" ? systemPrompt : base.systemPrompt,
    skills: readStringArray(value["skills"], "skills", base.skills),
    mcpServers: readStringArray(value["mcpServers"], "mcpServers", base.mcpServers),
    tools: readStringArray(value["tools"], "tools", base.tools),
    // Validated by normalizeConfig, which owns the user-facing message.
    permissionMode: (typeof permissionMode === "string" ? permissionMode : base.permissionMode) as PermissionMode,
    memoryEnabled: typeof memoryEnabled === "boolean" ? memoryEnabled : base.memoryEnabled,
  };
}

function normalizeConfig(config: TietiezhiConfig): TietiezhiConfig {
  if (byteLength(config.systemPrompt) > MAX_CONFIG_PROMPT_BYTES) {
    throw new Error("系统指令不能超过 64 KB");
  }
  const tools = uniqueNonEmpty(config.tools).filter((tool) =>
    (ALLOWED_TOOLS as readonly string[]).includes(tool),
  );
  if (tools.length === 0) tools.push("device_call");

  if (!(PERMISSION_MODES as readonly string[]).includes(config.permissionMode)) {
    throw new Error("权限模式无效");
  }

  return {
    version: CONFIG_VERSION,
    systemPrompt: config.systemPrompt.trim(),
    skills: uniqueNonEmpty(config.skills),
    mcpServers: uniqueNonEmpty(config.mcpServers),
    tools,
    permissionMode: config.permissionMode,
    memoryEnabled: config.memoryEnabled,
  };
}

async function writeConfig(config: TietiezhiConfig): Promise<void> {
  const path = configPath();
  try {
    await mkdir(dataPath(), { recursive: true });
    await writeTextAtomic(path, JSON.stringify(config, null, 2));
  } catch (error) {
    throw new Error(`保存铁铁汁配置失败：${describe(error)}`);
  }
}

/** Reads the config, seeding the file with defaults the first time. */
export async function readTietiezhiConfig(): Promise<TietiezhiConfig> {
  const path = configPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      const config = defaultConfig();
      await writeConfig(config);
      return config;
    }
    throw new Error(`读取铁铁汁配置失败：${describe(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`铁铁汁配置损坏：${describe(error)}`);
  }
  return normalizeConfig(parseConfig(parsed));
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

function modifiedAtOf(mtimeMs: number): number {
  return Number.isFinite(mtimeMs) ? Math.trunc(mtimeMs) : 0;
}

async function listFilesIn(home: string): Promise<TietiezhiFileEntry[]> {
  const files: TietiezhiFileEntry[] = [];

  const walk = async (directory: string): Promise<void> => {
    if (files.length >= MAX_LISTED_FILES) return;
    let entries: string[];
    try {
      entries = await readdir(directory, { encoding: "utf8" });
    } catch {
      return;
    }
    for (const name of entries) {
      if (files.length >= MAX_LISTED_FILES) return;
      // `sessions/` is machine-managed and the marker is an implementation
      // detail; neither is browsable in the control center.
      if (name === SESSIONS_DIRECTORY || name === HOME_MARKER) continue;
      const full = join(directory, name);
      let info;
      try {
        info = await lstat(full);
      } catch {
        continue;
      }
      const relativeValue = relativePath(home, full);
      const isDirectory = info.isDirectory();
      files.push({
        path: relativeValue,
        name,
        isDirectory,
        size: info.isFile() ? info.size : 0,
        modifiedAt: modifiedAtOf(info.mtimeMs),
        protected: isProtected(relativeValue),
      });
      // Symlinked directories are listed but never descended into.
      if (isDirectory) await walk(full);
    }
  };

  await walk(home);

  files.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    if (left.path === right.path) return 0;
    return left.path < right.path ? -1 : 1;
  });
  return files;
}

async function readBounded(path: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new Error(`读取文件失败：${describe(error)}`);
  }
  if (!info.isFile()) {
    throw new Error("请选择文本文件");
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new Error("控制中心只能编辑不超过 1 MB 的文本文件");
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (error) {
    throw new Error(`读取文件失败：${describe(error)}`);
  }
  try {
    // `fatal` matches Rust's read_to_string: invalid UTF-8 is an error, not
    // silently replaced with U+FFFD.
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("文件不是有效的 UTF-8 文本");
  }
}

/** Bounded document injected into the agent's system prompt; empty on failure. */
export async function promptDocument(home: string, name: string): Promise<string> {
  try {
    const content = await readBounded(join(home, name));
    const bounded = [...content].slice(0, MAX_PROMPT_DOCUMENT_CHARS).join("");
    return `<${name}>\n${bounded}\n</${name}>`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Secret vault
// ---------------------------------------------------------------------------

/**
 * Encrypted values live outside the Home so they never show up in the file
 * browser, and separate from provider API keys — these are user-authored
 * `${secret:name}` references, a different lifecycle entirely.
 */
function secretStorePath(): string {
  return dataPath("tietiezhi-secrets.json");
}

interface SecretStoreFile {
  version: number;
  /** name -> base64 of safeStorage ciphertext. Never a plaintext value. */
  secrets: Record<string, string>;
}

async function loadSecretStore(): Promise<SecretStoreFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(secretStorePath(), "utf8"));
    if (!isRecord(parsed)) return { version: 1, secrets: {} };
    const secrets = parsed["secrets"];
    if (!isRecord(secrets)) return { version: 1, secrets: {} };
    const out: Record<string, string> = {};
    for (const key of Object.keys(secrets)) {
      const value = secrets[key];
      if (typeof value === "string") out[key] = value;
    }
    return { version: 1, secrets: out };
  } catch {
    return { version: 1, secrets: {} };
  }
}

async function saveSecretStore(store: SecretStoreFile): Promise<void> {
  try {
    await mkdir(dataPath(), { recursive: true });
    await writeTextAtomic(secretStorePath(), `${JSON.stringify(store, null, 2)}\n`, 0o600);
  } catch (error) {
    throw new Error(`保存密钥失败：${describe(error)}`);
  }
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统安全存储不可用，无法保存密钥。请确认操作系统的钥匙串或凭据管理器已启用");
  }
}

/**
 * Serializes read-modify-write of the vault file. Two `upsert_tietiezhi_secret`
 * calls arriving together would otherwise each load the same snapshot and the
 * later save would drop the earlier secret.
 */
let vaultQueue: Promise<unknown> = Promise.resolve();

function withVault<T>(task: () => Promise<T>): Promise<T> {
  const next = vaultQueue.then(task, task);
  vaultQueue = next.catch(() => undefined);
  return next;
}

export async function getTietiezhiSecret(name: string): Promise<string | null> {
  const store = await loadSecretStore();
  const encoded = store.secrets[name];
  if (encoded === undefined) {
    // The one-time import from the Tauri profile deposits vault secrets in the
    // provider keychain file under a `tietiezhi-secret-` account. Reading it
    // here is what keeps migrated secrets from silently vanishing; adopt on
    // first hit so the fallback is not needed again.
    const migrated = await legacyTietiezhiSecret(name).catch(() => null);
    if (migrated === null) return null;
    await withVault(async () => {
      const current = await loadSecretStore();
      if (current.secrets[name] !== undefined) return;
      requireEncryption();
      current.secrets[name] = safeStorage.encryptString(migrated).toString("base64");
      await saveSecretStore(current);
    }).catch(() => {
      // Adoption is opportunistic; the value is already in hand.
    });
    return migrated;
  }
  // Only touch safeStorage when there is something to decrypt, so an empty
  // vault still lists on a machine without a working credential store.
  requireEncryption();
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch (error) {
    throw new Error(`读取密钥失败：${describe(error)}`);
  }
}

async function setTietiezhiSecret(name: string, value: string): Promise<void> {
  requireEncryption();
  let encoded: string;
  try {
    encoded = safeStorage.encryptString(value).toString("base64");
  } catch (error) {
    throw new Error(`加密密钥失败：${describe(error)}`);
  }
  await withVault(async () => {
    const store = await loadSecretStore();
    store.secrets[name] = encoded;
    await saveSecretStore(store);
  });
}

async function deleteStoredSecret(name: string): Promise<void> {
  await withVault(async () => {
    const store = await loadSecretStore();
    if (!(name in store.secrets)) return;
    delete store.secrets[name];
    await saveSecretStore(store);
  });
}

function validateSecretName(name: string): void {
  const valid =
    name.length > 0 && byteLength(name) <= 64 && /^[a-z0-9_-]+$/.test(name);
  if (!valid) {
    throw new Error("密钥名称只能包含小写字母、数字、- 和 _，且不能超过 64 个字符");
  }
}

function secretFilePath(home: string, name: string): string {
  validateSecretName(name);
  return join(home, "secrets", `${name}.md`);
}

function parseSecretMetadata(content: string): SecretFileMetadata | null {
  if (!content.startsWith(SECRET_METADATA_START)) return null;
  const rest = content.slice(SECRET_METADATA_START.length);
  const end = rest.indexOf(SECRET_METADATA_END);
  if (end < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rest.slice(0, end));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { name, label, description, updatedAt } = parsed;
  if (
    typeof name !== "string" ||
    typeof label !== "string" ||
    typeof description !== "string" ||
    typeof updatedAt !== "number"
  ) {
    return null;
  }
  return { name, label, description, updatedAt };
}

async function listSecretMetadata(home: string): Promise<SecretFileMetadata[]> {
  const directory = join(home, "secrets");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    throw new Error(`读取密钥目录失败：${describe(error)}`);
  }

  const entries: SecretFileMetadata[] = [];
  for (const fileName of names) {
    if (fileName === "SECRETS.md") continue;
    const full = join(directory, fileName);
    try {
      const info = await lstat(full);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    let content: string;
    try {
      content = await readFile(full, "utf8");
    } catch {
      continue;
    }
    const metadata = parseSecretMetadata(content);
    if (!metadata) continue;
    // The file name is the identity; a document claiming a different name is
    // ignored rather than trusted.
    const stem = basename(fileName, extname(fileName));
    if (stem !== metadata.name) continue;
    try {
      validateSecretName(metadata.name);
    } catch {
      continue;
    }
    entries.push(metadata);
  }
  entries.sort((left, right) => (left.name === right.name ? 0 : left.name < right.name ? -1 : 1));
  return entries;
}

function secretDocument(metadata: SecretFileMetadata): string {
  const json = JSON.stringify({
    name: metadata.name,
    label: metadata.label,
    description: metadata.description,
    updatedAt: metadata.updatedAt,
  });
  return (
    `${SECRET_METADATA_START}${json}${SECRET_METADATA_END}\n\n` +
    `# ${metadata.label}\n\n` +
    `- 引用：\`\${secret:${metadata.name}}\`\n` +
    `- 存储：操作系统安全存储\n` +
    `- 最后更新：${metadata.updatedAt}\n\n` +
    `${metadata.description}\n`
  );
}

function markdownCell(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/\|/g, "\\|");
}

async function writeSecretIndex(home: string, metadata: SecretFileMetadata[]): Promise<void> {
  let content = `${SECRETS_INDEX_TEMPLATE}\n\n`;
  if (metadata.length === 0) {
    content += "当前没有已登记的密钥。\n";
  } else {
    content += "| 名称 | 引用 | 用途 |\n| --- | --- | --- |\n";
    for (const item of metadata) {
      content += `| ${markdownCell(item.label)} | \`\${secret:${item.name}}\` | ${markdownCell(item.description)} |\n`;
    }
  }
  try {
    await writeTextAtomic(join(home, "secrets", "SECRETS.md"), content);
  } catch (error) {
    throw new Error(`更新密钥索引失败：${describe(error)}`);
  }
}

/**
 * Expand every `${secret:name}` in `input`. Used by the MCP and device layers;
 * an unconfigured reference is an error rather than a silent empty string, so a
 * misconfigured server never authenticates as nobody.
 */
export async function resolveSecretReferences(input: string): Promise<string> {
  let remaining = input;
  let output = "";
  for (;;) {
    const start = remaining.indexOf(SECRET_REFERENCE_PREFIX);
    if (start < 0) break;
    output += remaining.slice(0, start);
    const reference = remaining.slice(start + SECRET_REFERENCE_PREFIX.length);
    const end = reference.indexOf("}");
    if (end < 0) {
      // Unterminated reference is left verbatim, exactly as the Rust version.
      return output + remaining.slice(start);
    }
    const name = reference.slice(0, end);
    validateSecretName(name);
    const value = await getTietiezhiSecret(name);
    if (value === null) {
      throw new Error(`密钥引用未配置：\${secret:${name}}`);
    }
    output += value;
    remaining = reference.slice(end + 1);
  }
  return output + remaining;
}

/** Replace any literal secret value with its reference before it is logged. */
export async function redactTietiezhiSecretValues(input: string): Promise<string> {
  let home: string;
  try {
    home = await tietiezhiHome();
  } catch {
    return input;
  }
  let metadata: SecretFileMetadata[];
  try {
    metadata = await listSecretMetadata(home);
  } catch {
    return input;
  }
  let redacted = input;
  for (const item of metadata) {
    let value: string | null;
    try {
      value = await getTietiezhiSecret(item.name);
    } catch {
      continue;
    }
    if (value !== null && value.length > 0) {
      redacted = redacted.split(value).join(`\${secret:${item.name}}`);
    }
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function timelinePath(home: string): string {
  return join(home, SESSIONS_DIRECTORY, "main.json");
}

function parseAttachment(value: unknown): TietiezhiAttachment {
  if (!isRecord(value)) {
    throw new Error("铁铁汁会话附件格式不正确");
  }
  const id = value["id"];
  const name = value["name"];
  if (typeof id !== "string" || typeof name !== "string") {
    throw new Error("铁铁汁会话附件缺少 id 或 name");
  }
  const kind = value["kind"];
  const mimeType = value["mimeType"];
  const path = value["path"];
  const size = value["size"];
  const textContent = value["textContent"];
  const truncated = value["truncated"];
  return {
    id,
    kind: typeof kind === "string" ? kind : null,
    name,
    mimeType: typeof mimeType === "string" ? mimeType : "",
    path: typeof path === "string" ? path : null,
    size: typeof size === "number" && Number.isFinite(size) ? Math.trunc(size) : null,
    textContent: typeof textContent === "string" ? textContent : null,
    truncated: typeof truncated === "boolean" ? truncated : null,
  };
}

function parseTimelineMessage(value: unknown): TietiezhiTimelineMessage {
  if (!isRecord(value)) {
    throw new Error("铁铁汁会话记录格式不正确");
  }
  const id = value["id"];
  const role = value["role"];
  const content = value["content"];
  const createdAt = value["createdAt"];
  if (typeof id !== "string" || typeof role !== "string" || typeof content !== "string") {
    throw new Error("铁铁汁会话记录缺少 id、role 或 content");
  }
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    throw new Error("铁铁汁会话记录的 createdAt 必须是数字");
  }
  const rawAttachments = value["attachments"];
  const attachments =
    rawAttachments === undefined || rawAttachments === null
      ? []
      : Array.isArray(rawAttachments)
        ? rawAttachments.map(parseAttachment)
        : (() => {
            throw new Error("铁铁汁会话附件必须是数组");
          })();

  const message: TietiezhiTimelineMessage = {
    id,
    role,
    content,
    createdAt: Math.trunc(createdAt),
  };
  if (attachments.length > 0) message.attachments = attachments;
  return message;
}

async function loadTimelineFrom(home: string): Promise<TietiezhiTimelineMessage[]> {
  const path = timelinePath(home);

  let size: number | null = null;
  try {
    size = (await lstat(path)).size;
  } catch {
    // Missing or unreadable: treated as "no history yet", like the Rust build.
    return [];
  }
  if (size > MAX_TIMELINE_BYTES) {
    throw new Error("铁铁汁会话文件超过 24 MB，请先备份后清理");
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`读取铁铁汁会话失败：${describe(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`铁铁汁会话文件损坏：${describe(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("铁铁汁会话文件损坏：期望一个数组");
  }

  let messages: TietiezhiTimelineMessage[];
  try {
    messages = parsed.map(parseTimelineMessage);
  } catch (error) {
    throw new Error(`铁铁汁会话文件损坏：${describe(error)}`);
  }
  return messages
    .filter((message) => (TIMELINE_ROLES as readonly string[]).includes(message.role))
    .slice(-MAX_TIMELINE_MESSAGES);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`缺少参数 ${key}`);
  }
  return value;
}

async function getTietiezhiConfigCommand(): Promise<TietiezhiConfig> {
  await tietiezhiHome();
  return readTietiezhiConfig();
}

async function saveTietiezhiConfigCommand(args: Record<string, unknown>): Promise<TietiezhiConfig> {
  const config = normalizeConfig(parseConfig(args["config"]));
  await writeConfig(config);
  return config;
}

async function listTietiezhiFilesCommand(): Promise<TietiezhiFileEntry[]> {
  return listFilesIn(await tietiezhiHome());
}

async function readTietiezhiFileCommand(args: Record<string, unknown>): Promise<string> {
  const home = await tietiezhiHome();
  return readBounded(await resolveHomePath(home, requireString(args, "path")));
}

async function writeTietiezhiFileCommand(args: Record<string, unknown>): Promise<null> {
  const path = requireString(args, "path");
  const content = requireString(args, "content");
  if (byteLength(content) > MAX_FILE_BYTES) {
    throw new Error("控制中心只能保存不超过 1 MB 的文本文件");
  }
  const home = await tietiezhiHome();
  const resolved = await resolveHomePath(home, path);
  const relativeValue = relativePath(home, resolved);
  // Case-folded for the same reason as `isProtected`: the write path must not
  // be a way around the guards the delete path enforces.
  const normalized = relativeValue.toLowerCase();
  if (normalized === HOME_MARKER.toLowerCase()) {
    throw new Error("铁铁汁 Home 标记由系统管理");
  }
  if (normalized.startsWith("secrets/")) {
    throw new Error("密钥说明由密钥库管理，请在“密钥库”面板中修改");
  }
  if (resolved === home) {
    throw new Error("请输入文件名");
  }
  try {
    await mkdir(dirname(resolved), { recursive: true });
  } catch (error) {
    throw new Error(`创建目录失败：${describe(error)}`);
  }
  try {
    await writeFile(resolved, content, "utf8");
  } catch (error) {
    throw new Error(`保存文件失败：${describe(error)}`);
  }
  return null;
}

async function deleteTietiezhiFileCommand(args: Record<string, unknown>): Promise<null> {
  const home = await tietiezhiHome();
  const resolved = await resolveHomePath(home, requireString(args, "path"));
  const relativeValue = relativePath(home, resolved);
  if (isProtected(relativeValue)) {
    throw new Error("核心记忆文件不能删除，可以清空或编辑内容");
  }
  let isDirectory = false;
  try {
    isDirectory = (await lstat(resolved)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (isDirectory) {
    try {
      await rmdir(resolved);
    } catch (error) {
      throw new Error(`删除空目录失败：${describe(error)}`);
    }
  } else {
    try {
      await rm(resolved);
    } catch (error) {
      throw new Error(`删除文件失败：${describe(error)}`);
    }
  }
  return null;
}

async function listTietiezhiSecretsCommand(): Promise<TietiezhiSecretMeta[]> {
  const home = await tietiezhiHome();
  const metadata = await listSecretMetadata(home);
  const out: TietiezhiSecretMeta[] = [];
  for (const item of metadata) {
    out.push({
      name: item.name,
      label: item.label,
      description: item.description,
      updatedAt: item.updatedAt,
      hasValue: (await getTietiezhiSecret(item.name)) !== null,
      reference: `\${secret:${item.name}}`,
    });
  }
  return out;
}

async function upsertTietiezhiSecretCommand(
  args: Record<string, unknown>,
): Promise<TietiezhiSecretMeta> {
  const name = requireString(args, "name").trim();
  validateSecretName(name);

  const label = requireString(args, "label").trim().replace(/[\r\n]/g, " ");
  if (label.length === 0 || charCount(label) > 80) {
    throw new Error("密钥显示名称不能为空且不能超过 80 个字符");
  }
  const description = requireString(args, "description").trim();
  if (charCount(description) > 500) {
    throw new Error("密钥用途不能超过 500 个字符");
  }

  const rawValue = args["value"];
  if (rawValue !== undefined && rawValue !== null && typeof rawValue !== "string") {
    throw new Error("密钥值必须是字符串");
  }
  const value = typeof rawValue === "string" ? rawValue : null;
  if (value !== null && value.length === 0) {
    throw new Error("密钥值不能为空");
  }

  const home = await tietiezhiHome();
  const hadValue = (await getTietiezhiSecret(name)) !== null;
  if (!hadValue && value === null) {
    throw new Error("新密钥需要填写密钥值");
  }

  const metadata: SecretFileMetadata = {
    name,
    label,
    description,
    updatedAt: nowMillis(),
  };
  try {
    await writeTextAtomic(secretFilePath(home, name), secretDocument(metadata));
  } catch (error) {
    throw new Error(`保存密钥说明失败：${describe(error)}`);
  }
  if (value !== null) {
    await setTietiezhiSecret(name, value);
  }
  await writeSecretIndex(home, await listSecretMetadata(home));

  return {
    name,
    label,
    description,
    updatedAt: metadata.updatedAt,
    hasValue: true,
    reference: `\${secret:${name}}`,
  };
}

async function revealTietiezhiSecretCommand(args: Record<string, unknown>): Promise<string> {
  const name = requireString(args, "name");
  validateSecretName(name);
  const value = await getTietiezhiSecret(name);
  if (value === null) {
    throw new Error("密钥值不存在，请重新保存");
  }
  return value;
}

async function deleteTietiezhiSecretCommand(args: Record<string, unknown>): Promise<null> {
  const name = requireString(args, "name");
  validateSecretName(name);
  const home = await tietiezhiHome();
  await deleteStoredSecret(name);
  const path = secretFilePath(home, name);
  if (await exists(path)) {
    try {
      await rm(path);
    } catch (error) {
      throw new Error(`删除密钥说明失败：${describe(error)}`);
    }
  }
  await writeSecretIndex(home, await listSecretMetadata(home));
  return null;
}

async function tietiezhiHomeOverviewCommand(): Promise<TietiezhiHomeOverview> {
  const home = await tietiezhiHome();
  const files = await listFilesIn(home);
  const timelineCount = (await loadTimelineFrom(home)).length;
  const plainFiles = files.filter((entry) => !entry.isDirectory);
  return {
    path: home,
    fileCount: plainFiles.length,
    memoryFileCount: plainFiles.filter(
      (entry) => entry.path === "MEMORY.md" || entry.path.startsWith("memory/"),
    ).length,
    totalSize: files.reduce((total, entry) => total + entry.size, 0),
    timelineCount,
  };
}

async function revealTietiezhiHomeCommand(): Promise<null> {
  const home = await tietiezhiHome();
  const error = await shell.openPath(home);
  if (error.length > 0) {
    throw new Error(`打开铁铁汁 Home 失败：${error}`);
  }
  return null;
}

async function loadTietiezhiTimelineCommand(): Promise<TietiezhiTimelineMessage[]> {
  return loadTimelineFrom(await tietiezhiHome());
}

async function saveTietiezhiTimelineCommand(args: Record<string, unknown>): Promise<null> {
  const raw = args["messages"];
  if (!Array.isArray(raw)) {
    throw new Error("铁铁汁会话记录必须是数组");
  }
  const home = await tietiezhiHome();

  const messages = raw
    .map(parseTimelineMessage)
    .filter((message) => {
      const attachments = message.attachments ?? [];
      return (
        message.id.trim().length > 0 &&
        (TIMELINE_ROLES as readonly string[]).includes(message.role) &&
        byteLength(message.content) <= MAX_FILE_BYTES &&
        attachments.length <= 12 &&
        attachments.every(
          (attachment) =>
            attachment.textContent === null || byteLength(attachment.textContent) <= MAX_FILE_BYTES,
        )
      );
    })
    .slice(-MAX_TIMELINE_MESSAGES);

  const serialized = JSON.stringify(messages, null, 2);
  if (byteLength(serialized) > MAX_TIMELINE_BYTES) {
    throw new Error("铁铁汁会话记录超过 24 MB，请减少大型文本附件");
  }
  try {
    await writeTextAtomic(timelinePath(home), serialized);
  } catch (error) {
    throw new Error(`保存铁铁汁会话失败：${describe(error)}`);
  }
  return null;
}

/** Registers every Tietiezhi control-center command on the bridge. */
export function registerTietiezhiCommands(): void {
  registerCommands({
    get_tietiezhi_config: getTietiezhiConfigCommand,
    save_tietiezhi_config: saveTietiezhiConfigCommand,
    list_tietiezhi_files: listTietiezhiFilesCommand,
    read_tietiezhi_file: readTietiezhiFileCommand,
    write_tietiezhi_file: writeTietiezhiFileCommand,
    delete_tietiezhi_file: deleteTietiezhiFileCommand,
    list_tietiezhi_secrets: listTietiezhiSecretsCommand,
    upsert_tietiezhi_secret: upsertTietiezhiSecretCommand,
    delete_tietiezhi_secret: deleteTietiezhiSecretCommand,
    reveal_tietiezhi_secret: revealTietiezhiSecretCommand,
    reveal_tietiezhi_home: revealTietiezhiHomeCommand,
    tietiezhi_home_overview: tietiezhiHomeOverviewCommand,
    load_tietiezhi_timeline: loadTietiezhiTimelineCommand,
    save_tietiezhi_timeline: saveTietiezhiTimelineCommand,
  });
}
