import { memo } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  Wrench,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ChatItem } from "@/stores/chat";

type ToolCallItem = Extract<ChatItem, { kind: "toolCall" }>;

const prettyArgs = (args: unknown): string => {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
};

/** One tool invocation in the transcript, collapsed to a single status row. */
export const ToolCallCard = memo(function ToolCallCard({
  item,
}: {
  item: ToolCallItem;
}) {
  const args = prettyArgs(item.args);
  const running = item.status === "running";

  return (
    <Collapsible defaultOpen={false} className="w-full">
      <div className="border-border/70 bg-muted/30 rounded-lg border">
        <CollapsibleTrigger className="group/tool flex w-full items-center gap-2 px-3 py-2 text-left">
          {running ? (
            <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
          ) : item.status === "success" ? (
            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
          ) : (
            <XCircle className="text-destructive size-3.5 shrink-0" />
          )}
          <Wrench className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate font-mono text-xs font-medium">{item.name}</span>
          <Badge
            variant={item.status === "error" ? "destructive" : "secondary"}
            className="ml-auto shrink-0 text-[10px]"
          >
            {running ? "运行中" : item.status === "success" ? "完成" : "失败"}
          </Badge>
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[state=open]/tool:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-border/70 flex flex-col gap-2 border-t px-3 py-2">
            {args && (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-[11px]">参数</span>
                <pre className="bg-background max-h-40 overflow-auto rounded-md p-2 text-[11px] leading-relaxed break-all whitespace-pre-wrap select-text">
                  {args}
                </pre>
              </div>
            )}
            {item.output != null && (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-[11px]">结果</span>
                <pre
                  className={cn(
                    "bg-background max-h-60 overflow-auto rounded-md p-2 text-[11px] leading-relaxed break-all whitespace-pre-wrap select-text",
                    item.status === "error" && "text-destructive",
                  )}
                >
                  {item.output}
                </pre>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});
