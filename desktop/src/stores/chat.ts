import { create } from "zustand";
import {
  archiveConversation as archiveConversationApi,
  archiveProjectConversations,
  chatCancel,
  chatStream,
  deleteConversation,
  errorMessage,
  generateConversationTitle,
  listConversations,
  loadConversation,
  permissionRespond,
  restoreConversation,
  saveConversation,
  setConversationPinned as setConversationPinnedApi,
} from "@/lib/api";
import type {
  ChatRole,
  ConversationMeta,
  PermissionDecision,
  StoredMessage,
} from "@/lib/api";
import { useProjectStore } from "@/stores/projects";

interface ItemBase {
  id: number;
  createdAt: number;
}

/** One transcript entry: a text message, a tool call, or a permission ask. */
export type ChatItem =
  | (ItemBase & {
      kind: "message";
      role: ChatRole;
      content: string;
      error?: boolean;
      model?: string;
      providerId?: string;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      usageEstimated?: boolean;
      firstTokenMs?: number;
      durationMs?: number;
      completedAt?: number;
    })
  | (ItemBase & {
      kind: "toolCall";
      callId: string;
      name: string;
      args: unknown;
      status: "running" | "success" | "error";
      output?: string;
    })
  | (ItemBase & {
      kind: "permission";
      requestId: string;
      tool: string;
      description: string;
      args: unknown;
      decision?: PermissionDecision;
    })
  | (ItemBase & {
      kind: "error";
      summary: string;
      detail: string;
      code?: string;
      status?: number;
      retryable: boolean;
      retries: number;
    });

export interface StreamRetryState {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  reason: string;
}

interface ChatState {
  /** Sidebar list, newest first. */
  conversations: ConversationMeta[];
  /** Current conversation id; null = a fresh, not-yet-persisted chat. */
  activeId: string | null;
  /** Increments whenever a fresh draft is requested, even if already on one. */
  draftVersion: number;
  /** Agent profile bound to the current conversation ("" = default). */
  activeAgentId: string;
  /** Project bound to the current task ("" = standalone task). */
  projectId: string;
  /** Messages of the current conversation. */
  items: ChatItem[];
  streaming: boolean;
  streamStartedAt: number | null;
  streamModel: string;
  streamRetry: StreamRetryState | null;
  requestId: number | null;
  init: () => Promise<void>;
  newConversation: (projectId?: string) => void;
  openConversation: (id: string) => Promise<void>;
  archiveConversation: (id: string) => Promise<void>;
  archiveProject: (projectId: string) => Promise<void>;
  restoreArchived: (id: string) => Promise<void>;
  deleteArchived: (id: string) => Promise<void>;
  setConversationPinned: (id: string, pinned: boolean) => Promise<void>;
  send: (providerId: string, model: string, text: string) => Promise<void>;
  setAgent: (agentId: string) => void;
  setProject: (projectId: string) => void;
  respondPermission: (requestId: string, decision: PermissionDecision) => void;
  /** Fork into a new conversation holding everything before `itemId`. */
  branchFrom: (itemId: number) => void;
  /** Fork before `itemId`, then resend it with edited text. */
  editAndResend: (
    itemId: number,
    text: string,
    providerId: string,
    model: string,
  ) => Promise<void>;
  retryFromError: (
    itemId: number,
    providerId: string,
    model: string,
  ) => Promise<void>;
  stop: () => void;
}

let nextId = 1;

const toItems = (messages: StoredMessage[]): ChatItem[] =>
  messages.map((m): ChatItem => {
    const base = { id: nextId++, createdAt: m.createdAt };
    if (m.kind === "toolCall") {
      return {
        ...base,
        kind: "toolCall",
        callId: m.toolCallId ?? "",
        name: m.toolName ?? "",
        args: m.toolArgs,
        status: m.error ? "error" : "success",
        output: m.toolOutput,
      };
    }
    if (m.kind === "permission") {
      return {
        ...base,
        kind: "permission",
        requestId: "",
        tool: m.toolName ?? "",
        description: m.content ?? "",
        args: m.toolArgs,
        decision: m.decision,
      };
    }
    if (m.kind === "error" || m.error) {
      return {
        ...base,
        kind: "error",
        summary:
          m.kind === "error"
            ? (m.content ?? "模型服务请求失败").replaceAll("中转站", "模型服务")
            : legacyErrorSummary(m.content ?? ""),
        detail: (m.errorDetail ?? m.content ?? "模型服务请求失败").replaceAll(
          "中转站",
          "模型服务",
        ),
        code: m.errorCode,
        status: m.errorStatus,
        retryable: m.errorRetryable ?? false,
        retries: m.errorRetries ?? 0,
      };
    }
    return {
      ...base,
      kind: "message",
      role: m.role ?? "assistant",
      content: m.content ?? "",
      model: m.model,
      providerId: m.providerId,
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      totalTokens: m.totalTokens,
      usageEstimated: m.usageEstimated,
      firstTokenMs: m.firstTokenMs,
      durationMs: m.durationMs,
      completedAt: m.completedAt,
    };
  });

/** Drop the UI-only `id`, keeping just what belongs on disk. */
const toStored = (items: ChatItem[]): StoredMessage[] =>
  items.map((it): StoredMessage => {
    if (it.kind === "toolCall") {
      return {
        kind: "toolCall",
        createdAt: it.createdAt,
        toolName: it.name,
        toolCallId: it.callId,
        toolArgs: it.args,
        toolOutput: it.output,
        ...(it.status === "error" ? { error: true } : {}),
      };
    }
    if (it.kind === "permission") {
      return {
        kind: "permission",
        createdAt: it.createdAt,
        toolName: it.tool,
        content: it.description,
        toolArgs: it.args,
        decision: it.decision,
      };
    }
    if (it.kind === "error") {
      return {
        kind: "error",
        createdAt: it.createdAt,
        content: it.summary,
        errorDetail: it.detail,
        errorCode: it.code,
        errorStatus: it.status,
        errorRetryable: it.retryable,
        errorRetries: it.retries,
      };
    }
    return {
      kind: "message",
      role: it.role,
      content: it.content,
      createdAt: it.createdAt,
      ...(it.error ? { error: true } : {}),
      model: it.model,
      providerId: it.providerId,
      promptTokens: it.promptTokens,
      completionTokens: it.completionTokens,
      totalTokens: it.totalTokens,
      usageEstimated: it.usageEstimated,
      firstTokenMs: it.firstTokenMs,
      durationMs: it.durationMs,
      completedAt: it.completedAt,
    };
  });

/** Model-facing history: only clean text turns with actual content. */
const toHistory = (items: ChatItem[]) =>
  items.flatMap((it) =>
    it.kind === "message" && !it.error && it.content
      ? [{ role: it.role, content: it.content }]
      : [],
  );

const DEFAULT_CONVERSATION_TITLE = "新会话";

const legacyErrorSummary = (detail: string): string => {
  if (/HTTP\s+(502|503|504)\b/.test(detail)) return "模型服务暂时不可用";
  if (/HTTP\s+429\b/.test(detail)) return "请求过于频繁";
  if (/HTTP\s+(401|403)\b/.test(detail)) return "模型服务认证失败";
  if (/超时|timeout/i.test(detail)) return "模型服务响应超时";
  return "模型服务请求失败";
};

/**
 * All conversation file writes/deletes are chained onto one queue so they
 * reach disk in call order (e.g. the mid-stream save never lands after the
 * final save, and a delete is never overtaken by a pending save).
 */
let fileQueue: Promise<void> = Promise.resolve();
const enqueueFileOp = (op: () => Promise<void>) => {
  fileQueue = fileQueue.then(op).catch((err: unknown) => {
    // Persistence must never break the chat flow; log and move on.
    console.error("会话存储操作失败：", errorMessage(err));
  });
  return fileQueue;
};

/** Archived or deleted conversations; pending saves for them are dropped. */
const inactiveIds = new Set<string>();
const pendingTitleIds = new Set<string>();

export const useChatStore = create<ChatState>()((set, get) => {
  /** Persist a conversation and move it to the top of the sidebar list. */
  const persist = (id: string, title: string, messages: StoredMessage[]) => {
    const { activeAgentId, projectId } = get();
    return enqueueFileOp(async () => {
      if (inactiveIds.has(id)) return;
      const saved = await saveConversation({
        id,
        title,
        messages,
        agentId: activeAgentId || undefined,
        projectId: projectId || undefined,
      });
      if (inactiveIds.has(id)) return;
      set((state) => ({
        conversations: [
          {
            id,
            title: saved.title,
            updatedAt: saved.updatedAt,
            projectId,
            archivedAt: 0,
            pinnedAt:
              state.conversations.find((conversation) => conversation.id === id)
                ?.pinnedAt ?? 0,
          },
          ...state.conversations.filter((c) => c.id !== id),
        ],
      }));
    });
  };

  const generateTitle = (
    id: string,
    conversationProviderId: string,
    conversationModel: string,
    userMessage: string,
    assistantMessage: string,
    afterSave: Promise<void>,
  ) => {
    if (pendingTitleIds.has(id) || inactiveIds.has(id)) return;
    pendingTitleIds.add(id);
    void afterSave
      .then(async () => {
        if (inactiveIds.has(id)) return;
        const title = await generateConversationTitle(
          id,
          conversationProviderId,
          conversationModel,
          userMessage,
          assistantMessage,
        );
        if (!title || inactiveIds.has(id)) return;
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === id ? { ...conversation, title } : conversation,
          ),
        }));
      })
      .catch((error: unknown) => {
        console.warn("生成会话标题失败：", errorMessage(error));
      })
      .finally(() => pendingTitleIds.delete(id));
  };

  const interruptStream = () => {
    const { streaming, requestId } = get();
    if (streaming && requestId != null) {
      void chatCancel(requestId);
      set({
        streaming: false,
        streamStartedAt: null,
        streamRetry: null,
        requestId: null,
      });
    }
  };

  /** Re-save the current transcript after task metadata changes. */
  const persistCurrent = () => {
    const { activeId, items, conversations } = get();
    if (activeId == null) return;
    const title =
      conversations.find((c) => c.id === activeId)?.title ??
      DEFAULT_CONVERSATION_TITLE;
    persist(activeId, title, toStored(items));
  };

  return {
    conversations: [],
    activeId: null,
    draftVersion: 0,
    activeAgentId: "",
    projectId: "",
    items: [],
    streaming: false,
    streamStartedAt: null,
    streamModel: "",
    streamRetry: null,
    requestId: null,

    async init() {
      try {
        set({ conversations: await listConversations() });
      } catch (err) {
        console.error("加载会话列表失败：", errorMessage(err));
      }
    },

    newConversation(projectId = "") {
      interruptStream();
      // Keep the picked agent so「换个话题」stays in the same persona;
      // Project binding is per task and resets for a fresh draft.
      set((state) => ({
        activeId: null,
        draftVersion: state.draftVersion + 1,
        items: [],
        projectId,
        streamStartedAt: null,
        streamRetry: null,
      }));
    },

    async openConversation(id) {
      if (get().activeId === id) return;
      interruptStream();
      try {
        const conv = await loadConversation(id);
        set({
          activeId: id,
          items: toItems(conv.messages),
          activeAgentId: conv.agentId ?? "",
          projectId: conv.projectId ?? "",
          streamStartedAt: null,
          streamRetry: null,
        });
        if (conv.projectId) void useProjectStore.getState().markUsed(conv.projectId);
      } catch (err) {
        console.error("加载会话失败：", errorMessage(err));
      }
    },

    async archiveConversation(id) {
      inactiveIds.add(id);
      if (get().activeId === id) {
        interruptStream();
        set({ activeId: null, items: [], projectId: "" });
      }
      set((state) => ({
        conversations: state.conversations.filter((c) => c.id !== id),
      }));
      await enqueueFileOp(() => archiveConversationApi(id));
    },

    async archiveProject(projectId) {
      const taskIds = get()
        .conversations.filter((task) => task.projectId === projectId)
        .map((task) => task.id);
      taskIds.forEach((id) => inactiveIds.add(id));
      if (get().activeId != null && taskIds.includes(get().activeId as string)) {
        interruptStream();
        set({ activeId: null, items: [], projectId: "" });
      }
      set((state) => ({
        conversations: state.conversations.filter(
          (task) => task.projectId !== projectId,
        ),
      }));
      await enqueueFileOp(async () => {
        await archiveProjectConversations(projectId);
      });
    },

    async restoreArchived(id) {
      await fileQueue;
      await restoreConversation(id);
      inactiveIds.delete(id);
      await get().init();
    },

    async deleteArchived(id) {
      inactiveIds.add(id);
      await fileQueue;
      await deleteConversation(id);
      await get().init();
    },

    async setConversationPinned(id, pinned) {
      const pinnedAt = pinned ? Date.now() : 0;
      set((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === id ? { ...conversation, pinnedAt } : conversation,
        ),
      }));
      await enqueueFileOp(async () => {
        const persistedPinnedAt = await setConversationPinnedApi(id, pinned);
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === id
              ? { ...conversation, pinnedAt: persistedPinnedAt }
              : conversation,
          ),
        }));
      });
    },

    setAgent(agentId) {
      set({ activeAgentId: agentId });
      persistCurrent();
    },

    setProject(projectId) {
      set({ projectId });
      persistCurrent();
    },

    respondPermission(requestId, decision) {
      void permissionRespond(requestId, decision).catch((err: unknown) => {
        console.error("回复授权失败：", errorMessage(err));
      });
      set((state) => ({
        items: state.items.map((it) =>
          it.kind === "permission" && it.requestId === requestId
            ? { ...it, decision }
            : it,
        ),
      }));
    },

    async send(providerId, model, text) {
      if (get().streaming) return;
      const requestId = nextId++;

      // Resolve the target conversation, creating one on first message.
      let convId = get().activeId;
      let title: string;
      if (convId == null) {
        convId = crypto.randomUUID();
        title = DEFAULT_CONVERSATION_TITLE;
        set({ activeId: convId });
      } else {
        title =
          get().conversations.find((c) => c.id === convId)?.title ??
          DEFAULT_CONVERSATION_TITLE;
      }

      const now = Date.now();
      const history = toHistory(get().items);

      const userItem: ChatItem = {
        id: nextId++,
        kind: "message",
        role: "user",
        content: text,
        createdAt: now,
      };
      set({
        items: [...get().items, userItem],
        streaming: true,
        streamStartedAt: now,
        streamModel: model,
        streamRetry: null,
        requestId,
      });

      // Persist the user turn right away so it survives crashes mid-stream.
      persist(convId, title, toStored(get().items));

      // The item currently receiving text deltas. A tool call closes it so
      // the next delta opens a fresh message (text/tool interleaving).
      let textItemId: number | null = null;
      let reply = "";
      let failed = false;
      let cancelled = false;
      let sawText = false;
      let titleAssistantText = "";
      let firstTokenAt: number | null = null;
      let lastTextItemId: number | null = null;
      let effectiveModel = model;
      let promptTokens = 0;
      let completionTokens = 0;
      let totalTokens = 0;
      let hasReportedUsage = false;

      const patchItem = (id: number, patch: (item: ChatItem) => ChatItem) => {
        set((state) => ({
          items: state.items.map((it) => (it.id === id ? patch(it) : it)),
        }));
      };

      const appendItem = (item: ChatItem) => {
        // Guard against patching a different conversation after mid-stream
        // switches: append only while this request is still the active one.
        if (get().requestId !== requestId) return;
        set((state) => ({ items: [...state.items, item] }));
      };

      const ensureTextItem = (): number => {
        if (textItemId == null) {
          reply = "";
          const item: ChatItem = {
            id: nextId++,
            kind: "message",
            role: "assistant",
            content: "",
            createdAt: Date.now(),
            model: effectiveModel,
            providerId,
          };
          textItemId = item.id;
          lastTextItemId = item.id;
          appendItem(item);
        }
        return textItemId;
      };

      // Deltas arrive per-token; painting each one re-renders the (markdown)
      // message and janks the stream. Batch them: at most one UI flush per
      // interval, with a final flush when the stream settles.
      let flushTimer: number | null = null;
      const flushReply = () => {
        flushTimer = null;
        if (textItemId != null) {
          const content = reply;
          patchItem(textItemId, (it) =>
            it.kind === "message" ? { ...it, content } : it,
          );
        }
      };
      const scheduleFlush = () => {
        flushTimer ??= window.setTimeout(flushReply, 50);
      };
      const cancelFlush = () => {
        if (flushTimer != null) window.clearTimeout(flushTimer);
        flushTimer = null;
      };

      const fail = (failure: {
        message: string;
        detail: string;
        code?: string;
        status?: number;
        retryable: boolean;
        retries: number;
      }) => {
        failed = true;
        appendItem({
          id: nextId++,
          kind: "error",
          summary: failure.message.replaceAll("中转站", "模型服务"),
          detail: failure.detail.replaceAll("中转站", "模型服务"),
          code: failure.code,
          status: failure.status,
          retryable: failure.retryable,
          retries: failure.retries,
          createdAt: Date.now(),
        });
      };

      try {
        await chatStream({
          requestId,
          providerId,
          model,
          messages: [...history, { role: "user", content: text }],
          conversationId: convId,
          agentId: get().activeAgentId || undefined,
          projectId: get().projectId || undefined,
          onEvent: (event) => {
            switch (event.type) {
              case "started": {
                effectiveModel = event.model;
                set({ streamModel: event.model });
                if (lastTextItemId != null) {
                  patchItem(lastTextItemId, (it) =>
                    it.kind === "message" ? { ...it, model: event.model } : it,
                  );
                }
                break;
              }
              case "delta": {
                if (get().streamRetry != null) set({ streamRetry: null });
                sawText = true;
                if (titleAssistantText.length < 4_000) {
                  titleAssistantText += event.content;
                }
                firstTokenAt ??= Date.now();
                ensureTextItem();
                reply += event.content;
                scheduleFlush();
                break;
              }
              case "usage": {
                hasReportedUsage = true;
                promptTokens += event.promptTokens;
                completionTokens += event.completionTokens;
                totalTokens += event.totalTokens;
                break;
              }
              case "toolCallStart": {
                set({ streamRetry: null });
                cancelFlush();
                flushReply();
                textItemId = null;
                appendItem({
                  id: nextId++,
                  kind: "toolCall",
                  callId: event.id,
                  name: event.name,
                  args: event.args,
                  status: "running",
                  createdAt: Date.now(),
                });
                break;
              }
              case "toolResult": {
                set((state) => ({
                  items: state.items.map((it) =>
                    it.kind === "toolCall" &&
                    it.callId === event.id &&
                    it.status === "running"
                      ? {
                          ...it,
                          status: event.isError ? "error" : "success",
                          output: event.output,
                        }
                      : it,
                  ),
                }));
                break;
              }
              case "permissionRequest": {
                set({ streamRetry: null });
                cancelFlush();
                flushReply();
                textItemId = null;
                appendItem({
                  id: nextId++,
                  kind: "permission",
                  requestId: event.id,
                  tool: event.tool,
                  description: event.description,
                  args: event.args,
                  createdAt: Date.now(),
                });
                break;
              }
              case "retrying": {
                set({
                  streamRetry: {
                    attempt: event.attempt,
                    maxRetries: event.maxRetries,
                    delayMs: event.delayMs,
                    reason: event.reason,
                  },
                });
                break;
              }
              case "done": {
                set({ streamRetry: null });
                cancelled = event.cancelled;
                break;
              }
              case "error": {
                set({ streamRetry: null });
                cancelFlush();
                fail(event);
                break;
              }
            }
          },
        });
      } catch (err) {
        cancelFlush();
        const detail = errorMessage(err).replaceAll("中转站", "模型服务");
        fail({
          message: "模型服务请求失败",
          detail,
          retryable: false,
          retries: 0,
        });
      } finally {
        cancelFlush();
        flushReply();
        if (!sawText && !failed) {
          const id = ensureTextItem();
          reply = cancelled ? "（已停止）" : "（空回复）";
          const content = reply;
          patchItem(id, (it) =>
            it.kind === "message" && !it.content ? { ...it, content } : it,
          );
        }
        const completedAt = Date.now();
        if (lastTextItemId != null) {
          patchItem(lastTextItemId, (it) =>
            it.kind === "message"
              ? {
                  ...it,
                  model: effectiveModel,
                  providerId,
                  ...(hasReportedUsage
                    ? {
                        promptTokens,
                        completionTokens,
                        totalTokens,
                        usageEstimated: false,
                      }
                    : {}),
                  firstTokenMs:
                    firstTokenAt == null ? undefined : firstTokenAt - now,
                  durationMs: completedAt - now,
                  completedAt,
                }
              : it,
          );
        }
        // Only clear the flags if no newer stream took over meanwhile.
        if (get().requestId === requestId) {
          set({
            streaming: false,
            streamStartedAt: null,
            streamRetry: null,
            requestId: null,
          });
          const saved = persist(convId, title, toStored(get().items));
          if (title === DEFAULT_CONVERSATION_TITLE) {
            generateTitle(
              convId,
              providerId,
              effectiveModel,
              text,
              titleAssistantText,
              saved,
            );
          }
        }
      }
    },

    branchFrom(itemId) {
      const { items } = get();
      const index = items.findIndex((it) => it.id === itemId);
      if (index < 0) return;
      interruptStream();

      // Everything before the picked message carries over; the original
      // conversation is left untouched.
      const kept = items.slice(0, index);
      const convId = crypto.randomUUID();
      set({ activeId: convId, items: kept });
      persist(convId, DEFAULT_CONVERSATION_TITLE, toStored(kept));
    },

    async editAndResend(itemId, text, providerId, model) {
      const { items } = get();
      const index = items.findIndex((it) => it.id === itemId);
      if (index < 0) return;
      interruptStream();

      // Fork before the edited turn, then send it as the new branch's opener.
      // The branch keeps the default title until AI title generation finishes.
      const kept = items.slice(0, index);
      set({ activeId: crypto.randomUUID(), items: kept });
      await get().send(providerId, model, text);
    },

    async retryFromError(itemId, providerId, model) {
      const { items } = get();
      const errorIndex = items.findIndex(
        (item) => item.id === itemId && item.kind === "error",
      );
      if (errorIndex < 0) return;
      const userItem = items
        .slice(0, errorIndex)
        .reverse()
        .find(
          (item): item is Extract<ChatItem, { kind: "message" }> =>
            item.kind === "message" && item.role === "user",
        );
      if (!userItem) return;
      const userIndex = items.findIndex((item) => item.id === userItem.id);
      if (userIndex < 0) return;
      interruptStream();
      set({ items: items.slice(0, userIndex), streamRetry: null });
      await get().send(providerId, model, userItem.content);
    },

    stop() {
      const id = get().requestId;
      if (id != null) void chatCancel(id);
    },
  };
});
