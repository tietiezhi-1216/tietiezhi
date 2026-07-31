import { useEffect, useState } from "react";
import {
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
} from "@shared/contracts";

type SettingsCategory = "account" | "providers" | "appearance";

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
    items: [{ id: "appearance", label: "外观", icon: Palette }],
  },
] as const;

const CATEGORY_LABELS: Record<SettingsCategory, string> = {
  account: "中转站账号",
  providers: "供应商",
  appearance: "外观",
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
