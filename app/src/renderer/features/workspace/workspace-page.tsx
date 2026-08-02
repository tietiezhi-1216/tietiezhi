import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowUp,
  Check,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  Info,
  Loader2,
  LogIn,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  Square,
  SquarePen,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { GateStarfield } from "@/components/gate-starfield";
import { ProductSwitcher } from "@/components/product-switcher";
import { ProductOrbitStage } from "@/components/product-orbit-stage";
import { ProviderEditDialog } from "@/features/settings/provider-edit-dialog";
import { WorkspaceModeSwitcher } from "@/components/workspace-mode-switcher";
import { GatewayAccountButton } from "@/components/gateway-account-button";
import { ProductMascotMotion } from "@/components/product-mascot-motion";
import { OctopusPeekButton } from "@/components/octopus-peek-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { chatModels } from "@/lib/model-capabilities";
import { Markdown, fadeTokens, isFadeSpace } from "./markdown";
import { WorkspaceModelSelect } from "./workspace-model-select";
import { ApprovalActions } from "./approval-actions";
import { applyWorkspaceEvents } from "./workspace-events";
import { formatRelativeTime, useRelativeNow } from "./relative-time";
import type { SettingsCategory } from "@/features/settings/provider-dialog";
import type { ProductArea } from "@/App";
import type {
  ApprovalDecision,
  ApprovalRecord,
  AppMessage,
  Conversation,
  EngineDescriptor,
  EngineEvent,
  GatewayAccountView,
  ProviderAccount,
  WorkspaceInfo,
  WorkspaceFile,
  TaskMode,
  PermissionProfileId,
} from "@shared/contracts";

type RetryEvent = Extract<EngineEvent, { type: "run.retrying" }>;
const IS_MACOS = navigator.userAgent.includes("Mac");
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_COLLAPSE_THRESHOLD = 140;

export function WorkspacePage({
  active,
  providerVersion,
  onOpenSettings,
  onProviderChanged,
  onSwitchArea,
}: {
  /** 本页在后台待命时仍然挂载，全局快捷键要靠它避让。 */
  active: boolean;
  providerVersion: number;
  onOpenSettings: (category?: SettingsCategory) => void;
  onProviderChanged: () => void;
  onSwitchArea: (area: ProductArea) => void;
}) {
  const [providers, setProviders] = useState<ProviderAccount[]>([]);
  const [gatewayView, setGatewayView] = useState<GatewayAccountView>();
  const [bootstrapped, setBootstrapped] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState("");
  const [gateProviderOpen, setGateProviderOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [engines, setEngines] = useState<EngineDescriptor[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [providerId, setProviderId] = useState(
    () => window.localStorage.getItem("workspace-provider") ?? "",
  );
  const engineId = "ai-sdk";
  const [defaultPermissionProfileId, setDefaultPermissionProfileId] =
    useState<PermissionProfileId>("ask");
  const [permissionProfileId, setPermissionProfileId] =
    useState<PermissionProfileId>("ask");
  const [requestedPermissionProfileId, setRequestedPermissionProfileId] =
    useState<PermissionProfileId>();
  const [model, setModel] = useState(
    () => window.localStorage.getItem("workspace-model") ?? "",
  );
  const [taskMode, setTaskMode] = useState<TaskMode>(
    () => window.localStorage.getItem("workspace-task-mode") === "work" ? "work" : "code",
  );
  const [draft, setDraft] = useState("");
  const [runId, setRunId] = useState<string>();
  const [retry, setRetry] = useState<RetryEvent>();
  const [error, setError] = useState("");
  const [isAtHistoryBottom, setIsAtHistoryBottom] = useState(true);
  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [panelOpen, setPanelOpen] = useState(
    () => window.localStorage.getItem("workspace-panel-open") === "true",
  );
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.localStorage.getItem("workspace-sidebar-open") !== "false",
  );
  const [projectsOpen, setProjectsOpen] = useState(
    () => window.localStorage.getItem("workspace-projects-open") !== "false",
  );
  const [tasksOpen, setTasksOpen] = useState(
    () => window.localStorage.getItem("workspace-tasks-open") === "true",
  );
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() => {
    try {
      const saved: unknown = JSON.parse(
        window.localStorage.getItem("workspace-expanded-projects") ?? "{}",
      );
      if (typeof saved !== "object" || saved === null) return {};
      return Object.fromEntries(
        Object.entries(saved).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      );
    } catch {
      return {};
    }
  });
  const [renaming, setRenaming] = useState<Conversation>();
  const [renameTitle, setRenameTitle] = useState("");
  const scrollHostRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const initialHistoryScrollDoneRef = useRef(false);
  const isAutoScrollingRef = useRef(false);
  const forcedScrollRef = useRef(false);
  const autoScrollFrameRef = useRef<number | undefined>(undefined);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarOpenTargetRef = useRef<number | undefined>(undefined);
  const queuedEvents = useRef<EngineEvent[]>([]);
  const eventFrame = useRef<number | undefined>(undefined);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const projectGroups = useMemo(() => {
    const groups = new Map<string, Conversation[]>();
    for (const conversation of conversations) {
      if (!conversation.workspace || /[/\\]workspaces[/\\][\w-]+$/.test(conversation.workspace)) {
        continue;
      }
      const current = groups.get(conversation.workspace) ?? [];
      current.push(conversation);
      groups.set(conversation.workspace, current);
    }
    return [...groups.entries()];
  }, [conversations]);
  const temporaryTasks = conversations.filter(
    (conversation) =>
      !conversation.workspace || /[/\\]workspaces[/\\][\w-]+$/.test(conversation.workspace),
  );
  // Onboarding gate: without a signed-in gateway account or a user-added
  // provider, the workspace UI stays hidden until one entry is completed.
  // The built-in gateway row always exists, so it never counts as setup.
  const setupRequired =
    !providers.some((provider) => !provider.builtIn) &&
    gatewayView?.loggedIn !== true;

  const refreshConversations = async () => {
    setConversations(await window.tietiezhi.conversations.list());
  };

  useEffect(() => {
    void Promise.all([
      window.tietiezhi.providers.list().then((value) => {
        setProviders(value);
        setProviderId(
          (current) => {
            const available = value.find(
              (provider) =>
                provider.id === current && chatModels(provider.models).length > 0,
            );
            return (
              available?.id ??
              value.find((provider) => chatModels(provider.models).length > 0)?.id ??
              ""
            );
          },
        );
      }),
      window.tietiezhi.gateway
        .account()
        .then(setGatewayView)
        .catch(() =>
          setGatewayView({
            providerId: "builtin-official",
            supported: false,
            loggedIn: false,
          }),
        ),
      refreshConversations(),
      window.tietiezhi.engines.list().then(setEngines),
      window.tietiezhi.preferences.get().then((preferences) => {
        const profile = preferences.defaultPermissionProfiles[engineId] ?? "ask";
        setDefaultPermissionProfileId(profile);
        if (activeId === undefined) setPermissionProfileId(profile);
      }),
    ]).finally(() => setBootstrapped(true));
  }, [providerVersion]);

  useEffect(() => {
    if (activeId === undefined) setPermissionProfileId(defaultPermissionProfileId);
  }, [activeId, defaultPermissionProfileId]);

  useEffect(() => {
    const refreshPermissionDefault = () => {
      void window.tietiezhi.preferences.get().then((preferences) => {
        const profile = preferences.defaultPermissionProfiles[engineId] ?? "ask";
        setDefaultPermissionProfileId(profile);
        if (activeId === undefined) setPermissionProfileId(profile);
      });
    };
    window.addEventListener("tietiezhi:preferences-changed", refreshPermissionDefault);
    return () => window.removeEventListener("tietiezhi:preferences-changed", refreshPermissionDefault);
  }, [activeId]);

  // The main process shrinks the window for onboarding and restores the
  // remembered workspace bounds once setup completes.
  useEffect(() => {
    if (!bootstrapped) return;
    void window.tietiezhi.appWindow
      .setMode(setupRequired ? "setup" : "normal")
      .catch(() => undefined);
  }, [bootstrapped, setupRequired]);

  useEffect(() => {
    if (!selectedProvider) {
      setModel("");
      return;
    }
    const models = chatModels(selectedProvider.models);
    if (!models.includes(model)) setModel(models[0] ?? "");
  }, [selectedProvider, model]);

  useEffect(() => {
    window.localStorage.setItem("workspace-provider", providerId);
    window.localStorage.setItem("workspace-model", model);
    window.localStorage.setItem("workspace-task-mode", taskMode);
  }, [providerId, model, taskMode]);

  useEffect(() => {
    window.localStorage.setItem("workspace-sidebar-open", String(sidebarOpen));
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const savedWidth = Number(window.localStorage.getItem("workspace-sidebar-width"));
    const width =
      Number.isFinite(savedWidth) &&
      savedWidth >= SIDEBAR_MIN_WIDTH &&
      savedWidth <= SIDEBAR_MAX_WIDTH
        ? savedWidth
        : SIDEBAR_DEFAULT_WIDTH;
    const openWidth = sidebarOpenTargetRef.current ?? width;
    sidebarOpenTargetRef.current = undefined;
    const frame = window.requestAnimationFrame(() => {
      sidebar.style.setProperty("width", sidebarOpen ? `${openWidth}px` : "0px");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sidebarOpen]);

  useEffect(() => {
    window.localStorage.setItem("workspace-panel-open", String(panelOpen));
  }, [panelOpen]);

  useEffect(() => {
    window.localStorage.setItem("workspace-projects-open", String(projectsOpen));
    window.localStorage.setItem("workspace-tasks-open", String(tasksOpen));
    window.localStorage.setItem(
      "workspace-expanded-projects",
      JSON.stringify(expandedProjects),
    );
  }, [expandedProjects, projectsOpen, tasksOpen]);

  useEffect(() => {
    if (!active) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "b" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      setSidebarOpen((current) => !current);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [active]);

  useEffect(() => {
    const unsubscribe = window.tietiezhi.onEngineEvent((event) => {
        if (event.conversationId !== activeId && activeId !== undefined) return;
        queuedEvents.current.push(event);
        if (eventFrame.current !== undefined) return;
        eventFrame.current = window.setTimeout(() => {
          eventFrame.current = undefined;
          const events = queuedEvents.current.splice(0);
          if (events.length === 0) return;
          setMessages((current) => applyWorkspaceEvents(current, events));
          const approvalsInBatch = events
            .filter((candidate) => candidate.type === "tool.approval_required")
            .map((candidate): ApprovalRecord => ({
              id: candidate.approvalId,
              runId: candidate.runId,
              conversationId: candidate.conversationId,
              messageId: candidate.messageId,
              toolCallId: candidate.toolCallId,
              toolName: candidate.toolName,
              description: candidate.description,
              input: candidate.input,
              risk: candidate.risk,
              status: "pending",
              createdAt: candidate.createdAt,
              expiresAt: candidate.expiresAt,
            }));
          if (approvalsInBatch.length > 0) {
            setApprovals((current) => {
              const ids = new Set(approvalsInBatch.map((item) => item.id));
              return [...current.filter((item) => !ids.has(item.id)), ...approvalsInBatch];
            });
          }
          const resolvedEvents = events.filter(
            (candidate): candidate is Extract<EngineEvent, { type: "tool.approval_resolved" }> =>
              candidate.type === "tool.approval_resolved",
          );
          if (resolvedEvents.length > 0) {
            setApprovals((current) => current.map((item) => {
              const resolved = resolvedEvents.find((candidate) => candidate.approvalId === item.id);
              return resolved
                ? {
                    ...item,
                    status: resolved.decision === "deny" ? "denied" : "approved",
                    decision: resolved.decision,
                    resolvedAt: resolved.createdAt,
                    reason: resolved.reason,
                  }
                : item;
            }));
          }
          setRetry((current) => {
            let next = current;
            for (const candidate of events) {
              if (candidate.type === "run.retrying") next = candidate;
              else if (
                candidate.type === "text.delta" ||
                candidate.type === "reasoning.delta" ||
                candidate.type === "tool.call" ||
                candidate.type === "run.completed" ||
                candidate.type === "run.failed"
              ) {
                next = undefined;
              }
            }
            return next;
          });
          const terminal = events.findLast(
            (candidate) =>
              candidate.type === "run.completed" || candidate.type === "run.failed",
          );
          if (terminal) {
            setRunId(undefined);
            void refreshConversations();
            void window.tietiezhi.approvals.list(terminal.conversationId).then(setApprovals);
          }
        }, 50);
      });
    return () => {
      unsubscribe();
      if (eventFrame.current !== undefined) {
        window.clearTimeout(eventFrame.current);
        eventFrame.current = undefined;
      }
      queuedEvents.current = [];
    };
  }, [activeId]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior, forced = false) => {
      const viewport = scrollHostRef.current?.querySelector<HTMLElement>(
        "[data-slot='scroll-area-viewport']",
      );
      if (!viewport) return;

      if (autoScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = undefined;
      }

      isAutoScrollingRef.current = true;
      forcedScrollRef.current = forced;
      setIsAtHistoryBottom(true);

      const finish = () => {
        viewport.scrollTop = Math.max(
          0,
          viewport.scrollHeight - viewport.clientHeight,
        );
        isAutoScrollingRef.current = false;
        forcedScrollRef.current = false;
        autoScrollFrameRef.current = undefined;
        stickToBottomRef.current = true;
        setIsAtHistoryBottom(true);
      };

      if (behavior !== "smooth") {
        finish();
        return;
      }

      stickToBottomRef.current = false;
      const startedAt = performance.now();
      const startTop = viewport.scrollTop;
      const duration = 520;
      const animate = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        const target = Math.max(
          0,
          viewport.scrollHeight - viewport.clientHeight,
        );
        viewport.scrollTop = startTop + (target - startTop) * eased;
        if (progress < 1) {
          autoScrollFrameRef.current =
            window.requestAnimationFrame(animate);
          return;
        }
        finish();
      };
      autoScrollFrameRef.current = window.requestAnimationFrame(animate);
    },
    [],
  );

  useEffect(() => {
    const viewport = scrollHostRef.current?.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']",
    );
    if (!viewport || messages.length === 0) return;

    const updateScrollState = () => {
      if (isAutoScrollingRef.current) return;
      const distanceFromBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (distanceFromBottom > 72) stickToBottomRef.current = false;
      else if (distanceFromBottom < 4) stickToBottomRef.current = true;
      setIsAtHistoryBottom(distanceFromBottom < 24);
    };
    const handleWheel = (event: WheelEvent) => {
      // 触控板抬手后仍会派发惯性 wheel 事件，主动「回到底部」要豁免，否则动画刚起步就被掐断。
      if (event.deltaY < 0 && !forcedScrollRef.current) {
        isAutoScrollingRef.current = false;
        if (autoScrollFrameRef.current !== undefined) {
          window.cancelAnimationFrame(autoScrollFrameRef.current);
          autoScrollFrameRef.current = undefined;
        }
        stickToBottomRef.current = false;
        setIsAtHistoryBottom(false);
      }
    };

    updateScrollState();
    viewport.addEventListener("scroll", updateScrollState, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", updateScrollState);
      viewport.removeEventListener("wheel", handleWheel);
    };
  }, [activeId, messages.length > 0]);

  useLayoutEffect(() => {
    if (messages.length === 0 || initialHistoryScrollDoneRef.current) return;
    initialHistoryScrollDoneRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      scrollToBottom("auto");
      window.requestAnimationFrame(() => scrollToBottom("auto"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, scrollToBottom]);

  useEffect(() => {
    const viewport = scrollHostRef.current?.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']",
    );
    const content = viewport?.firstElementChild;
    if (!viewport || !(content instanceof HTMLElement)) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottom("auto");
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [activeId, scrollToBottom]);

  useEffect(
    () => () => {
      if (autoScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollToBottom(runId ? "instant" : "smooth");
  }, [messages, runId, scrollToBottom]);

  useEffect(() => {
    const pending = approvals.findLast((approval) => approval.status === "pending");
    if (!pending) return;
    const frame = window.requestAnimationFrame(() => {
      const message = scrollHostRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(pending.messageId)}"]`,
      );
      message?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [approvals]);

  const open = async (id: string) => {
    stickToBottomRef.current = true;
    initialHistoryScrollDoneRef.current = false;
    setIsAtHistoryBottom(true);
    setRetry(undefined);
    const detail = await window.tietiezhi.conversations.load(id);
    setActiveId(id);
    setMessages(detail.messages);
    setProviderId(detail.conversation.providerAccountId ?? providerId);
    setModel(detail.conversation.activeModelId ?? model);
    setTaskMode(detail.conversation.taskMode);
    setPermissionProfileId(detail.conversation.permissionProfileId);
    setRunId(
      detail.messages.findLast(
        (message) =>
          message.status === "pending" ||
          message.status === "streaming" ||
          message.status === "waiting_approval",
      )?.runId,
    );
    const path = detail.conversation.workspace;
    setWorkspace(
      path
        ? {
            path,
            name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace",
            temporary: /[/\\]workspaces[/\\][\w-]+$/.test(path),
          }
        : undefined,
    );
    setApprovals(await window.tietiezhi.approvals.list(id));
    setError("");
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !providerId || !model || runId) return;
    stickToBottomRef.current = true;
    setRetry(undefined);
    const optimistic: AppMessage = {
      id: `optimistic-${crypto.randomUUID()}`,
      conversationId: activeId ?? "",
      role: "user",
      createdAt: Date.now(),
      status: "completed",
      parts: [{ type: "text", text }],
      engineId,
      modelId: model,
    };
    setMessages((current) => [...current, optimistic]);
    setDraft("");
    setError("");
    try {
      const started = await window.tietiezhi.conversations.send({
        conversationId: activeId,
        text,
        providerAccountId: providerId,
        model,
        engineId,
        workspace: workspace?.path,
        taskMode,
        permissionProfileId,
      });
      setActiveId(started.conversationId);
      setRunId(started.runId);
      const detail = await window.tietiezhi.conversations.load(started.conversationId);
      setMessages(detail.messages);
      setPermissionProfileId(detail.conversation.permissionProfileId);
      if (detail.conversation.workspace) {
        const path = detail.conversation.workspace;
        setWorkspace({
          path,
          name: /[/\\]workspaces[/\\][\w-]+$/.test(path)
            ? "临时 Workspace"
            : (path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace"),
          temporary: /[/\\]workspaces[/\\][\w-]+$/.test(path),
        });
      }
      await refreshConversations();
    } catch (cause) {
      setMessages((current) => current.filter((message) => message.id !== optimistic.id));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const resolveApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      try {
        await window.tietiezhi.approvals.resolve(approvalId, decision);
        setApprovals((current) => current.map((item) => item.id === approvalId
          ? {
              ...item,
              status: decision === "deny" ? "denied" : "approved",
              decision,
              resolvedAt: Date.now(),
            }
          : item));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    },
    [],
  );

  const remove = async (id: string) => {
    setError("");
    try {
      await window.tietiezhi.conversations.remove(id);
      if (activeId === id) {
        setActiveId(undefined);
        setMessages([]);
        setRetry(undefined);
        setWorkspace(undefined);
        setApprovals([]);
      }
      await refreshConversations();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const saveRename = async () => {
    if (!renaming || !renameTitle.trim()) return;
    setError("");
    try {
      await window.tietiezhi.conversations.rename(renaming.id, renameTitle);
      setRenaming(undefined);
      await refreshConversations();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const startProjectTask = (path: string) => {
    setWorkspace({
      path,
      name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? "项目",
      temporary: false,
    });
    setExpandedProjects((current) => ({ ...current, [path]: true }));
    setActiveId(undefined);
    setMessages([]);
    setRetry(undefined);
    setApprovals([]);
    setError("");
  };

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !sidebarRef.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = sidebarRef.current.getBoundingClientRect().width;
    let renderedWidth = startWidth;
    let targetWidth = startWidth;
    let collapse = false;
    let pausedUntil = 0;
    let frame: number | undefined;
    let finished = false;
    const sidebar = sidebarRef.current;
    sidebar.style.setProperty("transition", "none");
    handle.setPointerCapture(event.pointerId);

    const animate = (time: number) => {
      if (finished || collapse) {
        frame = undefined;
        return;
      }
      if (time < pausedUntil) {
        frame = window.requestAnimationFrame(animate);
        return;
      }
      if (pausedUntil > 0) {
        renderedWidth = sidebar.getBoundingClientRect().width;
        pausedUntil = 0;
        sidebar.style.setProperty("transition", "none");
      }
      renderedWidth += (targetWidth - renderedWidth) * 0.22;
      if (Math.abs(targetWidth - renderedWidth) < 0.35) {
        renderedWidth = targetWidth;
      }
      sidebar.style.setProperty("width", `${renderedWidth}px`);
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);

    const move = (moveEvent: PointerEvent) => {
      const rawWidth = startWidth + moveEvent.clientX - startX;
      const nextCollapse = rawWidth <= SIDEBAR_COLLAPSE_THRESHOLD;
      if (nextCollapse !== collapse) {
        collapse = nextCollapse;
        sidebar.style.removeProperty("transition");
        sidebar.style.removeProperty("opacity");
        if (!collapse) {
          sidebarOpenTargetRef.current = SIDEBAR_MIN_WIDTH;
          targetWidth = Math.max(SIDEBAR_MIN_WIDTH, rawWidth);
          pausedUntil = performance.now() + 90;
          if (frame === undefined) frame = window.requestAnimationFrame(animate);
        }
        setSidebarOpen(!collapse);
        return;
      }
      if (collapse) return;
      targetWidth = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, rawWidth),
      );
    };
    const finish = () => {
      finished = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
      sidebar.style.removeProperty("transition");
      sidebar.style.removeProperty("opacity");
      if (!collapse) {
        window.requestAnimationFrame(() => {
          sidebar.style.setProperty("width", `${targetWidth}px`);
        });
        window.localStorage.setItem(
          "workspace-sidebar-width",
          String(Math.round(targetWidth)),
        );
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
  };

  const resetSidebarWidth = () => {
    sidebarRef.current?.style.setProperty("width", `${SIDEBAR_DEFAULT_WIDTH}px`);
    window.localStorage.setItem(
      "workspace-sidebar-width",
      String(SIDEBAR_DEFAULT_WIDTH),
    );
  };

  const empty = !providerId || !model;
  const activeConversation = conversations.find((conversation) => conversation.id === activeId);
  const activeEngine = engines.find((engine) => engine.id === engineId);
  const permissionProfiles = activeEngine?.capabilities.permissions.profiles ?? [];
  const activePermissionProfile = permissionProfiles.find(
    (profile) => profile.id === permissionProfileId,
  );

  const commitPermission = async (profileId: PermissionProfileId) => {
    setError("");
    try {
      if (activeId) {
        const updated = await window.tietiezhi.conversations.setPermission(activeId, profileId);
        setConversations((current) =>
          current.map((conversation) => conversation.id === updated.id ? updated : conversation),
        );
      }
      setPermissionProfileId(profileId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectPermission = (profileId: PermissionProfileId) => {
    const profile = permissionProfiles.find((candidate) => candidate.id === profileId);
    if (profile?.requiresConfirmation) {
      setRequestedPermissionProfileId(profileId);
      return;
    }
    void commitPermission(profileId);
  };

  const gateLogin = async () => {
    setGateBusy(true);
    setGateError("");
    try {
      setGatewayView(await window.tietiezhi.gateway.login());
      onProviderChanged();
    } catch (cause) {
      setGateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGateBusy(false);
    }
  };

  if (!bootstrapped || setupRequired) {
    return (
      <div className="bg-background relative flex h-full min-h-0 flex-col overflow-hidden">
        <GateStarfield className="text-muted-foreground" />
        <header className="relative z-10 h-12 shrink-0 [-webkit-app-region:drag]" />
        {/* Optical centering: the stage sits slightly above true center. */}
        <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-[6vh]">
          <div
            className={cn(
              "flex flex-col items-center transition-opacity duration-500",
              bootstrapped ? "opacity-100" : "opacity-0",
            )}
          >
            <ProductOrbitStage variant="tietiezhi" className="-mt-4 -mb-1" />
            <div className="flex items-center gap-3">
              <Button
                type="button"
                disabled={gateBusy}
                onClick={() => void gateLogin()}
                className="h-10 rounded-full px-5 dark:bg-white dark:text-neutral-950 dark:hover:bg-white/90"
              >
                {gateBusy ? <Loader2 className="animate-spin" /> : <LogIn />}
                铁铁汁登录
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={gateBusy}
                onClick={() => setGateProviderOpen(true)}
                className="h-10 rounded-full px-5"
              >
                <Plus />
                添加供应商
              </Button>
            </div>
            {gateError && (
              <p className="text-destructive mt-4 max-w-sm text-center text-xs">
                {gateError}
              </p>
            )}
          </div>
        </div>
        <ProviderEditDialog
          open={gateProviderOpen}
          onOpenChange={setGateProviderOpen}
          onSaved={onProviderChanged}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-transparent">
      <aside
        ref={sidebarRef}
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen}
        className={cn(
          "@container/sidebar bg-sidebar/70 text-sidebar-foreground relative flex w-64 shrink-0 flex-col overflow-hidden border-r backdrop-blur-2xl transition-[width,opacity,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] supports-[backdrop-filter]:bg-sidebar/60",
          sidebarOpen
            ? "opacity-100"
            : "pointer-events-none border-r-transparent opacity-0",
        )}
      >
          <div
            className={cn(
              "flex h-12 shrink-0 items-center border-b px-2 [-webkit-app-region:drag]",
              IS_MACOS && "pl-24",
            )}
          >
            <ProductSwitcher
              area="workspace"
              onSwitch={onSwitchArea}
              variant="sidebar"
            />
          </div>
          <div className="p-2">
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start text-xs"
              onClick={() => {
                setActiveId(undefined);
                setMessages([]);
                setRetry(undefined);
                setError("");
                setWorkspace(undefined);
                setApprovals([]);
              }}
            >
              <MessageSquarePlus /> 新建任务
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="pb-3">
              <div className="relative flex w-full min-w-0 flex-col p-2">
                <div className="group/header relative">
                  <button
                    type="button"
                    aria-expanded={projectsOpen}
                    onClick={() => setProjectsOpen((current) => !current)}
                    className="text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground flex h-8 w-fit items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors duration-300"
                  >
                    <span>项目</span>
                    <ChevronRight
                      className={cn(
                        "size-4 opacity-0 transition-[opacity,rotate] duration-300 group-hover/header:opacity-100",
                        projectsOpen && "rotate-90",
                      )}
                    />
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-sidebar-foreground absolute top-1/2 right-1 size-5 -translate-y-1/2 opacity-0 transition-opacity duration-300 group-hover/header:opacity-100 focus-visible:opacity-100"
                    onClick={async () => {
                      const selected = await window.tietiezhi.workspace.choose();
                      if (selected) {
                        setWorkspace(selected);
                        setActiveId(undefined);
                        setMessages([]);
                        setRetry(undefined);
                      }
                    }}
                    aria-label="添加项目"
                  >
                    <Plus />
                  </Button>
                </div>
                <div
                  className={cn(
                    "grid overflow-hidden transition-[grid-template-rows,opacity,translate] duration-[360ms]",
                    projectsOpen
                      ? "grid-rows-[1fr] translate-y-0 opacity-100"
                      : "pointer-events-none grid-rows-[0fr] -translate-y-1 opacity-0",
                  )}
                >
                  <div className="min-h-0 overflow-hidden">
                    {projectGroups.length === 0 ? (
                      <button
                        type="button"
                        className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs"
                        onClick={async () => {
                          const selected = await window.tietiezhi.workspace.choose();
                          if (selected) setWorkspace(selected);
                        }}
                      >
                        <Folder className="size-4" /> 添加一个项目文件夹
                      </button>
                    ) : (
                      <div className="flex w-full min-w-0 flex-col">
                        {projectGroups.map(([path, projectTasks]) => {
                          const expanded = expandedProjects[path] ?? true;
                          return (
                            <div key={path} className="relative min-w-0">
                              <div className="group/project-row relative">
                                <button
                                  type="button"
                                  aria-expanded={expanded}
                                  onClick={() =>
                                    setExpandedProjects((current) => ({
                                      ...current,
                                      [path]: !expanded,
                                    }))
                                  }
                                  className="group/project hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 pr-14 text-left text-sm"
                                >
                                  <span className="text-sidebar-foreground/70 relative size-4 shrink-0">
                                    <Folder
                                      className={cn(
                                        "absolute inset-0 size-4 transition-[opacity,transform] duration-300",
                                        expanded
                                          ? "-rotate-6 scale-90 opacity-0"
                                          : "opacity-100",
                                      )}
                                    />
                                    <FolderOpen
                                      className={cn(
                                        "absolute inset-0 size-4 transition-[opacity,transform] duration-300",
                                        expanded
                                          ? "opacity-100"
                                          : "rotate-6 scale-90 opacity-0",
                                      )}
                                    />
                                  </span>
                                  <span className="truncate">
                                    {path.split(/[\\/]/).filter(Boolean).at(-1)}
                                  </span>
                                </button>
                                <div className="pointer-events-none absolute top-1 right-1 flex items-center opacity-0 transition-opacity duration-300 group-hover/project-row:pointer-events-auto group-hover/project-row:opacity-100 group-focus-within/project-row:pointer-events-auto group-focus-within/project-row:opacity-100">
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label="项目操作"
                                        className="data-[state=open]:bg-sidebar-accent"
                                      >
                                        <MoreHorizontal />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent
                                      side="right"
                                      align="start"
                                      className="w-max min-w-44"
                                    >
                                      <DropdownMenuItem
                                        className="whitespace-nowrap"
                                        onSelect={() => startProjectTask(path)}
                                      >
                                        <SquarePen />在此项目中新建任务
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        className="whitespace-nowrap"
                                        onSelect={() => {
                                          void window.tietiezhi.workspace.reveal(path).catch(
                                            (cause: unknown) =>
                                              setError(
                                                cause instanceof Error
                                                  ? cause.message
                                                  : String(cause),
                                              ),
                                          );
                                        }}
                                      >
                                        <FolderOpen />
                                        {IS_MACOS ? "在 Finder 中显示" : "打开项目文件夹"}
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    title="在此项目中新建任务"
                                    aria-label="在此项目中新建任务"
                                    onClick={() => startProjectTask(path)}
                                  >
                                    <SquarePen />
                                  </Button>
                                </div>
                              </div>
                              <div
                                className={cn(
                                  "grid overflow-hidden transition-[grid-template-rows,opacity,translate] duration-[360ms]",
                                  expanded
                                    ? "grid-rows-[1fr] translate-y-0 opacity-100"
                                    : "pointer-events-none grid-rows-[0fr] -translate-y-1 opacity-0",
                                )}
                              >
                                <div className="min-h-0 overflow-hidden">
                                  {projectTasks.length === 0 ? (
                                    <p className="text-muted-foreground py-1 pr-2 pl-8 text-xs">
                                      暂无任务
                                    </p>
                                  ) : (
                                    <div className="flex w-full min-w-0 flex-col">
                                      {projectTasks.map((conversation) => (
                                        <TaskRow
                                          key={conversation.id}
                                          conversation={conversation}
                                          active={activeId === conversation.id}
                                          nested
                                          onOpen={open}
                                          onRemove={remove}
                                          onRename={(item) => {
                                            setRenaming(item);
                                            setRenameTitle(item.title);
                                          }}
                                        />
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="relative flex w-full min-w-0 flex-col p-2 pt-0">
                <div className="group/tasks">
                  <button
                          type="button"
                    aria-expanded={tasksOpen}
                    onClick={() => setTasksOpen((current) => !current)}
                    className="text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground flex h-8 w-fit items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors duration-300"
                  >
                    <span>任务</span>
                    <ChevronRight
                      className={cn(
                        "size-4 opacity-0 transition-[opacity,rotate] duration-300 group-hover/tasks:opacity-100",
                        tasksOpen && "rotate-90",
                      )}
                    />
                  </button>
                </div>
                <div
                  className={cn(
                    "grid overflow-hidden transition-[grid-template-rows,opacity,translate] duration-[360ms]",
                    tasksOpen
                      ? "grid-rows-[1fr] translate-y-0 opacity-100"
                      : "pointer-events-none grid-rows-[0fr] -translate-y-1 opacity-0",
                  )}
                >
                  <div className="min-h-0 overflow-hidden">
                    {temporaryTasks.length === 0 ? (
                      <p className="text-muted-foreground px-2 py-1 text-xs">暂无任务</p>
                    ) : (
                      <div className="flex w-full min-w-0 flex-col">
                        {temporaryTasks.map((conversation) => (
                          <TaskRow
                            key={conversation.id}
                            conversation={conversation}
                            active={activeId === conversation.id}
                            onOpen={open}
                            onRemove={remove}
                            onRename={(item) => {
                              setRenaming(item);
                              setRenameTitle(item.title);
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </ScrollArea>
          <div className="border-t p-2">
            <GatewayAccountButton
              onOpenSettings={onOpenSettings}
              onChanged={onProviderChanged}
            />
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            title="拖动调整宽度，双击恢复默认"
            onPointerDown={beginSidebarResize}
            onDoubleClick={resetSidebarWidth}
            className="group absolute inset-y-0 -right-1 z-30 w-2 touch-none cursor-col-resize before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-sidebar-ring/70"
          />
      </aside>
      <section className="bg-background flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 [-webkit-app-region:drag]">
          {!sidebarOpen && IS_MACOS && <div aria-hidden="true" className="w-16 shrink-0" />}
          {!sidebarOpen && (
            <ProductSwitcher
              area="workspace"
              onSwitch={onSwitchArea}
              compact
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="[-webkit-app-region:no-drag]"
            onClick={() => setSidebarOpen((current) => !current)}
            aria-label={sidebarOpen ? "收起侧栏（⌘B）" : "展开侧栏（⌘B）"}
          >
            {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
          <span className="min-w-0 truncate text-sm font-medium">
            {activeConversation?.title ?? "新建任务"}
          </span>
          <div className="ml-auto flex min-w-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
            <WorkspaceModeSwitcher
              value={taskMode}
              disabled={runId !== undefined}
              onChange={setTaskMode}
            />
            {activeId && (
              <Button
                type="button"
                variant={panelOpen ? "secondary" : "ghost"}
                size="icon-sm"
                onClick={() => setPanelOpen((current) => !current)}
                aria-label={panelOpen ? "收起工作区面板" : "展开工作区面板"}
              >
                {panelOpen ? <PanelRightClose /> : <PanelRight />}
              </Button>
            )}
          </div>
        </header>
        {messages.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-8">
            <div className="flex w-full max-w-3xl flex-col items-center justify-center text-center">
                <ProductOrbitStage variant="workspace" className="-mb-3" />
                <h1 className="h-7 max-w-full truncate px-4 text-lg font-semibold">
                  {workspace?.temporary === false
                    ? workspace.name
                    : taskMode === "work"
                      ? "开始一项 Work 任务"
                      : "开始一项 Code 任务"}
                </h1>
                <p className="text-muted-foreground mt-1 text-sm">
                  {taskMode === "work"
                    ? "研究、整理资料，并在当前 Workspace 中完成交付。"
                    : "分析仓库、修改代码，并验证最终结果。"}
                </p>
                {empty && (
                  <div className="mt-4">
                    <WorkspaceModelSelect
                      providers={providers}
                      providerId={providerId}
                      model={model}
                      prominent
                      onSelect={(nextProviderId, nextModel) => {
                        setProviderId(nextProviderId);
                        setModel(nextModel);
                      }}
                      onOpenSettings={onOpenSettings}
                    />
                  </div>
                )}
            </div>
          </div>
        ) : (
          <div ref={scrollHostRef} className="min-h-0 flex-1">
            <ScrollArea className="h-full [&_[data-slot=scroll-area-viewport]>div]:h-full">
              <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 px-4 pt-6 pb-4">
                <div className="flex flex-col gap-5">
                  {messages.map((message) => (
                    <Message
                      key={message.id}
                      message={message}
                      providerName={
                        providers.find((provider) => provider.id === message.providerAccountId)
                          ?.displayName
                      }
                      approvals={approvals}
                      onResolveApproval={resolveApproval}
                    />
                  ))}
                </div>
                <div
                  role="status"
                  aria-live="polite"
                  aria-label={
                    retry
                      ? `正在进行第 ${retry.attempt}/${retry.maxRetries} 次重试`
                      : runId
                        ? `正在生成，模型 ${model}`
                        : "任务状态"
                  }
                  className="mt-auto flex h-12 items-center gap-2"
                >
                  <div className="relative size-12 shrink-0 overflow-hidden">
                    <ProductMascotMotion
                      src="./mode-mascots/paper-plane/code.png"
                      blinkSrc="./mode-mascots/paper-plane/code-blink.png"
                      variant="workspace"
                      className="size-12"
                    />
                  </div>
                  {runId && (
                    <span className="text-muted-foreground text-shimmer min-w-0 truncate text-xs">
                      {retry
                        ? `正在进行第 ${retry.attempt}/${retry.maxRetries} 次重试 · ${retry.reason}`
                        : `正在生成 · ${model}`}
                    </span>
                  )}
                </div>
              </div>
            </ScrollArea>
          </div>
        )}
        <div className="relative mx-auto w-full max-w-3xl px-4 pt-2 pb-4">
          {/* 章鱼的定位基准必须正好是输入框这一层（而不是带 px-4 pt-2 的外框），
              才能和创作页的探头高度、右边距完全一致；且必须排在输入框之前，才会沉到它后面。 */}
          <div className="relative">
            <OctopusPeekButton
              visible={messages.length > 0 && !isAtHistoryBottom}
              onClick={() => scrollToBottom("smooth", true)}
            />
            {/* Solid background: the panel must not let content behind it bleed through. */}
            <div className="bg-muted relative z-20 flex flex-col rounded-2xl border-0 px-2 pt-1.5 pb-1.5 shadow-none transition-colors">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={
                  empty
                    ? "登录中转站或配置可用模型"
                    : taskMode === "work"
                      ? "描述需要研究、整理或交付的工作…"
                      : "描述需要分析、修改或验证的代码任务…"
                }
                disabled={empty}
                rows={1}
                className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:bg-transparent focus-visible:ring-0 focus-visible:shadow-none disabled:bg-transparent dark:bg-transparent dark:focus-visible:bg-transparent dark:focus-visible:shadow-none dark:disabled:bg-transparent"
              />
              <div className="flex min-h-9 items-center gap-1 pt-0.5 pl-1">
                {!activeId && messages.length === 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground h-7 max-w-48 shrink-0 gap-1.5 rounded-full px-2 text-xs"
                    onClick={async () => {
                      const selected = await window.tietiezhi.workspace.choose();
                      if (selected) setWorkspace(selected);
                    }}
                  >
                    <FolderOpen className="size-3.5" />
                    <span className="truncate">{workspace?.name ?? "选择项目"}</span>
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-foreground size-7 shrink-0 rounded-full"
                      aria-label="添加上下文"
                    >
                      <Plus className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-60">
                    <DropdownMenuLabel>Workspace</DropdownMenuLabel>
                    <DropdownMenuItem
                      onSelect={async () => {
                        const selected = await window.tietiezhi.workspace.choose();
                        if (selected) setWorkspace(selected);
                      }}
                    >
                      <FolderOpen /> 选择项目文件夹
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setPanelOpen(true)}>
                      <PanelRight /> 打开文件与变更
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-muted-foreground font-normal">
                      Agent 可通过文件工具读取当前 Workspace
                    </DropdownMenuLabel>
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "text-muted-foreground hover:text-foreground h-7 max-w-36 shrink-0 gap-1.5 rounded-full px-2 text-xs",
                        permissionProfileId === "full-access" && "text-amber-600 dark:text-amber-400",
                      )}
                      aria-label={`权限：${activePermissionProfile?.name ?? "请求批准"}`}
                    >
                      <ShieldCheck className="size-3.5" />
                      <span className="truncate">{activePermissionProfile?.name ?? "请求批准"}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-72">
                    <DropdownMenuLabel>当前任务权限</DropdownMenuLabel>
                    {permissionProfiles.map((profile) => (
                      <DropdownMenuItem
                        key={profile.id}
                        onSelect={() => selectPermission(profile.id)}
                        className="items-start gap-2 py-2"
                      >
                        <Check className={cn("mt-0.5 size-3.5", profile.id !== permissionProfileId && "opacity-0")} />
                        <span className="min-w-0">
                          <span className="block text-xs font-medium">{profile.name}</span>
                          <span className="text-muted-foreground mt-0.5 block text-[11px] leading-4">
                            {profile.description}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                    {runId && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-muted-foreground font-normal">
                          更改将在下一次发送消息时生效
                        </DropdownMenuLabel>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className={cn("min-w-0 flex-1 truncate text-[11px]", error ? "text-destructive" : "text-muted-foreground")}>
                  {error || (empty ? "请先配置可用模型" : "")}
                </span>
                <WorkspaceModelSelect
                  providers={providers}
                  providerId={providerId}
                  model={model}
                  onSelect={(nextProviderId, nextModel) => {
                    setProviderId(nextProviderId);
                    setModel(nextModel);
                  }}
                  onOpenSettings={onOpenSettings}
                />
                {runId ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-8 shrink-0 rounded-full"
                    onClick={() => void window.tietiezhi.conversations.cancel(runId)}
                    aria-label="停止生成"
                  >
                    <Square />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="icon"
                    className="size-8 shrink-0 rounded-full"
                    onClick={() => void send()}
                    disabled={!draft.trim() || !providerId || !model}
                    aria-label="发送"
                  >
                    <ArrowUp />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
      {activeId && panelOpen && (
        <AgentPanel
          activeId={activeId}
          messages={messages}
          workspace={workspace}
          onClose={() => setPanelOpen(false)}
        />
      )}
      <AlertDialog
        open={requestedPermissionProfileId === "full-access"}
        onOpenChange={(open) => !open && setRequestedPermissionProfileId(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>为当前任务启用完全访问？</AlertDialogTitle>
            <AlertDialogDescription>
              Agent 将自动执行工作区内的文件操作和 Shell 命令，不再逐次询问。Workspace
              路径边界、命令超时、输出限制和停止任务仍然有效。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRequestedPermissionProfileId(undefined);
                void commitPermission("full-access");
              }}
              className="bg-amber-600 text-white hover:bg-amber-600/90"
            >
              仅为当前任务启用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={renaming !== undefined} onOpenChange={(open) => !open && setRenaming(undefined)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>重命名任务</DialogTitle></DialogHeader>
          <Input
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && renaming && renameTitle.trim()) {
                void saveRename();
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenaming(undefined)}>
              取消
            </Button>
            <Button type="button" onClick={() => void saveRename()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TaskRow({
  conversation,
  active,
  nested = false,
  onOpen,
  onRemove,
  onRename,
}: {
  conversation: Conversation;
  active: boolean;
  nested?: boolean;
  onOpen: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRename: (conversation: Conversation) => void;
}) {
  return (
    <AlertDialog>
      <div
        className={cn(
          "group/task-row relative flex h-8 items-center rounded-md",
          active && "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
      >
        <button
          type="button"
          onClick={() => void onOpen(conversation.id)}
          className={cn(
            "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex h-8 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md p-2 pr-16 text-left text-sm",
            nested && "pl-8",
          )}
        >
          <span className="truncate font-normal">{conversation.title}</span>
        </button>
        <div className="pointer-events-none absolute top-0.5 right-1 flex items-center opacity-0 transition-opacity duration-300 group-hover/task-row:pointer-events-auto group-hover/task-row:opacity-100 group-focus-within/task-row:pointer-events-auto group-focus-within/task-row:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="重命名任务"
            aria-label="重命名任务"
            onClick={() => onRename(conversation)}
          >
            <Pencil />
          </Button>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="删除任务"
              aria-label="删除任务"
              className="hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
        </div>
      </div>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除这个任务？</AlertDialogTitle>
          <AlertDialogDescription>
            对话记录会被永久删除；如果使用临时 Workspace，其中的文件也会一并清理。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => void onRemove(conversation.id)}
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const tokenFormatter = new Intl.NumberFormat("en-US");

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

function formatTps(tokensPerSecond: number): string {
  return tokensPerSecond >= 100
    ? Math.round(tokensPerSecond).toString()
    : tokensPerSecond.toFixed(1);
}

function DetailRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span
        title={value}
        className={cn(
          "text-foreground min-w-0 truncate tabular-nums hover:overflow-x-auto",
          strong && "font-semibold",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function FadeStreamText({ text }: { text: string }) {
  return (
    <>
      {fadeTokens(text).map((part, index) =>
        isFadeSpace(part) ? (
          part
        ) : (
          <span key={index} className="token-in">
            {part}
          </span>
        ),
      )}
    </>
  );
}

function messageStatus(status: AppMessage["status"]): string {
  if (status === "waiting_approval") return "等待审批";
  if (status === "streaming" || status === "pending") return "生成中";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return "已完成";
}

function MessageMetadata({
  message,
  providerName,
}: {
  message: AppMessage;
  providerName?: string;
}) {
  const now = useRelativeNow();
  const usage = message.usage;
  const durationMs =
    message.completedAt === undefined
      ? null
      : Math.max(0, message.completedAt - message.createdAt);
  const firstTokenMs =
    message.firstTokenAt === undefined
      ? null
      : Math.max(0, message.firstTokenAt - message.createdAt);
  const generationMs =
    message.completedAt === undefined || message.firstTokenAt === undefined
      ? null
      : Math.max(0, message.completedAt - message.firstTokenAt);
  const tokensPerSecond =
    usage?.outputTokens != null && generationMs != null && generationMs > 0
      ? usage.outputTokens / (generationMs / 1_000)
      : null;
  const timestamp = message.completedAt ?? message.createdAt;
  const exactTime = new Date(timestamp).toLocaleString("zh-CN");
  return (
    <div className="flex min-h-6 items-center">
      <div className="text-muted-foreground flex translate-y-0.5 items-center gap-1 opacity-0 transition-[opacity,translate] duration-200 ease-out group-hover/message:translate-y-0 group-hover/message:opacity-100 group-focus-within/message:translate-y-0 group-focus-within/message:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100">
        <time dateTime={new Date(timestamp).toISOString()} title={exactTime} className="px-1 text-[11px] tabular-nums">
          {message.status === "streaming" || message.status === "pending"
            ? "正在生成"
            : formatRelativeTime(timestamp, now)}
        </time>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            aria-label="消息详情"
            title="消息详情"
          >
            <Info className="size-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 gap-0 p-0">
          <div className="border-b px-3 py-2 text-xs font-semibold">消息详情</div>
          <div className="flex flex-col gap-1.5 px-3 py-2.5">
            <DetailRow label="状态" value={messageStatus(message.status)} />
            <DetailRow
              label={message.role === "user" ? "发送时间" : "生成时间"}
              value={exactTime}
            />
            {message.modelId && <DetailRow label="模型" value={message.modelId} />}
            {providerName && <DetailRow label="供应商" value={providerName} />}
            {usage && (
              <>
                {usage.inputTokens != null && (
                  <DetailRow
                    label="输入"
                    value={`${tokenFormatter.format(usage.inputTokens)} tokens`}
                  />
                )}
                {usage.cachedInputTokens != null && usage.cachedInputTokens > 0 && (
                  <DetailRow
                    label="其中缓存命中"
                    value={`${tokenFormatter.format(usage.cachedInputTokens)} tokens`}
                  />
                )}
                {usage.cacheWriteTokens != null && usage.cacheWriteTokens > 0 && (
                  <DetailRow
                    label="缓存写入"
                    value={`${tokenFormatter.format(usage.cacheWriteTokens)} tokens`}
                  />
                )}
                {usage.outputTokens != null && (
                  <DetailRow
                    label="输出"
                    value={`${tokenFormatter.format(usage.outputTokens)} tokens`}
                  />
                )}
                {usage.reasoningTokens != null && usage.reasoningTokens > 0 && (
                  <DetailRow
                    label="其中推理"
                    value={`${tokenFormatter.format(usage.reasoningTokens)} tokens`}
                  />
                )}
                {usage.totalTokens != null && (
                  <DetailRow
                    label="总计"
                    value={`${tokenFormatter.format(usage.totalTokens)} tokens`}
                    strong
                  />
                )}
              </>
            )}
            {tokensPerSecond != null && (
              <DetailRow label="生成速度" value={`${formatTps(tokensPerSecond)} tokens/s`} />
            )}
            {firstTokenMs != null && (
              <DetailRow label="首字延迟" value={formatDuration(firstTokenMs)} />
            )}
            {durationMs != null && (
              <DetailRow label="总耗时" value={formatDuration(durationMs)} />
            )}
            {generationMs != null && (
              <DetailRow label="纯生成耗时" value={formatDuration(generationMs)} />
            )}
            {message.runId && <DetailRow label="运行" value={message.runId} />}
          </div>
        </PopoverContent>
      </Popover>
      </div>
    </div>
  );
}

type ToolCallPart = Extract<AppMessage["parts"][number], { type: "tool-call" }>;

function toolVerb(call: ToolCallPart): string {
  const value = typeof call.input === "object" && call.input !== null ? call.input : {};
  const path = Reflect.get(value, "path");
  const command = Reflect.get(value, "command");
  if (call.toolName === "readFile") return `读取 ${typeof path === "string" ? path : "文件"}`;
  if (call.toolName === "listFiles") return "查看文件列表";
  if (call.toolName === "searchFiles") return "搜索工作区";
  if (call.toolName === "writeFile") return `写入 ${typeof path === "string" ? path : "文件"}`;
  if (call.toolName === "replaceText") return `修改 ${typeof path === "string" ? path : "文件"}`;
  if (call.toolName === "runCommand") return `运行 ${typeof command === "string" ? command : "命令"}`;
  if (call.toolName === "listSkills") return "查看可用技能";
  if (call.toolName === "readSkill") return "读取技能说明";
  return call.toolName;
}

function toolGroupSummary(calls: ToolCallPart[]): string {
  const running = calls.some((call) => call.status === "running");
  if (calls.length === 1) {
    const call = calls[0]!;
    if (call.status === "approval") return `${toolVerb(call)} · 等待授权`;
    if (call.status === "denied") return `${toolVerb(call)} · 已拒绝`;
    if (call.status === "failed") return `${toolVerb(call)} · 失败`;
  }
  const commands = calls.filter((call) => call.toolName === "runCommand").length;
  const tools = calls.length - commands;
  const parts = [
    commands > 0 ? `${running ? "正在运行" : "运行了"} ${commands} 个命令` : "",
    tools > 0 ? `${running ? "正在使用" : "使用了"} ${tools} 个工具` : "",
  ].filter(Boolean);
  return `${parts.join(" 并 ")}${running ? "…" : ""}`;
}

function toolGroups(parts: AppMessage["parts"]): Map<string, ToolCallPart[]> {
  const groups = new Map<string, ToolCallPart[]>();
  let current: ToolCallPart[] | undefined;
  for (const part of parts) {
    if (part.type === "tool-call") {
      const isolated = part.status === "approval" || part.status === "denied" || part.status === "failed";
      if (!isolated) {
        current ??= [];
        current.push(part);
        groups.set(part.toolCallId, current);
      } else {
        current = undefined;
        groups.set(part.toolCallId, [part]);
      }
    } else if (part.type === "text" || part.type === "reasoning" || part.type === "error") {
      current = undefined;
    }
  }
  return groups;
}

function ToolTimeline({
  calls,
  parts,
  approvals,
  onResolveApproval,
}: {
  calls: ToolCallPart[];
  parts: AppMessage["parts"];
  approvals: ApprovalRecord[];
  onResolveApproval: (approvalId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  const first = calls[0]!;
  const running = calls.some((call) => call.status === "running");
  const failed = calls.some((call) => call.status === "failed");
  const waiting = calls.some((call) => call.status === "approval");
  return (
    <Collapsible key={waiting ? "waiting" : "settled"} defaultOpen={waiting}>
      <div className="text-xs">
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group/tool flex min-h-8 w-full items-center gap-2 text-left transition-colors">
          <span className={cn("grid size-4 shrink-0 place-items-center", failed && "text-destructive", waiting && "text-amber-500")}>
            {running ? <Loader2 className="size-3 animate-spin" /> : <ToolIcon name={first.toolName} className="size-3" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{toolGroupSummary(calls)}</span>
          <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-[opacity,rotate] group-hover/tool:opacity-100 group-data-[state=open]/tool:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pb-2 pl-6">
          <div className="space-y-2 pt-0.5">
            {calls.map((call) => {
              const result = parts.find(
                (part): part is Extract<AppMessage["parts"][number], { type: "tool-result" }> =>
                  part.type === "tool-result" && part.toolCallId === call.toolCallId,
              );
              const diff = parts.find(
                (part): part is Extract<AppMessage["parts"][number], { type: "diff" }> =>
                  part.type === "diff" && part.toolCallId === call.toolCallId,
              );
              const approval = approvals.find(
                (item) => item.toolCallId === call.toolCallId && item.status === "pending",
              );
              const duration = call.startedAt !== undefined && call.completedAt !== undefined
                ? formatDuration(Math.max(0, call.completedAt - call.startedAt))
                : undefined;
              return (
                <div key={call.toolCallId} className="space-y-1.5">
                  {calls.length > 1 && (
                    <div className="flex items-center gap-2 text-[11px]">
                      <ToolIcon name={call.toolName} className="text-muted-foreground size-3" />
                      <span className="min-w-0 flex-1 truncate">{toolVerb(call)}</span>
                      {duration && <span className="text-muted-foreground tabular-nums">{duration}</span>}
                    </div>
                  )}
                  <details className="text-muted-foreground text-[10px]">
                    <summary className="hover:text-foreground cursor-pointer select-none">调用详情</summary>
                    <div className="mt-1 grid gap-1.5">
                      <pre className="bg-muted max-h-36 overflow-auto rounded-md p-2 whitespace-pre-wrap">{formatValue(call.input)}</pre>
                      {result && <pre className={cn("bg-muted max-h-48 overflow-auto rounded-md p-2 whitespace-pre-wrap", result.isError && "text-destructive")}>{formatValue(result.output)}</pre>}
                      {diff && <p>{diff.omitted ? `Diff 过大，已省略（${diff.bytes ?? 0} bytes）` : `已生成 ${diff.path} 的 Diff`}</p>}
                      <span>工具：{call.toolName}{duration ? ` · ${duration}` : ""}</span>
                    </div>
                  </details>
                  {approval && <ApprovalActions approval={approval} onResolve={onResolveApproval} showInput />}
                </div>
              );
            })}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

const Message = memo(function Message({
  message,
  providerName,
  approvals,
  onResolveApproval,
}: {
  message: AppMessage;
  providerName?: string;
  approvals: ApprovalRecord[];
  onResolveApproval: (approvalId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  const tailPart = message.parts.at(-1);
  const streamingTail =
    message.status === "streaming" || message.status === "pending"
      ? tailPart
      : undefined;
  const hasVisiblePart = message.parts.some(
    (part) =>
      (part.type === "text" && part.text !== "") ||
      (part.type === "reasoning" && part.text !== "") ||
      part.type === "tool-call" ||
      part.type === "error",
  );
  const groups = toolGroups(message.parts);
  return (
    <article
      tabIndex={0}
      data-message-id={message.id}
      className={cn(
        "group/message animate-in fade-in slide-in-from-bottom-1 flex min-w-0 flex-col gap-2 text-sm leading-7 outline-none duration-300",
        message.role === "user" && "bg-muted ml-auto max-w-[70%] rounded-xl px-3 py-2.5",
      )}
    >
      {message.parts.map((part, index) => {
        if (part.type === "text" && part.text !== "") {
          return message.role === "assistant" ? (
            <Markdown
              key={`text-${index}`}
              content={part.text}
              streaming={part === streamingTail}
            />
          ) : (
            <p key={`text-${index}`} className="px-1 whitespace-pre-wrap select-text">
              {part.text}
            </p>
          );
        }
        if (part.type === "reasoning" && part.text !== "") {
          return (
            <Collapsible
              key={`reasoning-${index}`}
              defaultOpen={message.status === "streaming" || message.status === "pending"}
            >
              <div className="border-border/60 bg-muted/30 rounded-lg border text-xs">
                <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-2.5 py-1.5 font-medium">
                  <ChevronRight className="size-3.5" />
                  思考过程
                </CollapsibleTrigger>
                <CollapsibleContent className="text-muted-foreground border-border/60 border-t px-2.5 py-2 leading-relaxed whitespace-pre-wrap select-text">
                  {part === streamingTail ? (
                    <FadeStreamText text={part.text} />
                  ) : (
                    part.text
                  )}
                </CollapsibleContent>
              </div>
            </Collapsible>
          );
        }
        if (part.type === "tool-call") {
          const group = groups.get(part.toolCallId) ?? [part];
          if (group[0]?.toolCallId !== part.toolCallId) return null;
          return (
            <ToolTimeline
              key={part.toolCallId}
              calls={group}
              parts={message.parts}
              approvals={approvals}
              onResolveApproval={onResolveApproval}
            />
          );
        }
        if (part.type === "error") {
          return (
            <p key={`error-${index}`} className="text-destructive mt-2 text-sm">
              {part.message}
            </p>
          );
        }
        return null;
      })}
      {!hasVisiblePart && (message.status === "streaming" || message.status === "pending") && (
        <p className="text-muted-foreground flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> 正在生成
        </p>
      )}
      <MessageMetadata message={message} providerName={providerName} />
    </article>
  );
});

function AgentPanel({
  activeId,
  messages,
  workspace,
  onClose,
}: {
  activeId?: string;
  messages: AppMessage[];
  workspace?: WorkspaceInfo;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [fileError, setFileError] = useState("");
  const parts = messages.flatMap((message) => message.parts);
  const diffs = parts.filter(
    (part): part is Extract<(typeof parts)[number], { type: "diff" }> =>
      part.type === "diff",
  );

  useEffect(() => {
    setFiles([]);
    setSelectedFile("");
    setFileContent("");
    if (!activeId || !workspace) return;
    void window.tietiezhi.workspace.listFiles(activeId).then(setFiles).catch(() => setFiles([]));
  }, [activeId, workspace, diffs.length]);

  useEffect(() => {
    const width = Number(window.localStorage.getItem("workspace-panel-width-v2"));
    if (Number.isFinite(width) && width >= 300 && width <= 560) {
      panelRef.current?.style.setProperty("width", `${width}px`);
    }
  }, []);

  const beginPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !panelRef.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = panelRef.current.getBoundingClientRect().width;
    let width = startWidth;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      width = Math.min(560, Math.max(300, startWidth + startX - moveEvent.clientX));
      panelRef.current?.style.setProperty("width", `${width}px`);
    };
    const finish = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
      window.localStorage.setItem("workspace-panel-width-v2", String(Math.round(width)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
  };

  const resetPanelWidth = () => {
    panelRef.current?.style.setProperty("width", "360px");
    window.localStorage.setItem("workspace-panel-width-v2", "360");
  };

  const openFile = async (path: string) => {
    if (!activeId) return;
    setSelectedFile(path);
    setFileError("");
    try {
      setFileContent(await window.tietiezhi.workspace.readFile(activeId, path));
    } catch (cause) {
      setFileContent("");
      setFileError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <aside
      ref={panelRef}
      aria-label="工作区文件与变更"
      className="bg-background relative flex min-h-0 w-90 min-w-75 max-w-[48vw] shrink-0 flex-col border-l"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整工作区面板宽度"
        title="拖动调整宽度，双击恢复默认"
        onPointerDown={beginPanelResize}
        onDoubleClick={resetPanelWidth}
        className="group absolute inset-y-0 -left-1 z-30 w-2 touch-none cursor-col-resize before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-ring/70"
      />
      <Tabs defaultValue={diffs.length > 0 ? "changes" : "files"} className="min-h-0 flex-1 gap-0">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <FolderOpen className="text-muted-foreground size-4 shrink-0" />
          <span className="text-sm font-medium">工作区</span>
          <span className="text-muted-foreground text-xs">文件与变更</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={onClose}
            aria-label="收起工作区面板"
          >
            <PanelRightClose />
          </Button>
        </div>
        <div className="flex h-10 shrink-0 items-center border-b px-3">
          <TabsList variant="line" className="h-9 min-w-0 flex-1 justify-start">
            <TabsTrigger value="changes">
              变更 {diffs.length > 0 && <Badge variant="secondary">{diffs.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="files">文件</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="changes" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-3 p-3">
              {diffs.length === 0 ? <EmptyPanel text="Agent 修改文件后会显示逐行变更" /> : diffs.map((diff, index) => (
                <Card key={`${diff.toolCallId}-${index}`} size="sm">
                  <CardHeader><CardTitle className="font-mono text-xs">{diff.path}</CardTitle></CardHeader>
                  <CardContent>
                    {diff.omitted ? (
                      <p className="text-muted-foreground text-xs">
                        文件较大（{formatBytes(diff.bytes ?? 0)}），已省略逐行 Diff。
                      </p>
                    ) : (
                      <LineDiff before={diff.before} after={diff.after} />
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="files" className="min-h-0">
          <div className="grid h-full min-h-0 grid-rows-[minmax(8rem,40%)_minmax(0,1fr)]">
            <ScrollArea className="border-b">
              <div className="p-2">
                {files.length === 0 ? <EmptyPanel text="Workspace 中暂无可预览文件" /> : files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    disabled={file.type === "directory"}
                    onClick={() => void openFile(file.path)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
                      file.type === "directory" && "text-muted-foreground",
                      selectedFile === file.path && "bg-muted",
                    )}
                  >
                    {file.type === "directory" ? <Folder className="size-3.5" /> : <FileCode2 className="size-3.5" />}
                    <span className="truncate">{file.path}</span>
                  </button>
                ))}
              </div>
            </ScrollArea>
            <ScrollArea>
              <div className="p-3">
                {fileError ? <p className="text-destructive text-xs">{fileError}</p> : selectedFile ? (
                  <>
                    <p className="text-muted-foreground mb-2 font-mono text-[10px]">{selectedFile}</p>
                    <pre className="select-text whitespace-pre-wrap break-words font-mono text-[10px] leading-4">{fileContent}</pre>
                  </>
                ) : <EmptyPanel text="选择文件以预览内容" />}
              </div>
            </ScrollArea>
          </div>
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-xs">{text}</p>;
}

function LineDiff({ before, after }: { before: string; after: string }) {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  const rows = [
    ...oldLines.slice(0, prefix).map((text, index) => ({ kind: "same", text, line: index + 1 })),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((text, index) => ({ kind: "remove", text, line: prefix + index + 1 })),
    ...newLines.slice(prefix, newLines.length - suffix).map((text, index) => ({ kind: "add", text, line: prefix + index + 1 })),
    ...newLines.slice(newLines.length - suffix).map((text, index) => ({ kind: "same", text, line: newLines.length - suffix + index + 1 })),
  ];
  return (
    <pre className="max-h-80 overflow-auto rounded-md border font-mono text-[10px] leading-4">
      {rows.map((row, index) => (
        <div key={`${row.kind}-${row.line}-${index}`} className={cn("grid grid-cols-[2.5rem_1rem_minmax(0,1fr)] px-2", row.kind === "remove" && "bg-destructive/10 text-destructive", row.kind === "add" && "bg-emerald-500/10 text-emerald-500")}>
          <span className="text-muted-foreground text-right">{row.line}</span>
          <span className="text-center">{row.kind === "remove" ? "-" : row.kind === "add" ? "+" : " "}</span>
          <span>{row.text || " "}</span>
        </div>
      ))}
    </pre>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function ToolIcon({ name, className }: { name: string; className?: string }) {
  if (name === "runCommand") return <TerminalSquare className={className} />;
  if (name === "listSkills" || name === "readSkill") {
    return <Sparkles className={className} />;
  }
  return <FileCode2 className={className} />;
}
