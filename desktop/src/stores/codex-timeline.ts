import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  CODEX_V2_NOTIFICATION_EVENT,
  CODEX_V2_SERVER_REQUEST_EVENT,
  type CodexV2Notification,
  type CodexV2ServerRequest,
} from "@/lib/api";
import type { ThreadItem } from "../../../shared/codex/v2/typescript/v2/ThreadItem";
import type { ThreadStatus } from "../../../shared/codex/v2/typescript/v2/ThreadStatus";
import type { TurnPlanStep } from "../../../shared/codex/v2/typescript/v2/TurnPlanStep";
import type { TurnStatus } from "../../../shared/codex/v2/typescript/v2/TurnStatus";

export interface CodexTimelineEntry {
  threadId: string;
  turnId: string;
  item: ThreadItem;
  lifecycle: "running" | "completed";
  startedAtMs?: number;
  completedAtMs?: number;
  progress?: string;
}

export interface CodexTimelineNotice {
  kind: "warning" | "error" | "guardian" | "config" | "deprecation";
  message: string;
}

export interface CodexThreadTimeline {
  entries: CodexTimelineEntry[];
  turnStatus?: TurnStatus;
  threadStatus?: ThreadStatus;
  diff?: string;
  plan?: {
    turnId: string;
    explanation: string | null;
    steps: TurnPlanStep[];
  };
  notices: CodexTimelineNotice[];
  pendingRequests: CodexV2ServerRequest[];
  realtime?: {
    active: boolean;
    version?: string;
    sessionId?: string | null;
    inputTranscript: string;
    outputTranscript: string;
    lastError?: string;
    audioChunks: number;
  };
}

export interface CodexTimelineState {
  threads: Record<string, CodexThreadTimeline>;
  applyNotification: (notification: CodexV2Notification) => void;
  applyServerRequest: (request: CodexV2ServerRequest) => void;
  hydrate: (threadId: string, turnId: string, items: ThreadItem[]) => void;
  clear: (threadId: string) => void;
}

const emptyTimeline = (): CodexThreadTimeline => ({
  entries: [],
  notices: [],
  pendingRequests: [],
});

function requestId(value: string | number): string {
  return String(value);
}

function notificationThreadId(notification: CodexV2Notification): string | undefined {
  const params = notification.params as { threadId?: unknown };
  return typeof params.threadId === "string" ? params.threadId : undefined;
}

function upsertEntry(
  timeline: CodexThreadTimeline,
  entry: CodexTimelineEntry,
): CodexThreadTimeline {
  const index = timeline.entries.findIndex(
    (candidate) => candidate.item.id === entry.item.id,
  );
  if (index < 0) {
    return { ...timeline, entries: [...timeline.entries, entry] };
  }
  const entries = [...timeline.entries];
  entries[index] = { ...entries[index], ...entry };
  return { ...timeline, entries };
}

function updateItem(
  timeline: CodexThreadTimeline,
  itemId: string,
  update: (item: ThreadItem) => ThreadItem,
  progress?: string,
): CodexThreadTimeline {
  const index = timeline.entries.findIndex((entry) => entry.item.id === itemId);
  if (index < 0) return timeline;
  const entries = [...timeline.entries];
  entries[index] = {
    ...entries[index],
    item: update(entries[index].item),
    ...(progress === undefined ? {} : { progress }),
  };
  return { ...timeline, entries };
}

function appendIndexed(values: string[], index: number, delta: string): string[] {
  const next = [...values];
  while (next.length <= index) next.push("");
  next[index] = `${next[index]}${delta}`;
  return next;
}

function noticeMessage(notification: CodexV2Notification): CodexTimelineNotice | null {
  switch (notification.method) {
    case "warning":
      return { kind: "warning", message: notification.params.message };
    case "error":
      return { kind: "error", message: notification.params.error.message };
    case "guardianWarning":
      return { kind: "guardian", message: notification.params.message };
    case "configWarning":
      return {
        kind: "config",
        message: [notification.params.summary, notification.params.details]
          .filter(Boolean)
          .join("："),
      };
    case "deprecationNotice":
      return {
        kind: "deprecation",
        message: [notification.params.summary, notification.params.details]
          .filter(Boolean)
          .join("："),
      };
    default:
      return null;
  }
}

export function reduceCodexTimeline(
  current: CodexThreadTimeline | undefined,
  notification: CodexV2Notification,
): CodexThreadTimeline {
  const timeline = current ?? emptyTimeline();
  let next = timeline;

  switch (notification.method) {
    case "item/started":
      next = upsertEntry(timeline, {
        threadId: notification.params.threadId,
        turnId: notification.params.turnId,
        item: notification.params.item,
        lifecycle: "running",
        startedAtMs: notification.params.startedAtMs,
      });
      break;
    case "item/completed":
      next = upsertEntry(timeline, {
        threadId: notification.params.threadId,
        turnId: notification.params.turnId,
        item: notification.params.item,
        lifecycle: "completed",
        completedAtMs: notification.params.completedAtMs,
      });
      break;
    case "item/agentMessage/delta":
      next = updateItem(timeline, notification.params.itemId, (item) =>
        item.type === "agentMessage"
          ? { ...item, text: `${item.text}${notification.params.delta}` }
          : item,
      );
      break;
    case "item/plan/delta":
      next = updateItem(timeline, notification.params.itemId, (item) =>
        item.type === "plan"
          ? { ...item, text: `${item.text}${notification.params.delta}` }
          : item,
      );
      break;
    case "item/reasoning/summaryPartAdded":
      next = updateItem(timeline, notification.params.itemId, (item) =>
        item.type === "reasoning"
          ? {
              ...item,
              summary: appendIndexed(item.summary, notification.params.summaryIndex, ""),
            }
          : item,
      );
      break;
    case "item/reasoning/summaryTextDelta":
      next = updateItem(timeline, notification.params.itemId, (item) =>
        item.type === "reasoning"
          ? {
              ...item,
              summary: appendIndexed(
                item.summary,
                notification.params.summaryIndex,
                notification.params.delta,
              ),
            }
          : item,
      );
      break;
    case "item/reasoning/textDelta":
      next = updateItem(timeline, notification.params.itemId, (item) =>
        item.type === "reasoning"
          ? {
              ...item,
              content: appendIndexed(
                item.content,
                notification.params.contentIndex,
                notification.params.delta,
              ),
            }
          : item,
      );
      break;
    case "item/commandExecution/outputDelta":
      next = updateItem(timeline, notification.params.itemId, (item) =>
        item.type === "commandExecution"
          ? {
              ...item,
              aggregatedOutput: `${item.aggregatedOutput ?? ""}${notification.params.delta}`,
            }
          : item,
      );
      break;
    case "item/fileChange/patchUpdated":
      next = updateItem(timeline, notification.params.itemId, (item) =>
        item.type === "fileChange"
          ? { ...item, changes: notification.params.changes }
          : item,
      );
      break;
    case "item/mcpToolCall/progress":
      next = updateItem(
        timeline,
        notification.params.itemId,
        (item) => item,
        notification.params.message,
      );
      break;
    case "turn/started":
      next = { ...timeline, turnStatus: notification.params.turn.status };
      for (const item of notification.params.turn.items) {
        next = upsertEntry(next, {
          threadId: notification.params.threadId,
          turnId: notification.params.turn.id,
          item,
          lifecycle: itemLifecycle(item),
        });
      }
      break;
    case "turn/completed":
      next = { ...timeline, turnStatus: notification.params.turn.status };
      for (const item of notification.params.turn.items) {
        next = upsertEntry(next, {
          threadId: notification.params.threadId,
          turnId: notification.params.turn.id,
          item,
          lifecycle: "completed",
        });
      }
      break;
    case "thread/status/changed":
      next = { ...timeline, threadStatus: notification.params.status };
      break;
    case "turn/diff/updated":
      next = { ...timeline, diff: notification.params.diff };
      break;
    case "turn/plan/updated":
      next = {
        ...timeline,
        plan: {
          turnId: notification.params.turnId,
          explanation: notification.params.explanation,
          steps: notification.params.plan,
        },
      };
      break;
    case "serverRequest/resolved":
      next = {
        ...timeline,
        pendingRequests: timeline.pendingRequests.filter(
          (request) =>
            requestId(request.id) !== requestId(notification.params.requestId),
        ),
      };
      break;
    case "thread/realtime/started":
      next = {
        ...timeline,
        realtime: {
          active: true,
          version: notification.params.version,
          sessionId: notification.params.realtimeSessionId,
          inputTranscript: "",
          outputTranscript: "",
          audioChunks: 0,
        },
      };
      break;
    case "thread/realtime/transcript/delta": {
      const realtime = timeline.realtime ?? {
        active: true,
        inputTranscript: "",
        outputTranscript: "",
        audioChunks: 0,
      };
      next = {
        ...timeline,
        realtime: {
          ...realtime,
          [notification.params.role === "user"
            ? "inputTranscript"
            : "outputTranscript"]: `${
            notification.params.role === "user"
              ? realtime.inputTranscript
              : realtime.outputTranscript
          }${notification.params.delta}`,
        },
      };
      break;
    }
    case "thread/realtime/transcript/done": {
      const realtime = timeline.realtime ?? {
        active: true,
        inputTranscript: "",
        outputTranscript: "",
        audioChunks: 0,
      };
      next = {
        ...timeline,
        realtime: {
          ...realtime,
          [notification.params.role === "user"
            ? "inputTranscript"
            : "outputTranscript"]: notification.params.text,
        },
      };
      break;
    }
    case "thread/realtime/outputAudio/delta": {
      const realtime = timeline.realtime ?? {
        active: true,
        inputTranscript: "",
        outputTranscript: "",
        audioChunks: 0,
      };
      next = {
        ...timeline,
        realtime: { ...realtime, audioChunks: realtime.audioChunks + 1 },
      };
      break;
    }
    case "thread/realtime/error": {
      const realtime = timeline.realtime ?? {
        active: false,
        inputTranscript: "",
        outputTranscript: "",
        audioChunks: 0,
      };
      next = {
        ...timeline,
        realtime: { ...realtime, lastError: notification.params.message },
      };
      break;
    }
    case "thread/realtime/closed": {
      const realtime = timeline.realtime ?? {
        active: false,
        inputTranscript: "",
        outputTranscript: "",
        audioChunks: 0,
      };
      next = {
        ...timeline,
        realtime: {
          ...realtime,
          active: false,
          ...(notification.params.reason
            ? { lastError: notification.params.reason }
            : {}),
        },
      };
      break;
    }
    default: {
      const notice = noticeMessage(notification);
      if (notice) {
        next = { ...timeline, notices: [...timeline.notices.slice(-19), notice] };
      }
    }
  }
  return next;
}

function itemLifecycle(item: ThreadItem): CodexTimelineEntry["lifecycle"] {
  if (
    (item.type === "commandExecution" ||
      item.type === "fileChange" ||
      item.type === "mcpToolCall" ||
      item.type === "dynamicToolCall" ||
      item.type === "collabAgentToolCall") &&
    item.status === "inProgress"
  ) {
    return "running";
  }
  return "completed";
}

export const useCodexTimelineStore = create<CodexTimelineState>((set) => ({
  threads: {},
  applyNotification: (notification) => {
    const threadId = notificationThreadId(notification);
    if (!threadId) return;
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: reduceCodexTimeline(state.threads[threadId], notification),
      },
    }));
  },
  applyServerRequest: (request) => {
    const params = request.params as { threadId?: unknown };
    if (typeof params.threadId !== "string") return;
    const threadId = params.threadId;
    set((state) => {
      const timeline = state.threads[threadId] ?? emptyTimeline();
      const id = requestId(request.id);
      return {
        threads: {
          ...state.threads,
          [threadId]: {
            ...timeline,
            pendingRequests: timeline.pendingRequests.some(
              (candidate) => requestId(candidate.id) === id,
            )
              ? timeline.pendingRequests.map((candidate) =>
                  requestId(candidate.id) === id ? request : candidate,
                )
              : [...timeline.pendingRequests, request],
          },
        },
      };
    });
  },
  hydrate: (threadId, turnId, items) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [threadId]: items.reduce(
          (timeline, item) =>
            upsertEntry(timeline, {
              threadId,
              turnId,
              item,
              lifecycle: itemLifecycle(item),
            }),
          state.threads[threadId] ?? emptyTimeline(),
        ),
      },
    })),
  clear: (threadId) =>
    set((state) => {
      const threads = { ...state.threads };
      delete threads[threadId];
      return { threads };
    }),
}));

let listenerPromise: Promise<UnlistenFn[]> | undefined;

export function installCodexTimelineListeners(): Promise<UnlistenFn[]> {
  listenerPromise ??= Promise.all([
    listen<CodexV2Notification>(CODEX_V2_NOTIFICATION_EVENT, (event) => {
      useCodexTimelineStore.getState().applyNotification(event.payload);
    }),
    listen<CodexV2ServerRequest>(CODEX_V2_SERVER_REQUEST_EVENT, (event) => {
      useCodexTimelineStore.getState().applyServerRequest(event.payload);
    }),
  ]);
  return listenerPromise;
}
