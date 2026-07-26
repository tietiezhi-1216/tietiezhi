import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  BrainCircuit,
  ChevronRight,
  CircleGauge,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FilePlus2,
  Files,
  Folder,
  FolderOpen,
  KeyRound,
  Loader2,
  LockKeyhole,
  Plug,
  Plus,
  Pencil,
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
import { message } from "@/components/app-message";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSection } from "@/features/settings/settings-section";
import {
  deleteTietiezhiFile,
  deleteTietiezhiSecret,
  errorMessage,
  getTietiezhiConfig,
  getTietiezhiHomeOverview,
  listSkills,
  listTietiezhiFiles,
  listTietiezhiSecrets,
  loadSettings,
  mcpServerStatus,
  readTietiezhiFile,
  revealTietiezhiSecret,
  revealTietiezhiHome,
  saveTietiezhiConfig,
  upsertTietiezhiSecret,
  writeTietiezhiFile,
} from "@/lib/api";
import type {
  McpServer,
  TietiezhiConfig,
  TietiezhiFileEntry,
  TietiezhiSecret,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";

type Section =
  | "overview"
  | "identity"
  | "memory"
  | "skills"
  | "mcp"
  | "secrets"
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
  { key: "secrets", label: "密钥库", icon: KeyRound },
  { key: "files", label: "文件", icon: Files },
  { key: "security", label: "权限与工具", icon: ShieldCheck },
];

const SECTION_GROUPS: { label: string; items: SectionDefinition[] }[] = [
  { label: "铁铁汁", items: SECTIONS.slice(0, 3) },
  { label: "能力", items: SECTIONS.slice(3, 6) },
  { label: "数据与安全", items: SECTIONS.slice(6) },
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
  const secretsQuery = useQuery({
    queryKey: ["tietiezhi", "secrets"],
    queryFn: listTietiezhiSecrets,
    enabled: open,
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
          <nav className="flex min-h-full flex-col gap-4 p-3">
            <DialogTitle className="px-2 pt-1 text-sm font-semibold">
              铁铁汁控制中心
            </DialogTitle>
            {SECTION_GROUPS.map((group) => (
              <div key={group.label} className="flex flex-col gap-1">
                <span className="text-muted-foreground px-2 pb-0.5 text-[11px] font-medium">
                  {group.label}
                </span>
                {group.items.map((item) => (
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
              </div>
            ))}
          </nav>
        </ScrollArea>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b px-7">
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
                  secretCount={secretsQuery.data?.filter((secret) => secret.hasValue).length}
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
              {draft && section === "secrets" && <SecretsVault />}
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
  secretCount = 0,
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
  secretCount?: number;
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
    {
      label: "密钥库",
      value: `${secretCount} 个可用`,
      detail: "Markdown 引用 + 系统安全存储",
      icon: KeyRound,
      section: "secrets" as const,
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="运行状态"
        description="配置会在下一轮对话生效，铁铁汁使用独立 Home，不与 Work / Code 任务目录混用。"
      >
        <div className="divide-y rounded-lg border">
          {cards.map((card) => (
            <button
              type="button"
              key={card.label}
              onClick={() => onNavigate(card.section)}
              className="hover:bg-accent/50 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors"
            >
              <card.icon className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{card.label}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">{card.detail}</p>
              </div>
              <span className="text-muted-foreground text-xs">{card.value}</span>
              <ChevronRight className="text-muted-foreground size-4 shrink-0" />
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="本地存储" description="记忆、记录和文件均保存在本机。">
        <div className="divide-y rounded-lg border">
          <div className="flex items-center gap-3 px-4 py-3">
            <FolderOpen className="text-muted-foreground size-4 shrink-0" />
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
              打开文件夹
            </Button>
          </div>
          <div className="text-muted-foreground grid grid-cols-2 gap-4 px-4 py-3 text-xs">
            <span>会话记录：{overview?.timelineCount ?? 0} 条</span>
            <span>权限模式：{draft.permissionMode}</span>
          </div>
        </div>
      </SettingsSection>
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
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="系统指令"
        description="留空时使用内置陪伴指令；填写后将作为铁铁汁的主要身份指令。"
      >
        <Textarea
          id="tietiezhi-system-prompt"
          value={draft.systemPrompt}
          onChange={(event) => onPatch({ systemPrompt: event.target.value })}
          placeholder="例如：你是一个了解我工作方式的个人助理……"
          className="min-h-36 resize-y leading-relaxed"
        />
      </SettingsSection>
      <SettingsSection
        title="身份文件"
        description="身份文件是普通 Markdown，可随时查看、编辑和备份。"
      >
        <div className="flex flex-col gap-6">
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
      </SettingsSection>
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
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="长期记忆"
        description="开启后，SOUL.md、USER.md 和 MEMORY.md 会参与每轮上下文；铁铁汁也可以在权限允许时更新这些文件。"
        action={
          <Switch
            checked={draft.memoryEnabled}
            onCheckedChange={(memoryEnabled) => onPatch({ memoryEnabled })}
          />
        }
      >
        <ManagedDocument
          path="MEMORY.md"
          title="MEMORY.md"
          description="长期事实与决定的主索引。适合保存偏好、约定和需要跨会话延续的事项。"
          disabled={!draft.memoryEnabled}
        />
      </SettingsSection>
      <SettingsSection
        title="存储结构"
        description="MEMORY.md 保存长期索引，memory/ 可继续拆分日记或专题记录。当前版本采用可读、可编辑的本地 Markdown，不使用不可见的向量记忆。"
      >
        <div className="text-muted-foreground rounded-lg border px-4 py-3 font-mono text-xs">
          MEMORY.md · memory/
        </div>
      </SettingsSection>
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
          <Sparkles className="text-muted-foreground size-4 shrink-0" />
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
            <Plug className="text-muted-foreground size-4 shrink-0" />
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
    <SettingsSection
      title={title}
      description={description}
      action={
        <Button variant="outline" size="sm" onClick={onManage}>
          <ExternalLink />
          {manageLabel}
        </Button>
      }
    >
      <div className="divide-y rounded-lg border">
        {hasChildren ? (
          children
        ) : (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">{empty}</p>
        )}
      </div>
    </SettingsSection>
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
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="操作确认"
        description="文件写入、设备与 MCP 操作是否需要确认。所有内置文件工具始终限制在铁铁汁 Home。"
      >
        <div className="flex max-w-md flex-col gap-2">
          <Label>权限模式</Label>
          <Select
            value={draft.permissionMode}
            onValueChange={(value) =>
              onPatch({ permissionMode: value as TietiezhiConfig["permissionMode"] })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">每次询问</SelectItem>
              <SelectItem value="auto">安全操作自动</SelectItem>
              <SelectItem value="full">全部自动</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs leading-relaxed">
            “每次询问”会在写文件、调用设备或 MCP 前请求批准。
          </p>
        </div>
      </SettingsSection>
      <SettingsSection
        title="内置工具"
        description="采用显式白名单。铁铁汁不会获得终端 Bash 工具。"
      >
        <div className="divide-y rounded-lg border">
          {TOOL_OPTIONS.map((tool) => {
            const checked = draft.tools.includes(tool.id);
            return (
              <div key={tool.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{tool.label}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">{tool.detail}</p>
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
      </SettingsSection>
    </div>
  );
}

interface SecretDraft {
  originalName?: string;
  name: string;
  label: string;
  description: string;
  value: string;
}

function SecretsVault() {
  const queryClient = useQueryClient();
  const secretsQuery = useQuery({
    queryKey: ["tietiezhi", "secrets"],
    queryFn: listTietiezhiSecrets,
  });
  const secrets = secretsQuery.data ?? [];
  const [draft, setDraft] = useState<SecretDraft | null>(null);
  const [showDraftValue, setShowDraftValue] = useState(false);
  const [revealed, setRevealed] = useState<{ name: string; value: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TietiezhiSecret | null>(null);
  const [error, setError] = useState("");

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "secrets"] });
    void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "files"] });
    void queryClient.invalidateQueries({ queryKey: ["tietiezhi", "overview"] });
    void queryClient.invalidateQueries({ queryKey: ["mcpStatus"] });
  };

  const save = useMutation({
    mutationFn: (value: SecretDraft) =>
      upsertTietiezhiSecret(
        value.name.trim(),
        value.label.trim(),
        value.description.trim(),
        value.value.length > 0 ? value.value : undefined,
      ),
    onSuccess: () => {
      refresh();
      setDraft(null);
      setShowDraftValue(false);
      setError("");
      message.success("密钥已保存", "相关 MCP 会在下次调用时使用新值。");
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });
  const remove = useMutation({
    mutationFn: deleteTietiezhiSecret,
    onSuccess: () => {
      refresh();
      setPendingDelete(null);
      setRevealed(null);
      setError("");
      message.success("密钥已删除");
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });

  const copyText = async (text: string, success: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(success);
    } catch (cause) {
      message.error("复制失败", errorMessage(cause));
    }
  };

  const toggleReveal = async (secret: TietiezhiSecret) => {
    if (revealed?.name === secret.name) {
      setRevealed(null);
      return;
    }
    setError("");
    try {
      const value = await revealTietiezhiSecret(secret.name);
      setRevealed({ name: secret.name, value });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const copyValue = async (secret: TietiezhiSecret) => {
    setError("");
    try {
      const value =
        revealed?.name === secret.name
          ? revealed.value
          : await revealTietiezhiSecret(secret.name);
      await copyText(value, "密钥值已复制");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  if (draft) {
    const existing = draft.originalName != null;
    return (
      <SettingsSection
        title={existing ? "编辑密钥" : "新增密钥"}
        description="Markdown 只记录引用和用途，真实值会写入系统安全存储。"
      >
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="secret-name">引用名称</Label>
            <Input
              id="secret-name"
              value={draft.name}
              disabled={existing}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  name: event.target.value.toLowerCase().replace(/\s+/g, "_"),
                })
              }
              autoComplete="off"
              placeholder="github_token"
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="secret-label">显示名称</Label>
            <Input
              id="secret-label"
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              placeholder="GitHub Token"
            />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="secret-description">用途</Label>
          <Textarea
            id="secret-description"
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            placeholder="用于发布代码和读取私有仓库"
            className="min-h-20"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="secret-value">密钥值</Label>
          <div className="relative">
            <Input
              id="secret-value"
              type={showDraftValue ? "text" : "password"}
              value={draft.value}
              onChange={(event) => setDraft({ ...draft, value: event.target.value })}
              placeholder={existing ? "已保存，留空保持不变" : "粘贴密钥值"}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="pr-9 font-mono"
            />
            <button
              type="button"
              onClick={() => setShowDraftValue((current) => !current)}
              aria-label={showDraftValue ? "隐藏密钥值" : "显示密钥值"}
              className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 grid w-9 place-items-center"
            >
              {showDraftValue ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label>保存后引用</Label>
          <Input
            value={`\${secret:${draft.name || "name"}}`}
            readOnly
            className="font-mono"
          />
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <div className="flex items-center gap-2">
          <Button
            disabled={
              !draft.name.trim() ||
              !draft.label.trim() ||
              (!existing && draft.value.length === 0) ||
              save.isPending
            }
            onClick={() => save.mutate(draft)}
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
            保存密钥
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setDraft(null);
              setShowDraftValue(false);
              setError("");
            }}
          >
            取消
          </Button>
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="文件式密钥库"
      description="secrets/ 保存可读的 Markdown 索引，真实值保存在系统安全存储。MCP 环境变量和 HTTP 请求头、设备调用参数支持引用。"
      action={
        <Button
          size="sm"
          onClick={() =>
            setDraft({ name: "", label: "", description: "", value: "" })
          }
        >
          <Plus />
          新增密钥
        </Button>
      }
    >
      <div className="rounded-lg border">
        <div className="border-b px-4 py-3">
          <p className="text-xs font-medium">引用示例</p>
          <code className="text-muted-foreground mt-1 block text-xs">
            Authorization: Bearer {"${secret:github_token}"}
          </code>
        </div>
        {secretsQuery.isLoading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
            <Loader2 className="size-4 animate-spin" />
            正在读取密钥库
          </div>
        ) : secrets.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <KeyRound className="text-muted-foreground mx-auto size-6" />
            <p className="mt-3 text-sm font-medium">还没有密钥</p>
            <p className="text-muted-foreground mt-1 text-xs">
              新增后会自动生成 `secrets/SECRETS.md` 索引。
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {secrets.map((secret) => {
              const visible = revealed?.name === secret.name;
              return (
                <div key={secret.name} className="flex items-center gap-3 px-4 py-3">
                  <KeyRound className="text-muted-foreground size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{secret.label}</span>
                      <Badge variant={secret.hasValue ? "outline" : "destructive"}>
                        {secret.hasValue ? "已安全保存" : "缺少值"}
                      </Badge>
                    </div>
                    <code className="text-muted-foreground mt-0.5 block truncate text-xs">
                      {visible ? revealed.value : secret.reference}
                    </code>
                    {secret.description && (
                      <p className="text-muted-foreground mt-0.5 truncate text-xs">
                        {secret.description}
                      </p>
                    )}
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={!secret.hasValue}
                    onClick={() => void toggleReveal(secret)}
                    aria-label={visible ? "隐藏密钥值" : "显示密钥值"}
                    title={visible ? "隐藏密钥值" : "显示密钥值"}
                  >
                    {visible ? <EyeOff /> : <Eye />}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => void copyText(secret.reference, "密钥引用已复制")}
                    aria-label="复制密钥引用"
                    title="复制密钥引用"
                  >
                    <Copy />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={!secret.hasValue}
                    onClick={() => void copyValue(secret)}
                    aria-label="复制密钥值"
                    title="复制密钥值"
                  >
                    <KeyRound />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() =>
                      setDraft({
                        originalName: secret.name,
                        name: secret.name,
                        label: secret.label,
                        description: secret.description,
                        value: "",
                      })
                    }
                    aria-label="编辑密钥"
                    title="编辑密钥"
                  >
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setPendingDelete(secret)}
                    aria-label="删除密钥"
                    title="删除密钥"
                  >
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(nextOpen) => !nextOpen && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{pendingDelete?.label}」？</AlertDialogTitle>
            <AlertDialogDescription>
              Markdown 说明和系统安全存储中的真实值都会被删除，现有引用将失效。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingDelete && remove.mutate(pendingDelete.name)}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
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
    <div className="flex min-h-[590px] overflow-hidden rounded-lg border">
      <div className="bg-muted/30 flex w-64 shrink-0 flex-col border-r">
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
  const managedSecret = entry.path.startsWith("secrets/");

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
          disabled={managedSecret || !changed || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
          保存
        </Button>
      </div>
      <Textarea
        value={content}
        disabled={fileQuery.isLoading}
        readOnly={managedSecret}
        onChange={(event) => {
          if (managedSecret) return;
          setContent(event.target.value);
          setChanged(true);
          setError("");
        }}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed"
      />
      {managedSecret && (
        <p className="text-muted-foreground text-xs">
          这是密钥库生成的只读说明文件，请在“密钥库”面板中修改。
        </p>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
