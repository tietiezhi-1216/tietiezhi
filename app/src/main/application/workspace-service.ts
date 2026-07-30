import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { app, dialog } from "electron";

import type { WorkspaceFile, WorkspaceInfo } from "@shared/contracts";

import { resolveWorkspacePath } from "../engines/workspace-tools.js";

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

  async readTextFile(root: string, requested: string): Promise<string> {
    const path = await resolveWorkspacePath(root, requested);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("目标不是文件");
    if (info.size > 1_000_000) throw new Error("文件超过 1 MB，无法预览");
    return readFile(path, "utf8");
  }
}
