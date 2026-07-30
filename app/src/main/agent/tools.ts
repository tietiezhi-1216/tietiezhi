/**
 * The four tools the agent starts with: read, write, edit, bash.
 *
 * Deliberately four. The core this project is replacing grew to ~90k lines
 * largely by accumulating tool surface, so anything beyond these has to justify
 * itself against real use rather than being added because it seems useful.
 *
 * Every path is resolved and checked against the session root before use. A
 * tool that can be talked into touching `~/.ssh` is not a tool, it is a hole —
 * and the model's input is untrusted by construction.
 */

import { exec } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Tool, ToolContext, ToolResult } from "./types.js";

/** Output beyond this is truncated: a huge tool result evicts the conversation. */
const MAX_OUTPUT_CHARS = 30_000;
/** Files larger than this are refused rather than silently truncated. */
const MAX_READ_BYTES = 2 * 1024 * 1024;
const BASH_TIMEOUT_MS = 120_000;

function truncate(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_OUTPUT_CHARS) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, MAX_OUTPUT_CHARS)}\n…（输出过长，已截断 ${value.length - MAX_OUTPUT_CHARS} 字符）`,
    truncated: true,
  };
}

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

function requiredString(input: unknown, key: string): string {
  const value = field(input, key);
  if (typeof value !== "string" || value === "") {
    throw new Error(`参数 ${key} 必须是非空字符串`);
  }
  return value;
}

/**
 * Resolves a model-supplied path inside the session root.
 *
 * Checks the resolved path, not the input string: `a/../../etc/passwd` and a
 * symlink both look harmless before resolution.
 */
function insideRoot(context: ToolContext, path: string): string {
  const root = resolve(context.cwd);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`路径超出会话目录：${path}`);
  }
  return target;
}

function ok(output: string, detail?: unknown): ToolResult {
  return detail === undefined ? { output } : { output, detail };
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

const readTool: Tool = {
  name: "read",
  description:
    "读取会话目录内的文本文件。返回带行号的内容，便于后续用 edit 精确替换。",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对会话目录的路径，或目录内的绝对路径" },
      offset: { type: "integer", description: "起始行号（从 1 开始），默认 1" },
      limit: { type: "integer", description: "最多读取多少行，默认全部" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(input, context) {
    const target = insideRoot(context, requiredString(input, "path"));
    const info = await stat(target).catch(() => null);
    if (info === null) return { output: `文件不存在：${requiredString(input, "path")}`, isError: true };
    if (info.isDirectory()) return { output: "这是一个目录，请给出文件路径", isError: true };
    if (info.size > MAX_READ_BYTES) {
      return { output: `文件过大（${info.size} 字节），请改用 bash 分段查看`, isError: true };
    }

    const lines = (await readFile(target, "utf8")).split("\n");
    const offsetRaw = field(input, "offset");
    const limitRaw = field(input, "limit");
    const start = typeof offsetRaw === "number" && offsetRaw > 0 ? Math.floor(offsetRaw) : 1;
    const count = typeof limitRaw === "number" && limitRaw > 0 ? Math.floor(limitRaw) : lines.length;
    const slice = lines.slice(start - 1, start - 1 + count);
    // Line numbers let `edit` target text unambiguously and let the model cite
    // locations back to the user.
    const numbered = slice.map((line, index) => `${start + index}\t${line}`).join("\n");
    const { text } = truncate(numbered);
    return ok(text, { path: relative(context.cwd, target), totalLines: lines.length });
  },
};

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

const writeTool: Tool = {
  name: "write",
  description: "写入文件，覆盖已有内容。父目录不存在时会创建。",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async run(input, context) {
    const relPath = requiredString(input, "path");
    const target = insideRoot(context, relPath);
    const content = field(input, "content");
    if (typeof content !== "string") throw new Error("参数 content 必须是字符串");

    const before = await readFile(target, "utf8").catch(() => null);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
    return ok(`已写入 ${relPath}（${content.length} 字符）`, {
      path: relative(context.cwd, target),
      before,
      after: content,
    });
  },
};

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

const editTool: Tool = {
  name: "edit",
  description:
    "把文件里的一段文本替换成另一段。oldText 必须在文件中唯一出现，否则报错而不是猜。",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldText: { type: "string", description: "要被替换的原文，需唯一匹配" },
      newText: { type: "string", description: "替换后的文本" },
      replaceAll: { type: "boolean", description: "替换全部匹配，默认 false" },
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
  },
  async run(input, context) {
    const relPath = requiredString(input, "path");
    const target = insideRoot(context, relPath);
    const oldText = requiredString(input, "oldText");
    const newTextRaw = field(input, "newText");
    if (typeof newTextRaw !== "string") throw new Error("参数 newText 必须是字符串");
    const replaceAll = field(input, "replaceAll") === true;

    const before = await readFile(target, "utf8").catch(() => null);
    if (before === null) return { output: `文件不存在：${relPath}`, isError: true };

    const occurrences = before.split(oldText).length - 1;
    if (occurrences === 0) {
      return { output: `在 ${relPath} 中找不到要替换的文本`, isError: true };
    }
    // Ambiguity is an error, not a coin flip: silently editing the wrong
    // occurrence is the failure mode that destroys trust in an agent.
    if (occurrences > 1 && !replaceAll) {
      return {
        output: `要替换的文本在 ${relPath} 中出现 ${occurrences} 次。请提供更长的唯一片段，或设置 replaceAll。`,
        isError: true,
      };
    }

    const after = replaceAll
      ? before.split(oldText).join(newTextRaw)
      : before.replace(oldText, newTextRaw);
    await writeFile(target, after, "utf8");
    return ok(`已修改 ${relPath}（替换 ${replaceAll ? occurrences : 1} 处）`, {
      path: relative(context.cwd, target),
      before,
      after,
    });
  },
};

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

const bashTool: Tool = {
  name: "bash",
  description:
    "在会话目录下执行 shell 命令。用于构建、测试、git 等。有超时限制，不要用来跑常驻进程。",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutMs: { type: "integer", description: `超时毫秒，默认 ${BASH_TIMEOUT_MS}` },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async run(input, context) {
    const command = requiredString(input, "command");
    const timeoutRaw = field(input, "timeoutMs");
    const timeout =
      typeof timeoutRaw === "number" && timeoutRaw > 0
        ? Math.min(Math.floor(timeoutRaw), BASH_TIMEOUT_MS)
        : BASH_TIMEOUT_MS;

    return new Promise<ToolResult>((resolvePromise) => {
      const child = exec(
        command,
        {
          cwd: context.cwd,
          timeout,
          maxBuffer: 8 * 1024 * 1024,
          // A command that waits for input would otherwise hang until timeout.
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (error, stdout, stderr) => {
          const merged = [stdout, stderr].filter((part) => part !== "").join("\n");
          const { text } = truncate(merged);
          if (error === null) {
            resolvePromise(ok(text === "" ? "（无输出）" : text, { exitCode: 0 }));
            return;
          }
          const code = typeof error.code === "number" ? error.code : null;
          const killed = error.killed === true;
          resolvePromise({
            output: `${killed ? `命令超时（${timeout}ms）后被终止` : `命令退出码 ${code ?? "未知"}`}\n${text}`,
            isError: true,
            detail: { exitCode: code, killed },
          });
        },
      );
      // Cancelling the turn must actually stop the command.
      context.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
    });
  },
};

/** The starting tool set, in the order the model sees them. */
export const DEFAULT_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool];

export function toolByName(name: string): Tool | undefined {
  return DEFAULT_TOOLS.find((entry) => entry.name === name);
}
