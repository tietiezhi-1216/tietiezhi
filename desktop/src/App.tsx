import { useEffect } from "react";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AgentsDialog } from "@/features/agents/agents-dialog";
import { AgentSelect } from "@/features/chat/agent-select";
import { ChatPage } from "@/features/chat/chat-page";
import { SettingsDialog } from "@/features/settings/settings-dialog";
import { useChatStore } from "@/stores/chat";
import { useProjectStore } from "@/stores/projects";
import { useUiStore } from "@/stores/ui";

const IS_MACOS = navigator.userAgent.includes("Mac");

export default function App() {
  const activeId = useChatStore((s) => s.activeId);
  const conversations = useChatStore((s) => s.conversations);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const title = conversations.find((c) => c.id === activeId)?.title ?? "新建任务";

  // Load the persisted conversation list once on startup.
  useEffect(() => {
    void (async () => {
      // Task loading performs the one-time legacy migration, which can create
      // projects from previously picked workspaces. Load projects afterwards.
      await useChatStore.getState().init();
      await useProjectStore.getState().init();
    })();
  }, []);

  return (
    <SidebarProvider width={`${sidebarWidth}px`}>
      {IS_MACOS && (
        <div
          data-tauri-drag-region
          aria-hidden
          className="fixed inset-x-0 top-0 z-40 h-8"
        />
      )}
      <AppSidebar />
      <SidebarInset className={IS_MACOS ? "h-svh overflow-hidden pt-8" : "h-svh overflow-hidden"}>
        <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4!" />
          <span className="truncate text-sm font-medium">{title}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <AgentSelect />
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <ChatPage />
        </div>
      </SidebarInset>
      <SettingsDialog />
      <AgentsDialog />
    </SidebarProvider>
  );
}
