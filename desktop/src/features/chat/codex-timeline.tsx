import { useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  FileCode2,
  GitCompareArrows,
  Image,
  Loader2,
  MessageSquare,
  Search,
  ShieldCheck,
  TerminalSquare,
  User,
  Users,
  Wrench,
  XCircle,
} from "lucide-react";
import { codexV2ServerResponse } from "@/lib/api";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  installCodexTimelineListeners,
  useCodexTimelineStore,
  type CodexTimelineEntry,
} from "@/stores/codex-timeline";
import { CodexApprovalPrompt } from "./codex-approval-prompt";
import type { ThreadItem } from "../../../../shared/codex/v2/typescript/v2/ThreadItem";

const ITEM_LABELS: Record<ThreadItem["type"], string> = {
  userMessage: "用户",
  hookPrompt: "Hook",
  agentMessage: "Codex",
  plan: "计划",
  reasoning: "推理摘要",
  commandExecution: "终端",
  fileChange: "文件变更",
  mcpToolCall: "MCP",
  dynamicToolCall: "动态工具",
  collabAgentToolCall: "协作",
  subAgentActivity: "子智能体",
  webSearch: "网页搜索",
  imageView: "查看图片",
  sleep: "等待",
  imageGeneration: "生成图片",
  enteredReviewMode: "进入审查",
  exitedReviewMode: "退出审查",
  contextCompaction: "上下文整理",
};

function iconFor(item: ThreadItem): ReactNode {
  const className = "size-4";
  switch (item.type) {
    case "userMessage":
      return <User className={className} />;
    case "agentMessage":
      return <Bot className={className} />;
    case "reasoning":
    case "contextCompaction":
      return <BrainCircuit className={className} />;
    case "plan":
      return <CircleDot className={className} />;
    case "commandExecution":
      return <TerminalSquare className={className} />;
    case "fileChange":
      return <FileCode2 className={className} />;
    case "mcpToolCall":
    case "dynamicToolCall":
    case "hookPrompt":
      return <Wrench className={className} />;
    case "collabAgentToolCall":
    case "subAgentActivity":
      return <Users className={className} />;
    case "webSearch":
      return <Search className={className} />;
    case "imageView":
    case "imageGeneration":
      return <Image className={className} />;
    case "sleep":
      return <Clock3 className={className} />;
    case "enteredReviewMode":
    case "exitedReviewMode":
      return <ShieldCheck className={className} />;
  }
}

function userInputText(item: Extract<ThreadItem, { type: "userMessage" }>): string {
  return item.content
    .map((input) => {
      switch (input.type) {
        case "text":
          return input.text;
        case "image":
          return `[图片] ${input.url}`;
        case "localImage":
          return `[本地图片] ${input.path}`;
        case "audio":
          return `[音频] ${input.url}`;
        case "localAudio":
          return `[本地音频] ${input.path}`;
        case "skill":
          return `[技能] ${input.name}`;
        case "mention":
          return `@${input.name}`;
      }
    })
    .join("\n");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function itemBody(item: ThreadItem): ReactNode {
  switch (item.type) {
    case "userMessage":
      return <TextBlock>{userInputText(item)}</TextBlock>;
    case "agentMessage":
      return <TextBlock>{item.text}</TextBlock>;
    case "plan":
      return <TextBlock>{item.text}</TextBlock>;
    case "reasoning":
      return (
        <div className="space-y-2">
          {item.summary.map((part, index) => (
            <TextBlock key={`summary-${index}`}>{part}</TextBlock>
          ))}
          {item.content.length > 0 && (
            <Details title="详细推理">
              <TextBlock>{item.content.join("\n\n")}</TextBlock>
            </Details>
          )}
        </div>
      );
    case "commandExecution":
      return (
        <div className="space-y-2">
          <div className="text-muted-foreground flex flex-wrap gap-x-3 text-[11px]">
            <span className="truncate">{item.cwd}</span>
            {item.durationMs != null && <span>{formatDuration(item.durationMs)}</span>}
            {item.exitCode != null && <span>退出码 {item.exitCode}</span>}
          </div>
          <code className="bg-background/70 block overflow-x-auto rounded-lg border px-3 py-2 text-xs">
            {item.command}
          </code>
          {item.aggregatedOutput && (
            <pre className="bg-background/70 max-h-80 overflow-auto rounded-lg border px-3 py-2 font-mono text-xs whitespace-pre-wrap">
              {item.aggregatedOutput}
            </pre>
          )}
        </div>
      );
    case "fileChange":
      return (
        <div className="space-y-2">
          {item.changes.map((change) => (
            <Details key={change.path} title={`${change.kind.type} · ${change.path}`}>
              <pre className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap">
                {change.diff}
              </pre>
            </Details>
          ))}
        </div>
      );
    case "mcpToolCall":
      return (
        <ToolBody
          name={`${item.server}/${item.tool}`}
          input={item.arguments}
          output={item.error?.message ?? item.result}
        />
      );
    case "dynamicToolCall":
      return (
        <ToolBody
          name={[item.namespace, item.tool].filter(Boolean).join("/")}
          input={item.arguments}
          output={item.contentItems}
        />
      );
    case "collabAgentToolCall":
      return (
        <div className="space-y-1 text-sm">
          <p className="font-medium">{item.tool}</p>
          {item.prompt && <TextBlock>{item.prompt}</TextBlock>}
          <p className="text-muted-foreground text-xs">
            {item.senderThreadId} → {item.receiverThreadIds.join(", ") || "等待目标"}
          </p>
        </div>
      );
    case "subAgentActivity":
      return (
        <p className="text-sm">
          {item.kind} · <span className="text-muted-foreground">{item.agentPath}</span>
        </p>
      );
    case "webSearch":
      return (
        <div className="space-y-2">
          <TextBlock>{item.query}</TextBlock>
          {item.results && <Details title={`${item.results.length} 条结果`}>
            <pre className="overflow-auto text-xs whitespace-pre-wrap">
              {jsonText(item.results)}
            </pre>
          </Details>}
        </div>
      );
    case "imageView":
      return <TextBlock>{item.path}</TextBlock>;
    case "sleep":
      return <TextBlock>{`等待 ${item.durationMs} ms`}</TextBlock>;
    case "imageGeneration":
      return (
        <div className="space-y-1 text-sm">
          {item.revisedPrompt && <TextBlock>{item.revisedPrompt}</TextBlock>}
          <p className="text-muted-foreground break-all">{item.savedPath ?? item.result}</p>
        </div>
      );
    case "enteredReviewMode":
    case "exitedReviewMode":
      return <TextBlock>{item.review}</TextBlock>;
    case "contextCompaction":
      return <TextBlock>已整理并压缩当前 Thread 上下文。</TextBlock>;
    case "hookPrompt":
      return (
        <pre className="overflow-auto text-xs whitespace-pre-wrap">
          {jsonText(item.fragments)}
        </pre>
      );
  }
}

function TextBlock({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-6 whitespace-pre-wrap">{children}</p>;
}

function Details({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-left text-xs">
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function ToolBody({
  name,
  input,
  output,
}: {
  name: string;
  input: unknown;
  output: unknown;
}) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-xs font-medium">{name}</p>
      <Details title="参数">
        <pre className="overflow-auto text-xs whitespace-pre-wrap">{jsonText(input)}</pre>
      </Details>
      {output != null && (
        <Details title="结果">
          <pre className="overflow-auto text-xs whitespace-pre-wrap">{jsonText(output)}</pre>
        </Details>
      )}
    </div>
  );
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${durationMs}ms`
    : `${Math.floor(durationMs / 1_000)}s`;
}

function compactText(value: string, limit = 96): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function itemSummary(item: ThreadItem): string {
  switch (item.type) {
    case "userMessage":
      return compactText(userInputText(item)) || "已发送消息";
    case "agentMessage":
      return compactText(item.text) || "正在生成回复";
    case "plan":
      return compactText(item.text) || "更新计划";
    case "reasoning":
      return compactText(item.summary.join(" ")) || "正在分析";
    case "commandExecution":
      return compactText(item.command) || "执行命令";
    case "fileChange":
      return item.changes.length === 1
        ? item.changes[0].path
        : `修改 ${item.changes.length} 个文件`;
    case "mcpToolCall":
      return `${item.server}/${item.tool}`;
    case "dynamicToolCall":
      return [item.namespace, item.tool].filter(Boolean).join("/");
    case "collabAgentToolCall":
      return `${item.tool} · ${item.receiverThreadIds.length || 1} 个目标`;
    case "subAgentActivity":
      return `${item.kind} · ${item.agentPath}`;
    case "webSearch":
      return compactText(item.query);
    case "imageView":
      return item.path;
    case "sleep":
      return `等待 ${formatDuration(item.durationMs)}`;
    case "imageGeneration":
      return compactText(item.revisedPrompt ?? item.savedPath ?? item.result);
    case "enteredReviewMode":
    case "exitedReviewMode":
      return compactText(item.review);
    case "contextCompaction":
      return "整理当前 Thread 上下文";
    case "hookPrompt":
      return "运行 Hook";
  }
}

function itemStatus(item: ThreadItem, lifecycle: CodexTimelineEntry["lifecycle"]): string {
  const raw = "status" in item ? String(item.status) : lifecycle;
  switch (raw) {
    case "inProgress":
    case "running":
    case "started":
      return "执行中";
    case "completed":
    case "success":
      return "完成";
    case "failed":
    case "error":
      return "失败";
    case "declined":
      return "已拒绝";
    case "cancelled":
      return "已停止";
    default:
      return raw;
  }
}

function statusIcon(
  item: ThreadItem,
  lifecycle: CodexTimelineEntry["lifecycle"],
): ReactNode {
  const status = itemStatus(item, lifecycle);
  if (status === "执行中") {
    return <Loader2 className="size-3.5 animate-spin" />;
  }
  if (status === "失败" || status === "已拒绝" || status === "已停止") {
    return <XCircle className="size-3.5" />;
  }
  return <CheckCircle2 className="size-3.5" />;
}

export function CodexTimelineItem({ entry }: { entry: CodexTimelineEntry }) {
  const [open, setOpen] = useState(false);
  const item = entry.item;
  const status = itemStatus(item, entry.lifecycle);
  const duration =
    "durationMs" in item && typeof item.durationMs === "number"
      ? formatDuration(item.durationMs)
      : null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <article
        data-codex-item={item.type}
        className="border-border/60 bg-muted/20 overflow-hidden rounded-lg border"
      >
        <CollapsibleTrigger className="group/tool-row hover:bg-muted/50 flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left transition-colors">
          <span
            className={cn(
              "text-muted-foreground shrink-0",
              status === "执行中" && "text-foreground",
              status === "失败" && "text-destructive",
            )}
          >
            {statusIcon(item, entry.lifecycle)}
          </span>
          <span className="text-muted-foreground shrink-0">{iconFor(item)}</span>
          <span className="shrink-0 text-xs font-medium">{ITEM_LABELS[item.type]}</span>
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]">
            {entry.progress ? compactText(entry.progress) : itemSummary(item)}
          </span>
          <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
            {status}
            {duration && ` · ${duration}`}
          </span>
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[state=open]/tool-row:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-border/60 border-t px-3 py-2.5">
            {itemBody(item)}
          </div>
        </CollapsibleContent>
      </article>
    </Collapsible>
  );
}

export function CodexTimeline({ threadId }: { threadId: string }) {
  const timeline = useCodexTimelineStore((state) => state.threads[threadId]);

  useEffect(() => {
    void installCodexTimelineListeners();
  }, []);

  if (!timeline || (timeline.entries.length === 0 && timeline.notices.length === 0)) {
    return null;
  }
  const operationalEntries = timeline.entries.filter(
    (entry) =>
      entry.item.type !== "userMessage" &&
      entry.item.type !== "agentMessage" &&
      entry.item.type !== "reasoning",
  );

  return (
    <section aria-label="Codex 执行时间线" className="space-y-1.5">
      {timeline.pendingRequests.length > 0 && (
        <div className="border-amber-500/30 bg-amber-500/10 flex items-center gap-2 rounded-xl border px-3 py-2 text-sm">
          <MessageSquare className="size-4" />
          需要输入或审批后才能继续
        </div>
      )}
      {timeline.pendingRequests.map((request) => (
        <CodexApprovalPrompt
          key={String(request.id)}
          request={request}
          onRespond={(response) => {
            void codexV2ServerResponse(response);
          }}
        />
      ))}
      {timeline.plan && (
        <div className="bg-muted/40 rounded-xl border px-3 py-2">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
            <GitCompareArrows className="size-4" /> 当前计划
          </div>
          <div className="space-y-1 text-xs">
            {timeline.plan.steps.map((step) => (
              <p key={step.step}>
                <span className="text-muted-foreground mr-2">{step.status}</span>
                {step.step}
              </p>
            ))}
          </div>
        </div>
      )}
      {operationalEntries.map((entry) => (
        <CodexTimelineItem key={entry.item.id} entry={entry} />
      ))}
      {timeline.notices.map((notice, index) => (
        <div
          key={`${notice.kind}-${index}`}
          className="border-destructive/20 bg-destructive/5 text-destructive rounded-xl border px-3 py-2 text-xs"
        >
          {notice.message}
        </div>
      ))}
    </section>
  );
}
