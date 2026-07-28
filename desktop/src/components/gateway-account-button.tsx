import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronUp,
  CircleGauge,
  Loader2,
  LogIn,
  LogOut,
  Mic,
  Monitor,
  Moon,
  Palette,
  Settings,
  Sun,
  UserRound,
} from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import type { Theme } from "@/components/theme-provider";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  dictationHotkey,
  gatewayAccount,
  gatewayLogin,
  gatewayLogout,
  listProviders,
  loadSettings,
} from "@/lib/api";
import type { GatewayAccount } from "@/lib/api";
import { formatShortcut } from "@/lib/shortcut";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";

const DICEBEAR_TOON_HEAD_URL = "https://api.dicebear.com/9.x/toon-head/svg";

const THEME_OPTIONS: Array<{
  value: Theme;
  label: string;
  icon: typeof Sun;
}> = [
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

function accountInitials(account?: GatewayAccount): string {
  const label = account?.nickname.trim() || account?.email.split("@")[0] || "";
  return label.slice(0, 2).toUpperCase();
}

export function GatewayAccountButton() {
  const queryClient = useQueryClient();
  const openSettings = useUiStore((state) => state.openSettings);
  const { theme, setTheme } = useTheme();
  const providersQuery = useQuery({
    queryKey: ["providers"],
    queryFn: listProviders,
  });
  const provider = providersQuery.data?.find((item) => item.builtIn);
  const accountQuery = useQuery({
    queryKey: ["gateway-account", provider?.id],
    queryFn: () => gatewayAccount(provider!.id),
    enabled: Boolean(provider),
    retry: false,
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: loadSettings,
  });
  const hotkeyQuery = useQuery({
    queryKey: ["dictationHotkey"],
    queryFn: dictationHotkey,
  });

  const invalidateAccountState = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["gateway-account", provider?.id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["gateway-quota", provider?.id],
      }),
      queryClient.invalidateQueries({ queryKey: ["providers"] }),
      queryClient.invalidateQueries({ queryKey: ["settings"] }),
    ]);
  };

  const login = useMutation({
    mutationFn: () => gatewayLogin(provider!.id),
    onSuccess: async (account) => {
      queryClient.setQueryData(["gateway-account", provider?.id], account);
      await invalidateAccountState();
    },
  });
  const logout = useMutation({
    mutationFn: () => gatewayLogout(provider!.id),
    onSuccess: invalidateAccountState,
  });

  const gatewaySupported = Boolean(
    provider && accountQuery.data?.supported !== false,
  );
  const account = accountQuery.data?.account;
  const loggedIn = Boolean(accountQuery.data?.loggedIn && account);
  const authPending =
    providersQuery.isLoading ||
    login.isPending ||
    logout.isPending ||
    accountQuery.isLoading;
  const dictationReady = Boolean(
    settingsQuery.data?.asrProviderId &&
      settingsQuery.data?.asrModel &&
      (!settingsQuery.data?.polishEnabled ||
        (settingsQuery.data?.polishProviderId && settingsQuery.data?.polishModel)),
  );
  const displayName = loggedIn
    ? account!.nickname.trim() || account!.email
    : gatewaySupported
      ? "登录中转站"
      : "铁铁汁";
  const subtitle = loggedIn
    ? account!.email
    : login.isError
      ? "登录失败，点击菜单重试"
      : gatewaySupported
        ? "同步账号与额度"
        : "本地模式 · 中转站暂不可达";
  const avatarUrl = loggedIn ? virtualAvatarUrl(account!) : undefined;
  const initials = accountInitials(account);

  return (
    <SidebarMenu className="group-data-[collapsible=icon]:items-center">
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={loggedIn ? account?.email : "用户菜单"}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:justify-center"
            >
              <Avatar className="size-8">
                {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground text-[11px] font-semibold">
                  {authPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : initials ? (
                    initials
                  ) : (
                    <UserRound className="size-4" />
                  )}
                </AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-medium">{displayName}</span>
                <span className="text-muted-foreground truncate text-[11px]">
                  {subtitle}
                </span>
              </div>
              <ChevronUp className="text-muted-foreground ml-auto size-4 group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-(--radix-dropdown-menu-trigger-width) min-w-60 max-w-80 rounded-xl p-1.5"
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2.5 px-2 py-2 text-left">
                <Avatar className="size-9">
                  {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
                  <AvatarFallback className="text-xs font-semibold">
                    {initials || <UserRound className="size-4" />}
                  </AvatarFallback>
                </Avatar>
                <div className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate text-sm font-semibold">{displayName}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {subtitle}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {loggedIn ? (
                <DropdownMenuItem
                  className="min-h-9 gap-2 px-2"
                  onSelect={() => openSettings("quota")}
                >
                  <CircleGauge />
                  <span>额度中心</span>
                </DropdownMenuItem>
              ) : provider ? (
                // Keep the login entry visible even in local mode (discovery
                // unreachable) — clicking retries discovery via the login
                // flow, so users are never left without a way to sign in.
                <DropdownMenuItem
                  className="min-h-9 gap-2 px-2"
                  disabled={authPending}
                  onSelect={() => {
                    void invalidateAccountState();
                    login.mutate();
                  }}
                >
                  {login.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <LogIn />
                  )}
                  <span>
                    {login.isError
                      ? "重新登录"
                      : gatewaySupported
                        ? "登录中转站"
                        : "重试连接并登录"}
                  </span>
                </DropdownMenuItem>
              ) : null}

              <DropdownMenuItem
                className="min-h-9 gap-2 px-2"
                onSelect={() => openSettings("dictationModel")}
              >
                <Mic />
                <span className="min-w-0 flex-1">
                  <span className="block">语音听写</span>
                  <span className="text-muted-foreground block truncate text-[10px]">
                    {dictationReady
                      ? `已就绪 · ${settingsQuery.data?.asrModel}`
                      : settingsQuery.data?.asrProviderId && settingsQuery.data?.asrModel
                        ? "未配置润色模型"
                        : "未配置识别模型"}
                  </span>
                </span>
                <DropdownMenuShortcut className="tracking-normal">
                  {formatShortcut(hotkeyQuery.data ?? "Alt+Space")}
                </DropdownMenuShortcut>
              </DropdownMenuItem>

              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="min-h-9 gap-2 px-2">
                  <Palette />
                  <span>主题外观</span>
                  <span className="text-muted-foreground ml-auto mr-1 text-xs">
                    {THEME_OPTIONS.find((option) => option.value === theme)?.label}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-36 rounded-lg">
                  <DropdownMenuRadioGroup
                    value={theme}
                    onValueChange={(value) => setTheme(value as Theme)}
                  >
                    {THEME_OPTIONS.map((option) => (
                      <DropdownMenuRadioItem
                        key={option.value}
                        value={option.value}
                        className="min-h-8 gap-2"
                      >
                        <option.icon
                          className={cn(
                            "text-muted-foreground",
                            theme === option.value && "text-foreground",
                          )}
                        />
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuItem
                className="min-h-9 gap-2 px-2"
                onSelect={() => openSettings()}
              >
                <Settings />
                <span>设置</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>

            {loggedIn && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  className="min-h-9 gap-2 px-2"
                  disabled={logout.isPending}
                  onSelect={() => logout.mutate()}
                >
                  {logout.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <LogOut />
                  )}
                  <span>退出登录</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
