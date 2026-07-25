import { lazy, Suspense, useEffect } from "react";
import { LoaderCircle, Settings, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UpdateReadyButton } from "@/components/update-ready-button";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ProductAreaSwitcher } from "@/components/product-area-switcher";
import { WorkspaceModeSwitcher } from "@/components/workspace-mode-switcher";
import { AgentsDialog } from "@/features/agents/agents-dialog";
import { AgentSelect } from "@/features/chat/agent-select";
import { ChatPage } from "@/features/chat/chat-page";
import { CreatePage } from "@/features/create/create-page";
import { ProductAreaPlaceholder } from "@/features/product-area-placeholder";
import { TietiezhiPage } from "@/features/tietiezhi/tietiezhi-page";
import { TietiezhiDeviceControl } from "@/features/tietiezhi/device-control";
import { TietiezhiControlCenter } from "@/features/tietiezhi/tietiezhi-control-center";
import { SettingsDialog } from "@/features/settings/settings-dialog";
import { useChatStore } from "@/stores/chat";
import { useProjectStore } from "@/stores/projects";
import { useUiStore } from "@/stores/ui";
import { useUpdaterStore } from "@/stores/updater";
import { getProductArea } from "@/lib/product-area";
import type { ProductArea } from "@/lib/product-area";

const IS_MACOS = navigator.userAgent.includes("Mac");
const AutomationsPage = lazy(async () => {
  const module = await import("@/features/automations/automations-page");
  return { default: module.AutomationsPage };
});

export default function App() {
  const activeId = useChatStore((s) => s.activeId);
  const conversations = useChatStore((s) => s.conversations);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const productArea = useUiStore((s) => s.productArea);
  const checkAndDownloadUpdate = useUpdaterStore((s) => s.checkAndDownload);
  const title =
    productArea === "workspace"
      ? conversations.find((c) => c.id === activeId)?.title ?? "新建任务"
      : getProductArea(productArea).name;

  // Load the persisted conversation list once on startup.
  useEffect(() => {
    void (async () => {
      // Task loading performs the one-time legacy migration, which can create
      // projects from previously picked workspaces. Load projects afterwards.
      await useChatStore.getState().init();
      await useProjectStore.getState().init();
    })();
  }, []);

  useEffect(() => {
    void checkAndDownloadUpdate();
  }, [checkAndDownloadUpdate]);

  return (
    <SidebarProvider width={`${sidebarWidth}px`}>
      {productArea === "workspace" && <AppSidebar />}
      <SidebarInset className="h-svh overflow-hidden">
        <AppHeader title={title} productArea={productArea} />
        <div className="min-h-0 flex-1">
          {productArea === "workspace" ? (
            <ChatPage />
          ) : productArea === "tietiezhi" ? (
            <TietiezhiPage />
          ) : productArea === "create" ? (
            <CreatePage />
          ) : productArea === "automations" ? (
            <Suspense fallback={<AutomationLoading />}>
              <AutomationsPage />
            </Suspense>
          ) : (
            <ProductAreaPlaceholder area={productArea} />
          )}
        </div>
      </SidebarInset>
      <SettingsDialog />
      <AgentsDialog />
    </SidebarProvider>
  );
}

function AutomationLoading() {
  return (
    <div className="text-muted-foreground grid h-full place-items-center text-sm">
      <span className="flex items-center gap-2">
        <LoaderCircle className="size-4 animate-spin" />
        正在加载 Automation
      </span>
    </div>
  );
}

function AppHeader({
  title,
  productArea,
}: {
  title: string;
  productArea: ProductArea;
}) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const newConversation = useChatStore((s) => s.newConversation);
  const openSettings = useUiStore((state) => state.openSettings);

  const workspace = productArea === "workspace";

  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center gap-3 border-b px-3"
    >
      {workspace && collapsed && IS_MACOS && (
        <div
          data-tauri-drag-region
          aria-hidden="true"
          className="w-16 shrink-0"
        />
      )}
      {!workspace && IS_MACOS && (
        <div
          data-tauri-drag-region
          aria-hidden="true"
          className="w-16 shrink-0"
        />
      )}
      {workspace && collapsed && <ProductAreaSwitcher variant="header" />}
      {workspace && !collapsed && <SidebarTrigger />}
      {workspace && collapsed && (
        <div className="flex shrink-0 items-center gap-1">
          <SidebarTrigger />
          {workspace && (
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
          )}
        </div>
      )}
      {workspace ? (
        <span
          data-tauri-drag-region
          className={
            collapsed
              ? "text-muted-foreground min-w-0 truncate text-sm"
              : "min-w-0 truncate text-sm font-medium"
          }
        >
          {title}
        </span>
      ) : (
        <ProductAreaSwitcher variant="header" />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {workspace && (
          <>
            <WorkspaceModeSwitcher />
            <AgentSelect />
          </>
        )}
        {productArea === "tietiezhi" && (
          <>
            <TietiezhiDeviceControl />
            <TietiezhiControlCenter />
          </>
        )}
        <UpdateReadyButton />
        {!workspace && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => openSettings()}
            aria-label="设置"
          >
            <Settings />
          </Button>
        )}
      </div>
    </header>
  );
}
