import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Folder,
  FolderOpen,
  LogOut,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  Paintbrush,
  Plus,
  Send,
  X,
} from "lucide-react";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AuthStatus, Conversation, ConversationDetail, Message, Workspace } from "@shared/contracts";

interface WorkspacePageProps {
  auth: AuthStatus;
  onAuthChange: (status: AuthStatus) => void;
  onLogout: () => Promise<void>;
}

export function WorkspacePage({ auth, onAuthChange, onLogout }: WorkspacePageProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<ConversationDetail>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const projects = useMemo(
    () => workspaces.filter((workspace) => workspace.kind === "project"),
    [workspaces],
  );
  const temporaryWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.kind === "temporary"),
    [workspaces],
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

  const refresh = async () => {
    const [nextWorkspaces, nextConversations] = await Promise.all([
      window.tietiezhi.workspaces.list(),
      window.tietiezhi.conversations.list(),
    ]);
    setWorkspaces(nextWorkspaces);
    setConversations(nextConversations);
  };

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);

  const openConversation = async (id: string) => {
    setError("");
    try {
      setActive(await window.tietiezhi.conversations.load(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createConversation = async (workspace: Workspace) => {
    setError("");
    try {
      const detail = await window.tietiezhi.conversations.create({
        workspaceId: workspace.id,
      });
      setActive(detail);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const addProject = async () => {
    setError("");
    try {
      const workspace = await window.tietiezhi.workspaces.chooseProject();
      if (!workspace) return;
      await refresh();
      await createConversation(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createTemporaryTask = async () => {
    setError("");
    try {
      const workspace = await window.tietiezhi.workspaces.createTemporary();
      await createConversation(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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

  const send = async () => {
    const text = draft.trim();
    if (!active || !text || busy) return;
    setBusy(true);
    setError("");
    try {
      const message = await window.tietiezhi.conversations.appendMessage({
        conversationId: active.conversation.id,
        role: "user",
        parts: [{ type: "text", text }],
      });
      const title = active.messages.length === 0
        ? await window.tietiezhi.conversations.rename(active.conversation.id, text.slice(0, 32))
        : active.conversation;
      setActive((current) => current
        ? { ...current, conversation: title, messages: [...current.messages, message] }
        : current);
      setDraft("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="bg-background flex h-full min-h-0">
      <aside className="bg-sidebar flex w-72 shrink-0 flex-col border-r pt-3">
        <div className="flex h-10 items-center gap-2 px-3 [-webkit-app-region:drag]">
          <img src="/tietiezhi.png" alt="Tietiezhi" className="size-7 rounded-lg" />
          <span className="font-semibold">Tietiezhi</span>
          <Button
            type="button"
            size="sm"
            className="ml-auto [-webkit-app-region:no-drag]"
            onClick={() => void createTemporaryTask()}
          >
            <MessageSquarePlus />新建任务
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 px-2 py-3">
          <SidebarSection
            title="项目"
            actionLabel="添加项目"
            onAction={() => void addProject()}
          >
            {projects.length === 0 ? (
              <EmptyRow icon={Folder} label="添加一个项目文件夹" onClick={() => void addProject()} />
            ) : projects.map((workspace) => (
              <WorkspaceGroup
                key={workspace.id}
                workspace={workspace}
                conversations={conversationsByWorkspace.get(workspace.id) ?? []}
                activeId={active?.conversation.id}
                onCreate={() => void createConversation(workspace)}
                onOpen={(id) => void openConversation(id)}
              />
            ))}
          </SidebarSection>

          <SidebarSection title="任务">
            {temporaryWorkspaces.length === 0 ? (
              <p className="text-muted-foreground px-2 py-2 text-xs">暂无临时任务</p>
            ) : temporaryWorkspaces.map((workspace) => {
              const items = conversationsByWorkspace.get(workspace.id) ?? [];
              return items.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={active?.conversation.id === conversation.id}
                  onOpen={() => void openConversation(conversation.id)}
                />
              ));
            })}
          </SidebarSection>
        </ScrollArea>

        <UserMenu
          auth={auth}
          onSetAvatar={() => void setAvatar()}
          onResetAvatar={() => void resetAvatar()}
          onLogout={() => void logout()}
        />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center border-b px-5 [-webkit-app-region:drag]">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {active?.conversation.title ?? "Workspace"}
            </p>
            <p className="text-muted-foreground truncate text-xs">
              {active
                ? `${active.workspace.kind === "project" ? "项目" : "临时任务"} · ${active.workspace.path}`
                : "选择项目，或创建一个临时任务"}
            </p>
          </div>
          {active && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto [-webkit-app-region:no-drag]"
              onClick={() => void window.tietiezhi.workspaces.reveal(active.workspace.id)}
            >
              <FolderOpen />打开文件夹
            </Button>
          )}
        </header>

        {active ? (
          <>
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-8">
                {active.messages.length === 0 ? (
                  <div className="grid min-h-[45vh] place-items-center text-center">
                    <div>
                      <MessageSquare className="text-muted-foreground mx-auto mb-4 size-9" />
                      <h1 className="text-lg font-semibold">开始一段对话</h1>
                      <p className="text-muted-foreground mt-1 text-sm">
                        当前阶段只验证 Workspace、Conversation 和 Message 的本地存储。
                      </p>
                    </div>
                  </div>
                ) : active.messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
              </div>
            </ScrollArea>
            <div className="mx-auto w-full max-w-3xl px-5 pb-5">
              <div className="text-muted-foreground mb-2 px-1 text-xs">
                Agent 内核尚未接入；消息会保存到本地 SQLite。
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
                  placeholder="输入一条消息，验证本地对话存储…"
                  rows={1}
                  className="max-h-40 min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                />
                <Button
                  type="button"
                  size="icon"
                  className="shrink-0 rounded-xl"
                  disabled={!draft.trim() || busy}
                  onClick={() => void send()}
                  aria-label="保存消息"
                >
                  <Send />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
            <div>
              <img src="/tietiezhi.png" alt="Tietiezhi" className="mx-auto mb-5 size-16 rounded-2xl" />
              <h1 className="text-xl font-semibold">从 Workspace 开始</h1>
              <p className="text-muted-foreground mt-2 max-w-md text-sm">
                项目绑定你选择的目录；任务使用 Tietiezhi 创建的独立临时目录。
              </p>
              <div className="mt-5 flex justify-center gap-2">
                <Button type="button" variant="outline" onClick={() => void addProject()}>
                  <FolderOpen />选择项目
                </Button>
                <Button type="button" onClick={() => void createTemporaryTask()}>
                  <MessageSquarePlus />新建任务
                </Button>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="text-destructive border-t px-5 py-2 text-sm">{error}</div>
        )}
      </section>
    </main>
  );
}

function defaultAvatarURL(auth: AuthStatus): string {
  const seed = profileName(auth);
  const colors = avatarGradientColors(seed);
  const parameters = new URLSearchParams({
    seed,
    backgroundType: "gradientLinear",
    backgroundRotation: String(avatarGradientRotation(seed)),
    radius: "50",
  });
  for (const color of colors) parameters.append("backgroundColor", color);
  return `https://api.dicebear.com/10.x/toon-head/svg?${parameters.toString()}`;
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
    <div className="border-sidebar-border bg-sidebar/95 border-t px-2 py-2 [-webkit-app-region:no-drag]">
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
            <ChevronDown className="text-muted-foreground size-4 shrink-0" />
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
            <Paintbrush />设置头像 URL
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onResetAvatar}>
            <X />恢复默认头像
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onLogout}>
            <LogOut />退出登录
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
            <Plus />
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
        <Folder className="text-muted-foreground mr-2 size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm">{workspace.name}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right">
            <DropdownMenuItem onSelect={onCreate}>
              <MessageSquarePlus />新建对话
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void window.tietiezhi.workspaces.reveal(workspace.id)}>
              <FolderOpen />打开文件夹
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100" onClick={onCreate}>
          <Plus />
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
}: {
  conversation: Conversation;
  active: boolean;
  onOpen: () => void;
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
      <MessageSquare className="text-muted-foreground size-3.5 shrink-0" />
      <span className="truncate">{conversation.title}</span>
    </button>
  );
}

function EmptyRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Folder;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:bg-sidebar-accent flex h-9 items-center gap-2 rounded-md px-2 text-left text-xs"
    >
      <Icon className="size-4" />{label}
    </button>
  );
}

function MessageBubble({ message }: { message: Message }) {
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
