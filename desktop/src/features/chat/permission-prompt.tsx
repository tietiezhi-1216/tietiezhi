import { memo } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PermissionDecision } from "@/lib/api";
import { useChatStore } from "@/stores/chat";
import type { ChatItem } from "@/stores/chat";

type PermissionItem = Extract<ChatItem, { kind: "permission" }>;

const decisionLabel: Record<PermissionDecision, string> = {
  allow: "已允许",
  allowAlways: "已允许（本会话不再询问）",
  deny: "已拒绝",
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
        {item.description} — {decisionLabel[item.decision]}
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
      <div className="flex items-center gap-2">
        <Button size="sm" className="h-7" onClick={() => answer("allow")}>
          允许一次
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => answer("allowAlways")}
        >
          本会话始终允许
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:text-destructive h-7"
          onClick={() => answer("deny")}
        >
          拒绝
        </Button>
      </div>
    </div>
  );
});
