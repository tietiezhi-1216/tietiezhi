import { PanelRightClose, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IntegratedTerminalPanel } from "@/features/chat/integrated-terminal-panel";
import { RemoteRealtimePanel } from "@/features/chat/remote-realtime-panel";
import { WorkspaceModePanel } from "@/features/chat/workspace-mode-panel";
import type { TaskMode } from "@/lib/task-mode";
import { useUiStore } from "@/stores/ui";

export function WorkspaceToolsPanel({
  taskId,
  taskMode,
}: {
  taskId: string;
  taskMode: TaskMode;
}) {
  const setWorkspacePanelOpen = useUiStore(
    (state) => state.setWorkspacePanelOpen,
  );

  return (
    <aside
      aria-label="工作区工具"
      className="bg-background absolute inset-y-0 right-0 z-30 flex w-[min(25rem,92vw)] shrink-0 flex-col border-l shadow-2xl md:relative md:inset-auto md:z-auto md:w-[min(25rem,42vw)] md:min-w-80 md:shadow-none"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Wrench className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">工作区</span>
        <span className="text-muted-foreground text-xs">
          环境、Apps 与运行工具
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={() => setWorkspacePanelOpen(false)}
          aria-label="收起工作区面板"
          title="收起工作区面板"
        >
          <PanelRightClose />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          <WorkspaceModePanel embedded />
          {taskMode === "code" && (
            <>
              <RemoteRealtimePanel threadId={taskId} embedded />
              <IntegratedTerminalPanel taskId={taskId} embedded />
            </>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
