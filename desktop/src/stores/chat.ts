import { create } from "zustand";
import {
  archiveConversation as archiveConversationApi,
  archiveProjectConversations,
  chatCancel,
  chatStream,
  codexResumeWorkspaceThread,
  codexStartWorkspaceThread,
  deleteConversation,
  errorMessage,
  generateConversationTitle,
  listConversations,
  loadConversation,
  permissionRespond,
  refreshProjectRecommendations,
  restoreConversation,
  saveConversation,
  setConversationPinned as setConversationPinnedApi,
} from "@/lib/api";
import type {
  ChatAttachment,
  ChatMessage,
  ChatRole,
  ConversationMeta,
  PermissionDecision,
  StoredMessage,
} from "@/lib/api";
import { useProjectStore } from "@/stores/projects";
import {
  installCodexTimelineListeners,
  useCodexTimelineStore,
} from "@/stores/codex-timeline";
import type { TaskMode } from "@/lib/task-mode";
import { notifyActionableGatewayError } from "@/lib/gateway-feedback";

interface ItemBase {
  id: number;
  createdAt: number;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  reasoningItemId?: string;
}

/** One transcript entry: a text message, a tool call, or a permission ask. */
export type ChatItem =
  | (ItemBase & {
      kind: "message";
      role: ChatRole;
      content: string;
      /** Reasoning / chain-of-thought, shown collapsed above the answer. */
      reasoning?: string;
      attachments?: ChatAttachment[];
      error?: boolean;
      model?: string;
      providerId?: string;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cachedTokens?: number;
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
      status: "running" | "success" | "error" | "cancelled";
      output?: string;
      timeoutMs?: number;
      durationMs?: number;
      exitCode?: number;
      timedOut?: boolean;
      truncated?: boolean;
    })
  | (ItemBase & {
      kind: "permission";
      requestId: string;
      tool: string;
      description: string;
      args: unknown;
      scope: string;
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
    })
  | (ItemBase & {
      kind: "context";
      action: "compaction" | "usage";
      summary?: string;
      automatic: boolean;
      duringTurn: boolean;
      tokensBefore: number;
      tokensAfter: number;
      contextWindow: number;
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
  /** Active writable execution space; transcript and task identity stay shared. */
  taskMode: TaskMode;
  /** Messages of the current conversation. */
  items: ChatItem[];
  streaming: boolean;
  streamStartedAt: number | null;
  streamModel: string;
  streamRetry: StreamRetryState | null;
  streamActivity: "compacting" | "inspecting" | null;
  requestId: number | null;
  init: () => Promise<void>;
  newConversation: (projectId?: string) => void;
  openConversation: (id: string) => Promise<void>;
  archiveConversation: (id: string) => Promise<void>;
  archiveProject: (projectId: string) => Promise<void>;
  restoreArchived: (id: string) => Promise<void>;
  deleteArchived: (id: string) => Promise<void>;
  setConversationPinned: (id: string, pinned: boolean) => Promise<void>;
  send: (
    providerId: string,
    model: string,
    text: string,
    attachments?: ChatAttachment[],
  ) => Promise<void>;
  setAgent: (agentId: string) => void;
  setProject: (projectId: string) => void;
  setTaskMode: (mode: TaskMode) => void;
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

const nextRequestId = (): number => {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] || 1;
};

const contextCommand = (
  text: string,
): "compact" | "inspect" | null => {
  switch (text.trim().toLocaleLowerCase()) {
    case "/compact":
    case "/summarize":
    case "/压缩":
      return "compact";
    case "/context":
    case "/上下文":
      return "inspect";
    default:
      return null;
  }
};

const normalizePermissionDecision = (
  decision: StoredMessage["decision"],
): PermissionDecision | undefined => {
  switch (decision) {
    case "accept":
    case "acceptForSession":
    case "decline":
    case "cancel":
      return decision;
    case "allow":
      return "accept";
    case "allowAlways":
      return "acceptForSession";
    case "deny":
      return "decline";
    default:
      return undefined;
  }
};

export const restoreConversationItems = (
  messages: StoredMessage[],
): ChatItem[] =>
  messages.map((m): ChatItem => {
    const base = {
      id: nextId++,
      createdAt: m.createdAt,
      threadId: m.threadId,
      turnId: m.turnId,
      itemId: m.itemId,
      reasoningItemId: m.reasoningItemId,
    };
    if (m.kind === "context") {
      return {
        ...base,
        kind: "context",
        action: m.contextAction ?? "usage",
        summary: m.contextSummary,
        automatic: m.contextAutomatic ?? false,
        duringTurn: m.contextDuringTurn ?? false,
        tokensBefore: m.contextTokensBefore ?? 0,
        tokensAfter: m.contextTokensAfter ?? m.contextTokensBefore ?? 0,
        contextWindow: m.contextWindow ?? 256 * 1024,
      };
    }
    if (m.kind === "toolCall") {
      return {
        ...base,
        kind: "toolCall",
        callId: m.toolCallId ?? "",
        name: m.toolName ?? "",
        args: m.toolArgs,
        status:
          m.toolStatus === "running" || m.toolStatus === "cancelled"
            ? "cancelled"
            : m.toolStatus === "error" || m.error
              ? "error"
              : "success",
        output:
          m.toolStatus === "running"
            ? m.toolOutput
              ? `${m.toolOutput}\n\n[上次运行未正常结束]`
              : "[上次运行未正常结束]"
            : m.toolOutput,
        durationMs: m.toolDurationMs,
        exitCode: m.toolExitCode,
        timedOut: m.toolTimedOut,
        truncated: m.toolTruncated,
      };
    }
    if (m.kind === "permission") {
      return {
        ...base,
        kind: "permission",
        requestId: m.permissionRequestId ?? "",
        tool: m.toolName ?? "",
        description: m.content ?? "",
        args: m.toolArgs,
        scope: m.permissionScope ?? "",
        decision: normalizePermissionDecision(m.decision),
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
      reasoning: m.reasoning,
      attachments: m.attachments,
      model: m.model,
      providerId: m.providerId,
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      totalTokens: m.totalTokens,
      cachedTokens: m.cachedTokens,
      usageEstimated: m.usageEstimated,
      firstTokenMs: m.firstTokenMs,
      durationMs: m.durationMs,
      completedAt: m.completedAt,
    };
  });

/** Drop the UI-only `id`, keeping just what belongs on disk. */
export const persistConversationItems = (
  items: ChatItem[],
): StoredMessage[] =>
  items.map((it): StoredMessage => {
    const identity = {
      threadId: it.threadId,
      turnId: it.turnId,
      itemId: it.itemId,
      reasoningItemId: it.reasoningItemId,
    };
    if (it.kind === "context") {
      return {
        ...identity,
        kind: "context",
        createdAt: it.createdAt,
        contextAction: it.action,
        contextSummary: it.summary,
        contextAutomatic: it.automatic,
        contextDuringTurn: it.duringTurn,
        contextTokensBefore: it.tokensBefore,
        contextTokensAfter: it.tokensAfter,
        contextWindow: it.contextWindow,
      };
    }
    if (it.kind === "toolCall") {
      return {
        ...identity,
        kind: "toolCall",
        createdAt: it.createdAt,
        toolName: it.name,
        toolCallId: it.callId,
        toolArgs: it.args,
        toolOutput: it.output,
        toolStatus: it.status,
        toolDurationMs: it.durationMs,
        toolExitCode: it.exitCode,
        toolTimedOut: it.timedOut,
        toolTruncated: it.truncated,
        ...(it.status === "error" ? { error: true } : {}),
      };
    }
    if (it.kind === "permission") {
      return {
        ...identity,
        kind: "permission",
        createdAt: it.createdAt,
        toolName: it.tool,
        permissionRequestId: it.requestId,
        content: it.description,
        toolArgs: it.args,
        permissionScope: it.scope,
        decision: it.decision,
      };
    }
    if (it.kind === "error") {
      return {
        ...identity,
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
      ...identity,
      kind: "message",
      role: it.role,
      content: it.content,
      ...(it.reasoning ? { reasoning: it.reasoning } : {}),
      attachments: it.attachments,
      createdAt: it.createdAt,
      ...(it.error ? { error: true } : {}),
      model: it.model,
      providerId: it.providerId,
      promptTokens: it.promptTokens,
      completionTokens: it.completionTokens,
      totalTokens: it.totalTokens,
      cachedTokens: it.cachedTokens,
      usageEstimated: it.usageEstimated,
      firstTokenMs: it.firstTokenMs,
      durationMs: it.durationMs,
      completedAt: it.completedAt,
    };
  });

const toModelContent = (
  text: string,
  attachments?: ChatAttachment[],
): ChatMessage["content"] => {
  if (!attachments?.length) return text;
  const context = attachments
    .filter((attachment) => (attachment.kind ?? "image") !== "image")
    .map((attachment) => {
      const label = attachment.kind === "folder" ? "attached_directory" : "attached_file";
      const attributes = [
        `name=${JSON.stringify(attachment.name)}`,
        attachment.path ? `path=${JSON.stringify(attachment.path)}` : "",
        attachment.mimeType ? `mime=${JSON.stringify(attachment.mimeType)}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const body = attachment.textContent
        ? `${attachment.textContent}${attachment.truncated ? "\n[内容已截断]" : ""}`
        : "[二进制资产：内容未内嵌；需要时可通过本地路径读取。]";
      return `<${label} ${attributes}>\n${body}\n</${label}>`;
    })
    .join("\n\n");
  const combinedText = [text, context].filter(Boolean).join("\n\n");
  const images = attachments.filter(
    (attachment) => (attachment.kind ?? "image") === "image" && attachment.dataUrl,
  );
  if (images.length === 0) return combinedText;
  return [
    ...(combinedText ? [{ type: "text" as const, text: combinedText }] : []),
    ...images.map((attachment) => ({
      type: "image_url" as const,
      image_url: { url: attachment.dataUrl! },
    })),
  ];
};

/** Model-facing history starts at the latest persisted compaction anchor. */
const toHistory = (items: ChatItem[]) => {
  let anchorIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "context" && item.action === "compaction" && item.summary) {
      anchorIndex = index;
      break;
    }
  }
  const anchor = anchorIndex >= 0 ? items[anchorIndex] : null;
  const recentItems = anchorIndex >= 0 ? items.slice(anchorIndex + 1) : items;
  const history = recentItems.flatMap((it) =>
    it.kind === "message" && !it.error && (it.content || it.attachments?.length)
      ? [{ role: it.role, content: toModelContent(it.content, it.attachments) }]
      : [],
  );
  if (anchor?.kind !== "context" || !anchor.summary) return history;
  return [
    {
      role: "system" as const,
      content: `<context_summary>\n${anchor.summary}\n</context_summary>\n以上是较早对话的锚定摘要。把它视为可信历史，并结合后续原始消息继续任务。`,
    },
    ...history,
  ];
};

const DEFAULT_CONVERSATION_TITLE = "新会话";

const legacyErrorSummary = (detail: string): string => {
  if (/HTTP\s+(502|503|504)\b/.test(detail)) return "模型服务暂时不可用";
  if (/HTTP\s+429\b/.test(detail)) return "请求过于频繁";
  if (/HTTP\s+(401|403)\b/.test(detail)) return "模型服务认证失败";
  if (/超时|timeout/i.test(detail)) return "模型服务响应超时";
  return "模型服务请求失败";
};

const notifyStandaloneGatewayFailure = (failure: {
  message: string;
  detail: string;
  code?: string;
  status?: number;
}): boolean =>
  notifyActionableGatewayError(
    [
      failure.message,
      failure.detail,
      failure.code,
      failure.status ? `HTTP ${failure.status}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

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
    const { activeAgentId, projectId, taskMode } = get();
    return enqueueFileOp(async () => {
      if (inactiveIds.has(id)) return;
      const saved = await saveConversation({
        id,
        title,
        messages,
        agentId: activeAgentId || undefined,
        projectId: projectId || undefined,
        taskMode,
      });
      if (inactiveIds.has(id)) return;
      set((state) => ({
        conversations: [
          {
            id,
            title: saved.title,
            updatedAt: saved.updatedAt,
            projectId,
            taskMode,
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
    const { streaming, requestId, activeId, conversations } = get();
    if (streaming && requestId != null) {
      void chatCancel(requestId);
      const interruptedAt = Date.now();
      set((state) => ({
        items: state.items.map((item) =>
          item.kind === "toolCall" && item.status === "running"
            ? {
                ...item,
                status: "cancelled",
                output: item.output
                  ? `${item.output}\n\n[已由用户停止]`
                  : "[已由用户停止]",
                durationMs: interruptedAt - item.createdAt,
              }
            : item,
        ),
        streaming: false,
        streamStartedAt: null,
        streamRetry: null,
        streamActivity: null,
        requestId: null,
      }));
      if (activeId != null) {
        const title =
          conversations.find((conversation) => conversation.id === activeId)?.title ??
          DEFAULT_CONVERSATION_TITLE;
        persist(activeId, title, persistConversationItems(get().items));
      }
    }
  };

  /** Re-save the current transcript after task metadata changes. */
  const persistCurrent = () => {
    const { activeId, items, conversations } = get();
    if (activeId == null) return;
    const title =
      conversations.find((c) => c.id === activeId)?.title ??
      DEFAULT_CONVERSATION_TITLE;
    persist(activeId, title, persistConversationItems(items));
  };

  const runContextCommand = async (
    providerId: string,
    model: string,
    action: "compact" | "inspect",
  ) => {
    if (get().streaming) return;
    const requestId = nextRequestId();
    const startedAt = Date.now();
    const conversationId = get().activeId;
    let changed = false;

    const appendContextError = (failure: {
      message: string;
      detail: string;
      code?: string;
      status?: number;
      retryable: boolean;
      retries: number;
    }) => {
      if (notifyStandaloneGatewayFailure(failure)) return;
      changed = true;
      set((state) => ({
        items: [
          ...state.items,
          {
            id: nextId++,
            kind: "error",
            summary: failure.message.replaceAll("中转站", "模型服务"),
            detail: failure.detail.replaceAll("中转站", "模型服务"),
            code: failure.code,
            status: failure.status,
            retryable: failure.retryable,
            retries: failure.retries,
            createdAt: Date.now(),
          },
        ],
      }));
    };

    set({
      streaming: true,
      streamStartedAt: startedAt,
      streamModel: model,
      streamRetry: null,
      streamActivity: action === "compact" ? "compacting" : "inspecting",
      requestId,
    });

    try {
      await chatStream({
        requestId,
        providerId,
        model,
        messages: toHistory(get().items),
        conversationId: conversationId ?? undefined,
        agentId: get().activeAgentId || undefined,
        projectId: get().projectId || undefined,
        taskMode: get().taskMode,
        contextAction: action,
        onEvent: (event) => {
          switch (event.type) {
            case "started":
              set({ streamModel: event.model });
              break;
            case "retrying":
              set({
                streamRetry: {
                  attempt: event.attempt,
                  maxRetries: event.maxRetries,
                  delayMs: event.delayMs,
                  reason: event.reason,
                },
              });
              break;
            case "contextCompactionStarted":
              set({ streamActivity: "compacting", streamRetry: null });
              break;
            case "contextCompacted":
              changed = true;
              set((state) => ({
                streamActivity: null,
                streamRetry: null,
                items: [
                  ...state.items,
                  {
                    id: nextId++,
                    kind: "context",
                    action: "compaction",
                    summary: event.summary,
                    automatic: event.automatic,
                    duringTurn: event.duringTurn,
                    tokensBefore: event.estimatedTokensBefore,
                    tokensAfter: event.estimatedTokensAfter,
                    contextWindow: event.contextWindow,
                    createdAt: Date.now(),
                  },
                ],
              }));
              break;
            case "contextUsage":
              changed = true;
              set((state) => ({
                streamActivity: null,
                items: [
                  ...state.items,
                  {
                    id: nextId++,
                    kind: "context",
                    action: "usage",
                    automatic: false,
                    duringTurn: false,
                    tokensBefore: event.estimatedTokens,
                    tokensAfter: event.estimatedTokens,
                    contextWindow: event.contextWindow,
                    createdAt: Date.now(),
                  },
                ],
              }));
              break;
            case "error":
              set({ streamActivity: null, streamRetry: null });
              appendContextError({ ...event, retryable: false });
              break;
            case "done":
            case "delta":
            case "reasoning":
            case "usage":
            case "toolCallStart":
            case "toolProgress":
            case "toolResult":
            case "permissionRequest":
              break;
          }
        },
      });
    } catch (error) {
      appendContextError({
        message: "上下文操作失败",
        detail: errorMessage(error),
        retryable: false,
        retries: 0,
      });
    } finally {
      if (get().requestId !== requestId) return;
      set({
        streaming: false,
        streamStartedAt: null,
        streamRetry: null,
        streamActivity: null,
        requestId: null,
      });
      const activeId = get().activeId;
      if (changed && activeId != null && activeId === conversationId) {
        const title =
          get().conversations.find((conversation) => conversation.id === activeId)?.title ??
          DEFAULT_CONVERSATION_TITLE;
        persist(activeId, title, persistConversationItems(get().items));
      }
    }
  };

  return {
    conversations: [],
    activeId: null,
    draftVersion: 0,
    activeAgentId: "",
    projectId: "",
    taskMode: "code",
    items: [],
    streaming: false,
    streamStartedAt: null,
    streamModel: "",
    streamRetry: null,
    streamActivity: null,
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
        streamActivity: null,
      }));
    },

    async openConversation(id) {
      if (get().activeId === id) return;
      interruptStream();
      try {
        const conv = await loadConversation(id);
        set({
          activeId: id,
          items: restoreConversationItems(conv.messages),
          activeAgentId: conv.agentId ?? "",
          projectId: conv.projectId ?? "",
          taskMode: conv.taskMode ?? "code",
          streamStartedAt: null,
          streamRetry: null,
          streamActivity: null,
        });
        void installCodexTimelineListeners();
        void codexResumeWorkspaceThread(id)
          .then((resumed) => {
            for (const turn of resumed.thread.turns) {
              useCodexTimelineStore
                .getState()
                .hydrate(id, turn.id, turn.items);
            }
          })
          .catch((error: unknown) => {
            console.error("恢复 Codex Thread 失败：", errorMessage(error));
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

    setTaskMode(taskMode) {
      if (get().streaming || get().taskMode === taskMode) return;
      set({ taskMode });
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

    async send(providerId, model, text, attachments = []) {
      if (get().streaming) return;
      const action = attachments.length === 0 ? contextCommand(text) : null;
      if (action) {
        await runContextCommand(providerId, model, action);
        return;
      }
      const requestId = nextRequestId();
      const taskMode = get().taskMode;
      const suggestionProjectId = get().projectId;

      // Resolve the target conversation, creating one on first message.
      let convId = get().activeId;
      let title: string;
      if (convId == null) {
        try {
          const started = await codexStartWorkspaceThread(
            providerId,
            model,
            get().projectId,
            taskMode,
            get().activeAgentId || undefined,
          );
          convId = started.thread.id;
        } catch (error) {
          set((state) => ({
            items: [
              ...state.items,
              {
                id: nextId++,
                kind: "error",
                summary: "无法创建 Codex Thread",
                detail: errorMessage(error),
                retryable: true,
                retries: 0,
                createdAt: Date.now(),
              },
            ],
          }));
          return;
        }
        title = DEFAULT_CONVERSATION_TITLE;
        set({ activeId: convId });
        void installCodexTimelineListeners();
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
        attachments,
        createdAt: now,
      };
      set({
        items: [...get().items, userItem],
        streaming: true,
        streamStartedAt: now,
        streamModel: model,
        streamRetry: null,
        streamActivity: null,
        requestId,
      });

      // Persist the user turn right away so it survives crashes mid-stream.
      await persist(convId, title, persistConversationItems(get().items));

      // The item currently receiving text deltas. A tool call closes it so
      // the next delta opens a fresh message (text/tool interleaving).
      let textItemId: number | null = null;
      let reply = "";
      let reasoningText = "";
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
      let cachedTokens = 0;
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

      const ensureTextItem = (
        event?: {
          threadId: string;
          turnId: string;
          itemId: string;
        },
        reasoning = false,
      ): number => {
        if (textItemId == null) {
          reply = "";
          reasoningText = "";
          const item: ChatItem = {
            id: nextId++,
            kind: "message",
            role: "assistant",
            content: "",
            createdAt: Date.now(),
            model: effectiveModel,
            providerId,
            threadId: event?.threadId,
            turnId: event?.turnId,
            itemId: reasoning ? undefined : event?.itemId,
            reasoningItemId: reasoning ? event?.itemId : undefined,
          };
          textItemId = item.id;
          lastTextItemId = item.id;
          appendItem(item);
        } else if (event) {
          patchItem(textItemId, (item) =>
            item.kind === "message"
              ? {
                  ...item,
                  threadId: event.threadId,
                  turnId: event.turnId,
                  ...(reasoning
                    ? { reasoningItemId: event.itemId }
                    : { itemId: event.itemId }),
                }
              : item,
          );
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
          const reasoning = reasoningText;
          patchItem(textItemId, (it) =>
            it.kind === "message" ? { ...it, content, reasoning } : it,
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

      const fail = (
        failure: {
          message: string;
          detail: string;
          code?: string;
          status?: number;
          retryable: boolean;
          retries: number;
        },
        identity?: {
          threadId: string;
          turnId: string;
          itemId: string;
        },
      ) => {
        failed = true;
        if (notifyStandaloneGatewayFailure(failure)) return;
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
          ...identity,
        });
      };

      try {
        await chatStream({
          requestId,
          providerId,
          model,
          messages: [
            ...history,
            { role: "user", content: toModelContent(text, attachments) },
          ],
          conversationId: convId,
          agentId: get().activeAgentId || undefined,
          projectId: get().projectId || undefined,
          taskMode,
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
              case "reasoning": {
                if (get().streamRetry != null) set({ streamRetry: null });
                if (get().streamActivity != null) set({ streamActivity: null });
                firstTokenAt ??= Date.now();
                ensureTextItem(event, true);
                reasoningText += event.content;
                scheduleFlush();
                break;
              }
              case "delta": {
                if (get().streamRetry != null) set({ streamRetry: null });
                if (get().streamActivity != null) set({ streamActivity: null });
                sawText = true;
                if (titleAssistantText.length < 4_000) {
                  titleAssistantText += event.content;
                }
                firstTokenAt ??= Date.now();
                ensureTextItem(event);
                reply += event.content;
                scheduleFlush();
                break;
              }
              case "usage": {
                hasReportedUsage = true;
                promptTokens += event.promptTokens;
                completionTokens += event.completionTokens;
                totalTokens += event.totalTokens;
                cachedTokens += event.cachedTokens ?? 0;
                break;
              }
              case "toolCallStart": {
                set({ streamRetry: null, streamActivity: null });
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
                  timeoutMs: event.timeoutMs,
                  createdAt: Date.now(),
                  threadId: event.threadId,
                  turnId: event.turnId,
                  itemId: event.itemId,
                });
                if (get().requestId === requestId) {
                  persist(convId, title, persistConversationItems(get().items));
                }
                break;
              }
              case "toolProgress": {
                set((state) => ({
                  items: state.items.map((it) =>
                    it.kind === "toolCall" &&
                    it.callId === event.id &&
                    it.status === "running"
                      ? {
                          ...it,
                          output: event.output,
                          durationMs: event.elapsedMs,
                          truncated: event.truncated,
                        }
                      : it,
                  ),
                }));
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
                          status: event.cancelled
                            ? "cancelled"
                            : event.isError
                              ? "error"
                              : "success",
                          output: event.output,
                          durationMs: event.durationMs,
                          exitCode: event.exitCode,
                          timedOut: event.timedOut,
                          truncated: event.truncated,
                        }
                      : it,
                  ),
                }));
                if (get().requestId === requestId) {
                  persist(convId, title, persistConversationItems(get().items));
                }
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
                  scope: event.scope,
                  createdAt: Date.now(),
                  threadId: event.threadId,
                  turnId: event.turnId,
                  itemId: event.itemId,
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
              case "contextCompactionStarted": {
                set({ streamActivity: "compacting", streamRetry: null });
                break;
              }
              case "contextCompacted": {
                set((state) => {
                  const contextItem: ChatItem = {
                    id: nextId++,
                    kind: "context",
                    action: "compaction",
                    summary: event.summary,
                    automatic: event.automatic,
                    duringTurn: event.duringTurn,
                    tokensBefore: event.estimatedTokensBefore,
                    tokensAfter: event.estimatedTokensAfter,
                    contextWindow: event.contextWindow,
                    createdAt: Date.now(),
                    threadId: event.threadId,
                    turnId: event.turnId,
                    itemId: event.itemId,
                  };
                  if (event.duringTurn) {
                    return {
                      streamActivity: null,
                      streamRetry: null,
                      items: [...state.items, contextItem],
                    };
                  }
                  const currentUserIndex = state.items.findIndex(
                    (item) => item.id === userItem.id,
                  );
                  if (currentUserIndex < 0) return { streamActivity: null };
                  return {
                    streamActivity: null,
                    streamRetry: null,
                    items: [
                      ...state.items.slice(0, currentUserIndex),
                      contextItem,
                      ...state.items.slice(currentUserIndex),
                    ],
                  };
                });
                break;
              }
              case "contextUsage": {
                break;
              }
              case "done": {
                set({ streamRetry: null, streamActivity: null });
                cancelled = event.cancelled;
                if (event.cancelled) {
                  const completedAt = Date.now();
                  set((state) => ({
                    items: state.items.map((it) =>
                      it.kind === "toolCall" && it.status === "running"
                        ? {
                            ...it,
                            status: "cancelled",
                            output: it.output
                              ? `${it.output}\n\n[任务已停止]`
                              : "[任务已停止]",
                            durationMs: completedAt - it.createdAt,
                          }
                        : it,
                    ),
                  }));
                }
                break;
              }
              case "error": {
                set({ streamRetry: null, streamActivity: null });
                cancelFlush();
                const completedAt = Date.now();
                set((state) => ({
                  items: state.items.map((it) =>
                    it.kind === "toolCall" && it.status === "running"
                      ? {
                          ...it,
                          status: "error",
                          output: it.output
                            ? `${it.output}\n\n[任务异常结束：${event.message}]`
                            : `[任务异常结束：${event.message}]`,
                          durationMs: completedAt - it.createdAt,
                        }
                      : it,
                  ),
                }));
                fail(event, {
                  threadId: event.threadId,
                  turnId: event.turnId,
                  itemId: event.itemId,
                });
                break;
              }
            }
          },
        });
      } catch (err) {
        cancelFlush();
        const detail = errorMessage(err).replaceAll("中转站", "模型服务");
        const completedAt = Date.now();
        set((state) => ({
          items: state.items.map((it) =>
            it.kind === "toolCall" && it.status === "running"
              ? {
                  ...it,
                  status: "error",
                  output: it.output
                    ? `${it.output}\n\n[连接异常结束]`
                    : "[连接异常结束]",
                  durationMs: completedAt - it.createdAt,
                }
              : it,
          ),
        }));
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
                        cachedTokens,
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
            streamActivity: null,
            requestId: null,
          });
          const saved = persist(
            convId,
            title,
            persistConversationItems(get().items),
          );
          if (title === DEFAULT_CONVERSATION_TITLE) {
            generateTitle(
              convId,
              providerId,
              effectiveModel,
              text || attachments.map((attachment) => attachment.name).join("、") || "附件",
              titleAssistantText,
              saved,
            );
          }
          if (!failed && !cancelled) {
            void saved.then(() => {
              window.setTimeout(() => {
                if (get().streaming) return;
                void refreshProjectRecommendations(
                  suggestionProjectId,
                  taskMode,
                ).catch((error: unknown) => {
                  console.warn("后台更新任务建议失败：", errorMessage(error));
                });
              }, 30_000);
            });
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
      persist(
        convId,
        DEFAULT_CONVERSATION_TITLE,
        persistConversationItems(kept),
      );
    },

    async editAndResend(itemId, text, providerId, model) {
      const { items } = get();
      const index = items.findIndex((it) => it.id === itemId);
      if (index < 0) return;
      const edited = items[index];
      interruptStream();

      // Fork before the edited turn, then send it as the new branch's opener.
      // The branch keeps the default title until AI title generation finishes.
      const kept = items.slice(0, index);
      set({ activeId: crypto.randomUUID(), items: kept });
      await get().send(
        providerId,
        model,
        text,
        edited.kind === "message" ? edited.attachments : undefined,
      );
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
      await get().send(providerId, model, userItem.content, userItem.attachments);
    },

    stop() {
      const id = get().requestId;
      if (id != null) void chatCancel(id);
    },
  };
});
