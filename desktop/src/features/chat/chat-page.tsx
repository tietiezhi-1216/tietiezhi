import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Mic, RefreshCw, Settings2, Square } from "lucide-react";
import { AppIconLoader } from "@/components/app-icon-loader";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice } from "@/features/chat/error-notice";
import { ChannelSetupMascot } from "@/features/chat/channel-setup-mascot";
import { MessageItem } from "@/features/chat/message-item";
import { ModelSelect } from "@/features/chat/model-select";
import { PermissionPrompt } from "@/features/chat/permission-prompt";
import { ProjectSelect } from "@/features/chat/project-select";
import { ToolCallCard } from "@/features/chat/tool-call-card";
import { dictationToggle, errorMessage, loadSettings, saveSettings } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat";
import { useUiStore } from "@/stores/ui";

type MascotPhase = "hero" | "docking" | "docked" | "undocking";

const MASCOT_SIZE = 128;
const MASCOT_MOVE_MS = 720;
const MASCOT_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

export function ChatPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const openSettings = useUiStore((s) => s.openSettings);
  const activeId = useChatStore((s) => s.activeId);
  const draftVersion = useChatStore((s) => s.draftVersion);
  const items = useChatStore((s) => s.items);
  const streaming = useChatStore((s) => s.streaming);
  const streamStartedAt = useChatStore((s) => s.streamStartedAt);
  const streamModel = useChatStore((s) => s.streamModel);
  const streamRetry = useChatStore((s) => s.streamRetry);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const branchFrom = useChatStore((s) => s.branchFrom);
  const editAndResend = useChatStore((s) => s.editAndResend);
  const retryFromError = useChatStore((s) => s.retryFromError);

  const [input, setInput] = useState("");
  const [streamNow, setStreamNow] = useState(() => Date.now());
  const [mascotPhase, setMascotPhase] = useState<MascotPhase>(() =>
    items.length > 0 ? "docked" : "hero",
  );
  const [ghostVisible, setGhostVisible] = useState(false);
  const [dockVisible, setDockVisible] = useState(true);
  const [hoveredMessageKey, setHoveredMessageKey] = useState<string | null>(null);
  const [peekExpression, setPeekExpression] = useState<"open" | "closed" | "look">(
    "open",
  );
  const [peekHovered, setPeekHovered] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollHostRef = useRef<HTMLDivElement>(null);
  const heroMascotRef = useRef<HTMLSpanElement>(null);
  const dockMascotRef = useRef<HTMLDivElement>(null);
  const ghostMascotRef = useRef<HTMLDivElement>(null);
  const lastDockRectRef = useRef<DOMRect | null>(null);
  const previousHasConversationRef = useRef(items.length > 0);
  const transitionIdRef = useRef(0);
  const ghostAnimationRef = useRef<Animation | null>(null);
  const stickToBottomRef = useRef(true);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** IME state — see `isImeEnter` for why both of these are needed. */
  const composingRef = useRef(false);
  const compositionEndAt = useRef(0);
  const peekTimersRef = useRef<number[]>([]);
  const autoSelectionRef = useRef("");

  const settings = settingsQuery.data;
  const chatOptions = useMemo(
    () =>
      (settings?.providers ?? []).flatMap((provider) =>
        provider.models
          .filter((candidate) => candidate.kind === "chat")
          .map((candidate) => ({
            providerId: provider.id,
            model: candidate.id,
          })),
      ),
    [settings],
  );
  const selectedChat = chatOptions.find(
    (option) =>
      option.providerId === settings?.chatProviderId && option.model === settings?.chatModel,
  );
  const providerId = selectedChat?.providerId ?? "";
  const model = selectedChat?.model ?? "";
  const ready = selectedChat != null;
  const readiness =
    settingsQuery.isError
      ? "error"
      : settings == null
        ? "loading"
        : settings.providers.length === 0
          ? "no-provider"
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
      ? errorMessage(settingsQuery.error)
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
              : "输入消息…";
  const lastItem = items[items.length - 1];
  const waitingForPermission =
    lastItem?.kind === "permission" && lastItem.decision == null;
  const indicatorActive = streaming && !waitingForPermission;
  const hasConversation = items.length > 0;

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
  const runningTool =
    lastItem?.kind === "toolCall" && lastItem.status === "running" ? lastItem.name : null;
  const streamStatus = streamRetry
    ? `正在进行第 ${streamRetry.attempt}/${streamRetry.maxRetries} 次重试 · ${streamRetry.reason}`
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

  const mascotTransform = useCallback(
    (rect: DOMRect) =>
      `translate3d(${rect.left + MASCOT_SIZE}px, ${rect.top + MASCOT_SIZE}px, 0) scale(${rect.width / MASCOT_SIZE})`,
    [],
  );

  const primeGhost = useCallback(
    (rect: DOMRect) => {
      const ghost = ghostMascotRef.current;
      if (!ghost) return;
      ghostAnimationRef.current?.cancel();
      setGhostVisible(true);
      ghostAnimationRef.current = ghost.animate(
        [{ transform: mascotTransform(rect) }, { transform: mascotTransform(rect) }],
        { duration: 0, fill: "forwards" },
      );
    },
    [mascotTransform],
  );

  const animateGhost = useCallback(
    (
      from: DOMRect,
      to: DOMRect,
      finalPhase: Extract<MascotPhase, "hero" | "docked">,
      id: number,
    ) => {
      const ghost = ghostMascotRef.current;
      if (!ghost || transitionIdRef.current !== id) return;

      primeGhost(from);

      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setMascotPhase(finalPhase);
        setGhostVisible(false);
        return;
      }

      ghostAnimationRef.current?.cancel();
      const animation = ghost.animate(
        [
          { transform: mascotTransform(from) },
          { transform: mascotTransform(to) },
        ],
        {
          duration: MASCOT_MOVE_MS,
          easing: MASCOT_EASING,
          fill: "forwards",
        },
      );
      ghostAnimationRef.current = animation;
      animation.onfinish = () => {
        if (transitionIdRef.current !== id) return;
        setMascotPhase(finalPhase);
        window.requestAnimationFrame(() => {
          if (transitionIdRef.current !== id) return;
          setGhostVisible(false);
        });
      };
    },
    [mascotTransform, primeGhost],
  );

  useLayoutEffect(() => {
    const previous = previousHasConversationRef.current;
    if (previous === hasConversation) return;
    previousHasConversationRef.current = hasConversation;
    const id = ++transitionIdRef.current;
    let firstFrame = 0;
    let secondFrame = 0;

    if (hasConversation) {
      const from = heroMascotRef.current?.getBoundingClientRect();
      if (from) primeGhost(from);
      setMascotPhase("docking");
      stickToBottomRef.current = true;
      endRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          const to = dockMascotRef.current?.getBoundingClientRect();
          if (!from || !to) {
            setMascotPhase("docked");
            setGhostVisible(false);
            return;
          }
          lastDockRectRef.current = to;
          animateGhost(from, to, "docked", id);
        });
      });
    } else {
      const from = lastDockRectRef.current;
      const fromWasVisible = from != null && from.bottom > 48 && from.top < window.innerHeight;
      if (from && fromWasVisible) primeGhost(from);
      setMascotPhase("undocking");
      firstFrame = window.requestAnimationFrame(() => {
        const to = heroMascotRef.current?.getBoundingClientRect();
        if (!from || !to || !fromWasVisible) {
          setMascotPhase("hero");
          setGhostVisible(false);
          return;
        }
        animateGhost(from, to, "hero", id);
      });
    }

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [animateGhost, hasConversation, primeGhost]);

  // Keep the filled transform until React has committed `visibility: hidden`.
  // Cancelling it in the finish callback resets the fixed element to its base
  // position before the opacity update is painted, causing a one-frame flash.
  useLayoutEffect(() => {
    if (ghostVisible) return;
    ghostAnimationRef.current?.cancel();
    ghostAnimationRef.current = null;
  }, [ghostVisible]);

  useEffect(() => {
    const finishMovingMascot = () => {
      const animation = ghostAnimationRef.current;
      if (!animation || animation.playState === "idle") return;

      ++transitionIdRef.current;
      animation.cancel();
      ghostAnimationRef.current = null;
      setGhostVisible(false);
      setMascotPhase(previousHasConversationRef.current ? "docked" : "hero");
    };

    window.addEventListener("resize", finishMovingMascot);
    return () => window.removeEventListener("resize", finishMovingMascot);
  }, []);

  useEffect(
    () => () => {
      ghostAnimationRef.current?.cancel();
      ghostAnimationRef.current = null;
    },
    [],
  );
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
      stickToBottomRef.current = distanceFromBottom < 72;
      lastDockRectRef.current = dock.getBoundingClientRect();
    };

    updateScrollState();
    viewport.addEventListener("scroll", updateScrollState, { passive: true });
    const observer = new IntersectionObserver(
      ([entry]) => setDockVisible(entry.isIntersecting && entry.intersectionRatio >= 0.35),
      { root: viewport, threshold: [0, 0.35, 1] },
    );
    observer.observe(dock);

    return () => {
      viewport.removeEventListener("scroll", updateScrollState);
      observer.disconnect();
    };
  }, [activeId, hasConversation]);

  useLayoutEffect(() => {
    if (hasConversation && dockMascotRef.current) {
      lastDockRectRef.current = dockMascotRef.current.getBoundingClientRect();
    }
  }, [hasConversation, items]);

  // Keep following the stream only while the reader remains near the bottom.
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    endRef.current?.scrollIntoView({
      behavior: streamingRef.current ? "instant" : "smooth",
      block: "end",
    });
  }, [items]);

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
    inputRef.current?.focus();
  }, [activeId, draftVersion]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming || !ready) return;
    stickToBottomRef.current = true;
    setInput("");
    void send(providerId, model, text);
  };

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
      <div
        ref={ghostMascotRef}
        aria-hidden
        className={cn(
          "pointer-events-none fixed -top-32 -left-32 z-50 origin-top-left",
          ghostVisible ? "visible opacity-100 will-change-transform" : "invisible opacity-0",
        )}
      >
        <AppIconLoader active={false} idle={false} />
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          aria-hidden={hasConversation}
          className={cn(
            "absolute inset-0 flex flex-col items-center justify-center px-4 text-center transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
            hasConversation
              ? "pointer-events-none -translate-y-1 opacity-0"
              : "translate-y-0 opacity-100",
          )}
        >
          {ready ? (
            <div className="flex flex-col items-center gap-1">
              <ChannelSetupMascot
                mascotRef={heroMascotRef}
                className={cn(
                  "h-56 w-80 transition-opacity duration-200 motion-reduce:transition-none",
                  mascotPhase === "hero" ? "opacity-100" : "opacity-0",
                )}
                mascotClassName="size-32"
              >
                <AppIconLoader
                  active={false}
                  idle={!hasConversation && mascotPhase === "hero"}
                />
              </ChannelSetupMascot>
              <p className="text-lg font-semibold">开始新任务</p>
            </div>
          ) : (
            <div className="flex select-none flex-col items-center">
              <ChannelSetupMascot mascotRef={heroMascotRef} />
              {readiness === "choose-model" && settings ? (
                <div className="mt-1 flex justify-center">
                  <ModelSelect
                    prominent
                    promptText="选择和铁铁汁一起探索世界的方式"
                    settings={settings}
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
                        onClick={() => void settingsQuery.refetch()}
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
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 px-4 pt-6 pb-6">
              {items.map((item, index) => {
                const hoverKey = `${item.id}:${index}:${item.createdAt}`;
                return item.kind === "toolCall" ? (
                  <ToolCallCard key={item.id} item={item} />
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
                  streaming ? `${streamStatus}，已用时 ${elapsedSeconds} 秒` : "铁铁汁就绪"
                }
                className="mt-auto flex min-h-14 items-center gap-2"
              >
                <div ref={dockMascotRef} className="relative size-12 shrink-0">
                  <div className={mascotPhase === "docked" ? "opacity-100" : "opacity-0"}>
                    <AppIconLoader
                      active={indicatorActive && mascotPhase === "docked" && dockVisible}
                      className="origin-top-left scale-[0.375]"
                      idle={hasConversation && mascotPhase === "docked" && dockVisible}
                    />
                  </div>
                </div>
                <span
                  aria-hidden
                  className={cn(
                    "text-muted-foreground flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs tabular-nums transition-[opacity,transform] duration-300",
                    streaming && mascotPhase === "docked"
                      ? "translate-x-0 opacity-100"
                      : "-translate-x-1 opacity-0",
                  )}
                >
                  <span className="truncate">{streamStatus}</span>
                  <span>·</span>
                  <span>{elapsedSeconds}s</span>
                  {streamModel && (
                    <>
                      <span>·</span>
                      <span>{streamModel}</span>
                    </>
                  )}
                </span>
              </div>
              <div ref={endRef} />
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* A fresh task without a model is configured from the focused empty
          state above. Existing conversations keep the composer visible so a
          removed model can be replaced without losing context. */}
      {(ready || hasConversation) && (
      <div className="relative mx-auto w-full max-w-3xl px-4 pt-2 pb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            stickToBottomRef.current = true;
            endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
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

        <div className="border-input bg-background focus-within:border-ring focus-within:ring-ring/30 relative z-20 flex flex-col rounded-2xl border px-2 pt-1.5 pb-1.5 shadow-sm transition-colors focus-within:ring-[3px]">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
            className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
            rows={1}
          />

          <div className="flex items-center gap-1 pt-0.5 pl-1">
            <span className="text-muted-foreground flex-1 truncate text-[11px]">
              {ready ? "Enter 发送 · Shift+Enter 换行" : setupDescription}
            </span>
            {settings && <ModelSelect settings={settings} />}
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
                    disabled={!input.trim()}
                    aria-label="发送"
                  >
                    <ArrowUp />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
