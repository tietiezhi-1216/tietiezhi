import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  Send,
  Settings,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
import type { ProductArea } from "@/App";
import type {
  AppMessage,
  Conversation,
  EngineDescriptor,
  EngineEvent,
  ProviderAccount,
  WorkspaceInfo,
  WorkspaceFile,
} from "@shared/contracts";

type ApprovalEvent = Extract<EngineEvent, { type: "tool.approval_required" }>;

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
  const [engines, setEngines] = useState<EngineDescriptor[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [providerId, setProviderId] = useState("");
  const [engineId, setEngineId] = useState("ai-sdk");
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState("");
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [approvals, setApprovals] = useState<ApprovalEvent[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<Conversation>();
  const [renameTitle, setRenameTitle] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const selectedChatModels = chatModels(selectedProvider?.models ?? []);
  const filteredConversations = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? conversations.filter((conversation) => conversation.title.toLowerCase().includes(query))
      : conversations;
  }, [conversations, search]);
  const projectGroups = useMemo(() => {
    const groups = new Map<string, Conversation[]>();
    for (const conversation of filteredConversations) {
      if (!conversation.workspace || /[/\\]workspaces[/\\][\w-]+$/.test(conversation.workspace)) {
        continue;
      }
      const current = groups.get(conversation.workspace) ?? [];
      current.push(conversation);
      groups.set(conversation.workspace, current);
    }
    return [...groups.entries()];
  }, [filteredConversations]);
  const temporaryTasks = filteredConversations.filter(
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
      window.tietiezhi.engines.list().then(setEngines),
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

  useEffect(
    () =>
      window.tietiezhi.onEngineEvent((event) => {
        if (event.conversationId !== activeId && activeId !== undefined) return;
        applyEvent(event, setMessages, setRunId, setError);
        if (event.type === "tool.approval_required") {
          setApprovals((current) => [
            ...current.filter((item) => item.approvalId !== event.approvalId),
            event,
          ]);
        }
        if (event.type === "run.completed" || event.type === "run.failed") {
          void refreshConversations();
        }
      }),
    [activeId],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
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

  return (
    <div
      className={cn(
        "grid h-full min-h-0 bg-[#101114]",
        panelOpen
          ? "grid-cols-[17rem_minmax(0,1fr)_22rem]"
          : "grid-cols-[17rem_minmax(0,1fr)]",
      )}
    >
      <aside className="flex min-h-0 flex-col border-r border-white/7 bg-[#0d0e11]">
        <div className="flex h-12 shrink-0 items-center border-b border-white/7 px-2 pl-20 [-webkit-app-region:drag]">
          <ProductSwitcher area="workspace" onSwitch={onSwitchArea} />
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
          <div className="relative mt-1">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索任务"
              className="h-8 border-0 bg-white/4 pl-8 text-xs"
            />
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2">
          <div className="space-y-5 pb-3">
            <div>
              <div className="mb-1 flex h-7 items-center px-2">
                <span className="text-[11px] font-medium text-white/35">项目</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto text-white/30"
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
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-white/35 hover:bg-white/5 hover:text-white/65"
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
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-white/60 hover:bg-white/5"
                        onClick={() =>
                          setWorkspace({
                            path,
                            name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? "项目",
                            temporary: false,
                          })
                        }
                      >
                        <FolderOpen className="size-4 text-white/40" />
                        <span className="truncate">
                          {path.split(/[\\/]/).filter(Boolean).at(-1)}
                        </span>
                      </button>
                      <div className="ml-3 border-l border-white/7 pl-2">
                        {tasks.map((conversation) => (
                          <TaskRow
                            key={conversation.id}
                            conversation={conversation}
                            active={activeId === conversation.id}
                            onOpen={open}
                            onRemove={remove}
                            onRename={(conversation) => {
                              setRenaming(conversation);
                              setRenameTitle(conversation.title);
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {temporaryTasks.length > 0 && (
              <div>
                <p className="mb-1 px-2 text-[11px] font-medium text-white/35">任务</p>
                {temporaryTasks.map((conversation) => (
                  <TaskRow
                    key={conversation.id}
                    conversation={conversation}
                    active={activeId === conversation.id}
                    onOpen={open}
                    onRemove={remove}
                    onRename={(conversation) => {
                      setRenaming(conversation);
                      setRenameTitle(conversation.title);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
        <div className="border-t border-white/7 p-2">
          <GatewayAccountButton
            onOpenSettings={onOpenSettings}
            onChanged={onProviderChanged}
          />
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/7 px-4 [-webkit-app-region:drag]">
          <Button
            type="button"
            variant="ghost"
            className="mr-auto max-w-64 justify-start [-webkit-app-region:no-drag]"
            onClick={async () => {
              const selected = await window.tietiezhi.workspace.choose();
              if (selected) setWorkspace(selected);
            }}
          >
            <FolderOpen />
            <span className="truncate">{workspace?.name ?? "临时 Workspace"}</span>
            <ChevronRight className="text-muted-foreground size-3" />
          </Button>
          <Button
            type="button"
            variant={panelOpen ? "secondary" : "ghost"}
            size="icon-sm"
            className="[-webkit-app-region:no-drag]"
            onClick={() => setPanelOpen((current) => !current)}
            aria-label={panelOpen ? "收起工作区面板" : "展开工作区面板"}
          >
            {panelOpen ? <PanelRightClose /> : <PanelRight />}
          </Button>
          <Select value={engineId} onValueChange={setEngineId}>
            <SelectTrigger size="sm" className="w-32 [-webkit-app-region:no-drag]">
              <SelectValue placeholder="选择引擎" />
            </SelectTrigger>
            <SelectContent>
              {engines.map((engine) => (
                <SelectItem key={engine.id} value={engine.id}>
                  {engine.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={providerId} onValueChange={setProviderId}>
            <SelectTrigger size="sm" className="w-44 [-webkit-app-region:no-drag]">
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
            <SelectTrigger size="sm" className="w-48 [-webkit-app-region:no-drag]">
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
            variant="ghost"
            size="icon-sm"
            className="[-webkit-app-region:no-drag]"
            onClick={onOpenSettings}
          >
            <Settings />
          </Button>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-3xl px-6 py-10">
            {messages.length === 0 ? (
              <div className="grid min-h-[55vh] place-items-center text-center">
                <div>
                  <img
                    src="./mode-mascots/paper-plane/code.png"
                    alt=""
                    className="mx-auto mb-4 size-28 object-contain drop-shadow-2xl"
                  />
                  <p className="text-2xl font-semibold tracking-tight">今天想完成什么？</p>
                  <p className="text-muted-foreground mt-2 text-sm">
                    AI SDK Agent 会在当前 Workspace 中读取、修改文件并运行任务。
                  </p>
                  <p className="mt-1 text-xs text-white/25">
                    未选择项目时，首次发送会自动创建隔离的临时目录。
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-8">
                {messages.map((message) => (
                  <Message key={message.id} message={message} />
                ))}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
        <div className="shrink-0 px-5 pb-6">
          <div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-white/5 p-2 shadow-2xl shadow-black/20">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={empty ? "登录中转站或配置可用模型" : "输入消息，Enter 发送"}
              disabled={empty}
              rows={3}
              className="min-h-20 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between px-1">
              <span className="text-destructive min-w-0 truncate text-xs">{error}</span>
              {runId ? (
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  onClick={() => void window.tietiezhi.conversations.cancel(runId)}
                  aria-label="停止生成"
                >
                  <Square />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  onClick={() => void send()}
                  disabled={!draft.trim() || !providerId || !model}
                  aria-label="发送"
                >
                  <Send />
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
      <div className={cn("group flex items-center rounded-md", active && "bg-white/7")}>
        <button
          type="button"
          onClick={() => void onOpen(conversation.id)}
          className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs text-white/55 hover:text-white/85"
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

function Message({ message }: { message: AppMessage }) {
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
  return (
    <article
      className={cn(
        "text-sm leading-7",
        message.role === "user" && "ml-auto max-w-[85%] rounded-2xl bg-white/7 px-4 py-2.5",
      )}
    >
      {message.role === "assistant" && (
        <p className="mb-2 text-xs font-medium text-cyan-300">AI SDK</p>
      )}
      {text ? (
        message.role === "assistant" ? (
          <div className="prose prose-invert max-w-none select-text text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        ) : (
          <p className="whitespace-pre-wrap select-text">{text}</p>
        )
      ) : message.status === "streaming" || message.status === "pending" ? (
        <p className="text-muted-foreground flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> 正在生成
        </p>
      ) : null}
      {errors.map((error) => (
        <p key={error.code} className="text-destructive mt-2 text-sm">
          {error.message}
        </p>
      ))}
      {message.usage?.totalTokens != null && (
        <p className="text-muted-foreground mt-2 text-[11px]">
          {message.usage.totalTokens.toLocaleString()} tokens
        </p>
      )}
    </article>
  );
}

function applyEvent(
  event: EngineEvent,
  setMessages: React.Dispatch<React.SetStateAction<AppMessage[]>>,
  setRunId: React.Dispatch<React.SetStateAction<string | undefined>>,
  setError: React.Dispatch<React.SetStateAction<string>>,
) {
  setMessages((current) => {
    const existing = current.find((message) => message.id === ("messageId" in event ? event.messageId : ""));
    if (existing === undefined) return current;
    return current.map((message) => {
      if (message !== existing) return message;
      const next: AppMessage = { ...message, parts: [...message.parts] };
      if (event.type === "text.delta") {
        const index = next.parts.findIndex((part) => part.type === "text");
        const text = index >= 0 && next.parts[index]?.type === "text" ? next.parts[index].text : "";
        const part = { type: "text" as const, text: text + event.delta };
        if (index >= 0) next.parts[index] = part;
        else next.parts.push(part);
        next.status = "streaming";
      } else if (event.type === "reasoning.delta") {
        const index = next.parts.findIndex((part) => part.type === "reasoning");
        const text =
          index >= 0 && next.parts[index]?.type === "reasoning" ? next.parts[index].text : "";
        const part = { type: "reasoning" as const, text: text + event.delta };
        if (index >= 0) next.parts[index] = part;
        else next.parts.push(part);
        next.status = "streaming";
      } else if (event.type === "tool.call") {
        next.parts.push({
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          status: "running",
        });
        next.status = "streaming";
      } else if (event.type === "tool.approval_required") {
        next.parts = next.parts.map((part) =>
          part.type === "tool-call" && part.toolCallId === event.toolCallId
            ? { ...part, status: "approval" }
            : part,
        );
      } else if (event.type === "tool.result") {
        next.parts = next.parts.map((part) =>
          part.type === "tool-call" && part.toolCallId === event.toolCallId
            ? { ...part, status: event.isError ? "failed" : "completed" }
            : part,
        );
        next.parts.push({
          type: "tool-result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.output,
          isError: event.isError,
        });
      } else if (event.type === "artifact.diff") {
        next.parts.push({
          type: "diff",
          toolCallId: event.toolCallId,
          path: event.path,
          before: event.before,
          after: event.after,
        });
      } else if (event.type === "usage") {
        next.usage = event.usage;
      } else if (event.type === "run.completed") {
        next.status = event.finishReason === "cancelled" ? "cancelled" : "completed";
      } else if (event.type === "run.failed") {
        next.status = "failed";
        next.parts.push({ type: "error", code: event.error.code, message: event.error.message });
      }
      return next;
    });
  });
  if (event.type === "run.completed" || event.type === "run.failed") setRunId(undefined);
  if (event.type === "run.failed") setError(event.error.message);
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
