/**
 * Skills, agent profiles, builtin tool names, and the MCP runtime-status
 * commands — the Electron port of `commands/skills.rs`, `commands/agents.rs`,
 * `commands/permissions.rs::list_builtin_tools` and `commands/mcp.rs`.
 *
 * On the `mcp_*` commands: the Tauri build owned every MCP connection itself,
 * so it could report a live running/stopped/error state per server. In the new
 * architecture the host only owns the *canonical* MCP configuration (see
 * ../config/), and each ACP core spawns and supervises its own MCP servers from
 * the projected config — the host never holds those connections and has no way
 * to observe them. Rather than invent a status, these three commands report an
 * honest "nothing connected here": `mcp_server_status` returns an empty list
 * (the settings UI already falls back to the "stopped" badge for an id it does
 * not find) and restart/stop are accepted no-ops, because a core reads its MCP
 * config at startup and the restart affordance belongs to the core, not here.
 * Whoever later surfaces per-core MCP state should replace this file's stubs.
 */

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { registerCommands } from "../bridge/index.js";
import { dataPath, readJson, writeJsonAtomic } from "./paths.js";

// ---------------------------------------------------------------------------
// Shapes (must match the serde output the frontend's api.ts was written for)
// ---------------------------------------------------------------------------

/** `Skill` in desktop/src/lib/api.ts. */
export interface SkillMeta {
  name: string;
  description: string;
  enabled: boolean;
}

/** `Agent` in desktop/src/lib/api.ts (serde `rename_all = "camelCase"`). */
export interface Agent {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  modelProviderId: string;
  reasoningEffort: string;
  skills: string[];
  mcpServers: string[];
  tools: string[];
  permissionMode: string;
}

/** `McpServerStatus` in desktop/src/lib/api.ts. */
export interface McpServerStatus {
  id: string;
  state: "running" | "stopped" | "error";
  toolCount: number;
  error: string;
}

/**
 * Builtin tool names, mirroring `crate::tools::ALL_TOOLS`. Order matters: the
 * agent editor renders the toggles in this order.
 */
const ALL_TOOLS: readonly string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  "bash",
  "fetch",
  "skill",
  "device_call",
];

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`参数 ${key} 必须是字符串`);
  return value;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") throw new Error(`参数 ${key} 必须是布尔值`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function stringField(value: Record<string, unknown>, key: string, fallback = ""): string {
  const raw = value[key];
  return typeof raw === "string" ? raw : fallback;
}

async function pathKind(path: string): Promise<"dir" | "file" | "missing"> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

// ---------------------------------------------------------------------------
// Skills: one folder per skill under <userData>/skills/<name>/SKILL.md
// ---------------------------------------------------------------------------

async function skillsDir(): Promise<string> {
  const dir = dataPath("skills");
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new Error(`创建技能目录失败：${String(error)}`);
  }
  return dir;
}

/** Skill names double as folder names; keep them filesystem-safe. */
function validateName(name: string): void {
  // Byte length, not code points: the Rust check was on `name.len()`.
  const byteLength = Buffer.byteLength(name, "utf8");
  const safe = /^[A-Za-z0-9_-]+$/.test(name);
  if (!safe || byteLength > 64) {
    throw new Error("技能名只能包含字母、数字、- 和 _");
  }
}

/** Rust's `str::trim_matches(ch)`: strips every leading and trailing `ch`. */
function trimChar(value: string, ch: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ch) start += 1;
  while (end > start && value[end - 1] === ch) end -= 1;
  return value.slice(start, end);
}

/**
 * Parse the two frontmatter keys a SKILL.md is required to carry. Hand-rolled
 * for the same reason as the Rust original: only `name` and `description`
 * matter, so pulling in a YAML parser would not buy anything.
 */
export function parseFrontmatter(content: string): {
  name: string | undefined;
  description: string | undefined;
} {
  let name: string | undefined;
  let description: string | undefined;
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { name, description };
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed === "---") break;
    const separator = trimmed.indexOf(":");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimChar(trimChar(trimmed.slice(separator + 1).trim(), '"'), "'");
    if (key === "name") name = value;
    else if (key === "description") description = value;
  }
  return { name, description };
}

async function skillMdPath(name: string): Promise<string> {
  validateName(name);
  return join(await skillsDir(), name, "SKILL.md");
}

/** Skill names the user switched off, read straight out of settings.json. */
async function disabledSkills(): Promise<string[]> {
  const settings = await readJson<Record<string, unknown>>(dataPath("settings.json"), {});
  return stringList(settings["skillsDisabled"]);
}

async function listSkills(): Promise<SkillMeta[]> {
  const dir = await skillsDir();
  const disabled = await disabledSkills();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`读取技能目录失败：${String(error)}`);
  }

  const out: SkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let content: string;
    try {
      content = await readFile(join(dir, entry.name, "SKILL.md"), "utf8");
    } catch {
      // A folder without SKILL.md is not a skill; skip it silently.
      continue;
    }
    const { name, description } = parseFrontmatter(content);
    out.push({
      name: name ?? entry.name,
      description: description ?? "",
      // Matches the Rust build: the disabled list is matched on the folder.
      enabled: !disabled.includes(entry.name),
    });
  }
  // Code-unit order, like the Rust `String` comparison, not a locale collation.
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

async function readSkill(name: string): Promise<string> {
  const path = await skillMdPath(name);
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(`技能 ${name} 不存在`);
  }
}

async function upsertSkill(name: string, description: string, body: string): Promise<null> {
  validateName(name);
  const path = await skillMdPath(name);
  try {
    await mkdir(join(await skillsDir(), name), { recursive: true });
  } catch (error) {
    throw new Error(`创建技能目录失败：${String(error)}`);
  }
  // A body that already carries frontmatter was edited raw; keep it verbatim
  // instead of stacking a second frontmatter block on top.
  const content = body.trimStart().startsWith("---")
    ? body
    : `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${body}`;
  try {
    await writeFile(path, content, "utf8");
  } catch (error) {
    throw new Error(`写入技能失败：${String(error)}`);
  }
  return null;
}

async function deleteSkill(name: string): Promise<null> {
  validateName(name);
  const dir = join(await skillsDir(), name);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`删除技能失败：${String(error)}`);
  }
  return null;
}

async function setSkillEnabled(name: string, enabled: boolean): Promise<null> {
  validateName(name);
  const path = dataPath("settings.json");
  // Read-modify-write of the whole document: every other key is preserved
  // verbatim so this stays safe next to whatever else owns settings.json.
  //
  // A swallowed read error must NOT fall back to `{}` here. Writing that back
  // would publish a document containing only `skillsDisabled`, wiping every
  // provider, model choice and prompt — and unlike the settings module, this
  // path takes no corruption backup. The Rust original aborts the same way.
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw new Error(`读取设置失败：${String(error)}`);
  });
  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("设置文件格式不正确");
    }
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`设置文件损坏，已中止保存以免覆盖：${String(error)}`);
  }
  const next = stringList(settings["skillsDisabled"]).filter((n) => n !== name);
  if (!enabled) next.push(name);
  settings["skillsDisabled"] = next;
  try {
    await writeJsonAtomic(path, settings);
  } catch (error) {
    throw new Error(`保存设置失败：${String(error)}`);
  }
  return null;
}

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 8;

async function copyDir(src: string, dest: string, depth: number): Promise<void> {
  if (depth > MAX_IMPORT_DEPTH) throw new Error("技能文件夹层级过深");
  try {
    await mkdir(dest, { recursive: true });
  } catch (error) {
    throw new Error(`创建目录失败：${String(error)}`);
  }
  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch (error) {
    throw new Error(`读取目录失败：${String(error)}`);
  }
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to, depth + 1);
    } else if (entry.isFile()) {
      // Symlinks are neither, so they are skipped — importing one would let a
      // skill folder reach outside itself.
      const info = await stat(from);
      if (info.size > MAX_IMPORT_BYTES) throw new Error(`文件 ${entry.name} 过大（>5MB）`);
      try {
        await copyFile(from, to);
      } catch (error) {
        throw new Error(`复制文件失败：${String(error)}`);
      }
    }
  }
}

const ARCHIVE_SUFFIXES = [".zip", ".tar", ".tar.gz", ".tgz", ".gz", ".7z", ".rar"];

/**
 * Import a skill by copying a local folder (which must contain SKILL.md) into
 * the skills directory, exactly like the Tauri build did. Archives are refused
 * with an explicit hint rather than a generic "pick a folder", because the
 * picker lets the user select one.
 */
async function importSkill(rawPath: string): Promise<SkillMeta> {
  const trimmed = rawPath.trim();
  const kind = await pathKind(trimmed);

  let src = trimmed;
  if (kind === "file") {
    // Selecting the SKILL.md itself is the obvious mistake; treat it as the
    // folder that contains it instead of failing.
    if (basename(trimmed) === "SKILL.md") {
      src = join(trimmed, "..");
    } else {
      const lower = trimmed.toLowerCase();
      if (ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
        throw new Error("暂不支持直接导入压缩包，请先解压后选择包含 SKILL.md 的文件夹");
      }
      throw new Error("请选择一个包含 SKILL.md 的文件夹");
    }
  } else if (kind === "missing") {
    throw new Error("请选择一个包含 SKILL.md 的文件夹");
  }

  let content: string;
  try {
    content = await readFile(join(src, "SKILL.md"), "utf8");
  } catch {
    throw new Error("文件夹内缺少 SKILL.md");
  }

  const parsed = parseFrontmatter(content);
  const name = parsed.name ?? basename(src);
  validateName(name);

  const dest = join(await skillsDir(), name);
  await copyDir(src, dest, 0);
  return { name, description: parsed.description ?? "", enabled: true };
}

// ---------------------------------------------------------------------------
// Agents: a single agents.json holding the whole list
// ---------------------------------------------------------------------------

function agentsPath(): string {
  return dataPath("agents.json");
}

/** Serde `#[serde(default)]` on the struct: every missing field falls back. */
function normalizeAgent(value: unknown): Agent | null {
  if (!isRecord(value)) return null;
  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    systemPrompt: stringField(value, "systemPrompt"),
    model: stringField(value, "model"),
    modelProviderId: stringField(value, "modelProviderId"),
    reasoningEffort: stringField(value, "reasoningEffort"),
    skills: stringList(value["skills"]),
    mcpServers: stringList(value["mcpServers"]),
    tools: stringList(value["tools"]),
    permissionMode: stringField(value, "permissionMode", "auto"),
  };
}

async function readAgents(): Promise<Agent[]> {
  const path = agentsPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // Missing file is the normal first-run state, not an error.
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`智能体文件损坏：${String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("智能体文件损坏：根节点不是对象");
  const list = parsed["agents"];
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error("智能体文件损坏：agents 不是数组");
  return list.flatMap((item) => {
    const agent = normalizeAgent(item);
    return agent ? [agent] : [];
  });
}

async function writeAgents(agents: Agent[]): Promise<void> {
  try {
    await writeJsonAtomic(agentsPath(), { agents });
  } catch (error) {
    throw new Error(`写入智能体失败：${String(error)}`);
  }
}

async function upsertAgent(value: unknown): Promise<null> {
  const agent = normalizeAgent(value);
  if (!agent || agent.id.trim() === "" || agent.name.trim() === "") {
    throw new Error("智能体需要 id 和名称");
  }
  const agents = await readAgents();
  const index = agents.findIndex((a) => a.id === agent.id);
  if (index >= 0) agents[index] = agent;
  else agents.push(agent);
  await writeAgents(agents);
  return null;
}

async function deleteAgent(id: string): Promise<null> {
  const agents = await readAgents();
  await writeAgents(agents.filter((a) => a.id !== id));
  return null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Registers the skills, agents, builtin-tools and MCP-status commands. */
export function registerSkillsCommands(): void {
  registerCommands({
    // --- skills ----------------------------------------------------------
    list_skills: () => listSkills(),
    read_skill: (args) => readSkill(stringArg(args, "name")),
    upsert_skill: (args) =>
      upsertSkill(stringArg(args, "name"), stringArg(args, "description"), stringArg(args, "body")),
    delete_skill: (args) => deleteSkill(stringArg(args, "name")),
    set_skill_enabled: (args) =>
      setSkillEnabled(stringArg(args, "name"), booleanArg(args, "enabled")),
    import_skill: (args) => importSkill(stringArg(args, "path")),

    // --- agents ----------------------------------------------------------
    list_agents: () => readAgents(),
    upsert_agent: (args) => upsertAgent(args["agent"]),
    delete_agent: (args) => deleteAgent(stringArg(args, "id")),

    list_builtin_tools: (): string[] => [...ALL_TOOLS],

    // --- MCP runtime state (see the file header for why these are empty) ---
    mcp_server_status: (): McpServerStatus[] => [],
    mcp_restart_server: (args): null => {
      // Validated so a malformed call still fails loudly; the restart itself
      // belongs to the core that owns the connection.
      stringArg(args, "id");
      return null;
    },
    mcp_stop_server: (args): null => {
      stringArg(args, "id");
      return null;
    },
  });
}
