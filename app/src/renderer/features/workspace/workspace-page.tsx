import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { AppIcon, type AppIconName } from "@/components/app-icon";
import { cn } from "@/lib/utils";
import type {
  AgentDefinition,
  AgentEvent,
  AgentGroup,
  AgentPreset,
  AuthStatus,
  CreateAgentInput,
  CreateAgentGroupInput,
  Conversation,
  ConversationDetail,
  Message,
  Workspace,
} from "@shared/contracts";

interface WorkspacePageProps {
  auth: AuthStatus;
  onAuthChange: (status: AuthStatus) => void;
  onLogout: () => Promise<void>;
}

const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_COLLAPSE_THRESHOLD = 140;

interface AgentStreamState {
  text: string;
  running: boolean;
}

type AgentArea = "agents" | "chat" | "workflow" | "tasks" | "projects" | "im" | "knowledge";

interface AgentAreaInfo {
  title: string;
  eyebrow: string;
  description: string;
  icon: AppIconName;
  actionLabel: string;
}

const AGENT_AREA_INFO: Record<AgentArea, AgentAreaInfo> = {
  agents: {
    title: "智能体",
    eyebrow: "WAKERS",
    description: "管理长期协作的数字员工，为每个角色配置独立的对话和工作上下文。",
    icon: "users",
    actionLabel: "创建智能体",
  },
  chat: {
    title: "对话",
    eyebrow: "CHAT",
    description: "和智能体私聊，或从一个任务开始一段可持续的协作。",
    icon: "message-square",
    actionLabel: "新建对话",
  },
  workflow: {
    title: "流程",
    eyebrow: "WAKERFLOW",
    description: "把多个智能体编排成可重复运行的工作流。",
    icon: "workflow",
    actionLabel: "创建流程",
  },
  tasks: {
    title: "任务",
    eyebrow: "BOARD",
    description: "集中查看待处理、进行中和已完成的工作。",
    icon: "kanban",
    actionLabel: "新建任务",
  },
  projects: {
    title: "公开项目",
    eyebrow: "PROJECTS",
    description: "浏览可复用的智能体、技能和工作流项目。",
    icon: "folder",
    actionLabel: "添加项目",
  },
  im: {
    title: "即时通讯",
    eyebrow: "IM",
    description: "将智能体接入团队常用的通讯渠道。",
    icon: "message-circle",
    actionLabel: "配置渠道",
  },
  knowledge: {
    title: "知识",
    eyebrow: "KNOWLEDGE",
    description: "维护智能体可以检索和持续学习的知识包。",
    icon: "book-open",
    actionLabel: "添加知识",
  },
};

export function WorkspacePage({ auth, onAuthChange, onLogout }: WorkspacePageProps) {
  const [agentProfiles, setAgentProfiles] = useState<AgentDefinition[]>([]);
  const [agentPresets, setAgentPresets] = useState<AgentPreset[]>([]);
  const [agentGroups, setAgentGroups] = useState<AgentGroup[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [area, setArea] = useState<AgentArea>("agents");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<ConversationDetail>();
  const [pendingWorkspace, setPendingWorkspace] = useState<Workspace>();
  const [pendingTemporary, setPendingTemporary] = useState(false);
  const [pendingGroupId, setPendingGroupId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [agentStreams, setAgentStreams] = useState<Record<string, AgentStreamState>>({});
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.localStorage.getItem("workspace-sidebar-open") !== "false",
  );
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarOpenTargetRef = useRef<number | undefined>(undefined);
  const activeConversationIdRef = useRef<string | undefined>(undefined);
  const promptGenerationRef = useRef(new Map<string, number>());
  const persistedGenerationRef = useRef(new Set<string>());

  activeConversationIdRef.current = active?.conversation.id;

  const projects = useMemo(
    () => workspaces.filter((workspace) => workspace.kind === "project"),
    [workspaces],
  );
  const temporaryWorkspaces = useMemo(
    () => workspaces.filter(
      (workspace) => workspace.kind === "temporary" &&
        conversations.some((conversation) => conversation.workspaceId === workspace.id),
    ),
    [conversations, workspaces],
  );
  const conversationsByWorkspace = useMemo(() => {
    const groups = new Map<string, Conversation[]>();
    for (const conversation of conversations) {
      const group = groups.get(conversation.workspaceId) ?? [];
      group.push(conversation);
      groups.set(conversation.workspaceId, group);
    }
    return groups;
  }, [conversations]);
  const hasPendingConversation = pendingTemporary || pendingWorkspace !== undefined;

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
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "b" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      setSidebarOpen((current) => !current);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const refresh = async () => {
    const [nextAgents, nextPresets, nextGroups, nextWorkspaces, nextConversations] = await Promise.all([
      window.tietiezhi.agentProfiles.list(),
      window.tietiezhi.agentProfiles.presets(),
      window.tietiezhi.agentGroups.list(),
      window.tietiezhi.workspaces.list(),
      window.tietiezhi.conversations.list(),
    ]);
    setAgentProfiles(nextAgents);
    setAgentPresets(nextPresets);
    setAgentGroups(nextGroups);
    setAgentsLoaded(true);
    setSelectedAgentId((current) => current ?? nextAgents[0]?.id);
    setWorkspaces(nextWorkspaces);
    setConversations(nextConversations.filter((conversation) => (conversation.messageCount ?? 0) > 0));
  };

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);

  useEffect(() => {
    const unsubscribe = window.tietiezhi.agents.onEvent((event) => {
      handleAgentEvent(event);
    });
    return unsubscribe;
  }, []);

  const handleAgentEvent = (event: AgentEvent) => {
    if (event.type === "session_started") {
      setAgentStreams((current) => {
        const previous = current[event.conversationId];
        return {
          ...current,
          [event.conversationId]: {
            text: previous?.text ?? "",
            running: true,
          },
        };
      });
      return;
    }

    if (event.type === "assistant_text_delta") {
      setAgentStreams((current) => {
        const previous = current[event.conversationId] ?? { text: "", running: true };
        return {
          ...current,
          [event.conversationId]: {
            text: previous.text + event.delta,
            running: true,
          },
        };
      });
      return;
    }

    if (event.type === "session_error") {
      setAgentStreams((current) => ({
        ...current,
        [event.conversationId]: {
          ...(current[event.conversationId] ?? { text: "" }),
          running: false,
        },
      }));
      if (activeConversationIdRef.current === event.conversationId) setError(event.message);
      return;
    }

    if (event.type === "session_stopped") {
      setAgentStreams((current) => ({
        ...current,
        [event.conversationId]: {
          ...(current[event.conversationId] ?? { text: "" }),
          running: false,
        },
      }));
      return;
    }

    const generation = promptGenerationRef.current.get(event.conversationId) ?? 0;
    const completionKey = `${event.conversationId}:${generation}`;
    if (persistedGenerationRef.current.has(completionKey)) return;
    persistedGenerationRef.current.add(completionKey);
    setAgentStreams((current) => ({
      ...current,
      [event.conversationId]: { text: event.text, running: false },
    }));
    if (!event.text.trim()) return;

    void (async () => {
      try {
        const message = await window.tietiezhi.conversations.appendMessage({
          conversationId: event.conversationId,
          role: "assistant",
          parts: [{ type: "text", text: event.text }],
        });
        if (activeConversationIdRef.current === event.conversationId) {
          setActive((current) => current
            ? { ...current, messages: [...current.messages, message] }
            : current);
        }
        const [nextWorkspaces, nextConversations] = await Promise.all([
          window.tietiezhi.workspaces.list(),
          window.tietiezhi.conversations.list(),
        ]);
        setWorkspaces(nextWorkspaces);
        setConversations(nextConversations.filter((conversation) => (conversation.messageCount ?? 0) > 0));
      } catch (cause: unknown) {
        persistedGenerationRef.current.delete(completionKey);
        if (
          promptGenerationRef.current.get(event.conversationId) === generation &&
          activeConversationIdRef.current === event.conversationId
        ) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        setAgentStreams((current) => {
          if (promptGenerationRef.current.get(event.conversationId) !== generation) return current;
          return {
            ...current,
            [event.conversationId]: { text: "", running: false },
          };
        });
      }
    })();
  };

  const openConversation = async (id: string) => {
    setError("");
    setArea("chat");
    try {
      setPendingWorkspace(undefined);
      setPendingTemporary(false);
      setPendingGroupId(undefined);
      const detail = await window.tietiezhi.conversations.load(id);
      setSelectedAgentId(detail.conversation.agentId);
      setActive(detail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const beginPendingConversation = (workspace?: Workspace, agentId = selectedAgentId) => {
    setError("");
    setArea("chat");
    setActive(undefined);
    setSelectedAgentId(agentId);
    setPendingWorkspace(workspace);
    setPendingTemporary(workspace === undefined);
    setPendingGroupId(undefined);
  };

  const beginPendingGroupConversation = (group: AgentGroup) => {
    setError("");
    setArea("chat");
    setActive(undefined);
    setSelectedAgentId(group.agentIds[0]);
    setPendingWorkspace(undefined);
    setPendingTemporary(true);
    setPendingGroupId(group.id);
  };

  const addProject = async () => {
    setError("");
    try {
      const workspace = await window.tietiezhi.workspaces.chooseProject();
      if (!workspace) return;
      await refresh();
      beginPendingConversation(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createTemporaryTask = async () => {
    setError("");
    beginPendingConversation();
  };

  const createAgent = async (input: CreateAgentInput) => {
    setError("");
    try {
      const agent = await window.tietiezhi.agentProfiles.create(input);
      setAgentProfiles((current) => [agent, ...current]);
      setSelectedAgentId(agent.id);
      beginPendingConversation(undefined, agent.id);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  const createGroup = async (input: CreateAgentGroupInput) => {
    setError("");
    try {
      const group = await window.tietiezhi.agentGroups.create(input);
      setAgentGroups((current) => [group, ...current]);
      setCreateGroupOpen(false);
      beginPendingGroupConversation(group);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  const setAvatar = async () => {
    const current = auth.profile?.avatar ?? defaultAvatarURL(auth);
    const value = window.prompt("输入 HTTPS 头像图片 URL，留空恢复默认头像", current);
    if (value === null) return;
    setError("");
    try {
      onAuthChange(await window.tietiezhi.auth.setAvatar(value.trim() || null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const resetAvatar = async () => {
    setError("");
    try {
      onAuthChange(await window.tietiezhi.auth.setAvatar(null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const logout = async () => {
    setError("");
    try {
      await onLogout();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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

  const send = async () => {
    const text = draft.trim();
    if ((!active && !hasPendingConversation) || !text || busy) return;
    const existing = active;
    const selectedWorkspace = pendingWorkspace;
    const needsTemporaryWorkspace = pendingTemporary && selectedWorkspace === undefined;
    let conversationId: string | undefined;
    setBusy(true);
    setError("");
    try {
      const workspace = existing?.workspace ?? selectedWorkspace ?? (
        needsTemporaryWorkspace
          ? await window.tietiezhi.workspaces.createTemporary()
          : undefined
      );
      if (!workspace) throw new Error("没有选择 Workspace");
      const agentId = existing?.conversation.agentId ?? selectedAgentId;
      const groupId = existing?.conversation.groupId ?? pendingGroupId;
      const detail = existing ?? await window.tietiezhi.conversations.create({
        workspaceId: workspace.id,
        agentId,
        groupId,
      });
      const nextConversationId = detail.conversation.id;
      conversationId = nextConversationId;
      const generation = (promptGenerationRef.current.get(nextConversationId) ?? 0) + 1;
      promptGenerationRef.current.set(nextConversationId, generation);
      setAgentStreams((current) => ({
        ...current,
        [nextConversationId]: { text: "", running: true },
      }));
      const message = await window.tietiezhi.conversations.appendMessage({
        conversationId: nextConversationId,
        role: "user",
        parts: [{ type: "text", text }],
      });
      const title = detail.messages.length === 0
        ? await window.tietiezhi.conversations.rename(nextConversationId, text.slice(0, 32))
        : detail.conversation;
      setActive({
        ...detail,
        conversation: title,
        messages: [...detail.messages, message],
      });
      setPendingWorkspace(undefined);
      setPendingTemporary(false);
      setPendingGroupId(undefined);
      setDraft("");
      await refresh();
      await window.tietiezhi.agents.start({
        conversationId: nextConversationId,
        workspaceId: workspace.id,
        agentId,
        groupId,
      });
      await window.tietiezhi.agents.prompt({ conversationId: nextConversationId, text });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (conversationId) {
        setAgentStreams((current) => ({
          ...current,
          [conversationId as string]: {
            ...(current[conversationId as string] ?? { text: "" }),
            running: false,
          },
        }));
      }
    } finally {
      setBusy(false);
    }
  };

  if (!agentsLoaded) {
    return (
      <div className="bg-background/60 grid h-full place-items-center backdrop-blur-2xl">
        <AppIcon name="loader-2" className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  if (agentProfiles.length === 0) {
    return (
      <AgentOnboarding
        presets={agentPresets}
        error={error}
        onCreate={async (input) => {
          await createAgent(input).catch(() => undefined);
        }}
      />
    );
  }

  return (
    <div className="relative isolate flex h-full min-h-0 bg-background">
      <AgentRail active={area} onChange={setArea} />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <nav
          aria-label="模式栏"
          className="relative z-[100] flex h-12 shrink-0 items-center border-b border-border/60 bg-background/90 px-3 [-webkit-app-region:drag]"
        >
          <div className="relative pointer-events-auto flex items-center px-2 [-webkit-app-region:no-drag]">
            <AgentProductBadge />
          </div>
        </nav>

      <div className="relative flex min-h-0 flex-1 bg-background">
        <aside
          ref={sidebarRef}
          aria-hidden={!sidebarOpen}
          inert={!sidebarOpen}
          className={cn(
            "@container/sidebar text-sidebar-foreground relative flex w-64 shrink-0 flex-col overflow-visible border-r border-border/60 bg-sidebar/85 transition-[width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
            sidebarOpen
              ? "opacity-100"
              : "pointer-events-none opacity-0",
          )}
        >
        <div className="flex gap-1 p-2">
          <Button
            type="button"
            variant="ghost"
            className="min-w-0 flex-1 justify-start text-xs"
            onClick={() => void createTemporaryTask()}
          >
            <AppIcon name="message-square-plus" /> 新建对话
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            title="创建群聊"
            aria-label="创建群聊"
            onClick={() => setCreateGroupOpen(true)}
          >
            <AppIcon name="users" />
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 px-2">
          <div className="space-y-4 pb-3">
            <SidebarSection
              title="我的智能体"
              actionLabel="创建智能体"
              onAction={() => setCreateAgentOpen(true)}
            >
              {agentProfiles.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  selected={selectedAgentId === agent.id && !active}
                  onOpen={() => beginPendingConversation(undefined, agent.id)}
                />
              ))}
            </SidebarSection>

            <SidebarSection title="群聊" actionLabel="创建群聊" onAction={() => setCreateGroupOpen(true)}>
              {agentGroups.length === 0 ? (
                <EmptyRow icon="users" label="创建一个群聊" onClick={() => setCreateGroupOpen(true)} />
              ) : agentGroups.map((group) => (
                <GroupRow
                  key={group.id}
                  group={group}
                  agents={agentProfiles}
                  active={active?.conversation.groupId === group.id}
                  onOpen={() => beginPendingGroupConversation(group)}
                />
              ))}
            </SidebarSection>

            <SidebarSection title="最近">
              {conversations.length === 0 ? (
                <p className="text-muted-foreground px-2 py-2 text-xs">还没有对话</p>
              ) : conversations.slice(0, 12).map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={active?.conversation.id === conversation.id}
                  onOpen={() => void openConversation(conversation.id)}
                  leading={conversation.groupId
                    ? agentGroups.find((group) => group.id === conversation.groupId)?.name
                    : agentProfiles.find((agent) => agent.id === conversation.agentId)?.name}
                />
              ))}
            </SidebarSection>

            <SidebarSection
              title="项目上下文"
              actionLabel="添加项目"
              onAction={() => void addProject()}
            >
              {projects.length === 0 ? (
                <EmptyRow icon="folder" label="添加一个项目文件夹" onClick={() => void addProject()} />
              ) : projects.map((workspace) => (
                <WorkspaceGroup
                  key={workspace.id}
                  workspace={workspace}
                  conversations={conversationsByWorkspace.get(workspace.id) ?? []}
                  activeId={active?.conversation.id}
                  onCreate={() => beginPendingConversation(workspace)}
                  onOpen={(id) => void openConversation(id)}
                />
              ))}
              {temporaryWorkspaces.length > 0 && (
                <p className="text-muted-foreground px-2 pt-2 text-[11px]">
                  {temporaryWorkspaces.length} 个临时工作目录由对话自动管理
                </p>
              )}
            </SidebarSection>
          </div>
        </ScrollArea>

        <UserMenu
          auth={auth}
          onSetAvatar={() => void setAvatar()}
          onResetAvatar={() => void resetAvatar()}
          onLogout={() => void logout()}
        />
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          onPointerDown={beginSidebarResize}
          onDoubleClick={resetSidebarWidth}
          className="group absolute inset-y-0 right-0 z-30 flex w-4 translate-x-2 touch-none select-none cursor-col-resize focus:outline-none"
        >
          <div className="pointer-events-none m-auto h-full w-px bg-gradient-to-b from-transparent via-foreground/25 to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100 group-focus-visible:opacity-100" />
        </div>
        </aside>

        <div className="relative min-h-0 min-w-0 flex-1 p-0">
        <section className="bg-background flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden shadow-none">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-6 [-webkit-app-region:drag]">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {area === "chat" && (active || hasPendingConversation)
                  ? active?.conversation.title ?? "新对话"
                  : AGENT_AREA_INFO[area].title}
              </p>
            </div>
          </header>

        {area === "chat" ? (active || hasPendingConversation ? (
          <>
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
                {!active || active.messages.length === 0 ? (
                  <div className="grid min-h-[40vh] place-items-center text-center">
                    <div>
                      <AppIcon name="message-square" className="text-muted-foreground mx-auto mb-4 size-9" />
                      <h1 className="text-lg font-semibold">开始一段对话</h1>
                      <p className="text-muted-foreground mt-1 text-sm">
                        输入第一条消息后才会创建会话，并交给 Pi Agent 处理。
                      </p>
                    </div>
                  </div>
                ) : active.messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
                {active && agentStreams[active.conversation.id]?.text && (
                  <MessageBubble
                    message={{
                      role: "assistant",
                      parts: [{ type: "text", text: agentStreams[active.conversation.id]?.text ?? "" }],
                    }}
                  />
                )}
                {active && agentStreams[active.conversation.id]?.running && !agentStreams[active.conversation.id]?.text && (
                  <div className="bg-muted text-muted-foreground flex w-fit items-center gap-2 rounded-2xl px-4 py-2.5 text-sm">
                    <AppIcon name="loader-2" className="size-4 animate-spin" />正在生成回复…
                  </div>
                )}
              </div>
            </ScrollArea>
            <div className="mx-auto w-full max-w-3xl px-4 pb-3">
              <div className="text-muted-foreground mb-1 px-1 text-xs">
                Pi Agent · 当前使用 Gateway 中的第一个可用模型
              </div>
              <div className="bg-muted flex items-end gap-2 rounded-2xl p-2">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="发送消息给 Pi Agent…"
                  rows={1}
                  className="max-h-40 min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                />
                <Button
                  type="button"
                  size="icon"
                  className="shrink-0 rounded-xl"
                  disabled={!draft.trim() || busy}
                  onClick={() => void send()}
                  aria-label="发送消息"
                >
                  <AppIcon name="send" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
            <div>
              <img src="/tietiezhi.png" alt="Tietiezhi" className="mx-auto mb-5 size-16 rounded-2xl" />
              <h1 className="text-xl font-semibold">从智能体开始</h1>
              <p className="text-muted-foreground mt-2 max-w-md text-sm">
                选择一个智能体开始私聊，也可以稍后把项目目录作为当前对话的上下文。
              </p>
              <div className="mt-5 flex justify-center gap-2">
                <Button type="button" onClick={() => void createTemporaryTask()}>
                  <AppIcon name="message-square-plus" />新建对话
                </Button>
              </div>
            </div>
          </div>
        )) : area === "agents" ? (
          <AgentDirectory
            agents={agentProfiles}
            conversations={conversations}
            onCreate={() => setCreateAgentOpen(true)}
            onOpen={(agentId) => beginPendingConversation(undefined, agentId)}
          />
        ) : area === "projects" ? (
          <ProjectDirectory
            projects={projects}
            onAdd={() => void addProject()}
            onOpen={(id) => void window.tietiezhi.workspaces.reveal(id)}
          />
        ) : area === "workflow" ? (
          <WorkflowDirectory
            groups={agentGroups}
            agents={agentProfiles}
            onCreate={() => setCreateGroupOpen(true)}
            onRun={beginPendingGroupConversation}
          />
        ) : area === "tasks" ? (
          <TaskBoard
            conversations={conversations}
            agents={agentProfiles}
            groups={agentGroups}
            onCreate={() => void createTemporaryTask()}
            onOpen={(id) => void openConversation(id)}
          />
        ) : (
          <AgentAreaPlaceholder
            area={area}
            onAction={() => {
              setError(`${AGENT_AREA_INFO[area].title}功能正在接入本地数据服务`);
            }}
          />
        )}

        {error && (
          <div className="text-destructive px-5 py-2 text-sm">{error}</div>
        )}
        </section>
        </div>
        <AgentCreationDialog
          open={createAgentOpen}
          presets={agentPresets}
          onOpenChange={setCreateAgentOpen}
          onCreate={createAgent}
        />
        <AgentGroupCreationDialog
          open={createGroupOpen}
          agents={agentProfiles}
          onOpenChange={setCreateGroupOpen}
          onCreate={createGroup}
        />
      </div>
      </div>
    </div>
  );
}

function AgentProductBadge() {
  return (
    <div
      aria-label="当前模式：Agents"
      role="status"
      className="flex h-8 max-w-64 min-w-0 items-center gap-2 px-2 text-left [-webkit-app-region:no-drag]"
    >
      <img
        src="./tietiezhi.png"
        alt=""
        decoding="async"
        draggable={false}
        className="size-6 shrink-0 object-contain"
      />
      <span className="relative grid min-w-0 flex-1 truncate text-sm font-semibold">
        <span className="col-start-1 row-start-1 bg-linear-to-r from-sky-300 via-indigo-400 to-violet-500 bg-clip-text text-transparent">
          Agents
        </span>
      </span>
      <AppIcon
        name="chevron-down"
        aria-hidden="true"
        className="text-muted-foreground size-3.5 shrink-0"
      />
    </div>
  );
}

function defaultAvatarURL(auth: AuthStatus): string {
  return dicebearAvatarURL(profileName(auth), "toon-head");
}

function agentAvatarURL(seed: string): string {
  return dicebearAvatarURL(seed, "bottts-neutral");
}

function dicebearAvatarURL(seed: string, style: "toon-head" | "bottts-neutral"): string {
  const colors = avatarGradientColors(seed);
  const parameters = new URLSearchParams({
    seed,
    backgroundType: "gradientLinear",
    backgroundRotation: String(avatarGradientRotation(seed)),
    radius: "50",
  });
  for (const color of colors) parameters.append("backgroundColor", color);
  return `https://api.dicebear.com/10.x/${style}/svg?${parameters.toString()}`;
}

function avatarHash(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function avatarGradientColors(seed: string): [string, string] {
  const fallback: [string, string] = ["0f172a", "38bdf8"];
  const palettes: Array<[string, string]> = [
    fallback,
    ["111827", "f97316"],
    ["1e1b4b", "a78bfa"],
    ["164e63", "facc15"],
    ["2e1065", "fb7185"],
    ["064e3b", "5eead4"],
    ["312e81", "f9a8d4"],
    ["431407", "fdba74"],
  ];
  return palettes[avatarHash(seed) % palettes.length] ?? fallback;
}

function avatarGradientRotation(seed: string): number {
  return avatarHash(`${seed}:rotation`) % 360;
}

function profileName(auth: AuthStatus): string {
  return auth.profile?.displayName || auth.account?.nickname || auth.account?.email || "Tietiezhi 用户";
}

function profileSubtitle(auth: AuthStatus): string {
  return auth.profile?.email || (auth.mode === "api_key" ? "API Key 登录" : "已登录");
}

function profileInitial(auth: AuthStatus): string {
  return profileName(auth).trim().slice(0, 1).toUpperCase() || "T";
}

function UserMenu({
  auth,
  onSetAvatar,
  onResetAvatar,
  onLogout,
}: {
  auth: AuthStatus;
  onSetAvatar: () => void;
  onResetAvatar: () => void;
  onLogout: () => void;
}) {
  const avatar = auth.profile?.avatar?.trim() || defaultAvatarURL(auth);
  return (
    <div className="p-2 [-webkit-app-region:no-drag]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="hover:bg-sidebar-accent focus-visible:ring-ring flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left outline-none focus-visible:ring-2"
          >
            <Avatar className="size-9 bg-sidebar-accent">
              <AvatarImage src={avatar} alt={profileName(auth)} />
              <AvatarFallback>{profileInitial(auth)}</AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{profileName(auth)}</span>
              <span className="text-muted-foreground block truncate text-xs">{profileSubtitle(auth)}</span>
            </span>
            <AppIcon name="chevron-down" className="text-muted-foreground size-4 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-64">
          <DropdownMenuLabel className="flex min-w-0 items-center gap-2">
            <Avatar className="size-9">
              <AvatarImage src={avatar} alt={profileName(auth)} />
              <AvatarFallback>{profileInitial(auth)}</AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              <span className="block truncate text-sm text-foreground">{profileName(auth)}</span>
              <span className="block truncate text-xs">{profileSubtitle(auth)}</span>
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSetAvatar}>
            <AppIcon name="paintbrush" />设置头像 URL
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onResetAvatar}>
            <AppIcon name="x" />恢复默认头像
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onLogout}>
            <AppIcon name="log-out" />退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SidebarSection({
  title,
  actionLabel,
  onAction,
  children,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4">
      <div className="flex h-8 items-center px-2">
        <span className="text-muted-foreground text-xs font-medium">{title}</span>
        {onAction && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            onClick={onAction}
            aria-label={actionLabel}
          >
            <AppIcon name="plus" />
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

function WorkspaceGroup({
  workspace,
  conversations,
  activeId,
  onCreate,
  onOpen,
}: {
  workspace: Workspace;
  conversations: Conversation[];
  activeId?: string;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div>
      <div className="group flex h-8 items-center rounded-md px-2 hover:bg-sidebar-accent">
        <AppIcon name="folder" className="text-muted-foreground mr-2 size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm">{workspace.name}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100">
              <AppIcon name="more-horizontal" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right">
            <DropdownMenuItem onSelect={onCreate}>
              <AppIcon name="message-square-plus" />新建对话
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void window.tietiezhi.workspaces.reveal(workspace.id)}>
              <AppIcon name="folder-open" />打开文件夹
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100" onClick={onCreate}>
          <AppIcon name="plus" />
        </Button>
      </div>
      <div className="ml-5 flex flex-col gap-0.5">
        {conversations.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            active={activeId === conversation.id}
            onOpen={() => onOpen(conversation.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  onOpen,
  leading,
}: {
  conversation: Conversation;
  active: boolean;
  onOpen: () => void;
  leading?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/70",
      )}
    >
      <AppIcon name="message-square" className="text-muted-foreground size-3.5 shrink-0" />
      <span className="truncate">{leading ? `${leading} · ` : ""}{conversation.title}</span>
    </button>
  );
}

function AgentRow({
  agent,
  selected,
  onOpen,
}: {
  agent: AgentDefinition;
  selected: boolean;
  onOpen: () => void;
}) {
  const avatar = agent.avatar?.trim() || agentAvatarURL(agent.name);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex h-11 min-w-0 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors",
        selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/70",
      )}
    >
      <span className="relative shrink-0">
        <Avatar className="size-8 bg-sidebar-accent">
          <AvatarImage src={avatar} alt="" />
          <AvatarFallback>{agent.name.slice(0, 1)}</AvatarFallback>
        </Avatar>
        <span
          aria-label={agent.availability === "working" ? "工作中" : "在线"}
          className={cn(
            "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar",
            agent.availability === "working" ? "bg-amber-400" : "bg-emerald-400",
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{agent.name}</span>
        <span className="text-muted-foreground block truncate text-[11px]">{agent.role}</span>
      </span>
      <AppIcon name="chevron-right" className="text-muted-foreground size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function GroupRow({
  group,
  agents,
  active,
  onOpen,
}: {
  group: AgentGroup;
  agents: AgentDefinition[];
  active: boolean;
  onOpen: () => void;
}) {
  const members = group.agentIds
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is AgentDefinition => agent !== undefined);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/70",
      )}
    >
      <span className="flex -space-x-2 shrink-0">
        {members.slice(0, 3).map((agent) => (
          <Avatar key={agent.id} className="size-7 border-2 border-sidebar bg-sidebar-accent">
            <AvatarImage src={agent.avatar?.trim() || agentAvatarURL(agent.name)} alt="" />
            <AvatarFallback className="text-[10px]">{agent.name.slice(0, 1)}</AvatarFallback>
          </Avatar>
        ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{group.name}</span>
        <span className="text-muted-foreground block truncate text-[11px]">{members.length} 个智能体协作</span>
      </span>
      <AppIcon name="chevron-right" className="text-muted-foreground size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function EmptyRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: AppIconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:bg-sidebar-accent flex h-9 items-center gap-2 rounded-md px-2 text-left text-xs"
    >
      <AppIcon name={Icon} className="size-4" />{label}
    </button>
  );
}

function AgentRail({
  active,
  onChange,
}: {
  active: AgentArea;
  onChange: (area: AgentArea) => void;
}) {
  const items: Array<{ key: AgentArea; label: string; icon: AppIconName }> = [
    { key: "agents", label: "智能体", icon: "users" },
    { key: "chat", label: "对话", icon: "message-square" },
    { key: "workflow", label: "流程", icon: "workflow" },
    { key: "tasks", label: "任务", icon: "kanban" },
    { key: "projects", label: "公开项目", icon: "folder" },
    { key: "im", label: "IM", icon: "message-circle" },
    { key: "knowledge", label: "知识", icon: "book-open" },
  ];
  return (
    <aside className="hidden w-16 shrink-0 flex-col items-center border-r border-border/60 bg-sidebar md:flex">
      <div className="flex h-12 w-16 shrink-0 items-center justify-center border-b border-border/60">
        <img src="./tietiezhi.png" alt="Tietiezhi" className="size-7 rounded-lg object-contain" />
      </div>
      <nav aria-label="主导航" className="flex w-full flex-col items-center gap-1 py-3">
        {items.map((item) => {
          const selected = active === item.key;
          return (
            <button
              key={item.key}
              type="button"
              aria-label={item.label}
              aria-current={selected ? "page" : undefined}
              title={item.label}
              onClick={() => onChange(item.key)}
              className={cn(
                "flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors",
                selected
                  ? "bg-foreground text-background shadow-sm"
                  : "hover:bg-sidebar-accent hover:text-foreground",
              )}
            >
              <AppIcon name={item.icon} className="size-[18px]" />
            </button>
          );
        })}
      </nav>
      <button
        type="button"
        aria-label="设置"
        title="设置"
        className="mt-auto mb-3 flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      >
        <AppIcon name="settings" className="size-[18px]" />
      </button>
    </aside>
  );
}

function AgentOnboarding({
  presets,
  error,
  onCreate,
}: {
  presets: AgentPreset[];
  error: string;
  onCreate: (input: CreateAgentInput) => Promise<void>;
}) {
  const [presetId, setPresetId] = useState(presets[0]?.id);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const preset = presets.find((item) => item.id === presetId);

  const submit = async () => {
    const normalizedName = name.trim();
    if (!normalizedName || busy) return;
    setBusy(true);
    try {
      await onCreate({
        presetId,
        name: normalizedName,
        role: preset?.role ?? "自定义智能体",
        description: preset?.description,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative isolate flex h-full min-h-0 overflow-auto bg-background">
      <div className="absolute inset-x-0 top-0 h-10 [-webkit-app-region:drag]" />
      <main className="relative m-auto w-full max-w-[700px] px-5 py-9 sm:px-8 [-webkit-app-region:no-drag]">
        <section className="rounded-2xl border border-border bg-card/90 p-6 shadow-xl shadow-black/10 sm:p-8">
          <div className="flex items-center gap-2">
            <img src="./tietiezhi.png" alt="" className="size-6 object-contain" />
            <span className="text-xs font-semibold tracking-[0.16em] text-foreground/75">TIETIEZHI AGENTS</span>
          </div>

          <div className="mt-8 flex items-start gap-3">
            <Avatar className="size-12 shrink-0 border border-border bg-muted">
              <AvatarImage src={preset ? agentAvatarURL(preset.name) : agentAvatarURL("Tietiezhi Agent")} alt="" />
              <AvatarFallback>{preset?.name.slice(0, 1) ?? "A"}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="text-primary text-[11px] font-semibold uppercase tracking-[0.18em]">第 1 步 · 角色</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">先设计你的第一个智能体</h1>
              <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-6">
                选择一个工作角色，再给它一个名字。之后可以继续补充记忆、技能和工作目录。
              </p>
            </div>
          </div>

          <div className="mt-7">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">选择工作角色</span>
              <span className="text-muted-foreground text-xs">{preset?.role ?? "自定义角色"}</span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {presets.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setPresetId(item.id)}
                  className={cn(
                    "flex min-h-16 items-center gap-3 rounded-xl border px-3 text-left transition-colors",
                    presetId === item.id
                      ? "border-foreground/60 bg-muted/70"
                      : "border-border bg-background/30 hover:border-foreground/30 hover:bg-muted/40",
                  )}
                >
                  <Avatar className="size-9 shrink-0 border border-border/70 bg-muted">
                    <AvatarImage src={item.avatar ?? agentAvatarURL(item.name)} alt="" />
                    <AvatarFallback>{item.name.slice(0, 1)}</AvatarFallback>
                  </Avatar>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{item.name}</span>
                    <span className="text-muted-foreground mt-0.5 block truncate text-xs">{item.role}</span>
                  </span>
                  {presetId === item.id && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-foreground" />}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground mt-3 text-xs leading-5">{preset?.description ?? "从你的工作方式出发，定义一个专属协作者。"}</p>
          </div>

          <div className="mt-6">
            <label className="text-sm font-medium" htmlFor="first-agent-name">智能体名称</label>
            <Input
              id="first-agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              placeholder={preset?.name ?? "例如：我的主理人"}
              className="mt-2 h-10 rounded-xl border-border bg-background/40 px-3"
              autoFocus
            />
            {error && <p className="text-destructive mt-2 text-xs">{error}</p>}
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
            <p className="text-muted-foreground text-xs">高级设置可以创建后再调整。</p>
            <Button type="button" className="rounded-xl" disabled={!name.trim() || busy} onClick={() => void submit()}>
              创建并开始私聊
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}

function AgentDirectory({
  agents,
  conversations,
  onCreate,
  onOpen,
}: {
  agents: AgentDefinition[];
  conversations: Conversation[];
  onCreate: () => void;
  onOpen: (agentId: string) => void;
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto w-full max-w-5xl px-6 py-8 lg:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-primary mb-2 text-[11px] font-semibold uppercase tracking-[0.2em]">Wakers</p>
            <h1 className="text-2xl font-semibold tracking-tight">你的智能体团队</h1>
            <p className="text-muted-foreground mt-2 text-sm leading-6">
              每个智能体都有独立的角色、记忆和对话空间。先从一个角色开始，再逐步组合成团队。
            </p>
          </div>
          <Button type="button" onClick={onCreate}>
            <AppIcon name="plus" />创建智能体
          </Button>
        </div>

        <div className="mt-7 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <MetricCard label="智能体" value={String(agents.length)} />
          <MetricCard label="已开始对话" value={String(conversations.length)} />
          <MetricCard label="当前状态" value="本地运行" />
        </div>

        <div className="mt-8 flex items-center justify-between">
          <h2 className="text-sm font-semibold">全部智能体</h2>
          <span className="text-muted-foreground text-xs">{agents.length} 个角色</span>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => {
            const conversationCount = conversations.filter((conversation) => conversation.agentId === agent.id).length;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => onOpen(agent.id)}
                className="group flex min-h-40 flex-col rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30 hover:bg-muted/40"
              >
                <div className="flex items-start gap-3">
                  <AgentAvatar agent={agent} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{agent.name}</span>
                      <span className="size-1.5 rounded-full bg-emerald-400" />
                    </span>
                    <span className="text-muted-foreground mt-1 block truncate text-xs">{agent.role}</span>
                  </span>
                  <AppIcon name="chevron-right" className="text-muted-foreground size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
                <p className="text-muted-foreground mt-4 line-clamp-2 text-xs leading-5">{agent.description}</p>
                <span className="text-muted-foreground mt-auto flex items-center gap-2 pt-4 text-[11px]">
                  <AppIcon name="message-square" className="size-3.5" />{conversationCount} 段对话
                  {agent.isBuiltIn && <span className="rounded-full bg-muted px-2 py-0.5">预设</span>}
                </span>
              </button>
            );
          })}
        </div>
      </main>
    </ScrollArea>
  );
}

function AgentAvatar({ agent }: { agent: AgentDefinition }) {
  const avatar = agent.avatar?.trim() || agentAvatarURL(agent.name);
  return (
    <Avatar className="size-10 shrink-0 bg-muted">
      <AvatarImage src={avatar} alt="" />
      <AvatarFallback>{agent.name.slice(0, 1)}</AvatarFallback>
    </Avatar>
  );
}

function ProjectDirectory({
  projects,
  onAdd,
  onOpen,
}: {
  projects: Workspace[];
  onAdd: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto w-full max-w-5xl px-6 py-8 lg:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-primary mb-2 text-[11px] font-semibold uppercase tracking-[0.2em]">Projects</p>
            <h1 className="text-2xl font-semibold tracking-tight">项目上下文</h1>
            <p className="text-muted-foreground mt-2 text-sm leading-6">
              给智能体一个可复用的工作目录，让每段对话都能沿着项目上下文继续。
            </p>
          </div>
          <Button type="button" onClick={onAdd}>
            <AppIcon name="plus" />添加项目
          </Button>
        </div>
        {projects.length === 0 ? (
          <div className="mt-12 grid min-h-[34vh] place-items-center rounded-xl border border-dashed border-border bg-card/30 px-6 py-14 text-center">
            <div>
              <span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted">
                <AppIcon name="folder" className="size-6" />
              </span>
              <h2 className="mt-5 text-lg font-semibold">还没有项目</h2>
              <p className="text-muted-foreground mt-2 text-sm">选择一个文件夹后，它会出现在项目上下文和对话创建器中。</p>
              <Button type="button" variant="outline" className="mt-5" onClick={onAdd}>
                <AppIcon name="folder-open" />选择文件夹
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-2">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => onOpen(project.id)}
                className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-4 text-left transition-colors hover:border-foreground/30 hover:bg-muted/40"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted">
                  <AppIcon name="folder" className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{project.name}</span>
                  <span className="text-muted-foreground mt-1 block truncate text-xs">项目文件夹</span>
                </span>
                <AppIcon name="folder-open" className="text-muted-foreground size-4 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>
        )}
      </main>
    </ScrollArea>
  );
}

function WorkflowDirectory({
  groups,
  agents,
  onCreate,
  onRun,
}: {
  groups: AgentGroup[];
  agents: AgentDefinition[];
  onCreate: () => void;
  onRun: (group: AgentGroup) => void;
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto w-full max-w-5xl px-6 py-8 lg:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-primary mb-2 text-[11px] font-semibold uppercase tracking-[0.2em]">WakerFlow</p>
            <h1 className="text-2xl font-semibold tracking-tight">智能体流程</h1>
            <p className="text-muted-foreground mt-2 text-sm leading-6">
              群聊就是最小的流程单元：先定义协作角色，再从一次任务运行它。
            </p>
          </div>
          <Button type="button" onClick={onCreate}>
            <AppIcon name="plus" />创建流程
          </Button>
        </div>
        {groups.length === 0 ? (
          <div className="mt-12 grid min-h-[34vh] place-items-center rounded-xl border border-dashed border-border bg-card/30 px-6 py-14 text-center">
            <div>
              <span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted"><AppIcon name="workflow" className="size-6" /></span>
              <h2 className="mt-5 text-lg font-semibold">还没有流程</h2>
              <p className="text-muted-foreground mt-2 text-sm">创建一个群聊并选择多个智能体，就能作为第一条协作流程运行。</p>
              <Button type="button" variant="outline" className="mt-5" onClick={onCreate}><AppIcon name="plus" />创建流程</Button>
            </div>
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-2">
            {groups.map((group) => (
              <article key={group.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">{group.name}</h2>
                    <p className="text-muted-foreground mt-1 text-xs">{group.description || "未设置流程目标"}</p>
                  </div>
                  <AppIcon name="workflow" className="text-muted-foreground size-4" />
                </div>
                <div className="mt-5 flex items-center gap-1">
                  {group.agentIds.map((id) => {
                    const agent = agents.find((item) => item.id === id);
                    return agent ? (
                      <span key={id} className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-[11px]">
                        <span className="grid size-4 place-items-center rounded-full bg-background text-[9px]">{agent.name.slice(0, 1)}</span>
                        {agent.name}
                      </span>
                    ) : null;
                  })}
                </div>
                <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => onRun(group)}>
                  <AppIcon name="play" />运行流程
                </Button>
              </article>
            ))}
          </div>
        )}
      </main>
    </ScrollArea>
  );
}

function TaskBoard({
  conversations,
  agents,
  groups,
  onCreate,
  onOpen,
}: {
  conversations: Conversation[];
  agents: AgentDefinition[];
  groups: AgentGroup[];
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto w-full max-w-5xl px-6 py-8 lg:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-primary mb-2 text-[11px] font-semibold uppercase tracking-[0.2em]">Board</p>
            <h1 className="text-2xl font-semibold tracking-tight">任务看板</h1>
            <p className="text-muted-foreground mt-2 text-sm">每段已经开始的对话都会成为一个可追踪的任务。</p>
          </div>
          <Button type="button" onClick={onCreate}><AppIcon name="plus" />新建任务</Button>
        </div>
        <div className="mt-8 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <TaskColumn title="待处理" items={[]} agents={agents} groups={groups} onOpen={onOpen} />
          <TaskColumn title="进行中" items={conversations} agents={agents} groups={groups} onOpen={onOpen} />
          <TaskColumn title="已完成" items={[]} agents={agents} groups={groups} onOpen={onOpen} />
        </div>
      </main>
    </ScrollArea>
  );
}

function TaskColumn({
  title,
  items,
  agents,
  groups,
  onOpen,
}: {
  title: string;
  items: Conversation[];
  agents: AgentDefinition[];
  groups: AgentGroup[];
  onOpen: (id: string) => void;
}) {
  return (
    <section className="min-h-48 rounded-xl border border-border bg-card/60 p-2">
      <div className="flex items-center justify-between px-2 py-2">
        <h2 className="text-xs font-semibold">{title}</h2>
        <span className="text-muted-foreground text-[11px]">{items.length}</span>
      </div>
      <div className="space-y-1">
        {items.length === 0 ? (
          <p className="text-muted-foreground px-2 py-8 text-center text-xs">暂无任务</p>
        ) : items.map((item) => {
          const owner = item.groupId
            ? groups.find((group) => group.id === item.groupId)?.name
            : agents.find((agent) => agent.id === item.agentId)?.name;
          return (
            <button key={item.id} type="button" onClick={() => onOpen(item.id)} className="w-full rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-left hover:bg-muted/60">
              <span className="block truncate text-xs font-medium">{item.title}</span>
              <span className="text-muted-foreground mt-1 block truncate text-[11px]">{owner ?? "未分配"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  );
}

function AgentAreaPlaceholder({
  area,
  onAction,
}: {
  area: Exclude<AgentArea, "agents" | "chat">;
  onAction: () => void;
}) {
  const info = AGENT_AREA_INFO[area];
  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex w-full max-w-5xl flex-col px-6 py-8 lg:px-10">
        <p className="text-primary mb-2 text-[11px] font-semibold uppercase tracking-[0.2em]">{info.eyebrow}</p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-semibold tracking-tight">{info.title}</h1>
            <p className="text-muted-foreground mt-2 text-sm leading-6">{info.description}</p>
          </div>
          <Button type="button" onClick={onAction}>
            <AppIcon name="plus" />{info.actionLabel}
          </Button>
        </div>

        <div className="mt-12 grid min-h-[38vh] place-items-center rounded-xl border border-dashed border-border bg-card/30 px-6 py-14 text-center">
          <div className="max-w-md">
            <span className="mx-auto grid size-12 place-items-center rounded-xl bg-muted text-foreground">
              <AppIcon name={info.icon} className="size-6" />
            </span>
            <h2 className="mt-5 text-lg font-semibold">从{info.title}开始</h2>
            <p className="text-muted-foreground mt-2 text-sm leading-6">
              这个工作区会和智能体共享同一套本地上下文。创建第一项内容后，相关记录会出现在这里。
            </p>
            <Button type="button" variant="outline" className="mt-5" onClick={onAction}>
              <AppIcon name="plus" />{info.actionLabel}
            </Button>
          </div>
        </div>
      </main>
    </ScrollArea>
  );
}

function AgentCreationDialog({
  open,
  presets,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  presets: AgentPreset[];
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateAgentInput) => Promise<void>;
}) {
  const [presetId, setPresetId] = useState(presets[0]?.id);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const preset = presets.find((item) => item.id === presetId);

  const submit = async () => {
    const normalizedName = name.trim();
    if (!normalizedName || busy) return;
    setBusy(true);
    try {
      await onCreate({
        presetId,
        name: normalizedName,
        role: preset?.role ?? "自定义智能体",
        description: preset?.description,
      });
      setName("");
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>创建智能体</DialogTitle>
          <DialogDescription>从一个角色模板开始，之后可以继续补充技能和记忆规则。</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {presets.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setPresetId(item.id)}
              className={cn(
                "rounded-xl p-2.5 text-left ring-1 transition-colors",
                presetId === item.id
                  ? "bg-primary/10 ring-primary/50"
                  : "bg-muted/40 ring-foreground/10 hover:bg-muted/70",
              )}
            >
              <span className="block truncate text-sm font-medium">{item.name}</span>
              <span className="text-muted-foreground mt-0.5 block truncate text-[11px]">{item.role}</span>
            </button>
          ))}
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="agent-name">名称</label>
          <Input
            id="agent-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder={preset?.name ?? "例如：发布经理"}
            className="mt-2 h-10"
            autoFocus
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" disabled={!name.trim() || busy} onClick={() => void submit()}>
            创建
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentGroupCreationDialog({
  open,
  agents,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  agents: AgentDefinition[];
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateAgentGroupInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setSelected(agents.slice(0, 2).map((agent) => agent.id));
  }, [agents, open]);

  const submit = async () => {
    const normalizedName = name.trim();
    if (!normalizedName || selected.length < 2 || busy) return;
    setBusy(true);
    try {
      await onCreate({ name: normalizedName, description, agentIds: selected });
      setName("");
      setDescription("");
      setSelected([]);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>创建群聊</DialogTitle>
          <DialogDescription>选择至少两个智能体，让他们围绕同一个任务协作。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium" htmlFor="group-name">群聊名称</label>
            <Input
              id="group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：产品发布小组"
              className="mt-2 h-10"
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="group-description">协作目标（可选）</label>
            <Textarea
              id="group-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="让成员知道这段群聊要完成什么"
              className="mt-2 min-h-20 resize-none"
            />
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">选择成员</span>
              <span className="text-muted-foreground text-xs">已选 {selected.length} 人</span>
            </div>
            <div className="grid max-h-48 grid-cols-1 gap-1 overflow-auto sm:grid-cols-2">
              {agents.map((agent) => {
                const checked = selected.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => setSelected((current) => checked
                      ? current.filter((id) => id !== agent.id)
                      : [...current, agent.id])}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
                      checked ? "border-primary/60 bg-primary/10" : "border-border hover:bg-muted/60",
                    )}
                  >
                    <AgentAvatar agent={agent} />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">{agent.name}</span>
                      <span className="text-muted-foreground block truncate text-[11px]">{agent.role}</span>
                    </span>
                    {checked && <AppIcon name="x" className="ml-auto size-3.5 text-primary" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" disabled={!name.trim() || selected.length < 2 || busy} onClick={() => void submit()}>
            创建并开始群聊
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MessageBubble({ message }: { message: Pick<Message, "role" | "parts"> }) {
  const text = message.parts
    .filter((part): part is Extract<(typeof message.parts)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return (
    <article className={cn("max-w-[78%]", message.role === "user" && "ml-auto")}>
      <div className={cn(
        "whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-6",
        message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
      )}>
        {text}
      </div>
    </article>
  );
}
