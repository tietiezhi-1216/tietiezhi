import { memo } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PermissionDecision } from "@/lib/api";
import { useChatStore } from "@/stores/chat";
import type { ChatItem } from "@/stores/chat";

type PermissionItem = Extract<ChatItem, { kind: "permission" }>;

const decisionLabel: Record<PermissionDecision, string> = {
  accept: "已允许一次",
  acceptForSession: "已允许此作用域",
  decline: "已拒绝并继续",
  cancel: "已停止任务",
};

/** Inline approval card for a tool call awaiting user permission. */
export const PermissionPrompt = memo(function PermissionPrompt({
  item,
}: {
  item: PermissionItem;
}) {
  const respondPermission = useChatStore((s) => s.respondPermission);

  // Already answered (or restored from disk): a quiet one-liner.
  if (item.decision) {
    return (
      <p className="text-muted-foreground text-xs">
        {item.description}：{decisionLabel[item.decision]}
      </p>
    );
  }

  const answer = (decision: PermissionDecision) => {
    if (!item.requestId) return;
    respondPermission(item.requestId, decision);
  };

  return (
    <div className="border-amber-500/40 bg-amber-500/5 flex flex-col gap-2.5 rounded-lg border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 shrink-0 text-amber-500" />
        <span className="text-sm font-medium">需要你的许可</span>
        <span className="text-muted-foreground truncate font-mono text-xs">
          {item.tool}
        </span>
      </div>
      <p className="text-sm break-all select-text">{item.description}</p>
      {item.scope ? (
        <p className="text-muted-foreground rounded-md bg-black/5 px-2 py-1.5 font-mono text-xs break-all select-text dark:bg-white/5">
          {item.scope}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-7" onClick={() => answer("accept")}>
          允许一次
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => answer("acceptForSession")}
        >
          本作用域允许
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:text-destructive h-7"
          onClick={() => answer("decline")}
        >
          拒绝并继续
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          onClick={() => answer("cancel")}
        >
          停止任务
        </Button>
      </div>
    </div>
  );
});
