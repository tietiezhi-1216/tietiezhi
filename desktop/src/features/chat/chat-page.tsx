import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  FilePlus2,
  FolderPlus,
  ImageIcon,
  Mic,
  Plus,
  RefreshCw,
  Settings2,
  Square,
  Wrench,
} from "lucide-react";
import { ProductMascotMotion } from "@/components/product-mascot-motion";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorNotice } from "@/features/chat/error-notice";
import { ChannelSetupMascot } from "@/features/chat/channel-setup-mascot";
import { attachmentKind, ChatAssetCard } from "@/features/chat/chat-asset-card";
import {
  CHAT_COMPOSER_TEXTAREA_CLASS,
  ChatComposerSurface,
} from "@/features/chat/chat-composer-surface";
import { ContextCommandMenu } from "@/features/chat/context-command-menu";
import { ContextNotice } from "@/features/chat/context-notice";
import { MessageItem } from "@/features/chat/message-item";
import { ModelSelect } from "@/features/chat/model-select";
import { PermissionPrompt } from "@/features/chat/permission-prompt";
import { ProjectSelect } from "@/features/chat/project-select";
import { StarterSuggestions } from "@/features/chat/starter-suggestions";
import { ToolCallCard } from "@/features/chat/tool-call-card";
import {
  dictationToggle,
  errorMessage,
  fetchProviderModels,
  inspectChatAssetPaths,
  listAgents,
  loadSettings,
  markProjectSuggestionUsed,
  pickChatFiles,
  pickChatFolder,
  projectRecommendations,
  saveSettings,
} from "@/lib/api";
import type { ChatAttachment, Provider } from "@/lib/api";
import {
  effectiveModelKind,
  modelHasCapability,
  modelInputModalities,
} from "@/lib/model-capabilities";
import { getTaskMode } from "@/lib/task-mode";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat";
import { useProjectStore } from "@/stores/projects";
import { useUiStore } from "@/stores/ui";

// The octopus doesn't travel between spots — the hero (empty state) and dock
// (composer) mascots simply cross-fade as the conversation starts or clears.
type MascotPhase = "hero" | "docked";

export function ChatPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const agentsQuery = useQuery({ queryKey: ["agents"], queryFn: listAgents });
  const openSettings = useUiStore((s) => s.openSettings);
  const activeId = useChatStore((s) => s.activeId);
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const projectId = useChatStore((s) => s.projectId);
  const taskMode = useChatStore((s) => s.taskMode);
  const draftVersion = useChatStore((s) => s.draftVersion);
  const items = useChatStore((s) => s.items);
  const streaming = useChatStore((s) => s.streaming);
  const streamStartedAt = useChatStore((s) => s.streamStartedAt);
  const streamModel = useChatStore((s) => s.streamModel);
  const streamRetry = useChatStore((s) => s.streamRetry);
  const streamActivity = useChatStore((s) => s.streamActivity);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const branchFrom = useChatStore((s) => s.branchFrom);
  const editAndResend = useChatStore((s) => s.editAndResend);
  const retryFromError = useChatStore((s) => s.retryFromError);
  const projects = useProjectStore((s) => s.projects);
  const selectedProject = projects.find((project) => project.id === projectId);
  const suggestionsEnabled = settingsQuery.data?.smartSuggestionsEnabled === true;
  const recommendationsQuery = useQuery({
    queryKey: ["project-recommendations", projectId, taskMode, draftVersion],
    queryFn: () => projectRecommendations(projectId, taskMode),
    enabled: suggestionsEnabled && items.length === 0,
    staleTime: Infinity,
  });

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [assetBusy, setAssetBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [streamNow, setStreamNow] = useState(() => Date.now());
  const [mascotPhase, setMascotPhase] = useState<MascotPhase>(() =>
    items.length > 0 ? "docked" : "hero",
  );
  const [dockVisible, setDockVisible] = useState(true);
  const [hoveredMessageKey, setHoveredMessageKey] = useState<string | null>(null);
  const [peekExpression, setPeekExpression] = useState<"open" | "closed" | "look">(
    "open",
  );
  const [peekHovered, setPeekHovered] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollHostRef = useRef<HTMLDivElement>(null);
  const dockMascotRef = useRef<HTMLDivElement>(null);
  const previousHasConversationRef = useRef(items.length > 0);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** IME state — see `isImeEnter` for why both of these are needed. */
  const composingRef = useRef(false);
  const compositionEndAt = useRef(0);
  const peekTimersRef = useRef<number[]>([]);
  const autoSelectionRef = useRef("");
  const startupRefreshRef = useRef(false);

  const settings = settingsQuery.data;
  const showMessageStats = settings?.showMessageStats ?? false;
  const builtInProvider = settings?.providers.find((provider) => provider.builtIn);
  const startupRefresh = useMutation({
    mutationFn: (provider: Provider) =>
      fetchProviderModels({
        id: provider.id,
        baseUrl: provider.baseUrl,
        kind: provider.type,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
  const chatOptions = useMemo(
    () =>
      (settings?.providers ?? []).flatMap((provider) =>
        provider.models
          .filter((candidate) => effectiveModelKind(candidate) === "chat")
          .map((candidate) => ({
            providerId: provider.id,
            model: candidate.id,
            modelInfo: candidate,
          })),
      ),
    [settings],
  );
  const settingsSelectedChat = chatOptions.find(
    (option) =>
      option.providerId === settings?.chatProviderId && option.model === settings?.chatModel,
  );
  const activeAgent = agentsQuery.data?.find((agent) => agent.id === activeAgentId);
  const taskModeDefinition = getTaskMode(taskMode);
  const starterSuggestions = recommendationsQuery.data?.suggestions ?? [];
  const lockedAgentSelection = activeAgent?.model
    ? {
        providerId: activeAgent.modelProviderId || settings?.chatProviderId || "",
        model: activeAgent.model,
      }
    : undefined;
  const agentSelectedChat = lockedAgentSelection
    ? chatOptions.find(
        (option) =>
          option.providerId === lockedAgentSelection.providerId &&
          option.model === lockedAgentSelection.model,
      )
    : undefined;
  const selectedChat = lockedAgentSelection ? agentSelectedChat : settingsSelectedChat;
  const providerId = selectedChat?.providerId ?? "";
  const model = selectedChat?.model ?? "";
  const supportsImageInput = selectedChat
    ? modelInputModalities(selectedChat.modelInfo).includes("image")
    : false;
  const hasPendingImages = attachments.some(
    (attachment) => attachmentKind(attachment) === "image",
  );
  const attachmentStatus =
    hasPendingImages && !supportsImageInput
      ? "当前模型不支持图片输入，请更换模型或移除图片"
      : attachmentError;
  const ready = selectedChat != null;
  const startupRefreshFailedWithoutCache =
    chatOptions.length === 0 && startupRefresh.isError;
  const setupError = settingsQuery.error ?? startupRefresh.error;
  const readiness =
    settingsQuery.isError || startupRefreshFailedWithoutCache
      ? "error"
      : settings == null
        ? "loading"
        : settings.providers.length === 0
          ? "no-provider"
          : chatOptions.length === 0 &&
              builtInProvider &&
              (startupRefresh.isIdle || startupRefresh.isPending)
            ? "loading"
          : chatOptions.length === 0
            ? "no-chat-model"
            : ready
              ? "ready"
              : "choose-model";
  const setupTitle =
    readiness === "error"
      ? "渠道检查失败"
      : readiness === "loading"
        ? "正在检查渠道…"
        : readiness === "no-provider"
          ? "还没有可用渠道"
          : readiness === "no-chat-model"
            ? "渠道已添加，还缺聊天模型"
            : "模型已到位，就等你选择";
  const setupDescription =
    readiness === "error"
      ? errorMessage(setupError)
      : readiness === "loading"
        ? "铁铁汁正在确认连接状态"
        : readiness === "no-provider"
          ? "添加一个供应商，让铁铁汁连上模型世界"
          : readiness === "no-chat-model"
            ? "供应商已经添加，请先获取或标记聊天模型"
            : `从 ${chatOptions.length} 个聊天模型中选一个，开启新的任务`;
  const composerPlaceholder =
    readiness === "error"
      ? "渠道状态异常，请重新检查"
      : readiness === "loading"
        ? "正在检查渠道…"
        : readiness === "no-provider"
          ? "添加供应商后即可输入消息"
          : readiness === "no-chat-model"
            ? "获取聊天模型后即可输入消息"
            : readiness === "choose-model"
              ? "选择聊天模型后即可输入消息"
              : taskMode === "work"
                ? "描述需要研究、整理或交付的工作…"
                : "描述需要分析、修改或验证的代码任务…";
  const lastItem = items[items.length - 1];
  const waitingForPermission =
    lastItem?.kind === "permission" && lastItem.decision == null;
  const hasConversation = items.length > 0;
  const suggestionsLoading =
    suggestionsEnabled && !hasConversation && recommendationsQuery.isPending;

  useEffect(() => {
    if (!builtInProvider || startupRefreshRef.current) return;
    startupRefreshRef.current = true;
    startupRefresh.mutate(builtInProvider);
  }, [builtInProvider, startupRefresh]);

  useEffect(() => {
    if (!settings || selectedChat || chatOptions.length !== 1) return;
    const onlyOption = chatOptions[0];
    const selectionKey = `${onlyOption.providerId}:${onlyOption.model}`;
    if (autoSelectionRef.current === selectionKey) return;
    autoSelectionRef.current = selectionKey;

    void saveSettings({
      ...settings,
      chatProviderId: onlyOption.providerId,
      chatModel: onlyOption.model,
    })
      .then(() => queryClient.invalidateQueries({ queryKey: ["settings"] }))
      .catch((error: unknown) => {
        autoSelectionRef.current = "";
        console.error(error);
      });
  }, [chatOptions, queryClient, selectedChat, settings]);

  useEffect(() => {
    if (!streaming) return;
    setStreamNow(Date.now());
    const timer = window.setInterval(() => setStreamNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [streaming]);

  const elapsedSeconds =
    streamStartedAt == null ? 0 : Math.max(0, Math.floor((streamNow - streamStartedAt) / 1_000));
  const runningToolItem =
    lastItem?.kind === "toolCall" && lastItem.status === "running" ? lastItem : null;
  const runningTool = runningToolItem?.name ?? null;
  const statusElapsedSeconds =
    runningToolItem == null
      ? elapsedSeconds
      : Math.max(0, Math.floor((streamNow - runningToolItem.createdAt) / 1_000));
  const streamStatus = streamRetry
    ? `正在进行第 ${streamRetry.attempt}/${streamRetry.maxRetries} 次重试 · ${streamRetry.reason}`
    : streamActivity === "compacting"
      ? "正在压缩上下文"
      : streamActivity === "inspecting"
        ? "正在计算上下文"
        : waitingForPermission
          ? "等待授权"
          : runningTool
            ? `正在运行 ${runningTool}`
            : "正在生成";
  const peekVisible = hasConversation && mascotPhase === "docked" && !dockVisible;
  const peekImage =
    peekExpression === "closed"
      ? "/octopus-loader/base-closed.png"
      : peekExpression === "look"
        ? "/octopus-loader/base-look-right.png"
        : "/octopus-loader/base-open.png";

  const clearPeekTimers = useCallback(() => {
    peekTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    peekTimersRef.current = [];
  }, []);

  const startPeekReaction = useCallback(() => {
    clearPeekTimers();
    setPeekHovered(true);
    setPeekExpression("closed");
    peekTimersRef.current = [
      window.setTimeout(() => setPeekExpression("look"), 150),
      window.setTimeout(() => setPeekExpression("closed"), 720),
      window.setTimeout(() => setPeekExpression("look"), 830),
    ];
  }, [clearPeekTimers]);

  const stopPeekReaction = useCallback(() => {
    clearPeekTimers();
    setPeekHovered(false);
    setPeekExpression("open");
  }, [clearPeekTimers]);

  // Every bottom-scroll goes to the true bottom (incl. trailing padding), the
  // same target the streaming pin uses — a mixed target would shift the docked
  // mascot by the padding height when a reply settles.
  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const viewport = scrollHostRef.current?.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']",
    );
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior });
  }, []);

  // Flip the mascot between hero and dock on the first/last message. The two
  // static mascots cross-fade in place (see their opacity transitions); there is
  // no travelling clone anymore.
  useLayoutEffect(() => {
    const previous = previousHasConversationRef.current;
    if (previous === hasConversation) return;
    previousHasConversationRef.current = hasConversation;
    setMascotPhase(hasConversation ? "docked" : "hero");
    if (hasConversation) {
      stickToBottomRef.current = true;
      scrollToBottom("instant");
    }
  }, [hasConversation, scrollToBottom]);
  useEffect(() => {
    const clearHoveredMessage = () => setHoveredMessageKey(null);
    window.addEventListener("blur", clearHoveredMessage);
    return () => window.removeEventListener("blur", clearHoveredMessage);
  }, []);
  useEffect(() => clearPeekTimers, [clearPeekTimers]);
  useEffect(() => {
    if (peekVisible) return;
    clearPeekTimers();
    setPeekHovered(false);
    setPeekExpression("open");
  }, [clearPeekTimers, peekVisible]);
  useEffect(() => {
    if (!peekVisible || peekHovered) return;

    let reopenTimer = 0;
    const blink = () => {
      setPeekExpression("closed");
      reopenTimer = window.setTimeout(() => setPeekExpression("open"), 145);
    };
    const firstBlink = window.setTimeout(blink, 2_600);
    const blinkInterval = window.setInterval(blink, 4_800);

    return () => {
      window.clearTimeout(firstBlink);
      window.clearTimeout(reopenTimer);
      window.clearInterval(blinkInterval);
    };
  }, [peekHovered, peekVisible]);

  useEffect(() => {
    const viewport = scrollHostRef.current?.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']",
    );
    const dock = dockMascotRef.current;
    if (!viewport || !dock || !hasConversation) {
      setDockVisible(true);
      return;
    }

    const updateScrollState = () => {
      setHoveredMessageKey(null);
      const distanceFromBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      // Hysteresis, not a single threshold: unstick only once clearly away,
      // re-stick only at the true bottom. A symmetric cutoff re-sticks on the
      // reader's first small upward move (40px < 72px) and the next flush
      // yanks them back down — an endless tug-of-war while streaming.
      if (distanceFromBottom > 72) stickToBottomRef.current = false;
      else if (distanceFromBottom < 4) stickToBottomRef.current = true;
    };

    // Scroll events land asynchronously, so during a stream the next flush can
    // pin the view back down before updateScrollState ever sees the reader's
    // upward move. Treat upward wheel intent as an immediate unstick;
    // updateScrollState re-sticks once the reader returns to the bottom.
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stickToBottomRef.current = false;
    };

    updateScrollState();
    viewport.addEventListener("scroll", updateScrollState, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: true });
    const observer = new IntersectionObserver(
      ([entry]) => setDockVisible(entry.isIntersecting && entry.intersectionRatio >= 0.35),
      { root: viewport, threshold: [0, 0.35, 1] },
    );
    observer.observe(dock);

    return () => {
      viewport.removeEventListener("scroll", updateScrollState);
      viewport.removeEventListener("wheel", handleWheel);
      observer.disconnect();
    };
  }, [activeId, hasConversation]);


  // Keep following the stream only while the reader remains near the bottom.
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    // Streaming pins instantly so a reader at the bottom never sees a yank;
    // a settled reply glides the last stretch smoothly.
    scrollToBottom(streamingRef.current ? "instant" : "smooth");
  }, [items, scrollToBottom]);

  // Stable handler so the memoized MessageItem list doesn't re-render per flush.
  const handleEdit = useCallback(
    (itemId: number, text: string) => {
      void editAndResend(itemId, text, providerId, model);
    },
    [editAndResend, providerId, model],
  );
  const handleMessageHoverChange = useCallback((hoverKey: string | null) => {
    setHoveredMessageKey(hoverKey);
  }, []);

  const assistantTurnTailIds = useMemo(() => {
    const tailIds = new Set<number>();
    let foundAssistantInTurn = false;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind !== "message") continue;
      if (item.role !== "assistant") {
        foundAssistantInTurn = false;
        continue;
      }
      if (!foundAssistantInTurn) tailIds.add(item.id);
      foundAssistantInTurn = true;
    }
    return tailIds;
  }, [items]);

  // Focus the composer when switching / starting conversations.
  useEffect(() => {
    stickToBottomRef.current = true;
    setInput("");
    setAttachments([]);
    setAttachmentError("");
    inputRef.current?.focus();
  }, [activeId, draftVersion]);

  const handleSend = () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming || !ready) return;
    if (hasPendingImages && !supportsImageInput) {
      setAttachmentError("当前模型不支持图片输入，请更换模型或移除图片");
      return;
    }
    stickToBottomRef.current = true;
    setInput("");
    const pendingAttachments = attachments;
    setAttachments([]);
    setAttachmentError("");
    void send(providerId, model, text, pendingAttachments);
  };
  const commandQuery =
    !streaming && attachments.length === 0 && input.trimStart().startsWith("/")
      ? input.trimStart()
      : null;

  const appendAssets = useCallback(
    (incoming: ChatAttachment[]) => {
      const rejectedImages = incoming.some(
        (asset) => attachmentKind(asset) === "image" && !supportsImageInput,
      );
      const candidates = incoming.filter(
        (asset) => attachmentKind(asset) !== "image" || supportsImageInput,
      );
      setAttachments((current) => {
        const next = [...current];
        const keys = new Set(current.map((asset) => asset.path || `${asset.name}:${asset.size}`));
        let imageCount = current.filter((asset) => attachmentKind(asset) === "image").length;
        for (const asset of candidates) {
          const key = asset.path || `${asset.name}:${asset.size}`;
          if (keys.has(key) || next.length >= 12) continue;
          if (attachmentKind(asset) === "image") {
            if (imageCount >= 4) continue;
            imageCount += 1;
          }
          keys.add(key);
          next.push(asset);
        }
        return next;
      });
      if (rejectedImages) {
        setAttachmentError("当前模型不支持图片输入，其他文件仍可作为上下文添加");
      } else if (candidates.some((asset) => asset.truncated)) {
        setAttachmentError("部分大文件或文件夹清单已截断后加入上下文");
      } else {
        setAttachmentError("");
      }
    },
    [supportsImageInput],
  );

  const addClipboardImages = async (files: File[]) => {
    const selected = files.filter((file) => file.type.startsWith("image/")).slice(0, 4);
    if (selected.length === 0) return;
    if (!supportsImageInput) {
      setAttachmentError("当前模型不支持图片输入");
      return;
    }
    if (selected.some((file) => file.size > 20 * 1024 * 1024)) {
      setAttachmentError("单张图片不能超过 20 MB");
      return;
    }
    const read = (file: File) =>
      new Promise<ChatAttachment>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
        reader.onload = () =>
          resolve({
            id: crypto.randomUUID(),
            kind: "image",
            name: file.name,
            mimeType: file.type,
            size: file.size,
            dataUrl: String(reader.result),
          });
        reader.readAsDataURL(file);
      });
    try {
      const loaded = await Promise.all(selected.map(read));
      appendAssets(loaded);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "读取图片失败");
    }
  };

  const pickAssets = useCallback(
    async (kind: "image" | "file" | "folder") => {
      setAssetBusy(true);
      try {
        const assets =
          kind === "folder" ? await pickChatFolder() : await pickChatFiles(kind === "image");
        appendAssets(assets);
      } catch (error) {
        setAttachmentError(errorMessage(error));
      } finally {
        setAssetBusy(false);
      }
    },
    [appendAssets],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragActive(true);
            return;
          }
          setDragActive(false);
          if (event.payload.type === "drop") {
            void inspectChatAssetPaths(event.payload.paths)
              .then(appendAssets)
              .catch((error) => setAttachmentError(errorMessage(error)));
          }
        }),
      )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Browser mock mode has no native drag-and-drop event bridge.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appendAssets]);

  /**
   * Whether an Enter keydown is the IME committing a candidate rather than a
   * send. Two signals are needed:
   *  • `isComposing` — catches the Chromium case, where the committing Enter
   *    still reports itself as part of the composition;
   *  • the time since `compositionend` — WebKit (so every macOS WKWebView, i.e.
   *    the app itself) fires `compositionend` FIRST and then delivers Enter with
   *    `isComposing: false`, which no flag alone can tell apart from a real one.
   */
  const isImeEnter = (e: React.KeyboardEvent) =>
    composingRef.current ||
    e.nativeEvent.isComposing ||
    Date.now() - compositionEndAt.current < 100;

  return (
    <div ref={pageRef} className="relative flex h-full flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1">
        <div
          aria-hidden={hasConversation}
          className={cn(
            // Fade only — no vertical slide. The slide moved the hero mascot
            // mid-flight, so the flying ghost snapshotted an unsettled target
            // and the octopus jumped a few px when it took back over.
            "absolute inset-0 flex flex-col items-center justify-center px-4 text-center transition-opacity duration-300 ease-out motion-reduce:transition-none",
            hasConversation ? "pointer-events-none opacity-0" : "opacity-100",
          )}
        >
          {ready ? (
            <div className="flex w-full max-w-3xl flex-col items-center gap-1">
              {/* Cross-fades with the dock mascot. The opacity lives on this
                  wrapper, not the mascot itself — the mascot's mount
                  `animate-channel-arrive` pins its own opacity to 1 and would
                  override an opacity class placed directly on it. */}
              <div
                className={cn(
                  "transition-opacity duration-300 ease-out",
                  mascotPhase === "hero" ? "opacity-100" : "opacity-0",
                )}
              >
                <ChannelSetupMascot
                  motionPaused={mascotPhase !== "hero"}
                  className="h-56 w-80"
                  mascotClassName="size-32"
                />
              </div>
              <p className="h-7 max-w-full truncate px-4 text-lg font-semibold">
                {selectedProject?.name ??
                  `在独立 ${taskMode === "work" ? "Work" : "Code"} 空间开始任务`}
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                {taskModeDefinition.emptyDescription}
              </p>
              {suggestionsEnabled &&
                (starterSuggestions.length > 0 || suggestionsLoading) && (
                  <StarterSuggestions
                    suggestions={starterSuggestions}
                    projectName={selectedProject?.name}
                    technologies={recommendationsQuery.data?.technologies}
                    loading={suggestionsLoading}
                    onSelect={(suggestion) => {
                      setInput(suggestion.prompt);
                      void markProjectSuggestionUsed(
                        projectId,
                        taskMode,
                        suggestion.id,
                      ).catch((error: unknown) => {
                        console.warn("记录任务建议使用失败：", errorMessage(error));
                      });
                      window.requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                  />
                )}
            </div>
          ) : (
            <div className="flex select-none flex-col items-center">
              <ChannelSetupMascot />
              {readiness === "choose-model" && settings ? (
                <div className="mt-1 flex justify-center">
                  <ModelSelect
                    prominent
                    promptText={
                      lockedAgentSelection
                        ? "当前智能体模型不可用"
                        : "选择和铁铁汁一起探索世界的方式"
                    }
                    settings={settings}
                    lockedSelection={lockedAgentSelection}
                  />
                </div>
              ) : (
                <>
                  <div className="mt-1 flex flex-col gap-1.5">
                    <p className="text-xl font-semibold tracking-tight">{setupTitle}</p>
                    <p className="text-muted-foreground text-sm">{setupDescription}</p>
                  </div>
                  {readiness === "error" ? (
                    <div className="mt-4 flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (builtInProvider) {
                            startupRefresh.mutate(builtInProvider);
                          } else {
                            void settingsQuery.refetch();
                          }
                        }}
                      >
                        <RefreshCw /> 重新检查
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openSettings("providers")}
                      >
                        <Settings2 /> 打开渠道设置
                      </Button>
                    </div>
                  ) : readiness === "loading" ? (
                    <Button
                      className="mt-4"
                      variant="ghost"
                      size="sm"
                      onClick={() => openSettings("providers")}
                    >
                      <Settings2 /> 打开渠道设置
                    </Button>
                  ) : (
                    <Button
                      className="mt-4"
                      variant="outline"
                      size="sm"
                      onClick={() => openSettings("providers")}
                    >
                      <Settings2 /> {readiness === "no-provider" ? "添加供应商" : "配置渠道"}
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div
          ref={scrollHostRef}
          onPointerLeave={() => setHoveredMessageKey(null)}
          aria-hidden={!hasConversation}
          className={cn(
            "absolute inset-0 transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
            hasConversation
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-1 opacity-0",
          )}
        >
          <ScrollArea className="h-full [&_[data-slot=scroll-area-viewport]>div]:h-full">
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 px-4 pt-6 pb-4">
              {items.map((item, index) => {
                const hoverKey = `${item.id}:${index}:${item.createdAt}`;
                return item.kind === "context" ? (
                  <ContextNotice key={item.id} item={item} />
                ) : item.kind === "toolCall" ? (
                  <ToolCallCard key={item.id} item={item} now={streamNow} />
                ) : item.kind === "permission" ? (
                  <PermissionPrompt key={item.id} item={item} />
                ) : item.kind === "error" ? (
                  <ErrorNotice
                    key={item.id}
                    item={item}
                    retryDisabled={streaming || !ready}
                    onRetry={() => {
                      void retryFromError(item.id, providerId, model);
                    }}
                  />
                ) : (
                  <MessageItem
                    key={item.id}
                    item={item}
                    hoverKey={hoverKey}
                    hovered={hoveredMessageKey === hoverKey}
                    showActions={
                      item.role !== "assistant" || assistantTurnTailIds.has(item.id)
                    }
                    showStats={showMessageStats}
                    showReasoning={settings?.showReasoning ?? false}
                    streaming={streaming && index === items.length - 1}
                    providerName={
                      settings?.providers.find((p) => p.id === item.providerId)?.name
                    }
                    onBranch={branchFrom}
                    onEdit={handleEdit}
                    onHoverChange={handleMessageHoverChange}
                  />
                );
              })}
              <div
                role="status"
                aria-live="polite"
                aria-label={
                  streaming
                    ? `${streamStatus}，已用时 ${statusElapsedSeconds} 秒`
                    : "铁铁汁就绪"
                }
                className="mt-auto flex h-12 items-center gap-2"
              >
                {/* Keep the dock mascot clipped to the fixed status row so its
                    continuous canvas deformation never changes scroll bounds. */}
                <div ref={dockMascotRef} className="relative size-12 shrink-0 overflow-hidden">
                  <ProductMascotMotion
                    src="/mode-mascots/paper-plane/code.png"
                    blinkSrc="/mode-mascots/paper-plane/code-blink.png"
                    variant="workspace"
                    className={cn(
                      "size-12 transition-opacity duration-300 ease-out",
                      mascotPhase === "docked" ? "opacity-100" : "opacity-0",
                    )}
                    paused={
                      !hasConversation || mascotPhase !== "docked" || !dockVisible
                    }
                  />
                </div>
                <span
                  aria-hidden
                  className={cn(
                    "text-muted-foreground flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs tabular-nums transition-[opacity,transform] duration-300",
                    streaming && mascotPhase === "docked"
                      ? "text-shimmer translate-x-0 opacity-100"
                      : "-translate-x-1 opacity-0",
                  )}
                >
                  <span className="truncate">{streamStatus}</span>
                  <span>·</span>
                  <span>{statusElapsedSeconds}s</span>
                  {streamModel && (
                    <>
                      <span>·</span>
                      <span>{streamModel}</span>
                    </>
                  )}
                </span>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* A fresh task without a model is configured from the focused empty
          state above. Existing conversations keep the composer visible so a
          removed model can be replaced without losing context. */}
      {(ready || hasConversation) && (
      <div className="relative mx-auto w-full max-w-3xl px-4 pt-2 pb-4">
        {/* Soften the transcript → composer boundary. Capped at 60% so the
            resting mascot right above the composer reads as standing on a soft
            shadow instead of sinking into solid black. */}
        <div
          aria-hidden
          className="to-background/60 pointer-events-none absolute inset-x-0 -top-10 h-10 bg-linear-to-b from-transparent"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            stickToBottomRef.current = true;
            scrollToBottom("smooth");
          }}
          onMouseEnter={startPeekReaction}
          onMouseLeave={stopPeekReaction}
          onFocus={startPeekReaction}
          onBlur={stopPeekReaction}
          aria-label="返回最新消息"
          aria-hidden={!peekVisible}
          title="返回最新消息"
          tabIndex={peekVisible ? 0 : -1}
          className={cn(
            "group absolute top-0 right-5 z-0 h-16 w-16 origin-bottom overflow-visible rounded-full bg-transparent p-0 shadow-none transition-[opacity,transform] duration-500 ease-out hover:-translate-y-10 hover:-rotate-6 hover:bg-transparent focus-visible:-translate-y-10 focus-visible:-rotate-6 focus-visible:ring-0 active:scale-95 motion-reduce:transition-none",
            peekVisible
              ? "-translate-y-8 opacity-100"
              : "pointer-events-none translate-y-2 scale-90 opacity-0",
          )}
        >
          <span aria-hidden className="relative block size-16">
            <img
              src={peekImage}
              alt=""
              draggable={false}
              className="absolute inset-0 size-16 max-w-none object-contain drop-shadow-sm transition-transform duration-500 ease-out group-hover:scale-105 group-focus-visible:scale-105"
            />
            <img
              src="/octopus-loader/decor-05.png"
              alt=""
              draggable={false}
              className="absolute top-1 right-0 size-4 translate-x-1 translate-y-2 rotate-12 opacity-0 transition-[opacity,transform] delay-100 duration-300 group-hover:translate-x-2 group-hover:-translate-y-1 group-hover:rotate-45 group-hover:opacity-100 group-focus-visible:translate-x-2 group-focus-visible:-translate-y-1 group-focus-visible:rotate-45 group-focus-visible:opacity-100"
            />
          </span>
        </Button>

        {activeId == null && items.length === 0 && (
          <div className="bg-muted/70 relative z-10 mx-3 -mb-2 flex h-10 items-start rounded-t-xl border px-1.5 pt-1 shadow-sm">
            <ProjectSelect />
          </div>
        )}

        <ChatComposerSurface dragActive={dragActive}>
          {commandQuery != null && (
            <ContextCommandMenu
              query={commandQuery}
              onSelect={(command) => {
                stickToBottomRef.current = true;
                setInput("");
                void send(providerId, model, command);
              }}
            />
          )}
          {dragActive && (
            <div className="bg-background/90 text-foreground pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl text-sm font-medium backdrop-blur-sm">
              松开即可添加到本轮上下文
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex gap-2 overflow-x-auto px-2 pt-1 pb-1.5">
              {attachments.map((attachment) => (
                <ChatAssetCard
                  key={attachment.id}
                  asset={attachment}
                  onRemove={() =>
                    setAttachments((current) =>
                      current.filter((candidate) => candidate.id !== attachment.id),
                    )
                  }
                />
              ))}
            </div>
          )}
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (!files.some((file) => file.type.startsWith("image/"))) return;
              event.preventDefault();
              void addClipboardImages(files);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              compositionEndAt.current = Date.now();
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey) return;
              if (isImeEnter(e)) return; // picking an IME candidate, not sending
              e.preventDefault();
              handleSend();
            }}
            placeholder={composerPlaceholder}
            disabled={!ready}
            className={CHAT_COMPOSER_TEXTAREA_CLASS}
            rows={1}
          />

          <div className="flex items-center gap-1 pt-0.5 pl-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground size-7 shrink-0 rounded-full"
                  disabled={!ready || assetBusy || attachments.length >= 12}
                  aria-label="添加上下文"
                  title="添加图片、文件或文件夹"
                >
                  <Plus className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-56">
                <DropdownMenuLabel>添加到本轮上下文</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!supportsImageInput}
                  onSelect={() => void pickAssets("image")}
                >
                  <ImageIcon className="size-4" />
                  <span className="flex-1">图片</span>
                  <span className="text-muted-foreground text-[10px]">最多 4 张</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void pickAssets("file")}>
                  <FilePlus2 className="size-4" />
                  <span className="flex-1">文件</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void pickAssets("folder")}>
                  <FolderPlus className="size-4" />
                  <span className="flex-1">文件夹</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-muted-foreground font-normal">
                  也可以拖入文件，或直接粘贴截图
                </DropdownMenuLabel>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="text-muted-foreground flex-1 truncate text-[11px]">
              {attachmentStatus ||
                (commandQuery != null
                  ? "/compact 压缩 · /context 查看占用"
                  : ready
                    ? "Enter 发送 · Shift+Enter 换行"
                    : setupDescription)}
            </span>
            {settings && (
              <ModelSelect
                settings={settings}
                lockedSelection={lockedAgentSelection}
                effortOverride={activeAgent?.reasoningEffort || undefined}
              />
            )}
            {selectedChat && !modelHasCapability(selectedChat.modelInfo, "tool-call") && (
              <span
                title="当前模型未声明工具调用能力，内置工具和 MCP 将不会发送"
                className="text-muted-foreground flex h-7 shrink-0 items-center gap-1 px-1 text-[11px]"
              >
                <Wrench className="size-3.5" />
                纯对话
              </span>
            )}
            {ready && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground size-7 shrink-0 rounded-full"
                  onClick={() => void dictationToggle()}
                  aria-label="语音听写"
                  title="语音听写"
                >
                  <Mic className="size-4" />
                </Button>
                {streaming ? (
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 shrink-0 rounded-full"
                    onClick={stop}
                    aria-label="停止生成"
                  >
                    <Square />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    className="size-8 shrink-0 rounded-full"
                    onClick={handleSend}
                    disabled={
                      (!input.trim() && attachments.length === 0) ||
                      (hasPendingImages && !supportsImageInput)
                    }
                    aria-label="发送"
                  >
                    <ArrowUp />
                  </Button>
                )}
              </>
            )}
          </div>
        </ChatComposerSurface>
      </div>
      )}
    </div>
  );
}
