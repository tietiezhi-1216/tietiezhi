import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronRight,
  Code2,
  FileCode2,
  Folder,
  FolderOpen,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  Pencil,
  Plus,
  ShieldAlert,
  Settings,
  Square,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ProductSwitcher } from "@/components/product-switcher";
import { GatewayAccountButton } from "@/components/gateway-account-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { chatModels } from "@/lib/model-capabilities";
import { Markdown } from "./markdown";
import type { ProductArea } from "@/App";
import type {
  AppMessage,
  Conversation,
  EngineEvent,
  ProviderAccount,
  WorkspaceInfo,
  WorkspaceFile,
} from "@shared/contracts";

type ApprovalEvent = Extract<EngineEvent, { type: "tool.approval_required" }>;
const IS_MACOS = navigator.userAgent.includes("Mac");

export function WorkspacePage({
  providerVersion,
  onOpenSettings,
  onProviderChanged,
  onSwitchArea,
}: {
  providerVersion: number;
  onOpenSettings: () => void;
  onProviderChanged: () => void;
  onSwitchArea: (area: ProductArea) => void;
}) {
  const [providers, setProviders] = useState<ProviderAccount[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [providerId, setProviderId] = useState("");
  const engineId = "ai-sdk";
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState("");
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [approvals, setApprovals] = useState<ApprovalEvent[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [renaming, setRenaming] = useState<Conversation>();
  const [renameTitle, setRenameTitle] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const queuedEvents = useRef<EngineEvent[]>([]);
  const eventFrame = useRef<number | undefined>(undefined);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const selectedChatModels = chatModels(selectedProvider?.models ?? []);
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

  const refreshConversations = async () => {
    setConversations(await window.tietiezhi.conversations.list());
  };

  useEffect(() => {
    void Promise.all([
      window.tietiezhi.providers.list().then((value) => {
        setProviders(value);
        setProviderId(
          (current) =>
            current ||
            value.find((provider) => chatModels(provider.models).length > 0)?.id ||
            "",
        );
      }),
      refreshConversations(),
    ]);
  }, [providerVersion]);

  useEffect(() => {
    if (!selectedProvider) {
      setModel("");
      return;
    }
    const models = chatModels(selectedProvider.models);
    if (!models.includes(model)) setModel(models[0] ?? "");
  }, [selectedProvider, model]);

  useEffect(() => {
    const unsubscribe = window.tietiezhi.onEngineEvent((event) => {
        if (event.conversationId !== activeId && activeId !== undefined) return;
        queuedEvents.current.push(event);
        if (eventFrame.current !== undefined) return;
        eventFrame.current = window.setTimeout(() => {
          eventFrame.current = undefined;
          const events = queuedEvents.current.splice(0);
          if (events.length === 0) return;
          setMessages((current) => applyEvents(current, events));
          const approvalsInBatch = events.filter(
            (candidate): candidate is ApprovalEvent =>
              candidate.type === "tool.approval_required",
          );
          if (approvalsInBatch.length > 0) {
            setApprovals((current) => {
              const ids = new Set(approvalsInBatch.map((item) => item.approvalId));
              return [...current.filter((item) => !ids.has(item.approvalId)), ...approvalsInBatch];
            });
          }
          const terminal = events.findLast(
            (candidate) =>
              candidate.type === "run.completed" || candidate.type === "run.failed",
          );
          if (terminal) {
            setRunId(undefined);
            if (terminal.type === "run.failed") setError(terminal.error.message);
            void refreshConversations();
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const open = async (id: string) => {
    const detail = await window.tietiezhi.conversations.load(id);
    setActiveId(id);
    setMessages(detail.messages);
    setProviderId(detail.conversation.providerAccountId ?? providerId);
    setModel(detail.conversation.activeModelId ?? model);
    setRunId(
      detail.messages.findLast(
        (message) => message.status === "pending" || message.status === "streaming",
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
    setApprovals([]);
    setError("");
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !providerId || !model || runId) return;
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
      });
      setActiveId(started.conversationId);
      setRunId(started.runId);
      const detail = await window.tietiezhi.conversations.load(started.conversationId);
      setMessages(detail.messages);
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

  const remove = async (id: string) => {
    setError("");
    try {
      await window.tietiezhi.conversations.remove(id);
      if (activeId === id) {
        setActiveId(undefined);
        setMessages([]);
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

  const empty = !providerId || !model;
  const activeConversation = conversations.find((conversation) => conversation.id === activeId);

  return (
    <div
      className={cn(
        "grid h-full min-h-0 bg-background",
        sidebarOpen && panelOpen && "grid-cols-[17rem_minmax(0,1fr)_22rem]",
        sidebarOpen && !panelOpen && "grid-cols-[17rem_minmax(0,1fr)]",
        !sidebarOpen && panelOpen && "grid-cols-[minmax(0,1fr)_22rem]",
        !sidebarOpen && !panelOpen && "grid-cols-[minmax(0,1fr)]",
      )}
    >
      {sidebarOpen && (
        <aside className="bg-sidebar text-sidebar-foreground flex min-h-0 flex-col border-r">
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
                setError("");
                setWorkspace(undefined);
                setApprovals([]);
              }}
            >
              <MessageSquarePlus /> 新建任务
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1 px-2">
            <div className="space-y-5 pb-3">
              <div>
                <div className="mb-1 flex h-7 items-center px-2">
                  <span className="text-muted-foreground text-[11px] font-medium">项目</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground ml-auto"
                    onClick={async () => {
                      const selected = await window.tietiezhi.workspace.choose();
                      if (selected) {
                        setWorkspace(selected);
                        setActiveId(undefined);
                        setMessages([]);
                      }
                    }}
                    aria-label="添加项目"
                  >
                    <Plus />
                  </Button>
                </div>
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
                  <div className="space-y-2">
                    {projectGroups.map(([path, tasks]) => (
                      <div key={path}>
                        <button
                          type="button"
                          className="hover:bg-sidebar-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs"
                          onClick={() =>
                            setWorkspace({
                              path,
                              name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? "项目",
                              temporary: false,
                            })
                          }
                        >
                          <FolderOpen className="text-muted-foreground size-4" />
                          <span className="truncate">
                            {path.split(/[\\/]/).filter(Boolean).at(-1)}
                          </span>
                        </button>
                        <div className="border-sidebar-border ml-3 border-l pl-2">
                          {tasks.map((conversation) => (
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
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <p className="text-muted-foreground mb-1 px-2 text-[11px] font-medium">任务</p>
                {temporaryTasks.length === 0 ? (
                  <p className="text-muted-foreground px-2 py-1 text-xs">暂无任务</p>
                ) : (
                  temporaryTasks.map((conversation) => (
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
                  ))
                )}
              </div>
            </div>
          </ScrollArea>
          <div className="border-t p-2">
            <GatewayAccountButton
              onOpenSettings={onOpenSettings}
              onChanged={onProviderChanged}
            />
          </div>
        </aside>
      )}
      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 [-webkit-app-region:drag]">
          {!sidebarOpen && IS_MACOS && <div aria-hidden="true" className="w-16 shrink-0" />}
          {!sidebarOpen && (
            <ProductSwitcher area="workspace" onSwitch={onSwitchArea} />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="[-webkit-app-region:no-drag]"
            onClick={() => setSidebarOpen((current) => !current)}
            aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
          >
            {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
          <span className="min-w-0 truncate text-sm font-medium">
            {activeConversation?.title ?? "新建任务"}
          </span>
          <div className="ml-auto flex min-w-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="max-w-48"
              onClick={async () => {
                const selected = await window.tietiezhi.workspace.choose();
                if (selected) setWorkspace(selected);
              }}
            >
              <Code2 />
              <span className="truncate">{workspace?.name ?? "临时 Workspace"}</span>
              <ChevronRight className="text-muted-foreground size-3" />
            </Button>
            <Select value={providerId} onValueChange={setProviderId}>
              <SelectTrigger size="sm" className="w-36">
                <SelectValue placeholder="选择供应商" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger size="sm" className="w-44">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                {selectedChatModels.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant={panelOpen ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => setPanelOpen((current) => !current)}
              aria-label={panelOpen ? "收起工作区面板" : "展开工作区面板"}
            >
              {panelOpen ? <PanelRightClose /> : <PanelRight />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onOpenSettings}
              aria-label="设置"
            >
              <Settings />
            </Button>
          </div>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 px-4 pt-6 pb-4">
            {messages.length === 0 ? (
              <div className="flex min-h-[58vh] flex-1 flex-col items-center justify-center text-center">
                <div className="relative grid h-56 w-80 place-items-center">
                  <span className="absolute size-40 rounded-full bg-cyan-400/8 blur-3xl" />
                  <span className="absolute h-24 w-64 rotate-[-7deg] rounded-[50%] border border-cyan-500/10" />
                  <span className="absolute h-36 w-72 rotate-[9deg] rounded-[50%] border border-sky-500/8" />
                  <img
                    src="./mode-mascots/paper-plane/code.png"
                    alt=""
                    decoding="async"
                    draggable={false}
                    className="animate-channel-breathe relative size-32 object-contain drop-shadow-lg"
                  />
                </div>
                <p className="h-7 max-w-full truncate px-4 text-lg font-semibold">
                  {workspace?.temporary === false ? workspace.name : "在独立 Code 空间开始任务"}
                </p>
                <p className="text-muted-foreground mt-1 text-sm">
                  AI SDK Agent 会在当前 Workspace 中读取、修改文件并运行任务。
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  未选择项目时，首次发送会自动创建隔离的临时目录。
                </p>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-5">
                  {messages.map((message) => (
                    <Message key={message.id} message={message} />
                  ))}
                </div>
                <div className="mt-auto flex h-12 items-center gap-2">
                  <img
                    src="./mode-mascots/paper-plane/code.png"
                    alt=""
                    decoding="async"
                    className="size-12 object-contain"
                  />
                  <span
                    className={cn(
                      "text-muted-foreground text-xs",
                      runId && "text-shimmer",
                    )}
                  >
                    {runId ? `正在生成 · ${model}` : "铁铁汁就绪"}
                  </span>
                </div>
              </>
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
        <div className="relative mx-auto w-full max-w-3xl px-4 pt-2 pb-4">
          <div className="bg-muted/70 relative z-20 flex flex-col rounded-2xl px-2 pt-1.5 pb-1.5 dark:bg-muted/65">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={empty ? "登录中转站或配置可用模型" : "描述需要分析、修改或验证的代码任务…"}
              disabled={empty}
              rows={2}
              className="max-h-40 min-h-12 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:bg-transparent focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex min-h-9 items-center gap-2">
              <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 px-2 text-[11px]">
                <FolderOpen className="size-3" />
                <span className="truncate">{workspace?.name ?? "发送后创建临时 Workspace"}</span>
              </span>
              <span className="text-destructive min-w-0 flex-1 truncate text-xs">{error}</span>
              {runId ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="secondary"
                  className="rounded-full"
                  onClick={() => void window.tietiezhi.conversations.cancel(runId)}
                  aria-label="停止生成"
                >
                  <Square />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon-sm"
                  className="rounded-full"
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
      </section>
      {panelOpen && (
        <AgentPanel
          activeId={activeId}
          messages={messages}
          workspace={workspace}
          approvals={approvals}
          onResolve={async (approvalId, approved) => {
            await window.tietiezhi.approvals.resolve(approvalId, approved);
            setApprovals((current) =>
              current.filter((item) => item.approvalId !== approvalId),
            );
          }}
        />
      )}
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
  onOpen,
  onRemove,
  onRename,
}: {
  conversation: Conversation;
  active: boolean;
  onOpen: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRename: (conversation: Conversation) => void;
}) {
  return (
    <AlertDialog>
      <div className={cn("group flex items-center rounded-md", active && "bg-sidebar-accent")}>
        <button
          type="button"
          onClick={() => void onOpen(conversation.id)}
          className="text-muted-foreground hover:text-sidebar-foreground min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs"
        >
          {conversation.title}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" className="mr-1 shrink-0 opacity-0 group-hover:opacity-100" aria-label="任务操作">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => onRename(conversation)}><Pencil />重命名</DropdownMenuItem>
            <DropdownMenuSeparator />
            <AlertDialogTrigger asChild>
              <DropdownMenuItem
                variant="destructive"
                onSelect={(event) => event.preventDefault()}
              >
                <Trash2 />删除
              </DropdownMenuItem>
            </AlertDialogTrigger>
          </DropdownMenuContent>
        </DropdownMenu>
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

const Message = memo(function Message({ message }: { message: AppMessage }) {
  const text = useMemo(
    () =>
      message.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join(""),
    [message.parts],
  );
  const errors = message.parts.filter(
    (part): part is Extract<typeof part, { type: "error" }> => part.type === "error",
  );
  const reasoning = message.parts
    .filter((part): part is Extract<typeof part, { type: "reasoning" }> => part.type === "reasoning")
    .map((part) => part.text)
    .join("\n");
  const toolCalls = message.parts.filter(
    (part): part is Extract<typeof part, { type: "tool-call" }> => part.type === "tool-call",
  );
  return (
    <article
      className={cn(
        "animate-in fade-in slide-in-from-bottom-1 flex min-w-0 flex-col gap-2 text-sm leading-7 duration-300",
        message.role === "user" && "bg-muted ml-auto max-w-[70%] rounded-xl px-3 py-2.5",
      )}
    >
      {message.role === "assistant" && reasoning && (
        <Collapsible defaultOpen={message.status === "streaming" || message.status === "pending"}>
          <div className="border-border/60 bg-muted/30 rounded-lg border text-xs">
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-2.5 py-1.5 font-medium">
              <ChevronRight className="size-3.5" />
              思考过程
            </CollapsibleTrigger>
            <CollapsibleContent className="text-muted-foreground border-border/60 border-t px-2.5 py-2 leading-relaxed whitespace-pre-wrap select-text">
              {reasoning}
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}
      {text ? (
        message.role === "assistant" ? (
          <Markdown content={text} />
        ) : (
          <p className="px-1 whitespace-pre-wrap select-text">{text}</p>
        )
      ) : message.status === "streaming" || message.status === "pending" ? (
        <p className="text-muted-foreground flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> 正在生成
        </p>
      ) : null}
      {toolCalls.map((call) => (
        <div key={call.toolCallId} className="bg-muted/30 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          {call.toolName === "runCommand" ? (
            <TerminalSquare className="text-muted-foreground size-3.5" />
          ) : (
            <FileCode2 className="text-muted-foreground size-3.5" />
          )}
          <span className="min-w-0 flex-1 truncate font-mono">{call.toolName}</span>
          <Badge variant={call.status === "failed" ? "destructive" : "outline"}>
            {toolStatus(call.status)}
          </Badge>
        </div>
      ))}
      {errors.map((error) => (
        <p key={error.code} className="text-destructive mt-2 text-sm">
          {error.message}
        </p>
      ))}
      {message.usage?.totalTokens != null && (
        <p className="text-muted-foreground text-[11px]">
          {message.usage.totalTokens.toLocaleString()} tokens
        </p>
      )}
    </article>
  );
});

function applyEvents(current: AppMessage[], events: EngineEvent[]): AppMessage[] {
  const next = [...current];
  const cloned = new Set<number>();
  for (const event of events) {
    const messageId = "messageId" in event ? event.messageId : "";
    const messageIndex = next.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) continue;
    if (!cloned.has(messageIndex)) {
      const source = next[messageIndex];
      if (!source) continue;
      next[messageIndex] = { ...source, parts: [...source.parts] };
      cloned.add(messageIndex);
    }
    const message = next[messageIndex];
    if (!message) continue;
    if (event.type === "text.delta") {
      const index = message.parts.findIndex((part) => part.type === "text");
      const existing = index >= 0 && message.parts[index]?.type === "text"
        ? message.parts[index].text
        : "";
      const part = { type: "text" as const, text: existing + event.delta };
      if (index >= 0) message.parts[index] = part;
      else message.parts.push(part);
      message.status = "streaming";
    } else if (event.type === "reasoning.delta") {
      const index = message.parts.findIndex((part) => part.type === "reasoning");
      const existing = index >= 0 && message.parts[index]?.type === "reasoning"
        ? message.parts[index].text
        : "";
      const part = { type: "reasoning" as const, text: existing + event.delta };
      if (index >= 0) message.parts[index] = part;
      else message.parts.push(part);
      message.status = "streaming";
    } else if (event.type === "tool.call") {
      message.parts.push({
        type: "tool-call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        status: "running",
      });
      message.status = "streaming";
    } else if (event.type === "tool.approval_required") {
      message.parts = message.parts.map((part) =>
        part.type === "tool-call" && part.toolCallId === event.toolCallId
          ? { ...part, status: "approval" }
          : part,
      );
    } else if (event.type === "tool.result") {
      message.parts = message.parts.map((part) =>
        part.type === "tool-call" && part.toolCallId === event.toolCallId
          ? { ...part, status: event.isError ? "failed" : "completed" }
          : part,
      );
      message.parts.push({
        type: "tool-result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: event.output,
        isError: event.isError,
      });
    } else if (event.type === "artifact.diff") {
      message.parts.push({
        type: "diff",
        toolCallId: event.toolCallId,
        path: event.path,
        before: event.before,
        after: event.after,
      });
    } else if (event.type === "usage") {
      message.usage = event.usage;
    } else if (event.type === "run.completed") {
      message.status = event.finishReason === "cancelled" ? "cancelled" : "completed";
    } else if (event.type === "run.failed") {
      message.status = "failed";
      message.parts.push({
        type: "error",
        code: event.error.code,
        message: event.error.message,
      });
    }
  }
  return cloned.size > 0 ? next : current;
}

function AgentPanel({
  activeId,
  messages,
  workspace,
  approvals,
  onResolve,
}: {
  activeId?: string;
  messages: AppMessage[];
  workspace?: WorkspaceInfo;
  approvals: ApprovalEvent[];
  onResolve: (approvalId: string, approved: boolean) => Promise<void>;
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [fileError, setFileError] = useState("");
  const parts = messages.flatMap((message) => message.parts);
  const calls = parts.filter(
    (part): part is Extract<(typeof parts)[number], { type: "tool-call" }> =>
      part.type === "tool-call",
  );
  const diffs = parts.filter(
    (part): part is Extract<(typeof parts)[number], { type: "diff" }> =>
      part.type === "diff",
  );
  const results = parts.filter(
    (part): part is Extract<(typeof parts)[number], { type: "tool-result" }> =>
      part.type === "tool-result",
  );
  const reasoning = parts
    .filter((part): part is Extract<(typeof parts)[number], { type: "reasoning" }> =>
      part.type === "reasoning",
    )
    .map((part) => part.text)
    .join("\n");

  useEffect(() => {
    setFiles([]);
    setSelectedFile("");
    setFileContent("");
    if (!activeId || !workspace) return;
    void window.tietiezhi.workspace.listFiles(activeId).then(setFiles).catch(() => setFiles([]));
  }, [activeId, workspace, diffs.length]);

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
    <aside className="flex min-h-0 flex-col border-l bg-background">
      <Tabs defaultValue="run" className="min-h-0 flex-1 gap-0">
        <div className="flex h-12 shrink-0 items-center border-b px-3">
          <TabsList variant="line" className="h-9 w-full justify-start">
            <TabsTrigger value="run">运行</TabsTrigger>
            <TabsTrigger value="changes">
              变更 {diffs.length > 0 && <Badge variant="secondary">{diffs.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="files">文件</TabsTrigger>
          </TabsList>
        </div>
        {approvals.length > 0 && (
          <div className="space-y-2 border-b p-3">
            {approvals.map((approval) => (
              <Card key={approval.approvalId} size="sm" className="border-amber-500/30">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ShieldAlert className="size-4 text-amber-500" />
                    {approval.description}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="bg-muted max-h-24 overflow-auto rounded-md p-2 text-[10px] whitespace-pre-wrap">
                    {formatValue(approval.input)}
                  </pre>
                  <div className="mt-3 flex justify-end gap-2">
                    <Button type="button" size="xs" variant="outline" onClick={() => void onResolve(approval.approvalId, false)}>
                      <X />拒绝
                    </Button>
                    <Button type="button" size="xs" onClick={() => void onResolve(approval.approvalId, true)}>
                      <Check />允许
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        <TabsContent value="run" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-3 p-3">
              <Card size="sm">
                <CardContent>
                  <div className="flex items-center gap-2 text-xs">
                    <FolderOpen className="size-3.5" />
                    <span>{workspace?.name ?? "等待创建临时 Workspace"}</span>
                  </div>
                  {workspace?.path && <p className="text-muted-foreground mt-2 break-all font-mono text-[10px]">{workspace.path}</p>}
                </CardContent>
              </Card>
              {reasoning && (
                <Collapsible>
                  <Card size="sm">
                    <CollapsibleTrigger className="w-full text-left">
                      <CardHeader><CardTitle>推理过程</CardTitle></CardHeader>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <CardContent className="text-muted-foreground whitespace-pre-wrap text-xs leading-5">{reasoning}</CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              )}
              {calls.length === 0 ? (
                <EmptyPanel text="Agent 调用工具后会显示在这里" />
              ) : calls.map((call) => {
                const result = results.find((item) => item.toolCallId === call.toolCallId);
                return (
                  <Collapsible key={call.toolCallId}>
                    <Card size="sm">
                      <CollapsibleTrigger className="w-full text-left">
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2">
                            {call.toolName === "runCommand" ? <TerminalSquare className="size-3.5" /> : <FileCode2 className="size-3.5" />}
                            <span className="font-mono">{call.toolName}</span>
                            <Badge className="ml-auto" variant={call.status === "failed" ? "destructive" : "outline"}>{toolStatus(call.status)}</Badge>
                          </CardTitle>
                        </CardHeader>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <CardContent className="space-y-2">
                          <pre className="bg-muted max-h-32 overflow-auto rounded-md p-2 text-[10px] whitespace-pre-wrap">{formatValue(call.input)}</pre>
                          {result && <pre className="bg-muted max-h-48 overflow-auto rounded-md p-2 text-[10px] whitespace-pre-wrap">{formatValue(result.output)}</pre>}
                        </CardContent>
                      </CollapsibleContent>
                    </Card>
                  </Collapsible>
                );
              })}
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="changes" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-3 p-3">
              {diffs.length === 0 ? <EmptyPanel text="Agent 修改文件后会显示逐行变更" /> : diffs.map((diff, index) => (
                <Card key={`${diff.toolCallId}-${index}`} size="sm">
                  <CardHeader><CardTitle className="font-mono text-xs">{diff.path}</CardTitle></CardHeader>
                  <CardContent><LineDiff before={diff.before} after={diff.after} /></CardContent>
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

function toolStatus(status: Extract<AppMessage["parts"][number], { type: "tool-call" }>["status"]) {
  if (status === "approval") return "等待审批";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "denied") return "已拒绝";
  return "运行中";
}
