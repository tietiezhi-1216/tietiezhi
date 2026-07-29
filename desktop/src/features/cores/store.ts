import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { isRecord, readString } from "./helpers";
import {
  CORE_EVENTS,
  type AcpSessionHandle,
  type CoreInstallState,
  type CoreInstallStateEvent,
  type CorePermissionRequest,
  type CoreRunState,
  type CoreRunStateEvent,
  type CoreStreamEvent,
  type McpProjectionReport,
} from "./types";

// ---------------------------------------------------------------------------
// Transcript model
// ---------------------------------------------------------------------------

export interface PlanStep {
  content: string;
  status: string;
  priority?: string;
}

export type TranscriptEntry =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "message"; text: string }
  | { id: string; kind: "thought"; text: string }
  | { id: string; kind: "tool"; callId: string; title: string; status: string; raw: unknown }
  | { id: string; kind: "plan"; steps: PlanStep[]; raw: unknown }
  | { id: string; kind: "turn-ended"; stopReason: string }
  | { id: string; kind: "error"; message: string };

export interface SessionTranscript {
  handle: AcpSessionHandle;
  entries: TranscriptEntry[];
  /** True while a `session/prompt` turn is in flight from this renderer. */
  busy: boolean;
}

let entrySeq = 0;
const nextEntryId = (): string => `entry-${++entrySeq}`;

/** ACP plans arrive as opaque payloads; pull out the parts we can render. */
function readPlanSteps(raw: unknown): PlanStep[] {
  if (!isRecord(raw)) return [];
  const entries = raw["entries"];
  if (!Array.isArray(entries)) return [];
  const steps: PlanStep[] = [];
  for (const item of entries) {
    if (!isRecord(item)) continue;
    const content = readString(item["content"]);
    if (content === undefined) continue;
    const priority = readString(item["priority"]);
    steps.push({
      content,
      status: readString(item["status"]) ?? "pending",
      ...(priority === undefined ? {} : { priority }),
    });
  }
  return steps;
}

/**
 * Folds one stream event into a transcript. Consecutive deltas of the same
 * kind merge into a single entry so the UI does not churn one node per token.
 */
export function appendStreamEvent(
  entries: TranscriptEntry[],
  event: CoreStreamEvent,
): TranscriptEntry[] {
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;

  switch (event.kind) {
    case "message-delta":
    case "thought-delta": {
      const kind = event.kind === "message-delta" ? "message" : "thought";
      if (last && last.kind === kind) {
        const merged: TranscriptEntry = { ...last, text: last.text + event.text };
        return [...entries.slice(0, -1), merged];
      }
      return [...entries, { id: nextEntryId(), kind, text: event.text }];
    }

    case "tool-call": {
      const existing = entries.findIndex(
        (entry) => entry.kind === "tool" && entry.callId === event.callId,
      );
      const entry: TranscriptEntry = {
        id: existing >= 0 ? (entries[existing]?.id ?? nextEntryId()) : nextEntryId(),
        kind: "tool",
        callId: event.callId,
        title: event.title,
        status: event.status,
        raw: event.raw,
      };
      if (existing < 0) return [...entries, entry];
      const next = [...entries];
      next[existing] = entry;
      return next;
    }

    case "tool-call-update": {
      const index = entries.findIndex(
        (entry) => entry.kind === "tool" && entry.callId === event.callId,
      );
      const found = index >= 0 ? entries[index] : undefined;
      if (!found || found.kind !== "tool") {
        // An update can outrun its `tool-call` if the core batches updates.
        return [
          ...entries,
          {
            id: nextEntryId(),
            kind: "tool",
            callId: event.callId,
            title: event.callId,
            status: event.status,
            raw: event.raw,
          },
        ];
      }
      const next = [...entries];
      next[index] = { ...found, status: event.status, raw: event.raw };
      return next;
    }

    case "plan":
      return [
        ...entries,
        { id: nextEntryId(), kind: "plan", steps: readPlanSteps(event.raw), raw: event.raw },
      ];

    case "turn-ended":
      return [...entries, { id: nextEntryId(), kind: "turn-ended", stopReason: event.stopReason }];

    case "error":
      return [...entries, { id: nextEntryId(), kind: "error", message: event.message }];
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface CoresState {
  /** Live overrides pushed by events; the query result is the baseline. */
  installState: Record<string, CoreInstallState>;
  runState: Record<string, CoreRunState>;
  sessions: Record<string, SessionTranscript>;
  /** Oldest first — the dialog always answers the head of the queue. */
  permissions: CorePermissionRequest[];
  projection: McpProjectionReport | null;
  selectedCoreId: string | null;
  activeSessionId: string | null;

  selectCore: (coreId: string | null) => void;
  setActiveSession: (sessionId: string | null) => void;
  registerSession: (handle: AcpSessionHandle) => void;
  dropSession: (sessionId: string) => void;
  appendUserText: (sessionId: string, text: string) => void;
  setSessionBusy: (sessionId: string, busy: boolean) => void;
  pushSessionError: (sessionId: string, message: string) => void;
  applyStream: (event: CoreStreamEvent) => void;
  applyRunState: (coreId: string, state: CoreRunState) => void;
  applyInstallState: (coreId: string, state: CoreInstallState) => void;
  pushPermission: (request: CorePermissionRequest) => void;
  dismissPermission: (requestId: string) => void;
  setProjection: (report: McpProjectionReport | null) => void;
}

export const useCoresStore = create<CoresState>()((set) => ({
  installState: {},
  runState: {},
  sessions: {},
  permissions: [],
  projection: null,
  selectedCoreId: null,
  activeSessionId: null,

  selectCore: (selectedCoreId) => set({ selectedCoreId }),

  setActiveSession: (activeSessionId) => set({ activeSessionId }),

  registerSession: (handle) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [handle.sessionId]: { handle, entries: [], busy: false },
      },
      activeSessionId: handle.sessionId,
    })),

  dropSession: (sessionId) =>
    set((state) => {
      const next = { ...state.sessions };
      delete next[sessionId];
      const remaining = Object.keys(next);
      return {
        sessions: next,
        activeSessionId:
          state.activeSessionId === sessionId ? (remaining[0] ?? null) : state.activeSessionId,
      };
    }),

  appendUserText: (sessionId, text) =>
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return {};
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            entries: [...session.entries, { id: nextEntryId(), kind: "user", text }],
          },
        },
      };
    }),

  setSessionBusy: (sessionId, busy) =>
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return {};
      return { sessions: { ...state.sessions, [sessionId]: { ...session, busy } } };
    }),

  pushSessionError: (sessionId, message) =>
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return {};
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            entries: [...session.entries, { id: nextEntryId(), kind: "error", message }],
          },
        },
      };
    }),

  applyStream: (event) =>
    set((state) => {
      const session = state.sessions[event.sessionId];
      // Events for sessions this window never opened are not ours to render.
      if (!session) return {};
      const busy = event.kind === "turn-ended" || event.kind === "error" ? false : session.busy;
      return {
        sessions: {
          ...state.sessions,
          [event.sessionId]: {
            ...session,
            busy,
            entries: appendStreamEvent(session.entries, event),
          },
        },
      };
    }),

  applyRunState: (coreId, state) =>
    set((current) => ({ runState: { ...current.runState, [coreId]: state } })),

  applyInstallState: (coreId, install) =>
    set((current) => ({ installState: { ...current.installState, [coreId]: install } })),

  pushPermission: (request) =>
    set((state) =>
      state.permissions.some((pending) => pending.requestId === request.requestId)
        ? {}
        : { permissions: [...state.permissions, request] },
    ),

  dismissPermission: (requestId) =>
    set((state) => ({
      permissions: state.permissions.filter((pending) => pending.requestId !== requestId),
    })),

  setProjection: (projection) => set({ projection }),
}));

// ---------------------------------------------------------------------------
// Event bridge
// ---------------------------------------------------------------------------

async function subscribe(): Promise<UnlistenFn[]> {
  return Promise.all([
    listen<CoreStreamEvent>(CORE_EVENTS.stream, (event) => {
      useCoresStore.getState().applyStream(event.payload);
    }),
    listen<CorePermissionRequest>(CORE_EVENTS.permission, (event) => {
      useCoresStore.getState().pushPermission(event.payload);
    }),
    listen<CoreRunStateEvent>(CORE_EVENTS.runState, (event) => {
      useCoresStore.getState().applyRunState(event.payload.coreId, event.payload.state);
    }),
    listen<CoreInstallStateEvent>(CORE_EVENTS.installState, (event) => {
      useCoresStore.getState().applyInstallState(event.payload.coreId, event.payload.state);
    }),
    listen<McpProjectionReport>(CORE_EVENTS.mcpProjected, (event) => {
      useCoresStore.getState().setProjection(event.payload);
    }),
  ]).catch((): UnlistenFn[] => {
    // Without the host bridge the page still renders; commands report the error.
    return [];
  });
}

let bridgeRefs = 0;
let bridge: Promise<UnlistenFn[]> | null = null;

/** Subscribes the store to host events for as long as a component needs it. */
export function useCoreEventBridge(): void {
  useEffect(() => {
    bridgeRefs += 1;
    bridge ??= subscribe();
    return () => {
      bridgeRefs -= 1;
      if (bridgeRefs > 0) return;
      const pending = bridge;
      bridge = null;
      void pending?.then((unlisteners) => {
        for (const unlisten of unlisteners) unlisten();
      });
    };
  }, []);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Effective install state: an event override wins over the query baseline. */
export function mergeInstallState(
  baseline: CoreInstallState,
  override: CoreInstallState | undefined,
): CoreInstallState {
  return override ?? baseline;
}

export function mergeRunState(
  baseline: CoreRunState,
  override: CoreRunState | undefined,
): CoreRunState {
  return override ?? baseline;
}
