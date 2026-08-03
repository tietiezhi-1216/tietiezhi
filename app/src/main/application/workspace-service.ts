import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Workspace, WorkspaceDirectoryEntry } from "@shared/contracts";

import { AppDatabase } from "../infrastructure/database.js";

function isInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export interface WorkspacePlatform {
  chooseDirectory(): Promise<string | null>;
  reveal(path: string): Promise<string>;
}

export class WorkspaceService {
  readonly #temporaryRoot: string;

  constructor(
    private readonly database: AppDatabase,
    temporaryRoot: string,
    private readonly platform?: WorkspacePlatform,
  ) {
    mkdirSync(temporaryRoot, { recursive: true });
    this.#temporaryRoot = realpathSync(resolve(temporaryRoot));
  }

  list(): Workspace[] {
    return this.database.listWorkspaces();
  }

  require(id: string): Workspace {
    const workspace = this.database.workspace(id);
    if (!workspace) throw new Error("Workspace 不存在");
    return workspace;
  }

  async chooseProject(): Promise<Workspace | null> {
    if (!this.platform) throw new Error("当前环境不能选择项目文件夹");
    const selected = await this.platform.chooseDirectory();
    if (!selected) return null;
    return this.registerProject(selected);
  }

  async registerProject(path: string): Promise<Workspace> {
    const canonical = await realpath(resolve(path));
    const existing = this.database.workspaceByPath(canonical);
    const now = Date.now();
    if (existing) {
      const workspace = { ...existing, name: basename(canonical), updatedAt: now };
      this.database.saveWorkspace(workspace);
      return this.database.workspaceByPath(canonical) ?? workspace;
    }
    const workspace: Workspace = {
      id: randomUUID(),
      kind: "project",
      name: basename(canonical),
      path: canonical,
      createdAt: now,
      updatedAt: now,
    };
    this.database.saveWorkspace(workspace);
    return workspace;
  }

  async createTemporary(): Promise<Workspace> {
    const id = randomUUID();
    const path = join(this.#temporaryRoot, id);
    await mkdir(path, { recursive: false });
    const canonical = await realpath(path);
    if (!isInside(this.#temporaryRoot, canonical)) {
      throw new Error("临时 Workspace 路径无效");
    }
    const now = Date.now();
    const workspace: Workspace = {
      id,
      kind: "temporary",
      name: "新任务",
      path: canonical,
      createdAt: now,
      updatedAt: now,
    };
    this.database.saveWorkspace(workspace);
    return workspace;
  }

  async reveal(id: string): Promise<void> {
    if (!this.platform) throw new Error("当前环境不能打开文件夹");
    const workspace = this.require(id);
    const error = await this.platform.reveal(workspace.path);
    if (error) throw new Error(error);
  }

  async listDirectory(id: string, requested = "."): Promise<WorkspaceDirectoryEntry[]> {
    const workspace = this.require(id);
    const directory = await this.#resolvePath(workspace, requested);
    const details = await stat(directory);
    if (!details.isDirectory()) throw new Error("目标不是目录");
    const entries = await readdir(directory, { withFileTypes: true });
    const result: WorkspaceDirectoryEntry[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      const displayPath = relative(workspace.path, path).split(sep).join("/");
      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          path: displayPath,
          type: "directory",
          hidden: entry.name.startsWith("."),
        });
      } else if (entry.isFile()) {
        const file = await stat(path);
        result.push({
          name: entry.name,
          path: displayPath,
          type: "file",
          size: file.size,
          hidden: entry.name.startsWith("."),
        });
      }
    }
    return result.sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN", { numeric: true });
    });
  }

  async readTextFile(id: string, requested: string): Promise<string> {
    const workspace = this.require(id);
    const path = await this.#resolvePath(workspace, requested);
    const details = await stat(path);
    if (!details.isFile()) throw new Error("目标不是文件");
    if (details.size > 1_000_000) throw new Error("文件超过 1 MB，无法预览");
    return readFile(path, "utf8");
  }

  async #resolvePath(workspace: Workspace, requested: string): Promise<string> {
    const root = await realpath(workspace.path);
    const candidate = resolve(root, requested);
    if (!isInside(root, candidate)) throw new Error("路径超出 Workspace");
    const canonical = await realpath(candidate);
    if (!isInside(root, canonical)) throw new Error("路径超出 Workspace");
    return canonical;
  }
}
