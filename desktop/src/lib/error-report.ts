import { getVersion } from "@tauri-apps/api/app";
import { message } from "@/components/app-message";
import { errorMessage, readNativeErrorLog } from "@/lib/api";

/** GitHub repository that receives user-submitted bug reports. */
export const ISSUE_REPO_URL = "https://github.com/tietiezhi-1216/tietiezhi";

export interface AppErrorRecord {
  at: number;
  source: string;
  message: string;
  stack?: string;
  /** Consecutive occurrences folded into this record. */
  count: number;
}

const MAX_RECORDS = 50;
const TOAST_THROTTLE_MS = 90_000;

const records: AppErrorRecord[] = [];
const listeners = new Set<() => void>();
let lastToastAt = 0;
let installed = false;
// Stable snapshot for useSyncExternalStore: only replaced when data changes.
let snapshot: AppErrorRecord[] = [];

const notifyListeners = () => {
  snapshot = records
    .slice()
    .reverse()
    .map((record) => ({ ...record }));
  for (const listener of listeners) listener();
};

/** Subscribe to error-buffer changes (for the settings feedback section). */
export function subscribeAppErrors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recentAppErrors(): AppErrorRecord[] {
  return snapshot;
}

export function recordAppError(
  source: string,
  detail: unknown,
  stack?: string,
) {
  const text = errorMessage(detail).slice(0, 2_000);
  if (!text.trim()) return;
  const last = records[records.length - 1];
  if (last && last.message === text && last.source === source) {
    last.count += 1;
    last.at = Date.now();
  } else {
    records.push({
      at: Date.now(),
      source,
      message: text,
      stack: stack?.slice(0, 4_000),
      count: 1,
    });
    if (records.length > MAX_RECORDS) records.shift();
  }
  notifyListeners();

  const now = Date.now();
  if (now - lastToastAt >= TOAST_THROTTLE_MS) {
    lastToastAt = now;
    message.warning(
      "检测到应用异常",
      "可打开 设置 → 通用 → 问题反馈，一键上报到 GitHub 帮助我们排查。",
    );
  }
}

/**
 * Capture unhandled window errors, promise rejections, and `console.error`
 * output into a bounded in-memory buffer used by the feedback reporter.
 */
export function installGlobalErrorCapture() {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (event) => {
    recordAppError(
      "window",
      event.message || event.error,
      event.error instanceof Error ? event.error.stack : undefined,
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    recordAppError(
      "promise",
      event.reason,
      event.reason instanceof Error ? event.reason.stack : undefined,
    );
  });

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    try {
      const text = args
        .map((arg) => (typeof arg === "string" ? arg : errorMessage(arg)))
        .join(" ");
      recordAppError("console", text);
    } catch {
      // Reporting must never break logging itself.
    }
  };
}

const formatTime = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** Assemble the diagnostic report body (Markdown) for a GitHub issue. */
export async function buildIssueBody(description: string): Promise<string> {
  const version = await getVersion().catch(() => "未知");
  const nativeLog = await readNativeErrorLog().catch(() => "");
  const errors = recentAppErrors().slice(0, 10);

  const lines: string[] = [];
  lines.push("### 问题描述");
  lines.push(description.trim() || "（未填写）");
  lines.push("");
  lines.push("### 环境信息");
  lines.push(`- 应用版本：${version}`);
  lines.push(`- 系统：${navigator.userAgent}`);
  lines.push(`- 报告时间：${formatTime(Date.now())}`);
  lines.push("");
  if (errors.length > 0) {
    lines.push("### 最近运行错误");
    lines.push("```");
    for (const record of errors) {
      const repeat = record.count > 1 ? ` ×${record.count}` : "";
      lines.push(
        `[${formatTime(record.at)}] [${record.source}]${repeat} ${record.message.slice(0, 400)}`,
      );
    }
    lines.push("```");
    lines.push("");
  }
  if (nativeLog.trim()) {
    lines.push("### 原生崩溃日志（末尾）");
    lines.push("```");
    lines.push(nativeLog.trim().slice(-2_000));
    lines.push("```");
  }
  return lines.join("\n");
}

/**
 * Open a prefilled GitHub issue in the browser. The user reviews and submits
 * it under their own account, so the app never needs an embedded token.
 */
export async function openGitHubIssueReport(description: string) {
  const body = await buildIssueBody(description);
  const title = encodeURIComponent(
    `[错误反馈] ${description.trim().slice(0, 60) || "应用运行异常"}`,
  );
  let encodedBody = encodeURIComponent(body);
  // GitHub rejects overly long URLs; keep the whole link comfortably short.
  const maxBodyLength = 6_500;
  if (encodedBody.length > maxBodyLength) {
    let sliced = body;
    while (encodeURIComponent(sliced).length > maxBodyLength - 100) {
      sliced = sliced.slice(0, Math.floor(sliced.length * 0.8));
    }
    encodedBody = encodeURIComponent(`${sliced}\n\n（诊断内容过长，已截断）`);
  }
  const url = `${ISSUE_REPO_URL}/issues/new?title=${title}&body=${encodedBody}`;
  window.open(url, "_blank", "noopener,noreferrer");
}
