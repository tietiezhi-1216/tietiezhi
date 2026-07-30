import { useEffect, useState } from "react";
import { ChevronUp, Loader2, LogIn, LogOut, Settings, UserRound } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { GatewayAccountView } from "@shared/contracts";

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
  onOpenSettings: () => void;
  onChanged: () => void;
}) {
  const [view, setView] = useState<GatewayAccountView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    setError("");
    try {
      setView(await window.tietiezhi.gateway.account());
    } catch (cause) {
      setView({
        providerId: "builtin-official",
        supported: false,
        loggedIn: false,
      });
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label="中转站账号">
            {busy ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Avatar className="size-6">
                <AvatarFallback className="text-[9px]">
                  {initials(view) || <UserRound className="size-3" />}
                </AvatarFallback>
              </Avatar>
            )}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start gap-2 px-2 py-2"
          >
            <Avatar className="size-7">
              <AvatarFallback className="text-[10px]">
                {initials(view) || <UserRound className="size-3.5" />}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-xs font-medium">
                {loggedIn ? account.nickname || account.email : "登录中转站"}
              </span>
              <span className="text-muted-foreground block truncate text-[10px]">
                {loggedIn ? account.email : busy ? "等待浏览器授权" : "使用 Tietiezhi Gateway"}
              </span>
            </span>
            {busy ? <Loader2 className="animate-spin" /> : <ChevronUp className="size-3.5" />}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={compact ? "bottom" : "top"} align="end" className="w-64">
        <DropdownMenuLabel>
          <span className="block text-xs">{loggedIn ? account.nickname || account.email : "Tietiezhi Gateway"}</span>
          <span className="text-muted-foreground block truncate text-[10px] font-normal">
            {loggedIn ? account.email : view?.supported === false ? "暂时无法连接中转站" : "登录后同步模型访问凭据"}
          </span>
        </DropdownMenuLabel>
        {error && (
          <>
            <DropdownMenuSeparator />
            <p className="text-destructive px-2 py-1.5 text-xs">{error}</p>
          </>
        )}
        <DropdownMenuSeparator />
        {loggedIn ? (
          <DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => void logout()}>
            <LogOut /> 退出登录
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={busy} onSelect={() => void login()}>
            {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
            {busy ? "等待浏览器授权" : "登录中转站"}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onOpenSettings}>
          <Settings /> 模型供应商设置
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
