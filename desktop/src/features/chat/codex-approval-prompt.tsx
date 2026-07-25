import { memo, useMemo, useState } from "react";
import { ExternalLink, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  CodexV2Response,
  CodexV2ServerRequest,
} from "@/lib/api";

type Decision = "accept" | "acceptForSession" | "decline" | "cancel";

function responseFor(
  request: CodexV2ServerRequest,
  decision: Decision,
  elicitationContent?: Record<string, unknown>,
): CodexV2Response {
  if (request.method === "item/tool/requestUserInput") {
    if (decision === "accept" || decision === "acceptForSession") {
      return {
        id: request.id,
        result: {
          answers: Object.fromEntries(
            Object.entries(elicitationContent ?? {}).map(([id, answer]) => [
              id,
              {
                answers: Array.isArray(answer)
                  ? answer.map(String)
                  : [String(answer)],
              },
            ]),
          ),
        },
      };
    }
    if (decision === "decline") {
      return { id: request.id, result: { answers: {} } };
    }
    return {
      id: request.id,
      error: { code: -32800, message: "user input request cancelled" },
    };
  }
  if (request.method === "mcpServer/elicitation/request") {
    return {
      id: request.id,
      result: {
        action:
          decision === "accept" || decision === "acceptForSession"
            ? "accept"
            : decision,
        content:
          decision === "accept" || decision === "acceptForSession"
            ? (elicitationContent ?? {})
            : null,
        _meta: null,
      },
    };
  }
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
  if (request.method === "mcpServer/elicitation/request") {
    return String(params.message ?? "MCP 服务器需要补充信息");
  }
  if (request.method === "item/tool/requestUserInput") {
    const questions = params.questions as
      | Array<{ question?: string }>
      | undefined;
    return questions?.[0]?.question ?? "Codex 需要你的选择";
  }
  return request.method;
}

interface ElicitationProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  oneOf?: Array<{ const?: string; title?: string }>;
}

interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

function initialElicitationContent(
  request: CodexV2ServerRequest,
): Record<string, unknown> {
  if (request.method !== "mcpServer/elicitation/request") return {};
  const params = request.params as Record<string, unknown>;
  const schema = params.requestedSchema as
    | { properties?: Record<string, ElicitationProperty> }
    | undefined;
  return Object.fromEntries(
    Object.entries(schema?.properties ?? {}).map(([key, property]) => {
      const fallback =
        property.type === "boolean"
          ? false
          : property.type === "number" || property.type === "integer"
            ? 0
            : (property.enum?.[0] ?? property.oneOf?.[0]?.const ?? "");
      return [key, property.default ?? fallback];
    }),
  );
}

export const CodexApprovalPrompt = memo(function CodexApprovalPrompt({
  request,
  onRespond,
}: {
  request: CodexV2ServerRequest;
  onRespond: (response: CodexV2Response) => void;
}) {
  const [elicitationContent, setElicitationContent] = useState<
    Record<string, unknown>
  >(() => initialElicitationContent(request));
  const params = request.params as Record<string, unknown>;
  const isElicitation = request.method === "mcpServer/elicitation/request";
  const isUserInput = request.method === "item/tool/requestUserInput";
  const userQuestions = isUserInput
    ? ((params.questions as UserInputQuestion[] | undefined) ?? [])
    : [];
  const schema = isElicitation
    ? (params.requestedSchema as
        | { properties?: Record<string, ElicitationProperty> }
        | undefined)
    : undefined;
  const fields = useMemo(
    () => Object.entries(schema?.properties ?? {}),
    [schema],
  );
  const answer = (decision: Decision) =>
    onRespond(responseFor(request, decision, elicitationContent));
  return (
    <div className="border-amber-500/40 bg-amber-500/5 flex flex-col gap-2.5 rounded-lg border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 shrink-0 text-amber-500" />
        <span className="text-sm font-medium">
          {isElicitation
            ? "MCP 服务器需要你的输入"
            : isUserInput
              ? "Codex 需要你的选择"
              : "Codex 需要你的许可"}
        </span>
      </div>
      <p className="text-sm break-all select-text">{requestSummary(request)}</p>
      {isUserInput ? (
        <div className="grid gap-3">
          {userQuestions.map((question) => (
            <fieldset key={question.id} className="grid gap-1.5">
              <legend className="text-xs font-medium">{question.header}</legend>
              <p className="text-muted-foreground text-xs">
                {question.question}
              </p>
              <div className="grid gap-1">
                {(question.options ?? []).map((option) => (
                  <label
                    key={option.label}
                    className="hover:bg-muted/60 flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm"
                  >
                    <input
                      type="radio"
                      name={question.id}
                      value={option.label}
                      checked={elicitationContent[question.id] === option.label}
                      onChange={() =>
                        setElicitationContent((current) => ({
                          ...current,
                          [question.id]: option.label,
                        }))
                      }
                    />
                    <span className="grid gap-0.5">
                      <span>{option.label}</span>
                      <span className="text-muted-foreground text-xs">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
                {question.isOther ? (
                  <input
                    className="bg-background rounded-md border px-2 py-1.5 text-sm"
                    type={question.isSecret ? "password" : "text"}
                    placeholder="其他答案"
                    onChange={(event) =>
                      setElicitationContent((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))
                    }
                  />
                ) : null}
              </div>
            </fieldset>
          ))}
        </div>
      ) : null}
      {isElicitation && params.mode === "url" && typeof params.url === "string" ? (
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={() => window.open(params.url as string, "_blank", "noopener")}
        >
          <ExternalLink className="mr-1.5 size-3.5" />
          打开授权页面
        </Button>
      ) : null}
      {isElicitation && fields.length > 0 ? (
        <div className="grid gap-2">
          {fields.map(([key, property]) => {
            const label = property.title ?? key;
            const value = elicitationContent[key];
            const options =
              property.enum ??
              property.oneOf
                ?.map((option) => option.const)
                .filter((option): option is string => Boolean(option));
            if (property.type === "boolean") {
              return (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(event) =>
                      setElicitationContent((current) => ({
                        ...current,
                        [key]: event.target.checked,
                      }))
                    }
                  />
                  {label}
                </label>
              );
            }
            if (options?.length) {
              return (
                <label key={key} className="grid gap-1 text-xs">
                  {label}
                  <select
                    className="bg-background rounded-md border px-2 py-1.5 text-sm"
                    value={String(value ?? "")}
                    onChange={(event) =>
                      setElicitationContent((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  >
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              );
            }
            const numeric =
              property.type === "number" || property.type === "integer";
            return (
              <label key={key} className="grid gap-1 text-xs">
                {label}
                <input
                  className="bg-background rounded-md border px-2 py-1.5 text-sm"
                  type={numeric ? "number" : "text"}
                  value={String(value ?? "")}
                  onChange={(event) =>
                    setElicitationContent((current) => ({
                      ...current,
                      [key]: numeric
                        ? Number(event.target.value)
                        : event.target.value,
                    }))
                  }
                />
                {property.description ? (
                  <span className="text-muted-foreground">
                    {property.description}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-7" onClick={() => answer("accept")}>
          {isElicitation || isUserInput ? "提交" : "允许一次"}
        </Button>
        {!isElicitation && !isUserInput ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => answer("acceptForSession")}
          >
            本作用域允许
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:text-destructive h-7"
          onClick={() => answer("decline")}
        >
          {isElicitation || isUserInput ? "不提供并继续" : "拒绝并继续"}
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
