import type { CoreInstallState, CoreRunState, CoreSource, McpConfigFormat } from "./types";

/** Narrows unvalidated IPC payloads without reaching for `any`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Best-effort message for anything thrown across the IPC boundary. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** `KEY=VALUE` / `Name: value` lines → object, mirroring the settings editor. */
export function parsePairs(text: string, separator: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function formatPairs(pairs: Record<string, string> | undefined, separator: "=" | ": "): string {
  if (!pairs) return "";
  return Object.entries(pairs)
    .map(([key, value]) => `${key}${separator}${value}`)
    .join("\n");
}

export function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Display labels (Chinese, user facing)
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<CoreSource, string> = {
  builtin: "内置",
  npm: "npm 包",
  binary: "可执行文件",
  path: "本机命令",
};

export function sourceLabel(source: CoreSource): string {
  return SOURCE_LABELS[source];
}

const CONFIG_FORMAT_LABELS: Record<McpConfigFormat, string> = {
  "claude-json": "Claude JSON",
  "codex-toml": "Codex TOML",
  "gemini-json": "Gemini JSON",
  none: "不支持 MCP 配置",
};

export function configFormatLabel(format: McpConfigFormat | undefined): string {
  return format ? CONFIG_FORMAT_LABELS[format] : "不支持 MCP 配置";
}

export function installLabel(state: CoreInstallState): string {
  switch (state.status) {
    case "not-installed":
      return "未安装";
    case "installing":
      return "安装中";
    case "installed":
      return `已安装 ${state.version}`;
    case "failed":
      return "安装失败";
  }
}

export function runLabel(state: CoreRunState): string {
  switch (state.status) {
    case "stopped":
      return "未运行";
    case "starting":
      return "启动中";
    case "ready":
      return "运行中";
    case "crashed":
      return "已崩溃";
  }
}

/**
 * npm gives no machine-readable progress, so the installer's number is a
 * heuristic. Surfacing it as a percentage would be a lie — collapse it into a
 * coarse stage instead.
 */
export type InstallStage = "preparing" | "downloading" | "finishing";

export function installStage(progress: number | undefined): InstallStage {
  if (progress === undefined || progress < 0.2) return "preparing";
  if (progress < 0.7) return "downloading";
  return "finishing";
}

export const INSTALL_STAGE_TEXT: Record<InstallStage, string> = {
  preparing: "正在准备安装环境…",
  downloading: "正在拉取依赖，耗时取决于网络…",
  finishing: "即将完成，正在校验…",
};

/** Static Tailwind widths — the bar is a rough stage indicator, not a gauge. */
export const INSTALL_STAGE_WIDTH: Record<InstallStage, string> = {
  preparing: "w-1/4",
  downloading: "w-1/2",
  finishing: "w-4/5",
};

export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "未知时间";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/** Pretty-prints a raw protocol payload for the "详情" disclosures. */
export function formatRaw(raw: unknown): string {
  try {
    return JSON.stringify(raw, null, 2) ?? String(raw);
  } catch {
    return String(raw);
  }
}
