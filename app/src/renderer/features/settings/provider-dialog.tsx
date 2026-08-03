import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Download,
  Info,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
  WalletCards,
  Wrench,
} from "lucide-react";

import { useTheme, type Theme } from "@/components/theme-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
import { ProviderEditDialog } from "@/features/settings/provider-edit-dialog";
import { SkillsSection } from "@/features/settings/skills-section";
import { SystemPromptSection } from "@/features/settings/system-prompt-section";
import { ToolsSection } from "@/features/settings/tools-section";
import { SettingsSection } from "@/features/settings/settings-section";
import { cn } from "@/lib/utils";
import type {
  GatewayAccountView,
  ProviderAccount,
  PermissionProfileId,
  EngineDescriptor,
  UpdateState,
} from "@shared/contracts";

export type SettingsCategory =
  | "account"
  | "providers"
  | "systemPrompt"
  | "tools"
  | "skills"
  | "permissions"
  | "appearance"
  | "updates"
  | "about";

const GROUPS = [
  {
    label: "账号",
    items: [{ id: "account", label: "额度中心", icon: WalletCards }],
  },
  {
    label: "模型",
    items: [{ id: "providers", label: "供应商", icon: Server }],
  },
  {
    label: "智能体",
    items: [
      { id: "systemPrompt", label: "系统提示词", icon: ScrollText },
      { id: "tools", label: "工具", icon: Wrench },
      { id: "skills", label: "技能", icon: Sparkles },
      { id: "permissions", label: "权限", icon: ShieldCheck },
    ],
  },
  {
    label: "通用",
    items: [
      { id: "appearance", label: "外观", icon: Palette },
      { id: "updates", label: "软件更新", icon: RefreshCw },
      { id: "about", label: "关于", icon: Info },
    ],
  },
] as const;

const CATEGORY_LABELS: Record<SettingsCategory, string> = {
  account: "额度中心",
  providers: "供应商",
  systemPrompt: "系统提示词",
  tools: "工具",
  skills: "技能",
  permissions: "权限",
  appearance: "外观",
  updates: "软件更新",
  about: "关于",
};

export function ProviderDialog({
  open,
  onOpenChange,
  onChanged,
  initialCategory = "providers",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  initialCategory?: SettingsCategory;
}) {
  const [category, setCategory] = useState<SettingsCategory>("providers");

  useEffect(() => {
    if (open) setCategory(initialCategory);
  }, [initialCategory, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex h-[760px] max-h-[calc(100vh-7rem)] w-[calc(100vw-7rem)] gap-0 overflow-hidden p-0 sm:max-w-5xl"
      >
        <ScrollArea className="bg-muted/30 w-56 shrink-0 border-r">
          <nav className="flex min-h-full flex-col gap-4 p-3">
            <DialogTitle className="px-2 pt-1 text-sm font-semibold">设置</DialogTitle>
            {GROUPS.map((group) => (
              <div key={group.label} className="flex flex-col gap-1">
                <span className="text-muted-foreground px-2 pb-0.5 text-[11px] font-medium">
                  {group.label}
                </span>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setCategory(item.id)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                      category === item.id
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
          <header className="flex h-14 shrink-0 items-center border-b px-7">
            <h2 className="text-base font-semibold">{CATEGORY_LABELS[category]}</h2>
          </header>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-7 py-6">
              {category === "account" && (
                <AccountSection open={open} onChanged={onChanged} />
              )}
              {category === "providers" && (
                <ProviderSection open={open} onChanged={onChanged} />
              )}
              {category === "systemPrompt" && <SystemPromptSection />}
              {category === "tools" && <ToolsSection />}
              {category === "skills" && <SkillsSection />}
              {category === "permissions" && <PermissionsSection />}
              {category === "appearance" && <AppearanceSection />}
              {category === "updates" && <UpdateSection open={open} />}
              {category === "about" && <AboutSection />}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AccountSection({
  open,
  onChanged,
}: {
  open: boolean;
  onChanged: () => void;
}) {
  const [view, setView] = useState<GatewayAccountView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      setView(await window.tietiezhi.gateway.account());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  const login = async () => {
    setBusy(true);
    setError("");
    try {
      setView(await window.tietiezhi.gateway.login());
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      await window.tietiezhi.gateway.logout();
      await refresh();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const account = view?.account;
  const loggedIn = view?.loggedIn === true && account !== undefined;
  const initials = (account?.nickname || account?.email || "").slice(0, 2).toUpperCase();

  if (!loggedIn) {
    return (
      <SettingsSection
        title="登录中转站"
        description="登录后可以使用官方中转站模型，并查看当前账号和可用模型。"
      >
        {error && <p className="text-destructive text-xs">{error}</p>}
        <Button className="w-fit" disabled={busy} onClick={() => void login()}>
          {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
          {busy ? "等待浏览器授权" : "登录当前中转站"}
        </Button>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title={account.nickname || account.email || "额度中心"}
      description={account.email}
      action={
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw className={busy ? "animate-spin" : undefined} /> 刷新
        </Button>
      }
    >
      <div className="flex items-center gap-4 rounded-xl border p-4">
        <Avatar className="size-12">
          <AvatarFallback>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : initials ? (
              initials
            ) : (
              <UserRound className="size-5" />
            )}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {loggedIn ? account.nickname || account.email : "尚未登录"}
          </p>
          <p className="text-muted-foreground mt-1 truncate text-xs">
            {loggedIn
              ? account.email
              : view?.supported === false
                ? "当前无法连接中转站"
                : "使用浏览器完成安全授权"}
          </p>
        </div>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void logout()}>
          {busy ? <Loader2 className="animate-spin" /> : <LogOut />}
          退出登录
        </Button>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Separator />
      <p className="text-muted-foreground text-xs leading-relaxed">
        中转站登录凭据与手工配置的 Provider API Key 独立保存，并通过 Electron
        safeStorage 加密。
      </p>
    </SettingsSection>
  );
}

function ProviderSection({
  open,
  onChanged,
}: {
  open: boolean;
  onChanged: () => void;
}) {
  const [providers, setProviders] = useState<ProviderAccount[]>([]);
  const [gateway, setGateway] = useState<GatewayAccountView>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    setProviders(await window.tietiezhi.providers.list());
    try {
      setGateway(await window.tietiezhi.gateway.account());
    } catch {
      setGateway({ providerId: "builtin-official", supported: false, loggedIn: false });
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  const login = async () => {
    setBusy(true);
    setError("");
    try {
      setGateway(await window.tietiezhi.gateway.login());
      await refresh();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const refreshModels = async (provider: ProviderAccount) => {
    setBusy(true);
    setError("");
    try {
      await window.tietiezhi.providers.refreshModels(provider.id);
      await refresh();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const builtInProvider = providers.find((provider) => provider.builtIn);
  const customProviders = providers.filter((provider) => !provider.builtIn);
  const loggedIn = gateway?.loggedIn === true;
  const editing = providers.find((provider) => provider.id === editingId);

  return (
    <SettingsSection>
      <div className="flex flex-col gap-5">
        {builtInProvider && (
          <div className="flex flex-wrap items-center gap-4 rounded-xl border px-4 py-3.5">
            <img
              src="./tietiezhi.png"
              alt="Tietiezhi Gateway"
              draggable={false}
              className="size-12 shrink-0 select-none rounded-full object-contain"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="truncate text-sm font-semibold">Tietiezhi Gateway</span>
              <span className="text-muted-foreground text-xs">
                {loggedIn ? `${builtInProvider.models.length} 个可用模型` : "未登录"}
              </span>
            </div>
            {loggedIn ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void refreshModels(builtInProvider)}
              >
                <RefreshCw className={busy ? "animate-spin" : undefined} />
                刷新模型列表
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void login()}>
                {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
                铁铁汁登录
              </Button>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3 px-0.5">
            <h3 className="text-sm font-medium">已添加供应商</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditingId(undefined);
                setEditorOpen(true);
              }}
            >
              <Plus /> 添加供应商
            </Button>
          </div>
          {customProviders.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed px-4 py-5 text-center text-xs">
              暂无其他供应商，需要时可在右上角添加
            </div>
          ) : customProviders.map((provider) => (
            <div
              key={provider.id}
              className="hover:bg-accent/40 flex items-center gap-3 rounded-lg border px-3.5 py-3 transition-colors"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{provider.displayName}</span>
                  {provider.credentialRef && (
                    <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">已存 Key</Badge>
                  )}
                </div>
                <span className="text-muted-foreground truncate text-xs">
                  {provider.baseURL || "默认地址"} · {provider.models.length} 个模型
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="编辑"
                onClick={() => {
                  setEditingId(provider.id);
                  setEditorOpen(true);
                }}
              >
                <KeyRound />
              </Button>
            </div>
          ))}
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
      </div>

      <ProviderEditDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        provider={editing}
        onSaved={() => {
          void refresh();
          onChanged();
        }}
      />
    </SettingsSection>
  );
}

const THEMES: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <SettingsSection>
      <div className="flex flex-col gap-2">
        <Label>主题</Label>
        <div className="flex gap-2">
        {THEMES.map((option) => (
          <Button
            key={option.value}
            type="button"
            variant={theme === option.value ? "default" : "outline"}
            onClick={() => setTheme(option.value)}
          >
            <option.icon />
            {option.label}
          </Button>
        ))}
        </div>
      </div>
    </SettingsSection>
  );
}

const UPDATE_STATUS_LABEL: Record<UpdateState["status"], string> = {
  disabled: "不可用",
  idle: "等待检查",
  checking: "正在检查",
  available: "发现新版本",
  downloading: "正在下载",
  downloaded: "等待安装",
  "not-available": "已是最新版本",
  error: "更新失败",
};

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function UpdateSection({ open }: { open: boolean }) {
  const [state, setState] = useState<UpdateState>();
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void window.tietiezhi.updates.state().then((next) => active && setState(next));
    const dispose = window.tietiezhi.onUpdateEvent((event) => active && setState(event.state));
    return () => { active = false; dispose(); };
  }, [open]);

  const run = async (action: () => Promise<UpdateState>) => {
    setActionBusy(true);
    try { setState(await action()); } finally { setActionBusy(false); }
  };

  if (!state) {
    return <div className="grid min-h-48 place-items-center"><Loader2 className="text-muted-foreground size-5 animate-spin" /></div>;
  }

  const active = actionBusy || state.status === "checking" || state.status === "downloading";
  const description = [
    `当前版本 v${state.currentVersion}`,
    state.status === "checking" ? "正在检查更新。" : "",
    state.status === "not-available" ? "已是最新版本。" : "",
    state.status === "available" ? `发现 v${state.availableVersion}。` : "",
    state.status === "downloading" ? `正在后台下载 v${state.availableVersion}。` : "",
    state.status === "downloaded" ? `v${state.availableVersion} 已下载完成。` : "",
  ].filter(Boolean).join("，");

  return (
    <SettingsSection description={description}>
      {state.releaseNotes && ["available", "downloading", "downloaded"].includes(state.status) && (
        <p className="text-muted-foreground whitespace-pre-wrap text-sm">{state.releaseNotes}</p>
      )}
      {state.error && <p className="text-destructive text-sm">{state.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {state.status === "available" ? (
          <Button onClick={() => void run(() => window.tietiezhi.updates.download())} disabled={active}>
            <Download /> 下载 v{state.availableVersion}
          </Button>
        ) : state.status === "downloading" ? (
          <Button disabled><Loader2 className="animate-spin" /> 后台下载中{state.percent != null ? ` ${state.percent.toFixed(0)}%` : "…"}</Button>
        ) : state.status === "downloaded" ? (
          <Button onClick={() => void window.tietiezhi.updates.install()}><CheckCircle2 /> 重启以完成更新</Button>
        ) : (
          <Button variant="outline" onClick={() => void run(() => window.tietiezhi.updates.check())} disabled={!state.supported || active}>
            {active ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {state.status === "error" ? "重试更新" : "检查更新"}
          </Button>
        )}
        {state.status === "not-available" && (
          <Badge variant="secondary" className="text-emerald-600 dark:text-emerald-400"><CheckCircle2 /> 已是最新</Badge>
        )}
        {!state.supported && <Badge variant="secondary">当前构建不支持自动更新</Badge>}
      </div>
    </SettingsSection>
  );
}

function PermissionsSection() {
  const [engine, setEngine] = useState<EngineDescriptor>();
  const [profileId, setProfileId] = useState<PermissionProfileId>("ask");
  const [requestedProfile, setRequestedProfile] = useState<PermissionProfileId>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([
      window.tietiezhi.engines.list(),
      window.tietiezhi.preferences.get(),
    ]).then(([engines, preferences]) => {
      setEngine(engines.find((candidate) => candidate.id === "ai-sdk"));
      setProfileId(preferences.defaultPermissionProfiles["ai-sdk"] ?? "ask");
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => setBusy(false));
  }, []);

  const saveProfile = async (next: PermissionProfileId) => {
    setBusy(true);
    setError("");
    try {
      const preferences = await window.tietiezhi.preferences.get();
      const saved = await window.tietiezhi.preferences.save({
        ...preferences,
        defaultPermissionProfiles: {
          ...preferences.defaultPermissionProfiles,
          "ai-sdk": next,
        },
      });
      setProfileId(saved.defaultPermissionProfiles["ai-sdk"] ?? "ask");
      window.dispatchEvent(new CustomEvent("tietiezhi:preferences-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const choose = (value: string) => {
    if (value !== "ask" && value !== "agent-managed" && value !== "full-access") return;
    if (value === "full-access") setRequestedProfile(value);
    else void saveProfile(value);
  };

  const profiles = engine?.capabilities.permissions.profiles ?? [];
  const current = profiles.find((profile) => profile.id === profileId);
  const rules = profileId === "ask"
    ? ["读取自动允许", "文件修改每次询问", "Shell 每次询问"]
    : profileId === "agent-managed"
      ? ["读取自动允许", "普通文件修改自动允许", "危险 Shell 仍会询问"]
      : ["读取与修改自动允许", "Shell 自动允许", "Workspace 安全边界始终有效"];
  return (
    <SettingsSection>
      <div className="flex max-w-md flex-col gap-2">
        <Label>默认权限模式</Label>
        <Select value={profileId} disabled={busy || profiles.length === 0} onValueChange={choose}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {profiles.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {current?.description ?? "新任务会继承此设置，已有任务保持自己的权限模式。"}
        </p>
        {error && <p className="text-destructive text-xs">{error}</p>}
      </div>
      <Separator />
      <div className="divide-y rounded-lg border">
        {rules.map((rule, index) => (
          <div key={rule} className="flex items-start gap-4 px-4 py-4">
            <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-lg">
              <ShieldCheck className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <strong className="text-sm">{["Workspace 读取", "文件与工具", "Shell 与边界"][index]}</strong>
              <span className="text-muted-foreground mt-1 block text-xs leading-5">
                {rule}
              </span>
            </span>
          </div>
        ))}
      </div>
      <Dialog open={requestedProfile === "full-access"} onOpenChange={(open) => !open && setRequestedProfile(undefined)}>
        <DialogContent className="max-w-md">
          <DialogTitle>将完全访问设为默认？</DialogTitle>
          <p className="text-muted-foreground text-sm leading-6">
            之后创建的任务会自动执行工作区文件操作和 Shell 命令。现有任务不会改变，Workspace 路径和进程安全限制仍然有效。
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRequestedProfile(undefined)}>取消</Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-600/90"
              onClick={() => {
                setRequestedProfile(undefined);
                void saveProfile("full-access");
              }}
            >
              设为新任务默认
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

function AboutSection() {
  const [state, setState] = useState<UpdateState>();

  useEffect(() => {
    void window.tietiezhi.updates.state().then(setState);
  }, []);

  return (
    <SettingsSection>
      <div className="flex items-center gap-4">
        <img
          src="./mode-mascots/paper-plane/code.png"
          alt=""
          draggable={false}
          className="size-16 object-contain"
        />
        <div>
          <h3 className="text-lg font-semibold">Tietiezhi Desktop</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Electron + TypeScript Workspace AI 应用
          </p>
          <p className="text-muted-foreground mt-2 font-mono text-xs">
            {state ? `v${state.currentVersion} · ${state.platform} · ${state.architecture}` : "正在读取版本…"}
          </p>
        </div>
      </div>
      <Separator />
      <p className="text-muted-foreground text-xs leading-relaxed">
        Workspace 使用统一 AIEngine 和 EngineEvent，支持受限文件工具、Shell、审批、
        Diff、系统提示词和按需技能加载。
      </p>
    </SettingsSection>
  );
}
