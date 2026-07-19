import { useEffect } from "react";
import { SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
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
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden">
        <AppHeader title={title} />
        <div className="min-h-0 flex-1">
          <ChatPage />
        </div>
      </SidebarInset>
      <SettingsDialog />
      <AgentsDialog />
    </SidebarProvider>
  );
}

function AppHeader({ title }: { title: string }) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const newConversation = useChatStore((s) => s.newConversation);

  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center gap-3 border-b px-3"
    >
      {collapsed && IS_MACOS && (
        <div
          data-tauri-drag-region
          aria-hidden="true"
          className="w-16 shrink-0"
        />
      )}
      {collapsed && (
        <div className="flex shrink-0 items-center gap-1">
          <SidebarTrigger />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="新建任务"
            aria-label="新建任务"
            onClick={() => newConversation()}
          >
            <SquarePen />
          </Button>
        </div>
      )}
      <span
        data-tauri-drag-region
        className="min-w-0 truncate text-sm font-medium"
      >
        {title}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <AgentSelect />
      </div>
    </header>
  );
}
