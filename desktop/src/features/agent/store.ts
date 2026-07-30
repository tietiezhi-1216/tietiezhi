import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import { AGENT_EVENTS, type StreamEnvelope } from "./api";
import type {
  AgentEvent,
  ApprovalEnvelope,
  ApprovalRequest,
  Message,
  SessionMeta,
  TranscriptEntry,
  TranscriptState,
} from "./types";

let entrySeq = 0;
const nextId = (): string => `ae-${++entrySeq}`;

/**
 * Folds one event into a transcript.
 *
 * Deltas grow the trailing bubble of the same kind rather than appending a new
 * one, which is what makes streaming look continuous. `message-done` is
 * deliberately *not* used to rebuild the transcript: the deltas already produced
 * it, and replacing it would make the text flicker.
 */
function applyEvent(entries: TranscriptEntry[], event: AgentEvent): TranscriptEntry[] {
  switch (event.type) {
    case "text-delta":
    case "reasoning-delta": {
      const kind = event.type === "text-delta" ? "assistant" : "reasoning";
      const last = entries[entries.length - 1];
      if (last?.kind === kind && last.streaming) {
        return [...entries.slice(0, -1), { ...last, text: last.text + event.text }];
      }
      return [...entries, { id: nextId(), kind, text: event.text, streaming: true }];
    }

    case "tool-call-start":
      return [
        ...entries,
        {
          id: nextId(),
          kind: "tool",
          callId: event.callId,
          toolName: event.toolName,
          input: null,
          status: "pending",
          output: null,
          detail: null,
        },
      ];

    case "tool-call": {
      // The entry usually exists from `tool-call-start`; a provider that skips
      // that part must still produce a visible call.
      const index = entries.findIndex(
        (entry) => entry.kind === "tool" && entry.callId === event.callId,
      );
      if (index < 0) {
        return [
          ...entries,
          {
            id: nextId(),
            kind: "tool",
            callId: event.callId,
            toolName: event.toolName,
            input: event.input,
            status: "pending",
            output: null,
            detail: null,
          },
        ];
      }
      return entries.map((entry, at) =>
        at === index && entry.kind === "tool" ? { ...entry, input: event.input } : entry,
      );
    }

    case "approval-required":
      return entries.map((entry) =>
        entry.kind === "tool" && entry.status === "pending" && entry.toolName === event.request.toolName
          ? { ...entry, status: "awaiting-approval" }
          : entry,
      );

    case "tool-result":
      return entries.map((entry) =>
        entry.kind === "tool" && entry.callId === event.callId
          ? {
              ...entry,
              status: event.isError ? "error" : "done",
              output: event.output,
              // Only the live event carries this; it is not persisted, so a
              // reopened session shows the call without a diff.
              detail: event.detail ?? null,
            }
          : entry,
      );

    case "turn-done": {
      const settled = entries.map((entry) =>
        (entry.kind === "assistant" || entry.kind === "reasoning") && entry.streaming
          ? { ...entry, streaming: false }
          : entry,
      );
      // Only outcomes the user would otherwise misread get a notice; a plain
      // `stop` needs no announcement.
      const notice =
        event.reason === "max-steps"
          ? "已达到本轮步数上限，可以继续追问让它接着做。"
          : event.reason === "denied"
            ? "你拒绝了这个操作，本轮已结束。"
            : event.reason === "cancelled"
              ? "已取消。"
              : null;
      return notice === null
        ? settled
        : [
            ...settled,
            { id: nextId(), kind: "notice", text: notice, tone: "info" },
          ];
    }

    case "error":
      return [...entries, { id: nextId(), kind: "notice", text: event.message, tone: "error" }];

    case "message-done":
      return entries;
  }
}

/** Rebuilds a transcript from persisted history when a session is reopened. */
export function entriesFromMessages(messages: Message[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "text") {
        entries.push(
          message.role === "user"
            ? { id: nextId(), kind: "user", text: part.text }
            : { id: nextId(), kind: "assistant", text: part.text, streaming: false },
        );
      } else if (part.type === "reasoning") {
        entries.push({ id: nextId(), kind: "reasoning", text: part.text, streaming: false });
      } else if (part.type === "tool-call") {
        entries.push({
          id: nextId(),
          kind: "tool",
          callId: part.callId,
          toolName: part.toolName,
          input: part.input,
          status: "pending",
          output: null,
          detail: null,
        });
      } else {
        const index = entries.findIndex(
          (entry) => entry.kind === "tool" && entry.callId === part.callId,
        );
        if (index >= 0) {
          const existing = entries[index];
          if (existing?.kind === "tool") {
            entries[index] = {
              ...existing,
              status: part.isError === true ? "error" : "done",
              output: part.output,
            };
          }
        }
      }
    }
  }
  return entries;
}

interface AgentStoreState {
  sessions: Record<string, TranscriptState>;
  activeId: string | null;
  setActive: (sessionId: string | null) => void;
  openSession: (meta: SessionMeta, messages: Message[]) => void;
  closeSession: (sessionId: string) => void;
  appendUser: (sessionId: string, text: string) => void;
  setBusy: (sessionId: string, busy: boolean) => void;
  applyStream: (envelope: StreamEnvelope) => void;
  setApproval: (sessionId: string, request: ApprovalRequest | null) => void;
  patchMeta: (meta: SessionMeta) => void;
}

export const useAgentStore = create<AgentStoreState>()((set) => ({
  sessions: {},
  activeId: null,

  setActive: (activeId) => set({ activeId }),

  openSession: (meta, messages) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [meta.id]: {
          meta,
          entries: entriesFromMessages(messages),
          busy: false,
          approval: null,
        },
      },
      activeId: meta.id,
    })),

  closeSession: (sessionId) =>
    set((state) => {
      const next = { ...state.sessions };
      delete next[sessionId];
      const remaining = Object.keys(next);
      return {
        sessions: next,
        activeId: state.activeId === sessionId ? (remaining[0] ?? null) : state.activeId,
      };
    }),

  appendUser: (sessionId, text) =>
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return {};
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            entries: [...session.entries, { id: nextId(), kind: "user", text }],
          },
        },
      };
    }),

  setBusy: (sessionId, busy) =>
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return {};
      return { sessions: { ...state.sessions, [sessionId]: { ...session, busy } } };
    }),

  applyStream: ({ sessionId, event }) =>
    set((state) => {
      const session = state.sessions[sessionId];
      // Events for sessions this window has not opened are not ours to render.
      if (!session) return {};
      const busy = event.type === "turn-done" ? false : session.busy;
      const approval = event.type === "turn-done" ? null : session.approval;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            busy,
            approval,
            entries: applyEvent(session.entries, event),
          },
        },
      };
    }),

  setApproval: (sessionId, request) =>
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return {};
      return { sessions: { ...state.sessions, [sessionId]: { ...session, approval: request } } };
    }),

  patchMeta: (meta) =>
    set((state) => {
      const session = state.sessions[meta.id];
      if (!session) return {};
      return { sessions: { ...state.sessions, [meta.id]: { ...session, meta } } };
    }),
}));

let refs = 0;
let bridge: Promise<UnlistenFn[]> | null = null;

async function subscribe(): Promise<UnlistenFn[]> {
  return Promise.all([
    listen<StreamEnvelope>(AGENT_EVENTS.stream, (event) => {
      useAgentStore.getState().applyStream(event.payload);
    }),
    listen<ApprovalEnvelope>(AGENT_EVENTS.approval, (event) => {
      useAgentStore.getState().setApproval(event.payload.sessionId, event.payload.request);
    }),
  ]).catch((): UnlistenFn[] => []);
}

/** Subscribes to agent events for as long as a component needs them. */
export function useAgentEventBridge(): void {
  useEffect(() => {
    refs += 1;
    bridge ??= subscribe();
    return () => {
      refs -= 1;
      if (refs > 0) return;
      const pending = bridge;
      bridge = null;
      void pending?.then((unlisteners) => {
        for (const unlisten of unlisteners) unlisten();
      });
    };
  }, []);
}
