import { BriefcaseBusiness, Code2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskMode } from "@/lib/task-mode";
import { useChatStore } from "@/stores/chat";

const MODES: readonly {
  id: TaskMode;
  name: string;
  title: string;
  icon: typeof BriefcaseBusiness;
}[] = [
  {
    id: "work",
    name: "Work",
    title: "切换到 Work 工作方式（共享当前工作区）",
    icon: BriefcaseBusiness,
  },
  {
    id: "code",
    name: "Code",
    title: "切换到 Code 工作方式（共享当前工作区）",
    icon: Code2,
  },
];

export function WorkspaceModeSwitcher() {
  const taskMode = useChatStore((state) => state.taskMode);
  const setTaskMode = useChatStore((state) => state.setTaskMode);
  const streaming = useChatStore((state) => state.streaming);

  return (
    <div
      role="group"
      aria-label="任务工作方式"
      className="bg-muted/65 flex h-8 items-center rounded-lg border p-0.5 shadow-xs"
    >
      {MODES.map((mode) => {
        const selected = taskMode === mode.id;
        const Icon = mode.icon;
        return (
          <Button
            key={mode.id}
            type="button"
            variant="ghost"
            size="sm"
            disabled={streaming}
            aria-pressed={selected}
            title={streaming ? "当前任务运行结束后可切换工作方式" : mode.title}
            onClick={() => setTaskMode(mode.id)}
            className={cn(
              "text-muted-foreground h-6 gap-1 rounded-md border border-transparent px-2 text-[11px] font-medium shadow-none transition-[color,background-color,border-color,box-shadow]",
              selected &&
                mode.id === "work" &&
                "border-cyan-500/20 bg-cyan-500/10 text-cyan-700 shadow-xs dark:text-cyan-300",
              selected &&
                mode.id === "code" &&
                "border-violet-500/20 bg-violet-500/10 text-violet-700 shadow-xs dark:text-violet-300",
            )}
          >
            <Icon className="size-3" />
            {mode.name}
          </Button>
        );
      })}
    </div>
  );
}
