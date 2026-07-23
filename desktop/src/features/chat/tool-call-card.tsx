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
  now,
}: {
  item: ToolCallItem;
  now: number;
}) {
  const args = prettyArgs(item.args);
  const running = item.status === "running";
  const durationMs = running
    ? Math.max(0, now - item.createdAt)
    : (item.durationMs ?? 0);
  const duration =
    durationMs < 1_000
      ? `${durationMs}ms`
      : `${Math.floor(durationMs / 1_000)}s`;
  const waitingWithoutOutput =
    running && durationMs >= 30_000 && !item.output?.trim();
  const statusLabel =
    item.status === "running"
      ? "运行中"
      : item.status === "success"
        ? "完成"
        : item.status === "cancelled"
          ? "已停止"
          : item.timedOut
            ? "已超时"
            : "失败";

  return (
    <Collapsible defaultOpen={false} className="w-full">
      <div className="border-border/70 bg-muted/30 rounded-lg border">
        <CollapsibleTrigger className="group/tool flex w-full items-center gap-2 px-3 py-2 text-left">
          {running ? (
            <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
          ) : item.status === "success" ? (
            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
          ) : (
            <XCircle
              className={cn(
                "size-3.5 shrink-0",
                item.status === "cancelled"
                  ? "text-amber-500"
                  : "text-destructive",
              )}
            />
          )}
          <Wrench className="text-muted-foreground size-3.5 shrink-0" />
          <span
            className={cn(
              "truncate font-mono text-xs font-medium",
              running && "text-shimmer",
            )}
          >
            {item.name}
          </span>
          <Badge
            variant={item.status === "error" ? "destructive" : "secondary"}
            className="ml-auto shrink-0 text-[10px]"
          >
            {statusLabel} · {duration}
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
            <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
              {item.timeoutMs != null && running && (
                <span>最长 {Math.floor(item.timeoutMs / 1_000)}s</span>
              )}
              {item.exitCode != null && <span>退出码 {item.exitCode}</span>}
              {item.truncated && <span>输出已保留首尾并截断中间部分</span>}
            </div>
            {waitingWithoutOutput && (
              <div className="border-amber-500/30 bg-amber-500/5 rounded-md border px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                30 秒内尚未收到输出。命令可能正在等待输入、网络或外部进程；可停止后改用非交互命令。
              </div>
            )}
            {item.output != null && (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-[11px]">
                  {running ? "实时输出" : "结果"}
                </span>
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
