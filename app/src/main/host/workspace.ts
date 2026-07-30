/**
 * Task workspaces and their Git operations — the Electron port of
 * `commands/workspace.rs` plus the `crates/agent-git` runtime it delegates to.
 *
 * The Rust build split this in two: `workspace.rs` owned the task/project
 * plumbing and `tietiezhi-agent-git` owned the descriptor store and every Git
 * call. Both halves live here because the split existed to keep a reusable
 * crate reusable, and there is nothing to reuse in a single host module.
 *
 * On-disk formats are unchanged so a migrated profile keeps working:
 * `agent-runtime/git-workspaces/states/<taskId>.json` holds
 * `{ version: 1, descriptor }` with the same camelCase field names serde
 * produced, and snapshots still live under `refs/tietiezhi/snapshots/*` with a
 * private alternate index so the user's real index and branch are never
 * touched.
 *
 * Every `git` invocation goes through {@link gitRaw}, which spawns an argv
 * array with no shell. Branch names, remotes, paths and commit messages all
 * arrive from the renderer; a shell string would make each of them a command
 * injection, so there is deliberately no code path here that builds one.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { registerCommands } from "../bridge/index.js";
import { dataPath, readJson, writeJsonAtomic } from "./paths.js";
import { findProject, markProjectUsed } from "./projects.js";

// ---------------------------------------------------------------------------
// Shapes (must match the serde output desktop/src/lib/api.ts was written for)
// ---------------------------------------------------------------------------

/** `ExecutionEnvironment` in api.ts. */
export type ExecutionEnvironment = "local" | "worktree";

/** Work and Code are behaviour profiles over one workspace, not two roots. */
export type TaskMode = "work" | "code";

export interface WorkspaceSnapshot {
  id: string;
  label: string;
  reference: string;
  commit: string;
  createdAtMs: number;
}

export interface WorkspaceHandoff {
  branch: string;
  commit: string;
  snapshotId: string;
  createdAtMs: number;
}

export interface WorkspaceGitChange {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  stagedDiff: string;
  unstagedDiff: string;
  truncated: boolean;
}

export interface WorkspaceGitDiff {
  head: string | null;
  branch: string | null;
  detached: boolean;
  remotes: string[];
  changes: WorkspaceGitChange[];
}

export interface WorkspaceGitCommit {
  commit: string;
  summary: string;
}

export interface WorkspaceFileEntry {
  path: string;
  size: number;
  modifiedAt: number;
}

export interface TaskWorkspaceModeStatus {
  mode: TaskMode;
  initialized: boolean;
  rootPath: string;
  isGit: boolean;
  fileCount: number;
  fileCountCapped: boolean;
  changedFiles: string[];
  deliverables: WorkspaceFileEntry[];
  transferableFiles: WorkspaceFileEntry[];
}

export interface TaskWorkspaceOverview {
  work: TaskWorkspaceModeStatus;
  code: TaskWorkspaceModeStatus;
  environment: ExecutionEnvironment;
  initialized: boolean;
  rootPath: string;
  projectRoot: string | null;
  head: string | null;
  branch: string | null;
  detached: boolean;
  snapshots: WorkspaceSnapshot[];
  handoffs: WorkspaceHandoff[];
}

/** Persisted state; `PathBuf` fields were plain JSON strings on the Rust side. */
interface WorkspaceDescriptor {
  taskId: string;
  environment: ExecutionEnvironment;
  initialized: boolean;
  projectRoot: string | null;
  repositoryRoot: string | null;
  worktreeRoot: string | null;
  activeRoot: string;
  /** Path of the project inside its repository, slash-joined, `""` at the root. */
  relativeProject: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  createdAtMs: number;
  snapshots: WorkspaceSnapshot[];
  handoffs: WorkspaceHandoff[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_VERSION = 1;
const SNAPSHOT_REF_ROOT = "refs/tietiezhi/snapshots";
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_INCLUDED_FILE_BYTES = 100 * 1024 * 1024;
const MAX_INCLUDED_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_SCANNED_FILES = 5_000;
const MAX_LISTED_FILES = 24;
const MAX_COMMIT_MESSAGE_BYTES = 10_000;

const DISABLED_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

/** Local Git work is fast; a longer budget only hides a wedged child. */
const GIT_TIMEOUT_MS = 60_000;
/** Push talks to a remote, so it gets its own budget. */
const GIT_NETWORK_TIMEOUT_MS = 180_000;

const DELIVERABLE_EXTENSIONS = new Set([
  "md",
  "txt",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "csv",
  "html",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "svg",
  "json",
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Errors raised by the ported agent-git layer.
 *
 * The Rust command layer wrapped every one of them with `工作区操作失败：`
 * while returning its own messages (`任务工作区尚未创建`, …) untouched. Keeping
 * the two kinds apart reproduces that split without threading a result type
 * through the whole module.
 */
class WorkspaceRuntimeError extends Error {}

function invalid(message: string): WorkspaceRuntimeError {
  return new WorkspaceRuntimeError(`invalid workspace request: ${message}`);
}

function notGit(path: string): WorkspaceRuntimeError {
  return new WorkspaceRuntimeError(`not a Git repository: ${path}`);
}

function stateNotFound(taskId: string): WorkspaceRuntimeError {
  return new WorkspaceRuntimeError(`workspace state was not found: ${taskId}`);
}

function ioError(error: unknown): WorkspaceRuntimeError {
  return new WorkspaceRuntimeError(`I/O error: ${describe(error)}`);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function mapRuntimeError<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof WorkspaceRuntimeError) {
      throw new Error(`工作区操作失败：${error.message}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Git process
// ---------------------------------------------------------------------------

interface GitOutput {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
}

interface GitOptions {
  /** Extra environment entries, e.g. `GIT_INDEX_FILE` for snapshots. */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

/**
 * Runs `git` with an argv array — never a shell.
 *
 * stdout stays a Buffer because `status --porcelain -z` is parsed byte-wise and
 * a text decode would destroy the NUL record separators. stderr is kept because
 * Git's own diagnostics ("nothing to commit", "rejected — non-fast-forward")
 * are the only useful part of a failure for the user.
 */
function gitRaw(root: string, args: readonly string[], options: GitOptions = {}): Promise<GitOutput> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-c", `core.hooksPath=${DISABLED_HOOKS_PATH}`, ...args], {
      cwd: root,
      // GIT_TERMINAL_PROMPT=0 turns a credential prompt on a push into an
      // immediate error instead of a child that blocks until the timeout.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

    const settle = (result: GitOutput | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) rejectPromise(result);
      else resolvePromise(result);
    };

    child.on("error", (error) => settle(new Error(`无法执行 Git：${error.message}`)));
    child.on("close", (code) => {
      if (timedOut) {
        settle(new Error(`Git 命令超时：git ${args.join(" ")}`));
        return;
      }
      settle({ ok: code === 0, stdout: Buffer.concat(stdout), stderr: stderr.join("") });
    });
  });
}

function gitFailure(args: readonly string[], stderr: string): WorkspaceRuntimeError {
  return new WorkspaceRuntimeError(`Git command failed: git ${args.join(" ")}: ${stderr.trim()}`);
}

/** Runs a command for its bytes, throwing with Git's stderr on failure. */
async function gitOutput(
  root: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<Buffer> {
  const result = await gitRaw(root, args, options);
  if (!result.ok) throw gitFailure(args, result.stderr);
  return result.stdout;
}

/** Trimmed stdout, matching agent-git's `git_stdout`. */
async function gitText(
  root: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  return (await gitOutput(root, args, options)).toString("utf8").trim();
}

async function runGit(
  root: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<void> {
  await gitOutput(root, args, options);
}

/** Trimmed stdout, or `null` when the command failed — agent-git's `git_optional`. */
async function gitOptional(root: string, args: readonly string[]): Promise<string | null> {
  try {
    return await gitText(root, args);
  } catch {
    return null;
  }
}

/** Exit status only — agent-git's `git_status`. */
async function gitSucceeds(root: string, args: readonly string[]): Promise<boolean> {
  return (await gitRaw(root, args)).ok;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * macOS and Windows resolve paths case-insensitively, so a containment check
 * that compares raw strings can be walked straight past with `/Repo` vs
 * `/repo`. Both sides are folded before comparison on those platforms.
 */
const CASE_INSENSITIVE_PATHS = process.platform === "darwin" || process.platform === "win32";

function foldPath(path: string): string {
  return CASE_INSENSITIVE_PATHS ? path.toLowerCase() : path;
}

/**
 * True when `candidate` is `root` or sits underneath it.
 *
 * The separator is required after the prefix: without it `/data/workspace-evil`
 * counts as inside `/data/workspace`. Both arguments must already be resolved
 * with {@link realpath} when the answer is a security decision, otherwise a
 * symlink inside the workspace can still point out of it.
 */
function isInsidePath(root: string, candidate: string): boolean {
  const foldedRoot = foldPath(root);
  const foldedCandidate = foldPath(candidate);
  if (foldedCandidate === foldedRoot) return true;
  const prefix = foldedRoot.endsWith(sep) ? foldedRoot : `${foldedRoot}${sep}`;
  return foldedCandidate.startsWith(prefix);
}

/** Slash-joined relative path, or `null` when `candidate` is outside `root`. */
function relativeWithin(root: string, candidate: string): string | null {
  if (!isInsidePath(root, candidate)) return null;
  return slashPath(relative(root, candidate));
}

/** Drops `.`/`..`/root components and joins with `/`, like agent-git's `slash_path`. */
function slashPath(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");
}

/** Rejects anything that is not a plain relative path — renderer input. */
function looksAbsolute(path: string): boolean {
  return isAbsolute(path) || /^[\\/]/.test(path) || /^[A-Za-z]:/.test(path);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isPlainFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw ioError(error);
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!(await isDirectory(path))) {
    throw invalid(`directory does not exist: ${path}`);
  }
  return canonical(path);
}

/** `workspace.rs::canonical_or_original`; the name is Rust's, the behaviour is a hard resolve. */
async function canonicalOrOriginal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new Error(`无法解析任务工作区：${describe(error)}`);
  }
}

function nowMs(): number {
  return Date.now();
}

/**
 * UUIDv7, matching the Rust `Uuid::now_v7()` used for snapshot ids: the
 * timestamp prefix keeps `indexes/<id>.index` and the snapshot list sortable by
 * creation time.
 */
function uuidV7(): string {
  const bytes = randomBytes(16);
  const milliseconds = Date.now();
  bytes[0] = Math.floor(milliseconds / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(milliseconds / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(milliseconds / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(milliseconds / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(milliseconds / 2 ** 8) & 0xff;
  bytes[5] = milliseconds & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Task ids become path segments, so only a hyphenated UUID is accepted. */
function validateTaskId(taskId: string): void {
  if (!UUID.test(taskId)) throw new Error("非法的任务 ID");
}

function validateSnapshotId(snapshotId: string): void {
  if (!UUID.test(snapshotId)) throw invalid("snapshot id must be a UUID");
}

/**
 * Commit ids read back out of the state file end up as `git reset` arguments.
 * A tampered state file could otherwise smuggle an option in there, so only a
 * bare object name is accepted (40 hex for SHA-1, 64 for SHA-256).
 */
function validateCommitId(commit: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw invalid(`invalid commit id: ${commit}`);
}

async function validateBranch(root: string, branch: string): Promise<void> {
  if (branch.trim() !== branch || branch === "") {
    throw invalid("branch name must not be empty or padded");
  }
  // A leading dash would be read as an option by every Git subcommand that
  // takes a branch name, including the validator below.
  if (branch.startsWith("-")) throw invalid(`invalid branch name: ${branch}`);
  await runGit(root, ["check-ref-format", "--branch", branch]);
}

/**
 * Remotes are used as positional arguments (`push <remote> …`,
 * `remote get-url <remote>`), so a leading dash has to go before Git sees it.
 */
function validateRemoteName(remote: string): void {
  if (remote === "" || remote.startsWith("-")) throw invalid(`unknown Git remote: ${remote}`);
}

/** `workspace.rs::checked_relative_path`, returning the slash form. */
function checkedRelativePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || looksAbsolute(trimmed)) throw new Error("非法的工作区文件路径");
  const segments = trimmed.split(/[\\/]+/);
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new Error("非法的工作区文件路径");
    kept.push(segment);
  }
  if (kept.length === 0) throw new Error("非法的工作区文件路径");
  return kept.join("/");
}

/** agent-git's `validate_scoped_paths`: sorted, de-duplicated, escape-free. */
function validateScopedPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) throw invalid("at least one path must be selected");
  const validated: string[] = [];
  for (const raw of paths) {
    if (raw.trim() === "" || looksAbsolute(raw)) throw invalid(`invalid workspace path: ${raw}`);
    const kept: string[] = [];
    for (const segment of raw.split(/[\\/]+/)) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") throw invalid(`invalid workspace path: ${raw}`);
      kept.push(segment);
    }
    if (kept.length === 0) throw invalid(`invalid workspace path: ${raw}`);
    validated.push(kept.join("/"));
  }
  validated.sort();
  return [...new Set(validated)];
}

/** Prefixes a workspace-relative path with the project's position in the repo. */
function repositoryPath(descriptor: WorkspaceDescriptor, path: string): string {
  return descriptor.relativeProject === "" ? path : `${descriptor.relativeProject}/${path}`;
}

// ---------------------------------------------------------------------------
// Descriptor store
// ---------------------------------------------------------------------------

function stateRoot(): string {
  return dataPath("agent-runtime", "git-workspaces");
}

function statePath(taskId: string): string {
  return join(stateRoot(), "states", `${taskId}.json`);
}

function snapshotIndexPath(snapshotId: string): string {
  return join(stateRoot(), "indexes", `${snapshotId}.index`);
}

function taskRoot(taskId: string): string {
  validateTaskId(taskId);
  return dataPath("tasks", taskId);
}

function sharedWorkspacePath(taskId: string): string {
  return join(taskRoot(taskId), "workspace");
}

/** Pre-R29 layout: one directory per task mode under `tasks/<id>/workspaces/`. */
function legacyModeWorkspacePath(taskId: string, mode: TaskMode): string {
  return join(taskRoot(taskId), "workspaces", mode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readEnvironment(value: unknown): ExecutionEnvironment {
  return value === "worktree" ? "worktree" : "local";
}

function parseSnapshots(value: unknown): WorkspaceSnapshot[] {
  if (!Array.isArray(value)) return [];
  const snapshots: WorkspaceSnapshot[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = entry["id"];
    const commit = entry["commit"];
    if (typeof id !== "string" || typeof commit !== "string") continue;
    snapshots.push({
      id,
      label: typeof entry["label"] === "string" ? entry["label"] : "",
      reference: typeof entry["reference"] === "string" ? entry["reference"] : "",
      commit,
      createdAtMs: typeof entry["createdAtMs"] === "number" ? entry["createdAtMs"] : 0,
    });
  }
  return snapshots;
}

function parseHandoffs(value: unknown): WorkspaceHandoff[] {
  if (!Array.isArray(value)) return [];
  const handoffs: WorkspaceHandoff[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const branch = entry["branch"];
    const commit = entry["commit"];
    if (typeof branch !== "string" || typeof commit !== "string") continue;
    handoffs.push({
      branch,
      commit,
      snapshotId: typeof entry["snapshotId"] === "string" ? entry["snapshotId"] : "",
      createdAtMs: typeof entry["createdAtMs"] === "number" ? entry["createdAtMs"] : 0,
    });
  }
  return handoffs;
}

/**
 * Reads `states/<taskId>.json`.
 *
 * A missing file means "no workspace yet", but an unreadable or mismatched one
 * is an error rather than a silent `null`: treating corruption as absence would
 * let the next resolve create a fresh descriptor on top of it and drop every
 * snapshot reference the user still has.
 */
async function readDescriptor(taskId: string): Promise<WorkspaceDescriptor | null> {
  validateTaskId(taskId);
  let raw: string;
  try {
    raw = await readFile(statePath(taskId), "utf8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return null;
    throw ioError(error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new WorkspaceRuntimeError(`JSON error: ${describe(error)}`);
  }
  const state = isRecord(parsed) ? parsed : null;
  const descriptor = state !== null && isRecord(state["descriptor"]) ? state["descriptor"] : null;
  if (
    state === null ||
    descriptor === null ||
    state["version"] !== STATE_VERSION ||
    descriptor["taskId"] !== taskId ||
    typeof descriptor["activeRoot"] !== "string"
  ) {
    throw invalid(`unsupported workspace state for \`${taskId}\``);
  }
  return {
    taskId,
    environment: readEnvironment(descriptor["environment"]),
    initialized: descriptor["initialized"] === true,
    projectRoot: readOptionalString(descriptor, "projectRoot"),
    repositoryRoot: readOptionalString(descriptor, "repositoryRoot"),
    worktreeRoot: readOptionalString(descriptor, "worktreeRoot"),
    activeRoot: descriptor["activeRoot"],
    relativeProject: slashPath(
      typeof descriptor["relativeProject"] === "string" ? descriptor["relativeProject"] : "",
    ),
    head: readOptionalString(descriptor, "head"),
    branch: readOptionalString(descriptor, "branch"),
    detached: descriptor["detached"] === true,
    createdAtMs: typeof descriptor["createdAtMs"] === "number" ? descriptor["createdAtMs"] : 0,
    snapshots: parseSnapshots(descriptor["snapshots"]),
    handoffs: parseHandoffs(descriptor["handoffs"]),
  };
}

async function persistDescriptor(descriptor: WorkspaceDescriptor): Promise<void> {
  await writeJsonAtomic(statePath(descriptor.taskId), {
    version: STATE_VERSION,
    descriptor,
  });
}

/**
 * Serializes everything this module does.
 *
 * Two reasons, both already paid for in this project: a descriptor is
 * read-modify-write, so concurrent snapshot and environment changes would drop
 * each other's edits; and concurrent `git add`/`git status` on one repository
 * fight over `index.lock` and fail with nothing useful to show the user.
 */
let workspaceQueue: Promise<unknown> = Promise.resolve();

function withWorkspace<T>(task: () => Promise<T>): Promise<T> {
  const next = workspaceQueue.then(task, task);
  // Keep the chain alive after a rejection so one failure cannot wedge it.
  workspaceQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// ---------------------------------------------------------------------------
// Repository discovery
// ---------------------------------------------------------------------------

interface RepositoryContext {
  repositoryRoot: string;
  /** Slash-joined path of the project inside the repository. */
  relativeProject: string;
}

async function repositoryContext(projectRoot: string): Promise<RepositoryContext> {
  const result = await gitRaw(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) throw notGit(projectRoot);
  const repositoryRoot = await canonical(result.stdout.toString("utf8").trim());
  const relativeProject = relativeWithin(repositoryRoot, await canonical(projectRoot));
  if (relativeProject === null) throw invalid("project is outside its Git root");
  return { repositoryRoot, relativeProject };
}

async function repositoryContextOptional(projectRoot: string): Promise<RepositoryContext | null> {
  try {
    return await repositoryContext(projectRoot);
  } catch {
    return null;
  }
}

async function currentBranch(root: string): Promise<string | null> {
  const branch = await gitOptional(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch === null || branch.trim() === "") return null;
  return branch.trim();
}

async function isGitDirectory(root: string): Promise<boolean> {
  const value = await gitOptional(root, ["rev-parse", "--is-inside-work-tree"]);
  return value === "true";
}

/** The directory Git commands run in: the worktree, or the project's repository. */
function gitCommandRoot(descriptor: WorkspaceDescriptor): string | null {
  return descriptor.environment === "worktree" ? descriptor.worktreeRoot : descriptor.repositoryRoot;
}

// ---------------------------------------------------------------------------
// Status, diff
// ---------------------------------------------------------------------------

function splitNul(buffer: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      if (index > start) records.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < buffer.length) records.push(buffer.subarray(start));
  return records;
}

/** Strips the project prefix off a repository-relative path. */
function stripProjectPrefix(prefix: string, path: string): string | null {
  const normalized = slashPath(path);
  if (prefix === "") return normalized;
  if (normalized === prefix) return "";
  return normalized.startsWith(`${prefix}/`) ? normalized.slice(prefix.length + 1) : null;
}

interface GitStatusEntry {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

const SPACE = 0x20;
const QUESTION = 0x3f;
const RENAME = 0x52;
const COPY = 0x43;

/**
 * Parses `status --porcelain=v1 -z`: `XY<space><path>` per NUL record, with
 * renames and copies followed by a second record holding the origin path.
 */
function parseStatusEntries(stdout: Buffer, projectPrefix: string): GitStatusEntry[] {
  const records = splitNul(stdout);
  const entries: GitStatusEntry[] = [];
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    if (record !== undefined && record.length >= 4) {
      const x = record[0] ?? SPACE;
      const y = record[1] ?? SPACE;
      const path = stripProjectPrefix(projectPrefix, record.subarray(3).toString("utf8"));
      if (path !== null && path !== "") {
        entries.push({
          path,
          staged: x !== SPACE && x !== QUESTION,
          unstaged: y !== SPACE && y !== QUESTION,
          untracked: x === QUESTION && y === QUESTION,
        });
      }
      if (x === RENAME || x === COPY || y === RENAME || y === COPY) index += 1;
    }
    index += 1;
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return entries;
}

async function gitStatusEntries(
  root: string,
  projectPrefix: string,
): Promise<GitStatusEntry[]> {
  const stdout = await gitOutput(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseStatusEntries(stdout, projectPrefix);
}

async function listChangedFiles(root: string, projectPrefix: string): Promise<string[]> {
  const entries = await gitStatusEntries(root, projectPrefix);
  return [...new Set(entries.map((entry) => entry.path))].sort();
}

async function gitFileDiff(root: string, staged: boolean, path: string): Promise<string> {
  const args = ["diff", "--no-ext-diff", "--no-color"];
  if (staged) args.push("--cached");
  // `--` keeps a path that starts with a dash out of Git's option parser.
  args.push("--", path);
  return gitText(root, args);
}

/** Rust's `str::lines()`: split on `\n`, drop a trailing empty line, strip `\r`. */
function textLines(value: string): string[] {
  if (value === "") return [];
  const parts = value.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Synthesises an "all added" diff for a file Git does not track yet. */
async function untrackedDiff(path: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw ioError(error);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return "Binary or non-regular untracked file\n";
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw ioError(error);
  }
  const head = bytes.subarray(0, MAX_DIFF_BYTES);
  if (head.includes(0)) return "Binary untracked file\n";
  let diff = `--- /dev/null\n+++ b/${basename(path)}\n`;
  for (const line of textLines(head.toString("utf8"))) {
    diff += `+${line}\n`;
  }
  return diff;
}

function truncateDiff(diff: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(diff, "utf8");
  if (bytes.length <= MAX_DIFF_BYTES) return { text: diff, truncated: false };
  // Walk back off any UTF-8 continuation byte so the cut never splits a rune.
  let end = MAX_DIFF_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return {
    text: `${bytes.subarray(0, end).toString("utf8")}\n… diff truncated …\n`,
    truncated: true,
  };
}

async function listRemotes(root: string): Promise<string[]> {
  const stdout = await gitText(root, ["remote"]);
  const remotes = textLines(stdout)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return [...new Set(remotes)].sort();
}

// ---------------------------------------------------------------------------
// .worktreeinclude
// ---------------------------------------------------------------------------

interface IncludeRule {
  exclude: boolean;
  matcher: RegExp;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Translates one glob segment; `*` and `?` never cross a separator. */
function translateGlobSegment(segment: string, raw: string): string {
  let source = "";
  let index = 0;
  while (index < segment.length) {
    const character = segment[index] ?? "";
    if (character === "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    if (character === "[") {
      let cursor = index + 1;
      let negated = false;
      if (segment[cursor] === "!" || segment[cursor] === "^") {
        negated = true;
        cursor += 1;
      }
      const contentStart = cursor;
      // A `]` immediately after the (optional) negation is a literal member.
      if (segment[cursor] === "]") cursor += 1;
      while (cursor < segment.length && segment[cursor] !== "]") cursor += 1;
      if (cursor >= segment.length) {
        throw invalid(`invalid .worktreeinclude glob \`${raw}\`: unclosed character class`);
      }
      const body = segment.slice(contentStart, cursor).replace(/[\\\]^]/g, "\\$&");
      source += negated ? `[^/${body}]` : `[${body}]`;
      index = cursor + 1;
      continue;
    }
    source += escapeRegExp(character);
    index += 1;
  }
  return source;
}

/** globset with `literal_separator(true)`: `**` is the only separator-crossing token. */
function compileGlob(pattern: string, raw: string): RegExp {
  const segments = pattern.split("/");
  let source = "^";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]*/)*";
      return;
    }
    source += translateGlobSegment(segment, raw);
    if (!last) source += "/";
  });
  return new RegExp(`${source}$`);
}

function parseIncludeRules(contents: string): IncludeRule[] {
  const rules: IncludeRule[] = [];
  for (const line of textLines(contents)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const exclude = trimmed.startsWith("!");
    const raw = (exclude ? trimmed.slice(1) : trimmed).replace(/^\/+/, "");
    if (
      raw === "" ||
      looksAbsolute(raw) ||
      raw.split(/[\\/]/).some((segment) => segment === "..")
    ) {
      throw invalid(`invalid .worktreeinclude rule \`${raw}\``);
    }
    let pattern = raw.replace(/\\/g, "/");
    if (pattern.endsWith("/")) pattern += "**";
    else if (!pattern.includes("/")) pattern = `**/${pattern}`;
    rules.push({ exclude, matcher: compileGlob(pattern, raw) });
  }
  return rules;
}

/**
 * Files a `.worktreeinclude` opts back in — normally secrets and local config
 * that `.gitignore` hides but the task still needs captured in a snapshot.
 */
async function includedPaths(root: string): Promise<string[]> {
  let contents: string;
  try {
    contents = await readFile(join(root, ".worktreeinclude"), "utf8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return [];
    throw ioError(error);
  }
  const rules = parseIncludeRules(contents);
  if (rules.length === 0) return [];
  const paths: string[] = [];
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) break;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw invalid(`scan .worktreeinclude files: ${describe(error)}`);
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const slash = slashPath(relative(root, full));
      let included = false;
      for (const rule of rules) {
        if (rule.matcher.test(slash)) included = !rule.exclude;
      }
      if (!included) continue;
      let size: number;
      try {
        size = (await lstat(full)).size;
      } catch (error) {
        throw invalid(`read included file metadata for \`${slash}\`: ${describe(error)}`);
      }
      if (size > MAX_INCLUDED_FILE_BYTES) {
        throw invalid(`.worktreeinclude file exceeds 100 MB: ${slash}`);
      }
      total += size;
      if (total > MAX_INCLUDED_TOTAL_BYTES) {
        throw invalid(".worktreeinclude exceeds the 1 GB total limit");
      }
      paths.push(slash);
    }
  }
  return [...new Set(paths)].sort();
}

// ---------------------------------------------------------------------------
// Runtime: descriptor lifecycle
// ---------------------------------------------------------------------------

/** Refreshes the volatile fields of a stored descriptor without persisting. */
async function resolveExisting(descriptor: WorkspaceDescriptor): Promise<WorkspaceDescriptor> {
  const resolved: WorkspaceDescriptor = { ...descriptor };
  if (resolved.environment === "worktree") {
    const root = resolved.worktreeRoot;
    if (root === null) throw invalid("worktree root is missing");
    if (!(await isDirectory(root))) throw invalid(`worktree no longer exists: ${root}`);
    resolved.activeRoot = await canonical(
      resolved.relativeProject === "" ? root : join(root, resolved.relativeProject),
    );
    resolved.head = await gitOptional(root, ["rev-parse", "HEAD"]);
    resolved.branch = await currentBranch(root);
    resolved.detached = resolved.branch === null;
  } else {
    resolved.activeRoot = await canonicalDirectory(resolved.activeRoot);
  }
  return resolved;
}

/**
 * Builds the descriptor for a project-bound task.
 *
 * Worktree creation from the Rust build is deliberately absent. This host runs
 * every task in the project directory itself — nothing in the Electron
 * execution path creates or checks out a managed worktree — so minting one here
 * would point the Git panel at a directory the agent never writes to. Existing
 * worktree descriptors carried over from the Tauri profile are still read,
 * diffed, snapshotted and handed off; only new ones are refused, matching the
 * `已禁用 Git Worktree` policy the environment switch already enforces.
 */
async function createProjectEnvironment(
  taskId: string,
  projectRoot: string,
  environment: ExecutionEnvironment,
  createdAtMs: number,
): Promise<WorkspaceDescriptor> {
  if (environment !== "local") {
    throw invalid("已禁用 Git Worktree，任务只允许使用 Local 环境");
  }
  const context = await repositoryContextOptional(projectRoot);
  return {
    taskId,
    environment: "local",
    initialized: true,
    projectRoot,
    repositoryRoot: context?.repositoryRoot ?? null,
    worktreeRoot: null,
    activeRoot: projectRoot,
    relativeProject: context?.relativeProject ?? "",
    head: context === null ? null : await gitOptional(context.repositoryRoot, ["rev-parse", "HEAD"]),
    branch: context === null ? null : await currentBranch(context.repositoryRoot),
    detached: false,
    createdAtMs,
    snapshots: [],
    handoffs: [],
  };
}

/** agent-git's `WorkspaceRuntime::resolve`. */
async function resolveDescriptor(
  taskId: string,
  projectRoot: string | null,
  managedWorkspaceRoot: string,
  preferredEnvironment: ExecutionEnvironment | null,
): Promise<WorkspaceDescriptor> {
  validateTaskId(taskId);
  const existing = await readDescriptor(taskId);
  if (existing !== null) return resolveExisting(existing);
  const createdAtMs = nowMs();
  let descriptor: WorkspaceDescriptor;
  if (projectRoot === null) {
    try {
      await mkdir(managedWorkspaceRoot, { recursive: true });
    } catch (error) {
      throw ioError(error);
    }
    descriptor = {
      taskId,
      environment: "local",
      initialized: true,
      projectRoot: null,
      repositoryRoot: null,
      worktreeRoot: null,
      activeRoot: await canonical(managedWorkspaceRoot),
      relativeProject: "",
      head: null,
      branch: null,
      detached: false,
      createdAtMs,
      snapshots: [],
      handoffs: [],
    };
  } else {
    descriptor = await createProjectEnvironment(
      taskId,
      await canonicalDirectory(projectRoot),
      preferredEnvironment ?? "local",
      createdAtMs,
    );
  }
  await persistDescriptor(descriptor);
  return descriptor;
}

/** agent-git's `WorkspaceRuntime::adopt`: register a pre-R29 directory in place. */
async function adoptDescriptor(
  taskId: string,
  projectRoot: string | null,
  activeRootInput: string,
): Promise<WorkspaceDescriptor> {
  validateTaskId(taskId);
  const existing = await readDescriptor(taskId);
  if (existing !== null) return resolveExisting(existing);

  const activeRoot = await canonicalDirectory(activeRootInput);
  const canonicalProjectRoot = projectRoot === null ? null : await canonicalDirectory(projectRoot);
  const activeContext = await repositoryContextOptional(activeRoot);
  const sourceContext =
    canonicalProjectRoot === null ? null : await repositoryContextOptional(canonicalProjectRoot);

  // A registered Git worktree keeps its own toplevel and a `.git` *file*; both
  // signals distinguish it from the project checkout itself.
  const isManagedWorktree =
    activeContext !== null &&
    ((sourceContext !== null && activeContext.repositoryRoot !== sourceContext.repositoryRoot) ||
      (await isPlainFile(join(activeRoot, ".git"))));

  const repositoryRoot =
    sourceContext?.repositoryRoot ?? activeContext?.repositoryRoot ?? null;
  const worktreeRoot = isManagedWorktree ? (activeContext?.repositoryRoot ?? null) : null;
  const relativeProject =
    (worktreeRoot === null ? null : relativeWithin(worktreeRoot, activeRoot)) ??
    sourceContext?.relativeProject ??
    "";
  const commandRoot = worktreeRoot ?? repositoryRoot;
  const branch = commandRoot === null ? null : await currentBranch(commandRoot);

  const descriptor: WorkspaceDescriptor = {
    taskId,
    environment: isManagedWorktree ? "worktree" : "local",
    initialized: true,
    projectRoot: canonicalProjectRoot,
    repositoryRoot,
    worktreeRoot,
    activeRoot,
    relativeProject,
    head: commandRoot === null ? null : await gitOptional(commandRoot, ["rev-parse", "HEAD"]),
    branch,
    detached: isManagedWorktree && branch === null,
    createdAtMs: nowMs(),
    snapshots: [],
    handoffs: [],
  };
  await persistDescriptor(descriptor);
  return descriptor;
}

/** `git rev-parse --show-toplevel` with `workspace.rs`'s user-facing wording. */
async function gitProject(projectRoot: string): Promise<{ gitRoot: string; relativeProject: string } | null> {
  const result = await gitRaw(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) return null;
  let gitRoot: string;
  try {
    gitRoot = await realpath(result.stdout.toString("utf8").trim());
  } catch {
    return null;
  }
  const relativeProject = relativeWithin(gitRoot, projectRoot);
  if (relativeProject === null) return null;
  return { gitRoot, relativeProject };
}

async function resolveExistingProjectWorkspace(
  projectRoot: string,
  workspace: string,
): Promise<string> {
  if (await pathExists(join(workspace, ".git"))) {
    const project = await gitProject(projectRoot);
    if (project !== null && project.relativeProject !== "") {
      const active = join(workspace, project.relativeProject);
      if (await isDirectory(active)) return canonicalOrOriginal(active);
    }
  }
  return canonicalOrOriginal(workspace);
}

async function resolveProjectDirectory(root: string): Promise<string> {
  if (!(await isDirectory(root))) throw new Error("项目文件夹不存在");
  try {
    return await realpath(root);
  } catch (error) {
    throw new Error(`无法解析项目目录：${describe(error)}`);
  }
}

async function projectRootForId(projectId: string | null): Promise<string | null> {
  const trimmed = projectId?.trim() ?? "";
  if (trimmed === "") return null;
  const project = await findProject(trimmed);
  if (project === null) throw new Error("找不到任务绑定的项目");
  return resolveProjectDirectory(project.rootPath);
}

/** Project binding of a task, read from `tasks/<id>/task.json`. */
export async function conversationProjectId(taskId: string): Promise<string | null> {
  validateTaskId(taskId);
  const stored = await readJson<unknown>(join(taskRoot(taskId), "task.json"), null);
  if (!isRecord(stored)) throw new Error("任务记录不存在或已损坏");
  const projectId = stored["projectId"];
  if (typeof projectId !== "string" || projectId.trim() === "") return null;
  return projectId.trim();
}

async function adoptLegacyWorkspace(
  taskId: string,
  projectId: string | null,
): Promise<WorkspaceDescriptor | null> {
  const existing = await readDescriptor(taskId);
  if (existing !== null) return resolveExisting(existing);
  const projectRoot = await projectRootForId(projectId);
  for (const candidate of [
    sharedWorkspacePath(taskId),
    legacyModeWorkspacePath(taskId, "code"),
    legacyModeWorkspacePath(taskId, "work"),
  ]) {
    if (!(await isDirectory(candidate))) continue;
    const activeRoot =
      projectRoot === null
        ? await canonicalOrOriginal(candidate)
        : await resolveExistingProjectWorkspace(projectRoot, candidate);
    return adoptDescriptor(taskId, projectRoot, activeRoot);
  }
  return null;
}

/**
 * The single writable root a task owns. `TaskMode` only changes model and tool
 * behaviour; it never selects another filesystem root.
 */
/**
 * Exported so the terminal module opens shells in the same directory the
 * Git panel reports on; two independent notions of "the task's cwd" would
 * silently diverge.
 */
export async function resolveTaskWorkspace(
  projectId: string | null,
  taskId: string | null,
): Promise<string> {
  if (taskId === null) throw new Error("任务尚未创建");
  validateTaskId(taskId);
  const adopted = await adoptLegacyWorkspace(taskId, projectId);
  if (adopted !== null) return canonicalOrOriginal(adopted.activeRoot);
  const projectRoot = await projectRootForId(projectId);
  const descriptor = await resolveDescriptor(
    taskId,
    projectRoot,
    sharedWorkspacePath(taskId),
    "local",
  );
  const trimmed = projectId?.trim() ?? "";
  if (trimmed !== "") {
    // Best-effort recency bump, exactly as the Rust `let _ =` did.
    await markProjectUsed(trimmed).catch(() => undefined);
  }
  return canonicalOrOriginal(descriptor.activeRoot);
}

async function ensureWorkspaceDescriptor(taskId: string): Promise<WorkspaceDescriptor> {
  validateTaskId(taskId);
  const projectId = await conversationProjectId(taskId);
  await resolveTaskWorkspace(projectId, taskId);
  const descriptor = await readDescriptor(taskId);
  if (descriptor === null) throw new Error("任务工作区尚未创建");
  return descriptor;
}

async function requireGitDescriptor(taskId: string): Promise<WorkspaceDescriptor> {
  const descriptor = await readDescriptor(taskId);
  if (descriptor === null) throw stateNotFound(taskId);
  if (gitCommandRoot(descriptor) === null) throw notGit(descriptor.activeRoot);
  return descriptor;
}

// ---------------------------------------------------------------------------
// Runtime: Git operations
// ---------------------------------------------------------------------------

async function hasChanges(taskId: string): Promise<boolean> {
  const descriptor = await readDescriptor(taskId);
  if (descriptor === null) throw stateNotFound(taskId);
  const root = gitCommandRoot(descriptor);
  if (root === null) return false;
  return (await gitOutput(root, ["status", "--porcelain=v1", "-z"])).length > 0;
}

async function changedFiles(taskId: string): Promise<string[]> {
  const descriptor = await readDescriptor(taskId);
  if (descriptor === null) throw stateNotFound(taskId);
  const root = gitCommandRoot(descriptor);
  if (root === null) return [];
  return listChangedFiles(root, descriptor.relativeProject);
}

async function workspaceDiff(taskId: string): Promise<WorkspaceGitDiff> {
  const descriptor = await readDescriptor(taskId);
  if (descriptor === null) throw stateNotFound(taskId);
  const root = gitCommandRoot(descriptor);
  if (root === null) throw notGit(descriptor.activeRoot);

  const changes: WorkspaceGitChange[] = [];
  for (const status of await gitStatusEntries(root, descriptor.relativeProject)) {
    const inRepository = repositoryPath(descriptor, status.path);
    const staged = truncateDiff(status.staged ? await gitFileDiff(root, true, inRepository) : "");
    const unstagedRaw = status.untracked
      ? await untrackedDiff(join(descriptor.activeRoot, status.path))
      : status.unstaged
        ? await gitFileDiff(root, false, inRepository)
        : "";
    const unstaged = truncateDiff(unstagedRaw);
    changes.push({
      path: status.path,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      stagedDiff: staged.text,
      unstagedDiff: unstaged.text,
      truncated: staged.truncated || unstaged.truncated,
    });
  }

  const branch = await currentBranch(root);
  return {
    head: await gitOptional(root, ["rev-parse", "--verify", "HEAD"]),
    branch,
    detached: branch === null,
    remotes: await listRemotes(root),
    changes,
  };
}

async function stagePaths(taskId: string, paths: readonly string[]): Promise<WorkspaceGitDiff> {
  const descriptor = await requireGitDescriptor(taskId);
  const root = gitCommandRoot(descriptor);
  if (root === null) throw notGit(descriptor.activeRoot);
  const scoped = validateScopedPaths(paths).map((path) => repositoryPath(descriptor, path));
  await runGit(root, ["add", "--", ...scoped]);
  return workspaceDiff(taskId);
}

async function unstagePaths(taskId: string, paths: readonly string[]): Promise<WorkspaceGitDiff> {
  const descriptor = await requireGitDescriptor(taskId);
  const root = gitCommandRoot(descriptor);
  if (root === null) throw notGit(descriptor.activeRoot);
  const scoped = validateScopedPaths(paths).map((path) => repositoryPath(descriptor, path));
  if ((await gitOptional(root, ["rev-parse", "--verify", "HEAD"])) !== null) {
    await runGit(root, ["restore", "--staged", "--", ...scoped]);
  } else {
    // Without a HEAD there is nothing to restore from; drop the index entries.
    await runGit(root, ["rm", "--cached", "--ignore-unmatch", "--", ...scoped]);
  }
  return workspaceDiff(taskId);
}

async function discardPaths(taskId: string, paths: readonly string[]): Promise<WorkspaceGitDiff> {
  const descriptor = await requireGitDescriptor(taskId);
  const root = gitCommandRoot(descriptor);
  if (root === null) throw notGit(descriptor.activeRoot);
  const statuses = await gitStatusEntries(root, descriptor.relativeProject);
  for (const requested of validateScopedPaths(paths)) {
    const status = statuses.find((entry) => entry.path === requested);
    if (status === undefined) throw invalid(`path is not changed: ${requested}`);
    if (status.untracked) {
      await removeUntrackedFile(descriptor.activeRoot, requested);
    } else {
      await runGit(root, [
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        repositoryPath(descriptor, requested),
      ]);
    }
  }
  return workspaceDiff(taskId);
}

/**
 * Deletes one untracked file.
 *
 * The path already passed component validation, but a symlinked directory
 * somewhere along it would still resolve outside the workspace, so the parent
 * is resolved and re-checked before anything is unlinked. Only the parent is
 * resolved: resolving the target itself would follow a symlink and delete what
 * it points at instead of the link.
 */
async function removeUntrackedFile(activeRoot: string, requested: string): Promise<void> {
  const target = join(activeRoot, requested);
  let resolvedParent: string;
  let resolvedRoot: string;
  try {
    resolvedParent = await realpath(dirname(target));
    resolvedRoot = await realpath(activeRoot);
  } catch (error) {
    throw ioError(error);
  }
  if (!isInsidePath(resolvedRoot, resolvedParent)) {
    throw invalid(`invalid workspace path: ${requested}`);
  }
  const resolvedTarget = join(resolvedParent, basename(target));
  let info;
  try {
    info = await lstat(resolvedTarget);
  } catch (error) {
    throw ioError(error);
  }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    throw invalid(`refusing to recursively discard untracked directory: ${requested}`);
  }
  try {
    await unlink(resolvedTarget);
  } catch (error) {
    throw ioError(error);
  }
}

async function commitWorkspace(taskId: string, rawMessage: string): Promise<WorkspaceGitCommit> {
  const descriptor = await requireGitDescriptor(taskId);
  const root = gitCommandRoot(descriptor);
  if (root === null) throw notGit(descriptor.activeRoot);
  const message = rawMessage.trim();
  if (message === "" || Buffer.byteLength(message, "utf8") > MAX_COMMIT_MESSAGE_BYTES) {
    throw invalid("commit message must contain 1 to 10000 bytes");
  }
  // `diff --cached --quiet` exits 0 precisely when the index matches HEAD.
  if (await gitSucceeds(root, ["diff", "--cached", "--quiet"])) {
    throw invalid("there are no staged changes to commit");
  }
  await runGit(root, ["commit", "-m", message]);
  return {
    commit: await gitText(root, ["rev-parse", "HEAD"]),
    summary: await gitText(root, ["show", "-s", "--format=%s", "HEAD"]),
  };
}

async function pushWorkspace(
  taskId: string,
  rawRemote: string,
  branch: string,
): Promise<WorkspaceGitDiff> {
  const descriptor = await requireGitDescriptor(taskId);
  const root = gitCommandRoot(descriptor);
  if (root === null) throw notGit(descriptor.activeRoot);
  const remote = rawRemote.trim();
  validateRemoteName(remote);
  if (!(await listRemotes(root)).includes(remote)) {
    throw invalid(`unknown Git remote: ${remote}`);
  }
  await validateBranch(root, branch);
  await runGit(root, ["push", "--set-upstream", remote, `HEAD:refs/heads/${branch}`], {
    timeoutMs: GIT_NETWORK_TIMEOUT_MS,
  });
  return workspaceDiff(taskId);
}

function githubRepository(remote: string): string | null {
  let path: string | null = null;
  for (const prefix of ["git@github.com:", "ssh://git@github.com/", "https://github.com/"]) {
    if (remote.startsWith(prefix)) {
      path = remote.slice(prefix.length);
      break;
    }
  }
  if (path === null) return null;
  while (path.endsWith("/")) path = path.slice(0, -1);
  while (path.endsWith(".git")) path = path.slice(0, -4);
  const parts = path.split("/");
  if (parts.length !== 2) return null;
  const [owner, repository] = parts;
  if (owner === undefined || repository === undefined || owner === "" || repository === "") {
    return null;
  }
  return `${owner}/${repository}`;
}

async function pullRequestUrl(taskId: string, remote: string, branch: string): Promise<string> {
  const descriptor = await requireGitDescriptor(taskId);
  const root = gitCommandRoot(descriptor);
  if (root === null) throw notGit(descriptor.activeRoot);
  await validateBranch(root, branch);
  validateRemoteName(remote);
  const url = await gitText(root, ["remote", "get-url", remote]);
  const repository = githubRepository(url.trim());
  if (repository === null) throw invalid("pull request links currently require GitHub");
  const symbolic = await gitOptional(root, [
    "symbolic-ref",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  ]);
  const separator = symbolic?.indexOf("/") ?? -1;
  const remoteHead =
    symbolic !== null && separator >= 0 ? symbolic.slice(separator + 1) : "main";
  return `https://github.com/${repository}/compare/${remoteHead}...${branch}?expand=1`;
}

/**
 * Commits the workspace into a private ref through an alternate index.
 *
 * `GIT_INDEX_FILE` points at a scratch index under `git-workspaces/indexes/`,
 * so `add -A` and `write-tree` never touch the index the user is staging into,
 * and the resulting commit is published under `refs/tietiezhi/snapshots/` where
 * it holds the objects alive without appearing as a branch.
 */
async function createSnapshot(
  descriptor: WorkspaceDescriptor,
  label: string,
): Promise<WorkspaceSnapshot> {
  const root = gitCommandRoot(descriptor);
  if (root === null) throw notGit(descriptor.activeRoot);
  const repositoryRoot = (await repositoryContext(root)).repositoryRoot;
  const id = uuidV7();
  const reference = `${SNAPSHOT_REF_ROOT}/${descriptor.taskId}/${id}`;
  const indexPath = snapshotIndexPath(id);
  try {
    await mkdir(dirname(indexPath), { recursive: true });
    await rm(indexPath, { force: true });
  } catch (error) {
    throw ioError(error);
  }

  const indexEnv = { GIT_INDEX_FILE: indexPath } as const;
  try {
    if ((await gitOptional(root, ["rev-parse", "--verify", "HEAD"])) !== null) {
      await runGit(root, ["read-tree", "HEAD"], { env: indexEnv });
    }
    await runGit(root, ["add", "-A"], { env: indexEnv });
    const included = await includedPaths(root);
    if (included.length > 0) {
      await runGit(root, ["add", "-f", "--", ...included], { env: indexEnv });
    }
    const tree = await gitText(root, ["write-tree"], { env: indexEnv });
    const parent = await gitOptional(root, ["rev-parse", "--verify", "HEAD"]);
    const message = label.trim() === "" ? "Codex workspace snapshot" : label.trim();
    const args = ["commit-tree", tree];
    if (parent !== null) args.push("-p", parent);
    args.push("-m", message);
    const commit = await gitText(root, args, {
      env: {
        ...indexEnv,
        GIT_AUTHOR_NAME: "Codex",
        GIT_AUTHOR_EMAIL: "noreply@openai.com",
        GIT_COMMITTER_NAME: "Codex",
        GIT_COMMITTER_EMAIL: "noreply@openai.com",
      },
    });
    await runGit(repositoryRoot, ["update-ref", reference, commit]);
    const snapshot: WorkspaceSnapshot = {
      id,
      label: message,
      reference,
      commit,
      createdAtMs: nowMs(),
    };
    descriptor.snapshots.push(snapshot);
    return snapshot;
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
  }
}

async function snapshotWorkspace(taskId: string, label: string): Promise<WorkspaceSnapshot> {
  const descriptor = await readDescriptor(taskId);
  if (descriptor === null) throw stateNotFound(taskId);
  const snapshot = await createSnapshot(descriptor, label);
  await persistDescriptor(descriptor);
  return snapshot;
}

async function restoreSnapshot(taskId: string, snapshotId: string): Promise<WorkspaceDescriptor> {
  validateSnapshotId(snapshotId);
  const descriptor = await readDescriptor(taskId);
  if (descriptor === null) throw stateNotFound(taskId);
  if (descriptor.environment !== "worktree") {
    throw invalid("snapshots can only be restored into a Worktree environment");
  }
  const snapshot = descriptor.snapshots.find((entry) => entry.id === snapshotId);
  if (snapshot === undefined) throw invalid(`unknown snapshot \`${snapshotId}\``);
  validateCommitId(snapshot.commit);
  if (await hasChanges(taskId)) {
    await createSnapshot(descriptor, "automatic pre-restore snapshot");
  }
  const root = descriptor.worktreeRoot;
  if (root === null) throw invalid("worktree root is missing");
  await runGit(root, ["reset", "--hard", snapshot.commit]);
  await runGit(root, ["clean", "-fd"]);
  descriptor.head = snapshot.commit;
  descriptor.branch = null;
  descriptor.detached = true;
  await persistDescriptor(descriptor);
  return descriptor;
}

function slug(label: string): string | null {
  const flattened = [...label.toLowerCase()]
    .map((character) => (/[0-9a-z]/.test(character) ? character : "-"))
    .join("");
  const parts = flattened
    .split("-")
    .filter((part) => part !== "")
    .slice(0, 6)
    .join("-");
  return parts === "" ? null : parts;
}

async function handoffWorkspace(
  taskId: string,
  requestedBranch: string | null,
  label: string,
): Promise<WorkspaceHandoff> {
  const descriptor = await readDescriptor(taskId);
  if (descriptor === null) throw stateNotFound(taskId);
  if (descriptor.environment !== "worktree") {
    throw invalid("Local environments do not need a Git handoff");
  }
  const snapshot = await createSnapshot(descriptor, label);
  validateCommitId(snapshot.commit);
  const root = descriptor.worktreeRoot;
  if (root === null) throw invalid("worktree root is missing");
  const trimmedRequest = requestedBranch?.trim() ?? "";
  const branch =
    trimmedRequest !== ""
      ? trimmedRequest
      : `codex/${taskId.slice(0, 8)}-${slug(label) ?? "handoff"}`;
  await validateBranch(root, branch);
  if (await gitSucceeds(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    throw invalid(`branch already exists: ${branch}`);
  }
  // `--` after the subcommand keeps the branch name out of option parsing.
  await runGit(root, ["branch", "--", branch, snapshot.commit]);
  const handoff: WorkspaceHandoff = {
    branch,
    commit: snapshot.commit,
    snapshotId: snapshot.id,
    createdAtMs: nowMs(),
  };
  descriptor.handoffs.push(handoff);
  await persistDescriptor(descriptor);
  return handoff;
}

async function setEnvironment(
  taskId: string,
  projectRootInput: string,
  environment: ExecutionEnvironment,
): Promise<WorkspaceDescriptor> {
  validateTaskId(taskId);
  const projectRoot = await canonicalDirectory(projectRootInput);
  const current = await readDescriptor(taskId);
  if (current !== null && current.environment === environment) {
    return resolveExisting(current);
  }

  if (current !== null) {
    if (
      current.environment === "worktree" &&
      current.worktreeRoot !== null &&
      (await hasChanges(taskId))
    ) {
      await createSnapshot(current, "before switching to Local");
    }
    if (environment === "local") {
      const context = await repositoryContextOptional(projectRoot);
      current.environment = "local";
      current.projectRoot = projectRoot;
      current.activeRoot = projectRoot;
      // Falling back to the stored values keeps the Rust behaviour for a
      // project that has stopped being a Git repository: the descriptor stays
      // scoped to the repository it was created against instead of widening to
      // its root.
      current.repositoryRoot = context?.repositoryRoot ?? current.repositoryRoot;
      current.relativeProject = context?.relativeProject ?? current.relativeProject;
      current.head =
        context === null ? null : await gitOptional(context.repositoryRoot, ["rev-parse", "HEAD"]);
      current.branch = context === null ? null : await currentBranch(context.repositoryRoot);
      current.detached = false;
      await persistDescriptor(current);
      return current;
    }
  }

  const created = await createProjectEnvironment(
    taskId,
    projectRoot,
    environment,
    current?.createdAtMs ?? nowMs(),
  );
  if (current !== null) {
    created.snapshots = current.snapshots;
    created.handoffs = current.handoffs;
  }
  await persistDescriptor(created);
  return created;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  // A leading dot makes the whole name a stem, so `.env` has no extension —
  // the same rule Rust's `Path::extension` applies.
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isDeliverable(path: string): boolean {
  return DELIVERABLE_EXTENSIONS.has(fileExtension(path));
}

interface ScanResult {
  files: WorkspaceFileEntry[];
  fileCount: number;
  capped: boolean;
}

/** Walks the workspace, never following links and never entering `.git`. */
async function scanWorkspaceFiles(root: string): Promise<ScanResult> {
  const files: WorkspaceFileEntry[] = [];
  let fileCount = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) break;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (fileCount >= MAX_SCANNED_FILES) return { files, fileCount, capped: true };
      fileCount += 1;
      let info;
      try {
        info = await lstat(full);
      } catch {
        continue;
      }
      files.push({
        path: slashPath(relative(root, full)),
        size: info.size,
        modifiedAt: Math.floor(info.mtimeMs),
      });
    }
  }
  return { files, fileCount, capped: false };
}

async function summarizeWorkspace(
  descriptor: WorkspaceDescriptor,
  mode: TaskMode,
  changed: readonly string[],
): Promise<TaskWorkspaceModeStatus> {
  const root = descriptor.activeRoot;
  const isGit = descriptor.repositoryRoot !== null || (await isGitDirectory(root));
  const changedSet = new Set(changed);
  const scan = await scanWorkspaceFiles(root);
  const files = [...scan.files].sort((left, right) => right.modifiedAt - left.modifiedAt);

  const deliverables = files
    .filter((file) => isDeliverable(file.path) && (!isGit || changedSet.has(file.path)))
    .slice(0, MAX_LISTED_FILES);

  // Work mode offers whatever the user might hand over; Code mode only what Git
  // sees as changed.
  const transferableFiles =
    mode === "work"
      ? (deliverables.length > 0 ? deliverables : files).slice(0, MAX_LISTED_FILES)
      : files.filter((file) => changedSet.has(file.path)).slice(0, MAX_LISTED_FILES);

  return {
    mode,
    initialized: descriptor.initialized,
    rootPath: root,
    isGit,
    fileCount: scan.fileCount,
    fileCountCapped: scan.capped,
    changedFiles: [...changed],
    deliverables,
    transferableFiles,
  };
}

function emptyModeStatus(mode: TaskMode, root: string): TaskWorkspaceModeStatus {
  return {
    mode,
    initialized: false,
    rootPath: root,
    isGit: false,
    fileCount: 0,
    fileCountCapped: false,
    changedFiles: [],
    deliverables: [],
    transferableFiles: [],
  };
}

async function taskWorkspaceOverview(taskId: string): Promise<TaskWorkspaceOverview> {
  validateTaskId(taskId);
  const projectId = await conversationProjectId(taskId);
  const projectRoot = await projectRootForId(projectId);
  const descriptor = await adoptLegacyWorkspace(taskId, projectId);
  const predictedRoot = projectRoot ?? sharedWorkspacePath(taskId);

  if (descriptor === null) {
    return {
      work: emptyModeStatus("work", predictedRoot),
      code: emptyModeStatus("code", predictedRoot),
      environment: "local",
      initialized: false,
      rootPath: predictedRoot,
      projectRoot,
      head: null,
      branch: null,
      detached: false,
      snapshots: [],
      handoffs: [],
    };
  }

  // A repository that disappeared under the task must not hide its file list.
  const changed = await changedFiles(taskId).catch(() => [] as string[]);
  return {
    work: await summarizeWorkspace(descriptor, "work", changed),
    code: await summarizeWorkspace(descriptor, "code", changed),
    environment: descriptor.environment,
    initialized: descriptor.initialized,
    rootPath: descriptor.activeRoot,
    projectRoot: descriptor.projectRoot,
    head: descriptor.head,
    branch: descriptor.branch,
    detached: descriptor.detached,
    snapshots: descriptor.snapshots,
    handoffs: descriptor.handoffs,
  };
}

/**
 * Pre-R29 compatibility. Both modes address the same file now, so nothing is
 * copied once the path has been validated.
 */
async function transferWorkspaceFile(
  taskId: string,
  fromMode: TaskMode,
  toMode: TaskMode,
  path: string,
): Promise<string> {
  if (fromMode === toMode) throw new Error("来源和目标工作方式不能相同");
  const descriptor = await ensureWorkspaceDescriptor(taskId);
  const relativePath = checkedRelativePath(path);
  const file = join(descriptor.activeRoot, relativePath);

  let canonicalFile: string;
  try {
    canonicalFile = await realpath(file);
  } catch {
    throw new Error(`找不到工作区文件：${path}`);
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(descriptor.activeRoot);
  } catch (error) {
    throw new Error(`无法解析工作区：${describe(error)}`);
  }
  if (
    !isInsidePath(canonicalRoot, canonicalFile) ||
    !(await isRegularFile(canonicalFile)) ||
    (await isSymbolicLink(file))
  ) {
    throw new Error("只能交接共享工作区内的普通文件");
  }
  return relativePath;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`缺少参数：${key}`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" ? value : null;
}

function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) throw new Error(`缺少参数：${key}`);
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`参数 ${key} 必须是字符串数组`);
    items.push(item);
  }
  return items;
}

function requireTaskMode(args: Record<string, unknown>, key: string): TaskMode {
  const value = args[key];
  if (value === "work" || value === "code") return value;
  throw new Error("非法的工作方式");
}

function requireEnvironment(args: Record<string, unknown>, key: string): ExecutionEnvironment {
  const value = args[key];
  if (value === "local" || value === "worktree") return value;
  throw new Error("非法的执行环境");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Runs one command body: serialized against every other, errors wrapped once. */
function command<T>(task: () => Promise<T>): Promise<T> {
  return withWorkspace(() => mapRuntimeError(task));
}

export function registerWorkspaceCommands(): void {
  registerCommands({
    task_workspace_overview: (args) => {
      const taskId = requireString(args, "taskId");
      return command(() => taskWorkspaceOverview(taskId));
    },

    set_task_workspace_environment: (args) => {
      const taskId = requireString(args, "taskId");
      const environment = requireEnvironment(args, "environment");
      return command(async () => {
        validateTaskId(taskId);
        const projectId = await conversationProjectId(taskId);
        const projectRoot = await projectRootForId(projectId);
        if (environment !== "local") {
          throw new Error("已禁用 Git Worktree，任务只允许使用 Local 环境");
        }
        await adoptLegacyWorkspace(taskId, projectId);
        if (projectRoot !== null) {
          await setEnvironment(taskId, projectRoot, environment);
        } else {
          await resolveDescriptor(taskId, null, sharedWorkspacePath(taskId), "local");
        }
        return taskWorkspaceOverview(taskId);
      });
    },

    create_task_workspace_snapshot: (args) => {
      const taskId = requireString(args, "taskId");
      const label = requireString(args, "label");
      return command(async () => {
        await ensureWorkspaceDescriptor(taskId);
        return snapshotWorkspace(taskId, label.trim());
      });
    },

    restore_task_workspace_snapshot: (args) => {
      const taskId = requireString(args, "taskId");
      const snapshotId = requireString(args, "snapshotId");
      return command(async () => {
        await ensureWorkspaceDescriptor(taskId);
        await restoreSnapshot(taskId, snapshotId);
        return taskWorkspaceOverview(taskId);
      });
    },

    handoff_task_workspace: (args) => {
      const taskId = requireString(args, "taskId");
      const branch = optionalString(args, "branch");
      const label = requireString(args, "label");
      return command(async () => {
        await ensureWorkspaceDescriptor(taskId);
        const trimmed = label.trim();
        return handoffWorkspace(taskId, branch, trimmed === "" ? "Codex handoff" : trimmed);
      });
    },

    task_workspace_git_diff: (args) => {
      const taskId = requireString(args, "taskId");
      return command(async () => {
        await ensureWorkspaceDescriptor(taskId);
        return workspaceDiff(taskId);
      });
    },

    stage_task_workspace_paths: (args) => {
      const taskId = requireString(args, "taskId");
      const paths = requireStringArray(args, "paths");
      return command(async () => {
        await ensureWorkspaceDescriptor(taskId);
        return stagePaths(taskId, paths);
      });
    },

    unstage_task_workspace_paths: (args) => {
      const taskId = requireString(args, "taskId");
      const paths = requireStringArray(args, "paths");
      return command(async () => {
        await ensureWorkspaceDescriptor(taskId);
        return unstagePaths(taskId, paths);
      });
    },

    discard_task_workspace_paths: (args) => {
      const taskId = requireString(args, "taskId");
      const paths = requireStringArray(args, "paths");
      return command(async () => {
        await ensureWorkspaceDescriptor(taskId);
        return discardPaths(taskId, paths);
      });
    },

    commit_task_workspace: (args) => {
      const taskId = requireString(args, "taskId");
      const message = requireString(args, "message");
      return command(async () => {
        await ensureWorkspaceDescriptor(taskId);
        return commitWorkspace(taskId, message);
      });
    },

    push_task_workspace: (args) => {
      const taskId = requireString(args, "taskId");
      const remote = requireString(args, "remote");
      const branch = requireString(args, "branch");
      return command(async () => {
        await ensureWorkspaceDescriptor(taskId);
        return pushWorkspace(taskId, remote, branch);
      });
    },

    task_workspace_pull_request_url: (args) => {
      const taskId = requireString(args, "taskId");
      const remote = requireString(args, "remote");
      const branch = requireString(args, "branch");
      return command(async () => {
        await ensureWorkspaceDescriptor(taskId);
        return pullRequestUrl(taskId, remote, branch);
      });
    },

    transfer_task_workspace_file: (args) => {
      const taskId = requireString(args, "taskId");
      const fromMode = requireTaskMode(args, "fromMode");
      const toMode = requireTaskMode(args, "toMode");
      const path = requireString(args, "path");
      return command(() => transferWorkspaceFile(taskId, fromMode, toMode, path));
    },
  });
}
