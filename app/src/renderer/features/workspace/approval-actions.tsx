import { useState } from "react";
import { Check, ChevronDown, Loader2, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ApprovalDecision, ApprovalRecord } from "@shared/contracts";

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ApprovalActions({
  approval,
  onResolve,
  showInput = false,
}: {
  approval: ApprovalRecord;
  onResolve: (approvalId: string, decision: ApprovalDecision) => Promise<void>;
  showInput?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const answer = async (decision: ApprovalDecision) => {
    if (pending) return;
    setPending(true);
    setFailure("");
    try {
      await onResolve(approval.id, decision);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  };
  return (
    <div className="border-amber-500/60 mt-1 space-y-2 border-l-2 py-1.5 pl-3">
      <div className="flex items-start gap-2 font-medium">
        <ShieldAlert className="size-3.5 text-amber-500" />
        <span className="min-w-0 flex-1 leading-5">{approval.description}</span>
        <span className="text-muted-foreground shrink-0 text-[10px] font-normal">
          {approval.risk === "high" ? "高风险" : "需要授权"}
        </span>
      </div>
      {showInput && (
        <Collapsible>
          <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px]">
            <ChevronDown className="size-3" /> 查看操作详情
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="bg-muted mt-1.5 max-h-36 overflow-auto rounded-md p-2 text-[10px] whitespace-pre-wrap">
              {formatValue(approval.input)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" disabled={pending} onClick={() => void answer("deny")}>
          <X />拒绝
        </Button>
        <Button type="button" size="xs" variant="outline" disabled={pending} onClick={() => void answer("allow-for-run")}>
          本轮不再询问
        </Button>
        <Button type="button" size="xs" disabled={pending} onClick={() => void answer("allow-once")}>
          {pending ? <Loader2 className="animate-spin" /> : <Check />}允许一次
        </Button>
      </div>
      {failure && <p className="text-destructive text-xs">{failure}</p>}
    </div>
  );
}
