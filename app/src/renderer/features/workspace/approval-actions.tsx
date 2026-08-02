import { useState } from "react";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
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
    <div className="border-amber-500/30 bg-amber-500/5 space-y-2 rounded-md border p-2">
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert className="size-3.5 text-amber-500" />
        <span>{approval.description}</span>
      </div>
      {showInput && (
        <pre className="bg-muted max-h-28 overflow-auto rounded p-2 text-[10px] whitespace-pre-wrap">
          {formatValue(approval.input)}
        </pre>
      )}
      <div className="flex flex-wrap justify-end gap-2">
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
