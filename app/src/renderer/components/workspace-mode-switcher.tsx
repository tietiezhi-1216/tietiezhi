import { BriefcaseBusiness, Code2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskMode } from "@shared/contracts";

const MODES = [
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
] as const;

export function WorkspaceModeSwitcher({
  value,
  disabled,
  onChange,
}: {
  value: TaskMode;
  disabled: boolean;
  onChange: (mode: TaskMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="任务工作方式"
      className="bg-muted/65 flex h-8 items-center rounded-lg border p-0.5 shadow-xs"
    >
      {MODES.map((mode) => {
        const selected = value === mode.id;
        const Icon = mode.icon;
        return (
          <Button
            key={mode.id}
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-pressed={selected}
            title={disabled ? "当前任务运行结束后可切换工作方式" : mode.title}
            onClick={() => onChange(mode.id)}
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
