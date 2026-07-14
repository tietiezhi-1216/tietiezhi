import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatPage } from "@/features/chat/chat-page";
import { ProvidersPage } from "@/features/providers/providers-page";
import { SettingsPage } from "@/features/settings/settings-page";
import { useUiStore } from "@/stores/ui";
import type { Page } from "@/stores/ui";

const PAGE_TITLES: Record<Page, string> = {
  chat: "聊天",
  providers: "接入配置",
  settings: "设置",
};

export default function App() {
  const page = useUiStore((s) => s.page);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4!" />
          <span className="text-sm font-medium">{PAGE_TITLES[page]}</span>
        </header>
        <div className="min-h-0 flex-1">
          {page === "chat" && <ChatPage />}
          {page === "providers" && <ProvidersPage />}
          {page === "settings" && <SettingsPage />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
