import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { app, dialog, shell } from "electron";

import type {
  WorkspaceChangeEntry,
  WorkspaceChangeStatus,
  WorkspaceDiffFile,
  WorkspaceDirectoryEntry,
  WorkspaceFile,
  WorkspaceGitStatus,
  WorkspaceInfo,
} from "@shared/contracts";

import { resolveWorkspacePath } from "../engines/workspace-tools.js";
import { parseGitDiff, parseGitNumstat } from "./workspace-git.js";

const GIT_OUTPUT_LIMIT = 2_000_000;

function git(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-c", "core.quotepath=false", ...args], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) <= GIT_OUTPUT_LIMIT) return next;
      truncated = true;
      return next.slice(0, GIT_OUTPUT_LIMIT);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr, truncated });
    });
  });
}

function changeStatus(code: string): WorkspaceChangeStatus {
  if (code.includes("R") || code.includes("C")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code === "??") return "untracked";
  if (code.includes("A")) return "added";
  return "modified";
}

function temporaryRoot(): string {
  const path = join(app.getPath("userData"), "workspaces");
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

export class WorkspaceService {
  readonly #temporaryRoot = temporaryRoot();
  readonly #selected = new Set<string>();

  #temporary(path: string): boolean {
    const relation = relative(resolve(this.#temporaryRoot), resolve(path));
    return relation !== "" && relation !== ".." && !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
  }

  async #prepare(path: string): Promise<WorkspaceInfo> {
    const normalized = resolve(path);
    const expectedTemporary = this.#temporary(normalized);
    await mkdir(normalized, { recursive: true });
    const canonical = await realpath(normalized);
    if (expectedTemporary && !this.#temporary(canonical)) {
      throw new Error("临时 Workspace 不能通过符号链接指向外部目录");
    }
    return {
      path: canonical,
      name: this.#temporary(canonical) ? "临时 Workspace" : basename(canonical),
      temporary: this.#temporary(canonical),
    };
  }

  async createTemporary(): Promise<WorkspaceInfo> {
    const path = join(this.#temporaryRoot, randomUUID());
    const workspace = await this.#prepare(path);
    this.#selected.add(workspace.path);
    return workspace;
  }

  async ensure(path: string): Promise<WorkspaceInfo> {
    const normalized = resolve(path);
    if (!this.#temporary(normalized) && !this.#selected.has(normalized)) {
      throw new Error("请通过文件夹选择器授权 Workspace");
    }
    return this.#prepare(normalized);
  }

  async restore(path: string): Promise<WorkspaceInfo> {
    return this.#prepare(path);
  }

  async choose(): Promise<WorkspaceInfo | null> {
    const result = await dialog.showOpenDialog({
      title: "选择 Workspace",
      properties: ["openDirectory", "createDirectory"],
    });
    const path = result.filePaths[0];
    if (result.canceled || path === undefined) return null;
    const workspace = await this.#prepare(path);
    this.#selected.add(workspace.path);
    return workspace;
  }

  async reveal(path: string): Promise<void> {
    const workspace = await this.restore(path);
    const error = await shell.openPath(workspace.path);
    if (error) throw new Error(error);
  }

  async removeTemporary(path: string): Promise<void> {
    const normalized = resolve(path);
    if (!this.#temporary(normalized)) return;
    this.#selected.delete(normalized);
    await rm(normalized, { recursive: true, force: true });
  }

  async listFiles(root: string): Promise<WorkspaceFile[]> {
    const workspace = await resolveWorkspacePath(root, ".");
    const result: WorkspaceFile[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 6 || result.length >= 2_000) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const path = join(directory, entry.name);
        const display = relative(workspace, path);
        if (entry.isDirectory()) {
          result.push({ path: display, type: "directory" });
          await visit(path, depth + 1);
        } else if (entry.isFile()) {
          const info = await stat(path);
          result.push({ path: display, type: "file", size: info.size });
        }
        if (result.length >= 2_000) return;
      }
    };
    await visit(workspace, 0);
    return result;
  }

  async listDirectory(root: string, requested = "."): Promise<WorkspaceDirectoryEntry[]> {
    const workspace = await resolveWorkspacePath(root, ".");
    const directory = await resolveWorkspacePath(root, requested);
    const info = await stat(directory);
    if (!info.isDirectory()) throw new Error("目标不是目录");
    const entries = await readdir(directory, { withFileTypes: true });
    const result: WorkspaceDirectoryEntry[] = [];
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const display = relative(workspace, path);
      if (entry.isDirectory()) {
        result.push({ name: entry.name, path: display, type: "directory", hidden: entry.name.startsWith(".") });
      } else if (entry.isFile()) {
        const details = await stat(path);
        result.push({ name: entry.name, path: display, type: "file", size: details.size, hidden: entry.name.startsWith(".") });
      }
    }
    return result.sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN", { numeric: true });
    });
  }

  async gitStatus(root: string): Promise<WorkspaceGitStatus> {
    const workspace = await resolveWorkspacePath(root, ".");
    let status;
    try {
      status = await git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
    } catch {
      return { repository: false, changes: [] };
    }
    if (status.code !== 0) return { repository: false, changes: [] };
    const [branchResult, unstagedResult, stagedResult] = await Promise.all([
      git(workspace, ["branch", "--show-current"]),
      git(workspace, ["diff", "--numstat", "-z", "--", "."]),
      git(workspace, ["diff", "--cached", "--numstat", "-z", "--", "."]),
    ]);
    const unstagedStats = parseGitNumstat(unstagedResult.stdout);
    const stagedStats = parseGitNumstat(stagedResult.stdout);
    const records = status.stdout.split("\0");
    const changes: WorkspaceChangeEntry[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || record.length < 4) continue;
      const code = record.slice(0, 2);
      const path = record.slice(3);
      const renamed = code.includes("R") || code.includes("C");
      const oldPath = renamed ? records[index + 1] : undefined;
      if (renamed) index += 1;
      const staged = code[0] !== " " && code[0] !== "?";
      const unstaged = code[1] !== " ";
      const stagedCount = stagedStats.get(path);
      const unstagedCount = unstagedStats.get(path);
      let additions: number | null =
        stagedCount?.additions === null || unstagedCount?.additions === null
          ? null
          : (stagedCount?.additions ?? 0) + (unstagedCount?.additions ?? 0);
      let deletions: number | null =
        stagedCount?.deletions === null || unstagedCount?.deletions === null
          ? null
          : (stagedCount?.deletions ?? 0) + (unstagedCount?.deletions ?? 0);
      if (code === "??") {
        try {
          const target = await resolveWorkspacePath(workspace, path);
          const details = await stat(target);
          if (details.size > 1_000_000) {
            additions = null;
            deletions = null;
          } else {
            const content = await readFile(target, "utf8");
            additions = content.split("\n").length;
          }
        } catch {
          additions = null;
          deletions = null;
        }
      }
      changes.push({
        path,
        ...(oldPath ? { oldPath } : {}),
        status: changeStatus(code),
        staged,
        unstaged,
        additions,
        deletions,
      });
    }
    return {
      repository: true,
      branch: branchResult.stdout.trim() || "HEAD",
      changes: changes.sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  async gitDiff(root: string, requested: string, staged = false): Promise<WorkspaceDiffFile> {
    const workspace = await resolveWorkspacePath(root, ".");
    await resolveWorkspacePath(root, requested);
    const status = await this.gitStatus(root);
    const change = status.changes.find((candidate) => candidate.path === requested);
    if (change?.status === "untracked") {
      const file = await resolveWorkspacePath(root, requested);
      const details = await stat(file);
      if (details.size > GIT_OUTPUT_LIMIT) {
        return { path: requested, staged: false, binary: false, truncated: true, lines: [] };
      }
      const content = await readFile(file);
      if (content.includes(0)) {
        return { path: requested, staged: false, binary: true, truncated: false, lines: [] };
      }
      return {
        path: requested,
        staged: false,
        binary: false,
        truncated: false,
        lines: content.toString("utf8").split("\n").map((text, index) => ({
          kind: "addition",
          text,
          newLine: index + 1,
        })),
      };
    }
    const result = await git(workspace, [
      "diff",
      ...(staged ? ["--cached"] : []),
      "--no-ext-diff",
      "--no-color",
      "--unified=3",
      "--",
      requested,
    ]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "无法读取 Git Diff");
    return parseGitDiff(requested, staged, result.stdout, result.truncated);
  }

  async readTextFile(root: string, requested: string): Promise<string> {
    const path = await resolveWorkspacePath(root, requested);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("目标不是文件");
    if (info.size > 1_000_000) throw new Error("文件超过 1 MB，无法预览");
    return readFile(path, "utf8");
  }
}
