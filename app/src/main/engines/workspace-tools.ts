import { spawn } from "node:child_process";
import { readdir, readFile, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { jsonSchema, tool } from "ai";

import type { SkillDetail, WorkspaceToolDescriptor } from "@shared/contracts";

const MAX_FILE_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 200_000;
const MAX_DIFF_BYTES = 200_000;

export interface WorkspaceToolEvent {
  type: "diff";
  toolCallId: string;
  toolName: string;
  input?: unknown;
  path?: string;
  before?: string;
  after?: string;
  omitted?: boolean;
  bytes?: number;
}

function emitDiff(
  context: ToolContext,
  input: Omit<WorkspaceToolEvent, "type" | "before" | "after"> & {
    before: string;
    after: string;
  },
): void {
  const bytes = Math.max(Buffer.byteLength(input.before), Buffer.byteLength(input.after));
  context.emit(
    bytes > MAX_DIFF_BYTES
      ? { ...input, type: "diff", before: "", after: "", omitted: true, bytes }
      : { ...input, type: "diff", bytes },
  );
}

interface ToolContext {
  workspace: string;
  signal: AbortSignal;
  emit(event: WorkspaceToolEvent): void;
}

export const WORKSPACE_TOOL_DESCRIPTORS: WorkspaceToolDescriptor[] = [
  {
    id: "listFiles",
    name: "列出文件",
    description: "列出 Workspace 内的文件和目录。",
    category: "read",
    approvalRequired: false,
  },
  {
    id: "readFile",
    name: "读取文件",
    description: "读取 Workspace 内的 UTF-8 文本文件。",
    category: "read",
    approvalRequired: false,
  },
  {
    id: "searchFiles",
    name: "搜索文件",
    description: "在 Workspace 文本文件中搜索指定内容。",
    category: "read",
    approvalRequired: false,
  },
  {
    id: "writeFile",
    name: "写入文件",
    description: "创建或完整覆盖 Workspace 内的文本文件。",
    category: "write",
    approvalRequired: true,
  },
  {
    id: "replaceText",
    name: "替换文本",
    description: "精确替换 Workspace 文件中的一段文本。",
    category: "write",
    approvalRequired: true,
  },
  {
    id: "runCommand",
    name: "运行 Shell",
    description: "在当前 Workspace 中执行 Shell 命令。",
    category: "shell",
    approvalRequired: true,
  },
  {
    id: "listSkills",
    name: "列出技能",
    description: "列出设置中已启用的技能及其描述。",
    category: "skill",
    approvalRequired: false,
  },
  {
    id: "readSkill",
    name: "读取技能",
    description: "按需加载一个已启用技能的完整说明。",
    category: "skill",
    approvalRequired: false,
  },
];

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("工具参数必须是对象");
  }
  return value as Record<string, unknown>;
}

export async function resolveWorkspacePath(
  workspace: string,
  requested: string,
  createParent = false,
): Promise<string> {
  const root = await realpath(workspace);
  const target = resolve(root, requested);
  const lexical = relative(root, target);
  if (lexical.startsWith("..") || (lexical === "" && requested !== "." && requested !== "./")) {
    throw new Error("路径超出 Workspace");
  }
  let existing = target;
  let resolved: string;
  for (;;) {
    try {
      resolved = await realpath(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) throw new Error("无法解析 Workspace 路径");
      existing = parent;
    }
  }
  const physical = relative(root, resolved);
  if (physical.startsWith("..")) throw new Error("路径通过符号链接超出 Workspace");
  if (createParent) await mkdir(dirname(target), { recursive: true });
  return target;
}

async function collectFiles(root: string, directory: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.slice(0, 500)) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    const display = relative(root, path);
    if (entry.isDirectory()) {
      result.push(`${display}/`);
      result.push(...(await collectFiles(root, path, depth - 1)));
    } else if (entry.isFile()) {
      result.push(display);
    }
  }
  return result;
}

function commandResult(
  command: string,
  workspace: string,
  signal: AbortSignal,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd: workspace,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString("utf8")).slice(-MAX_OUTPUT_BYTES);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const abort = () => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        child.kill();
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref();
        return;
      }
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      signal.removeEventListener("abort", abort);
      resolvePromise({ exitCode, stdout, stderr });
    });
  });
}

export function createWorkspaceTools(context: ToolContext, skills: SkillDetail[] = []) {
  return {
    listFiles: tool({
      description: "列出 Workspace 内的文件和目录。忽略 .git 和 node_modules。",
      inputSchema: jsonSchema<{ path?: string; depth?: number }>({
        type: "object",
        properties: {
          path: { type: "string" },
          depth: { type: "number", minimum: 0, maximum: 5 },
        },
        additionalProperties: false,
      }),
      execute: async (input) => {
        const path = await resolveWorkspacePath(context.workspace, input.path ?? ".");
        return { files: await collectFiles(context.workspace, path, input.depth ?? 2) };
      },
    }),
    readFile: tool({
      description: "读取 Workspace 内的 UTF-8 文本文件，单个文件最大 1 MB。",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const path = await resolveWorkspacePath(context.workspace, input.path);
        const info = await stat(path);
        if (!info.isFile()) throw new Error("目标不是文件");
        if (info.size > MAX_FILE_BYTES) throw new Error("文件超过 1 MB 限制");
        return { path: input.path, content: await readFile(path, "utf8") };
      },
    }),
    searchFiles: tool({
      description: "在 Workspace 文本文件中搜索字符串。",
      inputSchema: jsonSchema<{ query: string; path?: string }>({
        type: "object",
        properties: { query: { type: "string" }, path: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const root = await resolveWorkspacePath(context.workspace, input.path ?? ".");
        const files = (await collectFiles(context.workspace, root, 5)).filter(
          (path) => !path.endsWith("/"),
        );
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const name of files.slice(0, 1_000)) {
          try {
            const path = await resolveWorkspacePath(context.workspace, name);
            const info = await stat(path);
            if (info.size > MAX_FILE_BYTES) continue;
            const lines = (await readFile(path, "utf8")).split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
              const text = lines[index] ?? "";
              if (text.includes(input.query)) matches.push({ path: name, line: index + 1, text });
              if (matches.length >= 200) return { matches, truncated: true };
            }
          } catch {
            continue;
          }
        }
        return { matches, truncated: false };
      },
    }),
    writeFile: tool({
      description: "在 Workspace 内创建或完整覆盖 UTF-8 文本文件。执行前需要用户审批。",
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      }),
      execute: async (input, options) => {
        const path = await resolveWorkspacePath(context.workspace, input.path, true);
        let before = "";
        try {
          before = await readFile(path, "utf8");
        } catch {
          before = "";
        }
        await writeFile(path, input.content, "utf8");
        emitDiff(context, {
          toolCallId: options.toolCallId,
          toolName: "writeFile",
          path: input.path,
          before,
          after: input.content,
        });
        return { path: input.path, bytes: Buffer.byteLength(input.content) };
      },
    }),
    replaceText: tool({
      description: "精确替换 Workspace 文件中的一段文本。执行前需要用户审批。",
      inputSchema: jsonSchema<{ path: string; oldText: string; newText: string }>({
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      }),
      execute: async (input, options) => {
        const path = await resolveWorkspacePath(context.workspace, input.path);
        const before = await readFile(path, "utf8");
        const occurrences = before.split(input.oldText).length - 1;
        if (occurrences !== 1) {
          throw new Error(`要求 oldText 精确出现一次，实际出现 ${occurrences} 次`);
        }
        const after = before.replace(input.oldText, input.newText);
        await writeFile(path, after, "utf8");
        emitDiff(context, {
          toolCallId: options.toolCallId,
          toolName: "replaceText",
          path: input.path,
          before,
          after,
        });
        return { path: input.path, replaced: true };
      },
    }),
    runCommand: tool({
      description: "在 Workspace 内执行 Shell 命令。执行前需要高风险审批。",
      inputSchema: jsonSchema<{ command: string }>({
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        return commandResult(input.command, context.workspace, context.signal);
      },
    }),
    listSkills: tool({
      description: "列出当前已启用的技能。根据描述判断是否需要使用，再通过 readSkill 加载全文。",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => ({
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
        })),
      }),
    }),
    readSkill: tool({
      description: "读取一个已启用技能的完整 Markdown 说明。",
      inputSchema: jsonSchema<{ name: string }>({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const skill = skills.find((candidate) => candidate.name === input.name);
        if (skill === undefined) throw new Error(`技能 ${input.name} 未启用或不存在`);
        return {
          name: skill.name,
          description: skill.description,
          instructions: skill.body,
        };
      },
    }),
  };
}
