import { MessageSquare, Plug, Settings } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useUiStore } from "@/stores/ui";
import type { Page } from "@/stores/ui";

interface NavItem {
  page: Page;
  title: string;
  icon: typeof MessageSquare;
}

const NAV_ITEMS: NavItem[] = [
  { page: "chat", title: "聊天", icon: MessageSquare },
  { page: "providers", title: "接入配置", icon: Plug },
  { page: "settings", title: "设置", icon: Settings },
];

export function AppSidebar() {
  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <img src="/tietiezhi.png" alt="铁铁汁" className="size-8 rounded-lg" />
          <div className="flex flex-col">
            <span className="text-sm leading-tight font-semibold">铁铁汁</span>
            <span className="text-muted-foreground text-xs leading-tight">
              智能体终端 · 模型枢纽
            </span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.page}>
                  <SidebarMenuButton
                    isActive={page === item.page}
                    onClick={() => setPage(item.page)}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
