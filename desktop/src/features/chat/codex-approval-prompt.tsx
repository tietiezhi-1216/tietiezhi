import { memo } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  CodexV2Response,
  CodexV2ServerRequest,
} from "@/lib/api";

type Decision = "accept" | "acceptForSession" | "decline" | "cancel";

function responseFor(
  request: CodexV2ServerRequest,
  decision: Decision,
): CodexV2Response {
  if (request.method === "item/permissions/requestApproval") {
    if (decision === "accept" || decision === "acceptForSession") {
      const params = request.params as {
        permissions: unknown;
      };
      return {
        id: request.id,
        result: {
          permissions: params.permissions,
          scope: decision === "acceptForSession" ? "session" : "turn",
        },
      };
    }
    return {
      id: request.id,
      error: {
        code: decision === "cancel" ? -32800 : -32001,
        message:
          decision === "cancel"
            ? "permission request cancelled"
            : "permission request declined",
      },
    };
  }
  if (
    request.method === "applyPatchApproval" ||
    request.method === "execCommandApproval"
  ) {
    const legacyDecision = {
      accept: "approved",
      acceptForSession: "approved_for_session",
      decline: { denied: { rejection: "rejected by user" } },
      cancel: "abort",
    }[decision];
    return { id: request.id, result: { decision: legacyDecision } };
  }
  return { id: request.id, result: { decision } };
}

function requestSummary(request: CodexV2ServerRequest): string {
  const params = request.params as Record<string, unknown>;
  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "execCommandApproval"
  ) {
    const command = params.command;
    return Array.isArray(command) ? command.join(" ") : String(command ?? "command");
  }
  if (
    request.method === "item/fileChange/requestApproval" ||
    request.method === "applyPatchApproval"
  ) {
    return String(params.reason ?? params.grantRoot ?? "修改工作区文件");
  }
  if (request.method === "item/permissions/requestApproval") {
    return JSON.stringify(params.permissions);
  }
  return request.method;
}

export const CodexApprovalPrompt = memo(function CodexApprovalPrompt({
  request,
  onRespond,
}: {
  request: CodexV2ServerRequest;
  onRespond: (response: CodexV2Response) => void;
}) {
  const answer = (decision: Decision) => onRespond(responseFor(request, decision));
  return (
    <div className="border-amber-500/40 bg-amber-500/5 flex flex-col gap-2.5 rounded-lg border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 shrink-0 text-amber-500" />
        <span className="text-sm font-medium">Codex 需要你的许可</span>
      </div>
      <p className="text-sm break-all select-text">{requestSummary(request)}</p>
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

export { responseFor as codexApprovalResponse };
