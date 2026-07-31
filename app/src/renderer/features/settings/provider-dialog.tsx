import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Download,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  Server,
  Sun,
  Trash2,
  UserRound,
  WalletCards,
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
import { cn } from "@/lib/utils";
import type {
  GatewayAccountView,
  ProviderAccount,
  ProviderType,
  UpdateState,
} from "@shared/contracts";

type SettingsCategory = "account" | "providers" | "appearance" | "updates";

const GROUPS = [
  {
    label: "账号",
    items: [{ id: "account", label: "中转站账号", icon: WalletCards }],
  },
  {
    label: "模型",
    items: [{ id: "providers", label: "供应商", icon: Server }],
  },
  {
    label: "通用",
    items: [
      { id: "appearance", label: "外观", icon: Palette },
      { id: "updates", label: "软件更新", icon: RefreshCw },
    ],
  },
] as const;

const CATEGORY_LABELS: Record<SettingsCategory, string> = {
  account: "中转站账号",
  providers: "供应商",
  appearance: "外观",
  updates: "软件更新",
};

export function ProviderDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [category, setCategory] = useState<SettingsCategory>("providers");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex h-[720px] max-h-[90vh] gap-0 overflow-hidden p-0 sm:max-w-5xl"
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
              {category === "appearance" && <AppearanceSection />}
              {category === "updates" && <UpdateSection open={open} />}
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

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h3 className="font-semibold">Tietiezhi Gateway</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          登录中转站后自动同步内置供应商凭据和可用模型。
        </p>
      </div>
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
        {loggedIn ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void logout()}>
            {busy ? <Loader2 className="animate-spin" /> : <LogOut />}
            退出登录
          </Button>
        ) : (
          <Button type="button" disabled={busy} onClick={() => void login()}>
            {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
            {busy ? "等待浏览器授权" : "登录中转站"}
          </Button>
        )}
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Separator />
      <div className="rounded-lg bg-muted/40 p-3 text-xs leading-5">
        中转站登录凭据与手工配置的 Provider API Key 独立保存，并通过 Electron
        safeStorage 加密。
      </div>
    </section>
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
  const [selectedId, setSelectedId] = useState<string>("new");
  const selected = providers.find((provider) => provider.id === selectedId);
  const [providerType, setProviderType] = useState<ProviderType>("openai-compatible");
  const [displayName, setDisplayName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => setProviders(await window.tietiezhi.providers.list());

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  useEffect(() => {
    if (selected === undefined) {
      setProviderType("openai-compatible");
      setDisplayName("");
      setBaseURL("");
      setModels("");
    } else {
      setProviderType(selected.providerType);
      setDisplayName(selected.displayName);
      setBaseURL(selected.baseURL);
      setModels(selected.models.join(", "));
    }
    setApiKey("");
    setError("");
  }, [selected, selectedId]);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await window.tietiezhi.providers.save({
        id: selected?.id,
        providerType,
        displayName,
        baseURL,
        apiKey: apiKey || undefined,
        enabled: true,
        models: models
          .split(/[,，\n]/)
          .map((item) => item.trim())
          .filter(Boolean),
      });
      await refresh();
      setSelectedId(saved.id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await window.tietiezhi.providers.remove(selected.id);
      setSelectedId("new");
      await refresh();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const refreshModels = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const refreshed = await window.tietiezhi.providers.refreshModels(selected.id);
      setModels(refreshed.models.join(", "));
      await refresh();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <div className="space-y-1 border-r pr-4">
        <Button
          type="button"
          variant={selectedId === "new" ? "secondary" : "ghost"}
          className="w-full justify-start"
          onClick={() => setSelectedId("new")}
        >
          <Plus /> 新供应商
        </Button>
        {providers.map((provider) => (
          <Button
            key={provider.id}
            type="button"
            variant={selectedId === provider.id ? "secondary" : "ghost"}
            className="w-full justify-start"
            onClick={() => setSelectedId(provider.id)}
          >
            <KeyRound />
            <span className="min-w-0 flex-1 truncate text-left">{provider.displayName}</span>
            {provider.builtIn && <Badge variant="secondary">内置</Badge>}
          </Button>
        ))}
      </div>
      <div className="space-y-4">
        <Field label="类型">
          <Select
            value={providerType}
            onValueChange={(value) => setProviderType(value as ProviderType)}
            disabled={selected?.builtIn}
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              <SelectItem value="google">Google</SelectItem>
              <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="名称">
          <Input
            value={displayName}
            disabled={selected?.builtIn}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <Field label="Base URL">
          <Input
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
            placeholder="https://example.com/v1"
            disabled={selected?.builtIn}
          />
        </Field>
        {selected?.builtIn ? (
          <div className="bg-muted/40 rounded-lg border p-3 text-xs">
            内置中转站凭据由账号登录自动管理，不需要手工填写 API Key。
          </div>
        ) : (
          <Field label={selected ? "API Key（留空则保持原值）" : "API Key"}>
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
            />
          </Field>
        )}
        <Field label="模型">
          <div className="flex gap-2">
            <Input
              value={models}
              onChange={(event) => setModels(event.target.value)}
              placeholder="gpt-5, gpt-image-1"
              disabled={selected?.builtIn}
            />
            {selected && (
              <Button type="button" variant="outline" onClick={() => void refreshModels()} disabled={busy}>
                <RefreshCw className={busy ? "animate-spin" : ""} /> 获取
              </Button>
            )}
          </div>
        </Field>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <div className="flex items-center justify-between pt-2">
          <div>
            {selected && !selected.builtIn && (
              <Button type="button" variant="destructive" onClick={() => void remove()} disabled={busy}>
                <Trash2 /> 删除
              </Button>
            )}
          </div>
          {!selected?.builtIn && (
            <Button type="button" onClick={() => void save()} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              保存
            </Button>
          )}
        </div>
      </div>
    </section>
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
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="font-semibold">主题</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Workspace 与设置跟随主题；Create Studio 保持专注创作的深色界面。
        </p>
      </div>
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
    </section>
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
    void window.tietiezhi.updates.state().then((next) => {
      if (active) setState(next);
    });
    const dispose = window.tietiezhi.onUpdateEvent((event) => {
      if (active) setState(event.state);
    });
    return () => {
      active = false;
      dispose();
    };
  }, [open]);

  const run = async (action: () => Promise<UpdateState>) => {
    setActionBusy(true);
    try {
      setState(await action());
    } finally {
      setActionBusy(false);
    }
  };

  if (state === undefined) {
    return (
      <div className="grid min-h-48 place-items-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  const active = actionBusy || state.status === "checking" || state.status === "downloading";
  const architecture =
    state.architecture === "arm64"
      ? "Apple Silicon"
      : state.architecture === "x64"
        ? "Intel x64"
        : state.architecture;

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h3 className="font-semibold">Tietiezhi Desktop</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          自动匹配当前系统和 CPU 架构，下载完成后可直接重启安装。
        </p>
      </div>

      <div className="rounded-xl border">
        <div className="flex items-center gap-4 p-5">
          <div className="bg-primary/10 text-primary grid size-11 shrink-0 place-items-center rounded-xl">
            <Monitor className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">当前版本 v{state.currentVersion}</p>
              <Badge variant={state.status === "error" ? "destructive" : "secondary"}>
                {UPDATE_STATUS_LABEL[state.status]}
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              {state.platform === "darwin" ? "macOS" : state.platform === "win32" ? "Windows" : state.platform}
              {" · "}
              {architecture}
            </p>
          </div>
          {state.status !== "downloaded" && state.status !== "available" && (
            <Button
              type="button"
              variant="outline"
              disabled={!state.supported || active}
              onClick={() => void run(() => window.tietiezhi.updates.check())}
            >
              {active ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              检查更新
            </Button>
          )}
        </div>

        {(state.status === "available" ||
          state.status === "downloading" ||
          state.status === "downloaded") && (
          <div className="border-t p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold">
                  新版本 v{state.availableVersion ?? "未知"}
                </p>
                {state.releaseDate && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    发布时间 {new Date(state.releaseDate).toLocaleString("zh-CN")}
                  </p>
                )}
              </div>
              {state.status === "available" && (
                <Button
                  type="button"
                  disabled={active}
                  onClick={() => void run(() => window.tietiezhi.updates.download())}
                >
                  <Download />
                  下载更新
                </Button>
              )}
              {state.status === "downloaded" && (
                <Button type="button" onClick={() => void window.tietiezhi.updates.install()}>
                  <CheckCircle2 />
                  重启并安装
                </Button>
              )}
            </div>

            {state.status === "downloading" && (
              <div className="mt-4 space-y-2">
                <progress
                  className="accent-primary h-2 w-full overflow-hidden rounded-full"
                  value={state.percent ?? 0}
                  max={100}
                />
                <div className="text-muted-foreground flex justify-between text-xs">
                  <span>
                    {formatBytes(state.transferred)} / {formatBytes(state.total)}
                  </span>
                  <span>
                    {(state.percent ?? 0).toFixed(1)}% · {formatBytes(state.bytesPerSecond)}/s
                  </span>
                </div>
              </div>
            )}

            {state.releaseNotes && (
              <p className="text-muted-foreground mt-4 whitespace-pre-wrap text-sm leading-6">
                {state.releaseNotes}
              </p>
            )}
          </div>
        )}
      </div>

      {state.status === "not-available" && (
        <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="size-4" />
          当前已经是最新版本。
        </div>
      )}
      {state.error && (
        <div className="text-destructive bg-destructive/10 rounded-lg px-3 py-2.5 text-sm">
          {state.error}
        </div>
      )}
      <div className="bg-muted/40 rounded-lg p-3 text-xs leading-5">
        Windows 使用 NSIS 差分下载；macOS 从第二次应用内更新开始复用本地更新缓存进行差分下载。
        如果差分条件不满足，会自动回退为完整安装包。
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
