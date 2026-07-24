import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, LogIn, UserRound } from "lucide-react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  gatewayAccount,
  gatewayLogin,
  listProviders,
} from "@/lib/api";
import { useUiStore } from "@/stores/ui";

export function GatewayAccountButton() {
  const queryClient = useQueryClient();
  const openSettings = useUiStore((state) => state.openSettings);
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
  const login = useMutation({
    mutationFn: () => gatewayLogin(provider!.id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["gateway-account", provider?.id] }),
        queryClient.invalidateQueries({ queryKey: ["providers"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
  });

  if (!provider || accountQuery.data?.supported === false) return null;
  const account = accountQuery.data?.account;
  const loggedIn = Boolean(accountQuery.data?.loggedIn && account);
  const pending = login.isPending || accountQuery.isLoading;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="h-auto min-h-11 border py-2"
          tooltip={loggedIn ? account?.email : "登录中转站"}
          onClick={() => {
            if (loggedIn) {
              openSettings("quota");
            } else if (!pending) {
              login.mutate();
            }
          }}
        >
          {pending ? (
            <Loader2 className="animate-spin" />
          ) : loggedIn ? (
            <UserRound />
          ) : (
            <LogIn />
          )}
          <span className="flex min-w-0 flex-col">
            <strong className="truncate text-xs font-medium">
              {loggedIn ? account?.nickname || account?.email : "登录中转站"}
            </strong>
            <small className="text-muted-foreground truncate text-[10px]">
              {loggedIn
                ? account?.email
                : login.isError
                  ? "登录失败，点击重试"
                  : "可选，不登录也能使用"}
            </small>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
