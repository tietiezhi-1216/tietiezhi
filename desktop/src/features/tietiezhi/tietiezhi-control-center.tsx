import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenText,
  Bot,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleGauge,
  ExternalLink,
  File,
  FilePlus2,
  Files,
  Folder,
  FolderOpen,
  Loader2,
  LockKeyhole,
  Plug,
  Save,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteTietiezhiFile,
  errorMessage,
  getTietiezhiConfig,
  getTietiezhiHomeOverview,
  listSkills,
  listTietiezhiFiles,
  loadSettings,
  mcpServerStatus,
  readTietiezhiFile,
  revealTietiezhiHome,
  saveTietiezhiConfig,
  writeTietiezhiFile,
} from "@/lib/api";
import type {
  McpServer,
  TietiezhiConfig,
  TietiezhiFileEntry,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";

type Section =
  | "overview"
  | "identity"
  | "memory"
  | "skills"
  | "mcp"
  | "files"
  | "security";

interface SectionDefinition {
  key: Section;
  label: string;
  icon: typeof BrainCircuit;
}

const SECTIONS: SectionDefinition[] = [
  { key: "overview", label: "概览", icon: CircleGauge },
  { key: "identity", label: "身份与指令", icon: Bot },
  { key: "memory", label: "记忆", icon: BrainCircuit },
  { key: "skills", label: "Skills", icon: Sparkles },
  { key: "mcp", label: "MCP", icon: Plug },
  { key: "files", label: "文件", icon: Files },
  { key: "security", label: "权限与工具", icon: ShieldCheck },
];

const TOOL_OPTIONS = [
  { id: "read_file", label: "读取文件", detail: "读取 Home 内的文本文件" },
  { id: "write_file", label: "写入文件", detail: "创建或覆盖 Home 内的文件" },
  { id: "edit_file", label: "精确编辑", detail: "对文件内容做精确替换" },
  { id: "list_dir", label: "列出目录", detail: "查看 Home 的目录结构" },
  { id: "glob", label: "文件查找", detail: "按路径模式查找文件" },
  { id: "grep", label: "内容搜索", detail: "在 Home 文件中搜索文本" },
  { id: "fetch", label: "网页读取", detail: "读取公开的 HTTP 页面" },
  { id: "skill", label: "加载 Skill", detail: "按需读取已分配的技能说明" },
  { id: "device_call", label: "设备调用", detail: "操作右上角当前选择的设备" },
] as const;

function sectionLabel(section: Section): string {
  return SECTIONS.find((item) => item.key === section)?.label ?? "控制中心";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function toggleValue(values: string[], value: string, checked: boolean): string[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

export function TietiezhiControlCenter() {
  const queryClient = useQueryClient();
  const openSettings = useUiStore((state) => state.openSettings);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>("overview");
  const [draft, setDraft] = useState<TietiezhiConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");

  const configQuery = useQuery({
    queryKey: ["tietiezhi", "config"],
    queryFn: getTietiezhiConfig,
    enabled: open,
  });
  const overviewQuery = useQuery({
    queryKey: ["tietiezhi", "overview"],
    queryFn: getTietiezhiHomeOverview,
    enabled: open,
  });
  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: listSkills,
    enabled: open,
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: loadSettings,
    enabled: open,
  });
  const statusQuery = useQuery({
    queryKey: ["mcpStatus"],
    queryFn: mcpServerStatus,
    enabled: open,
    refetchInterval: open ? 5_000 : false,
  });

  useEffect(() => {
    if (open && configQuery.data && !dirty) {
      setDraft(structuredClone(configQuery.data));
    }
  }, [configQuery.data, dirty, open]);

  const saveConfig = useMutation({
    mutationFn: saveTietiezhiConfig,
    onSuccess: (saved) => {
      queryClient.setQueryData(["tietiezhi", "config"], saved);
      setDraft(structuredClone(saved));
      setDirty(false);
      setError("");
      void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "overview"] });
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });

  const patchDraft = (patch: Partial<TietiezhiConfig>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
    setError("");
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setDraft(null);
      setDirty(false);
      setError("");
      setSection("overview");
    }
  };

  const openGlobalSettings = (category: "skills" | "mcp") => {
    handleOpenChange(false);
    openSettings(category);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          title="铁铁汁控制中心"
          aria-label="铁铁汁控制中心"
        >
          <BrainCircuit />
          控制中心
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton
        className="flex h-[760px] max-h-[90vh] gap-0 overflow-hidden p-0 sm:max-w-5xl"
      >
        <ScrollArea className="bg-muted/30 w-56 shrink-0 border-r">
          <nav className="flex min-h-full flex-col gap-1 p-3">
            <div className="px-2 pt-1 pb-4">
              <DialogTitle className="text-sm font-semibold">铁铁汁控制中心</DialogTitle>
              <p className="text-muted-foreground mt-1 text-xs">记忆、能力与 Home</p>
            </div>
            {SECTIONS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setSection(item.key)}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  section === item.key
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <item.icon className="size-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            ))}
            <div className="mt-auto p-2">
              <div className="bg-background/70 rounded-lg border p-3">
                <p className="text-xs font-medium">独立运行空间</p>
                <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">
                  不与 Work / Code 任务目录混用。
                </p>
              </div>
            </div>
          </nav>
        </ScrollArea>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
            <h2 className="text-base font-semibold">{sectionLabel(section)}</h2>
            <div className="ml-auto flex items-center gap-2 pr-8">
              {error && <span className="text-destructive max-w-64 truncate text-xs">{error}</span>}
              {dirty && <span className="text-muted-foreground text-xs">有未保存更改</span>}
              <Button
                size="sm"
                disabled={!draft || !dirty || saveConfig.isPending}
                onClick={() => draft && saveConfig.mutate(draft)}
              >
                {saveConfig.isPending ? <Loader2 className="animate-spin" /> : <Save />}
                保存配置
              </Button>
            </div>
          </header>

          <ScrollArea className="min-h-0 flex-1">
            <div className="px-7 py-6">
              {!draft && (
                <div className="text-muted-foreground flex h-64 items-center justify-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  正在读取铁铁汁配置
                </div>
              )}
              {draft && section === "overview" && (
                <OverviewSection
                  draft={draft}
                  overview={overviewQuery.data}
                  skillCount={skillsQuery.data?.filter(
                    (skill) => skill.enabled && draft.skills.includes(skill.name),
                  ).length}
                  mcpCount={settingsQuery.data?.mcpServers.filter(
                    (server) => server.enabled && draft.mcpServers.includes(server.id),
                  ).length}
                  onNavigate={setSection}
                />
              )}
              {draft && section === "identity" && (
                <IdentitySection draft={draft} onPatch={patchDraft} />
              )}
              {draft && section === "memory" && (
                <MemorySection draft={draft} onPatch={patchDraft} />
              )}
              {draft && section === "skills" && (
                <SkillsAssignment
                  selected={draft.skills}
                  skills={skillsQuery.data ?? []}
                  onChange={(skills) => patchDraft({ skills })}
                  onManage={() => openGlobalSettings("skills")}
                />
              )}
              {draft && section === "mcp" && (
                <McpAssignment
                  selected={draft.mcpServers}
                  servers={settingsQuery.data?.mcpServers ?? []}
                  statuses={statusQuery.data ?? []}
                  onChange={(mcpServers) => patchDraft({ mcpServers })}
                  onManage={() => openGlobalSettings("mcp")}
                />
              )}
              {draft && section === "files" && <FileWorkbench />}
              {draft && section === "security" && (
                <SecuritySection draft={draft} onPatch={patchDraft} />
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OverviewSection({
  draft,
  overview,
  skillCount = 0,
  mcpCount = 0,
  onNavigate,
}: {
  draft: TietiezhiConfig;
  overview?: {
    path: string;
    fileCount: number;
    memoryFileCount: number;
    totalSize: number;
    timelineCount: number;
  };
  skillCount?: number;
  mcpCount?: number;
  onNavigate: (section: Section) => void;
}) {
  const cards = [
    {
      label: "长期记忆",
      value: draft.memoryEnabled ? `${overview?.memoryFileCount ?? 0} 个文件` : "已关闭",
      detail: "SOUL、USER 与 MEMORY",
      icon: BrainCircuit,
      section: "memory" as const,
    },
    {
      label: "Skills",
      value: `${skillCount} 个已分配`,
      detail: "按需加载技能说明",
      icon: Sparkles,
      section: "skills" as const,
    },
    {
      label: "MCP",
      value: `${mcpCount} 个已分配`,
      detail: "在对话运行时连接",
      icon: Plug,
      section: "mcp" as const,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="from-primary/10 via-background to-background relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6">
        <div className="relative flex items-start gap-5">
          <div className="bg-primary/10 text-primary grid size-12 shrink-0 place-items-center rounded-2xl">
            <BrainCircuit className="size-6" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold">一个独立、可控的个人 Agent 空间</h3>
            <p className="text-muted-foreground mt-1 max-w-xl text-sm leading-relaxed">
              配置会直接参与下一轮对话。长期资料留在本机 Home，Skills 与 MCP
              从全局资源库中按需分配。
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {cards.map((card) => (
          <button
            type="button"
            key={card.label}
            onClick={() => onNavigate(card.section)}
            className="group rounded-xl border p-4 text-left transition-colors hover:bg-accent/50"
          >
            <div className="flex items-center justify-between">
              <card.icon className="text-muted-foreground size-4" />
              <ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" />
            </div>
            <p className="mt-5 text-sm font-medium">{card.label}</p>
            <p className="mt-1 text-lg font-semibold">{card.value}</p>
            <p className="text-muted-foreground mt-1 text-xs">{card.detail}</p>
          </button>
        ))}
      </div>

      <div className="rounded-xl border">
        <div className="flex items-center gap-3 px-4 py-3">
          <FolderOpen className="text-muted-foreground size-4" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">铁铁汁 Home</p>
            <p className="text-muted-foreground truncate font-mono text-xs">
              {overview?.path ?? "正在读取…"}
            </p>
          </div>
          <Badge variant="outline">{overview?.fileCount ?? 0} 个文件</Badge>
          <Badge variant="outline">{formatBytes(overview?.totalSize ?? 0)}</Badge>
          <Button size="sm" variant="outline" onClick={() => void revealTietiezhiHome()}>
            <ExternalLink />
            在访达中打开
          </Button>
        </div>
        <Separator />
        <div className="text-muted-foreground grid grid-cols-2 gap-4 px-4 py-3 text-xs">
          <span>会话记录：{overview?.timelineCount ?? 0} 条</span>
          <span>权限模式：{draft.permissionMode}</span>
        </div>
      </div>
    </div>
  );
}

function IdentitySection({
  draft,
  onPatch,
}: {
  draft: TietiezhiConfig;
  onPatch: (patch: Partial<TietiezhiConfig>) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div>
          <Label htmlFor="tietiezhi-system-prompt">系统指令</Label>
          <p className="text-muted-foreground mt-1 text-xs">
            留空时使用内置陪伴指令；填写后将作为铁铁汁的主要身份指令。
          </p>
        </div>
        <Textarea
          id="tietiezhi-system-prompt"
          value={draft.systemPrompt}
          onChange={(event) => onPatch({ systemPrompt: event.target.value })}
          placeholder="例如：你是一个了解我工作方式的个人助理……"
          className="min-h-36 resize-y leading-relaxed"
        />
      </section>
      <Separator />
      <ManagedDocument
        path="SOUL.md"
        title="SOUL.md"
        description="稳定的身份、表达方式和行为边界，会在开启记忆时注入每轮上下文。"
      />
      <ManagedDocument
        path="USER.md"
        title="USER.md"
        description="用户档案、称呼和长期偏好。只记录你愿意长期保留的信息。"
      />
    </div>
  );
}

function MemorySection({
  draft,
  onPatch,
}: {
  draft: TietiezhiConfig;
  onPatch: (patch: Partial<TietiezhiConfig>) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between rounded-xl border p-4">
        <div className="pr-6">
          <p className="text-sm font-medium">在对话中使用长期记忆</p>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            开启后，SOUL.md、USER.md 和 MEMORY.md 会参与每轮上下文；铁铁汁也可以在权限允许时更新这些文件。
          </p>
        </div>
        <Switch
          checked={draft.memoryEnabled}
          onCheckedChange={(memoryEnabled) => onPatch({ memoryEnabled })}
        />
      </div>
      <ManagedDocument
        path="MEMORY.md"
        title="MEMORY.md"
        description="长期事实与决定的主索引。适合保存偏好、约定和需要跨会话延续的事项。"
        disabled={!draft.memoryEnabled}
      />
      <div className="bg-muted/35 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <BookOpenText className="text-muted-foreground size-4" />
          <p className="text-sm font-medium">分层记忆结构</p>
        </div>
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
          `MEMORY.md` 保存长期索引，`memory/` 可继续拆分日记或专题记录。当前版本采用可读、可编辑的本地
          Markdown，不做不可见的向量记忆。
        </p>
      </div>
    </div>
  );
}

function ManagedDocument({
  path,
  title,
  description,
  disabled = false,
}: {
  path: string;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const documentQuery = useQuery({
    queryKey: ["tietiezhi", "file", path],
    queryFn: () => readTietiezhiFile(path),
  });
  const [content, setContent] = useState("");
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (documentQuery.data != null && !changed) setContent(documentQuery.data);
  }, [changed, documentQuery.data]);

  const save = useMutation({
    mutationFn: () => writeTietiezhiFile(path, content),
    onSuccess: () => {
      queryClient.setQueryData(["tietiezhi", "file", path], content);
      setChanged(false);
      setError("");
      void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "overview"] });
      void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "files"] });
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });

  return (
    <section className={cn("flex flex-col gap-2", disabled && "opacity-60")}>
      <div className="flex items-start gap-3">
        <ScrollText className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <Label htmlFor={`document-${path}`}>{title}</Label>
          <p className="text-muted-foreground mt-1 text-xs">{description}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !changed || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
          保存文件
        </Button>
      </div>
      <Textarea
        id={`document-${path}`}
        value={content}
        disabled={disabled || documentQuery.isLoading}
        onChange={(event) => {
          setContent(event.target.value);
          setChanged(true);
          setError("");
        }}
        spellCheck={false}
        className="min-h-44 resize-y font-mono text-xs leading-relaxed"
      />
      {error && <p className="text-destructive text-xs">{error}</p>}
    </section>
  );
}

function SkillsAssignment({
  selected,
  skills,
  onChange,
  onManage,
}: {
  selected: string[];
  skills: { name: string; description: string; enabled: boolean }[];
  onChange: (skills: string[]) => void;
  onManage: () => void;
}) {
  return (
    <AssignmentLayout
      title="分配给铁铁汁的 Skills"
      description="只有同时在全局启用并在这里选中的 Skill，才会出现在铁铁汁下一轮对话中。"
      empty="技能库还是空的。先创建或导入一个 Skill。"
      manageLabel="管理技能库"
      onManage={onManage}
    >
      {skills.map((skill) => (
        <div key={skill.name} className="flex items-center gap-3 px-4 py-3">
          <div className="bg-muted grid size-8 shrink-0 place-items-center rounded-lg">
            <Sparkles className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-sm font-medium">{skill.name}</span>
              {!skill.enabled && <Badge variant="secondary">全局已停用</Badge>}
            </div>
            <p className="text-muted-foreground mt-0.5 truncate text-xs">
              {skill.description || "无描述"}
            </p>
          </div>
          <Switch
            disabled={!skill.enabled}
            checked={skill.enabled && selected.includes(skill.name)}
            onCheckedChange={(checked) =>
              onChange(toggleValue(selected, skill.name, checked))
            }
          />
        </div>
      ))}
    </AssignmentLayout>
  );
}

function McpAssignment({
  selected,
  servers,
  statuses,
  onChange,
  onManage,
}: {
  selected: string[];
  servers: McpServer[];
  statuses: { id: string; state: "running" | "stopped" | "error"; toolCount: number }[];
  onChange: (servers: string[]) => void;
  onManage: () => void;
}) {
  return (
    <AssignmentLayout
      title="分配给铁铁汁的 MCP"
      description="连接信息仍由全局 MCP 管理器维护。这里只决定铁铁汁可以调用哪些服务器。"
      empty="还没有配置 MCP 服务器。"
      manageLabel="管理 MCP 服务器"
      onManage={onManage}
    >
      {servers.map((server) => {
        const status = statuses.find((item) => item.id === server.id);
        return (
          <div key={server.id} className="flex items-center gap-3 px-4 py-3">
            <div className="bg-muted grid size-8 shrink-0 place-items-center rounded-lg">
              <Plug className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{server.name}</span>
                {!server.enabled ? (
                  <Badge variant="secondary">全局已停用</Badge>
                ) : status?.state === "error" ? (
                  <Badge variant="destructive">连接出错</Badge>
                ) : (
                  <Badge variant="outline">
                    {status?.state === "running" ? `${status.toolCount} 个工具` : "按需连接"}
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
                {server.transport.kind === "stdio"
                  ? server.transport.command
                  : server.transport.url}
              </p>
            </div>
            <Switch
              disabled={!server.enabled}
              checked={server.enabled && selected.includes(server.id)}
              onCheckedChange={(checked) =>
                onChange(toggleValue(selected, server.id, checked))
              }
            />
          </div>
        );
      })}
    </AssignmentLayout>
  );
}

function AssignmentLayout({
  title,
  description,
  empty,
  manageLabel,
  onManage,
  children,
}: {
  title: string;
  description: string;
  empty: string;
  manageLabel: string;
  onManage: () => void;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onManage}>
          <ExternalLink />
          {manageLabel}
        </Button>
      </div>
      <div className="divide-y rounded-xl border">
        {hasChildren ? (
          children
        ) : (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">{empty}</p>
        )}
      </div>
    </div>
  );
}

function SecuritySection({
  draft,
  onPatch,
}: {
  draft: TietiezhiConfig;
  onPatch: (patch: Partial<TietiezhiConfig>) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex items-start justify-between gap-6">
        <div>
          <Label>操作确认</Label>
          <p className="text-muted-foreground mt-1 max-w-lg text-xs leading-relaxed">
            文件写入、设备与 MCP 操作是否需要确认。所有内置文件工具始终限制在铁铁汁 Home。
          </p>
        </div>
        <Select
          value={draft.permissionMode}
          onValueChange={(value) =>
            onPatch({ permissionMode: value as TietiezhiConfig["permissionMode"] })
          }
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ask">每次询问</SelectItem>
            <SelectItem value="auto">安全操作自动</SelectItem>
            <SelectItem value="full">全部自动</SelectItem>
          </SelectContent>
        </Select>
      </section>
      <Separator />
      <section>
        <div className="mb-3">
          <Label>内置工具</Label>
          <p className="text-muted-foreground mt-1 text-xs">
            采用显式白名单。铁铁汁不会获得终端 Bash 工具。
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {TOOL_OPTIONS.map((tool) => {
            const checked = draft.tools.includes(tool.id);
            return (
              <div
                key={tool.id}
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-3 transition-colors",
                  checked && "bg-accent/45 border-primary/20",
                )}
              >
                <div
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-lg border",
                    checked
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground",
                  )}
                >
                  {checked ? <Check className="size-3.5" /> : <LockKeyhole className="size-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{tool.label}</p>
                  <p className="text-muted-foreground truncate text-xs">{tool.detail}</p>
                </div>
                <Switch
                  checked={checked}
                  onCheckedChange={(next) =>
                    onPatch({ tools: toggleValue(draft.tools, tool.id, next) })
                  }
                />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function FileWorkbench() {
  const queryClient = useQueryClient();
  const filesQuery = useQuery({
    queryKey: ["tietiezhi", "files"],
    queryFn: listTietiezhiFiles,
  });
  const files = filesQuery.data ?? [];
  const editableFiles = useMemo(() => files.filter((entry) => !entry.isDirectory), [files]);
  const [selectedPath, setSelectedPath] = useState("MEMORY.md");
  const [newPath, setNewPath] = useState("");
  const [pendingDelete, setPendingDelete] = useState<TietiezhiFileEntry | null>(null);
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      const normalized = newPath.trim().replace(/^\/+/, "");
      if (!normalized) throw new Error("请输入文件路径");
      await writeTietiezhiFile(normalized, `# ${normalized.split("/").pop() ?? "新笔记"}\n\n`);
      return normalized;
    },
    onSuccess: (path) => {
      setSelectedPath(path);
      setNewPath("");
      setError("");
      void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "files"] });
      void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "overview"] });
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });
  const remove = useMutation({
    mutationFn: deleteTietiezhiFile,
    onSuccess: (_, path) => {
      if (selectedPath === path) setSelectedPath("MEMORY.md");
      setPendingDelete(null);
      setError("");
      void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "files"] });
      void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "overview"] });
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });

  return (
    <div className="flex min-h-[590px] overflow-hidden rounded-xl border">
      <div className="bg-muted/20 flex w-64 shrink-0 flex-col border-r">
        <div className="border-b p-3">
          <div className="flex gap-2">
            <Input
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") create.mutate();
              }}
              placeholder="notes/新笔记.md"
              className="h-8 text-xs"
            />
            <Button
              size="icon-sm"
              variant="outline"
              disabled={!newPath.trim() || create.isPending}
              onClick={() => create.mutate()}
              aria-label="新建文本文件"
            >
              {create.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <FilePlus2 />
              )}
            </Button>
          </div>
          {error && <p className="text-destructive mt-2 text-xs">{error}</p>}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-2">
            {filesQuery.isLoading && (
              <p className="text-muted-foreground px-2 py-3 text-xs">正在读取文件…</p>
            )}
            {files.map((entry) => (
              <button
                type="button"
                key={entry.path}
                disabled={entry.isDirectory}
                onClick={() => setSelectedPath(entry.path)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                  entry.isDirectory && "text-muted-foreground font-medium",
                  !entry.isDirectory && "hover:bg-accent",
                  selectedPath === entry.path && !entry.isDirectory && "bg-accent font-medium",
                )}
              >
                {entry.isDirectory ? (
                  <Folder className="size-3.5 shrink-0" />
                ) : (
                  <File className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                {entry.protected && <LockKeyhole className="text-muted-foreground size-3" />}
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>
      <div className="flex min-w-0 flex-1 flex-col p-4">
        {editableFiles.some((entry) => entry.path === selectedPath) ? (
          <FileEditor
            key={selectedPath}
            entry={editableFiles.find((entry) => entry.path === selectedPath)!}
            onDelete={setPendingDelete}
          />
        ) : (
          <div className="text-muted-foreground grid flex-1 place-items-center text-sm">
            选择一个文本文件
          </div>
        )}
      </div>

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(nextOpen) => !nextOpen && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{pendingDelete?.path}」？</AlertDialogTitle>
            <AlertDialogDescription>文件会从铁铁汁 Home 永久删除。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingDelete && remove.mutate(pendingDelete.path)}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FileEditor({
  entry,
  onDelete,
}: {
  entry: TietiezhiFileEntry;
  onDelete: (entry: TietiezhiFileEntry) => void;
}) {
  const queryClient = useQueryClient();
  const fileQuery = useQuery({
    queryKey: ["tietiezhi", "file", entry.path],
    queryFn: () => readTietiezhiFile(entry.path),
  });
  const [content, setContent] = useState("");
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (fileQuery.data != null && !changed) setContent(fileQuery.data);
  }, [changed, fileQuery.data]);

  const save = useMutation({
    mutationFn: () => writeTietiezhiFile(entry.path, content),
    onSuccess: () => {
      queryClient.setQueryData(["tietiezhi", "file", entry.path], content);
      setChanged(false);
      setError("");
      void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "files"] });
      void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "overview"] });
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm font-medium">{entry.path}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">{formatBytes(entry.size)}</p>
        </div>
        {!entry.protected && (
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => onDelete(entry)}
            aria-label="删除文件"
          >
            <Trash2 />
          </Button>
        )}
        <Button
          size="sm"
          disabled={!changed || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
          保存
        </Button>
      </div>
      <Textarea
        value={content}
        disabled={fileQuery.isLoading}
        onChange={(event) => {
          setContent(event.target.value);
          setChanged(true);
          setError("");
        }}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed"
      />
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
