import { useMutation } from "@tanstack/react-query";
import { ChevronRight, CircleAlert, LoaderCircle, ShieldQuestionMark } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { corePermissionResolve } from "./api";
import { errorMessage, formatRaw } from "./helpers";
import { useCoresStore } from "./store";
import type { CorePermissionOption } from "./types";

/**
 * Every core phrases its options differently, so the option list is rendered
 * verbatim; only the emphasis is derived from the ACP `kind`.
 */
function optionVariant(kind: string): "default" | "secondary" | "outline" | "destructive" {
  switch (kind) {
    case "allow_always":
      return "default";
    case "allow_once":
      return "secondary";
    case "reject_always":
      return "destructive";
    case "reject_once":
      return "outline";
    default:
      return "outline";
  }
}

const KIND_TEXT: Record<string, string> = {
  allow_once: "仅本次允许",
  allow_always: "始终允许",
  reject_once: "仅本次拒绝",
  reject_always: "始终拒绝",
};

function optionHint(option: CorePermissionOption): string | null {
  const hint = KIND_TEXT[option.kind];
  if (!hint || hint === option.name) return null;
  return hint;
}

/**
 * Single approval surface shared by every core. Requests are answered oldest
 * first so a core that asks twice cannot jump the queue.
 */
export function CorePermissionDialog() {
  const permissions = useCoresStore((state) => state.permissions);
  const dismissPermission = useCoresStore((state) => state.dismissPermission);

  const current = permissions[0];

  const resolve = useMutation({
    mutationFn: (input: { requestId: string; optionId?: string }) =>
      corePermissionResolve(input.requestId, input.optionId),
    onSuccess: (_result, input) => dismissPermission(input.requestId),
  });

  if (!current) return null;

  const answer = (optionId?: string) => {
    if (resolve.isPending) return;
    resolve.mutate(optionId === undefined ? { requestId: current.requestId } : { requestId: current.requestId, optionId });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) answer();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldQuestionMark className="size-4" />
            核心请求授权
          </DialogTitle>
          <DialogDescription>
            核心「{current.coreId}」需要你确认下面这项操作后才能继续。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="bg-muted/40 rounded-lg px-3 py-2 text-sm leading-relaxed">
            {current.title || "核心未提供操作说明。"}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">核心 {current.coreId}</Badge>
            <Badge variant="outline" className="max-w-64">
              <span className="truncate font-mono">会话 {current.sessionId}</span>
            </Badge>
            {permissions.length > 1 && (
              <Badge variant="secondary">还有 {permissions.length - 1} 个待处理</Badge>
            )}
          </div>

          {current.options.length === 0 && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>核心没有给出可选项</AlertTitle>
              <AlertDescription>只能取消本次请求。</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-2">
            {current.options.map((option) => (
              <Button
                key={option.optionId}
                variant={optionVariant(option.kind)}
                size="lg"
                className="justify-between"
                onClick={() => answer(option.optionId)}
                disabled={resolve.isPending}
              >
                <span className="min-w-0 truncate">{option.name || option.optionId}</span>
                {optionHint(option) && (
                  <span className="text-xs opacity-70">{optionHint(option)}</span>
                )}
              </Button>
            ))}
          </div>

          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="xs" className="text-muted-foreground">
                <ChevronRight className="transition-transform group-data-[state=open]/button:rotate-90" />
                请求详情
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="bg-muted/60 mt-1.5 max-h-56 overflow-auto rounded-lg p-2 font-mono text-xs leading-relaxed">
                {formatRaw(current.raw)}
              </pre>
            </CollapsibleContent>
          </Collapsible>

          {resolve.error && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>无法提交结果</AlertTitle>
              <AlertDescription>{errorMessage(resolve.error)}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => answer()} disabled={resolve.isPending}>
            {resolve.isPending ? <LoaderCircle className="animate-spin" /> : null}
            取消本次请求
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
