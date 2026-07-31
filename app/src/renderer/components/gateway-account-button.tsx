import { useEffect, useState } from "react";
import {
  ChevronUp,
  CircleGauge,
  Loader2,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Settings,
  Sun,
  UserRound,
} from "lucide-react";

import { useTheme, type Theme } from "@/components/theme-provider";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { GatewayAccount, GatewayAccountView } from "@shared/contracts";

const DICEBEAR_TOON_HEAD_URL = "https://api.dicebear.com/9.x/toon-head/svg";
const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

function virtualAvatarUrl(account: GatewayAccount): string {
  const seed =
    account.nickname.trim() || account.email.trim() || String(account.userId);
  const params = new URLSearchParams({
    seed,
    size: "96",
    radius: "50",
    backgroundColor: "b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf",
    backgroundType: "gradientLinear",
  });
  return `${DICEBEAR_TOON_HEAD_URL}?${params.toString()}`;
}

function initials(view?: GatewayAccountView): string {
  const label = view?.account?.nickname || view?.account?.email.split("@")[0] || "";
  return label.slice(0, 2).toUpperCase();
}

export function GatewayAccountButton({
  compact = false,
  onOpenSettings,
  onChanged,
}: {
  compact?: boolean;
  onOpenSettings: (category?: "account" | "providers" | "appearance") => void;
  onChanged: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const [view, setView] = useState<GatewayAccountView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    setError("");
    try {
      setView(await window.tietiezhi.gateway.account());
    } catch (cause) {
      setView({ providerId: "builtin-official", supported: false, loggedIn: false });
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => { void refresh(); }, []);

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
  const displayName = loggedIn ? account.nickname || account.email : view?.supported === false ? "铁铁汁" : "登录中转站";
  const subtitle = loggedIn ? account.email : view?.supported === false ? "本地模式 · 中转站暂不可达" : "同步账号与额度";
  const avatarUrl = loggedIn ? virtualAvatarUrl(account) : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label="用户菜单">
            {busy ? <Loader2 className="animate-spin" /> : (
              <Avatar className="size-6">
                {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                <AvatarFallback className="text-[9px]">{initials(view) || <UserRound className="size-3" />}</AvatarFallback>
              </Avatar>
            )}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground h-auto w-full justify-start gap-2 px-2 py-2"
          >
            <Avatar className="size-8">
              {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
              <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground text-[11px] font-semibold">
                {busy ? <Loader2 className="size-4 animate-spin" /> : initials(view) || <UserRound className="size-4" />}
              </AvatarFallback>
            </Avatar>
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate text-sm font-medium">{displayName}</span>
              <span className="text-muted-foreground truncate text-[11px]">{subtitle}</span>
            </span>
            <ChevronUp className="text-muted-foreground ml-auto size-4" />
          </Button>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side={compact ? "bottom" : "top"}
        align={compact ? "end" : "start"}
        sideOffset={8}
        collisionPadding={8}
        className={cn(
          "max-w-[calc(100vw-1rem)] rounded-xl bg-popover/95 p-1.5 shadow-none backdrop-blur-xl",
          compact
            ? "w-64"
            : "w-(--radix-dropdown-menu-trigger-width) min-w-60 max-w-80",
        )}
      >
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2.5 px-2 py-2 text-left">
            <Avatar className="size-9">
              {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
              <AvatarFallback className="text-xs font-semibold">{initials(view) || <UserRound className="size-4" />}</AvatarFallback>
            </Avatar>
            <div className="grid min-w-0 flex-1 leading-tight">
              <span className="truncate text-sm font-semibold">{displayName}</span>
              <span className="text-muted-foreground truncate text-xs">{subtitle}</span>
            </div>
          </div>
        </DropdownMenuLabel>

        {error && <p className="text-destructive px-2 py-1.5 text-xs">{error}</p>}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {loggedIn ? (
            <DropdownMenuItem className="min-h-9 gap-2 px-2 whitespace-nowrap" onSelect={() => onOpenSettings("account")}>
              <CircleGauge /> <span>额度中心</span>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem className="min-h-9 gap-2 px-2 whitespace-nowrap" disabled={busy} onSelect={() => void login()}>
              {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
              <span>{view?.supported === false ? "重试连接并登录" : "登录中转站"}</span>
            </DropdownMenuItem>
          )}

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="min-h-9 gap-2 px-2 whitespace-nowrap">
              <Palette />
              <span>主题外观</span>
              <span className="text-muted-foreground ml-auto mr-1 text-xs">
                {THEME_OPTIONS.find((option) => option.value === theme)?.label}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-36 rounded-lg">
              <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                {THEME_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value} className="min-h-8 gap-2">
                    <option.icon className={cn("text-muted-foreground", theme === option.value && "text-foreground")} />
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuItem className="min-h-9 gap-2 px-2 whitespace-nowrap" onSelect={() => onOpenSettings()}>
            <Settings /> <span>设置</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        {loggedIn && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" className="min-h-9 gap-2 px-2 whitespace-nowrap" disabled={busy} onSelect={() => void logout()}>
              {busy ? <Loader2 className="animate-spin" /> : <LogOut />}
              <span>退出登录</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
