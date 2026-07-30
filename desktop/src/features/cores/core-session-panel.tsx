import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  ChevronRight,
  CircleAlert,
  CircleStop,
  FolderOpen,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  Play,
  Plus,
  Send,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  CORES_QUERY_KEY,
  coreList,
  coreSessionCancel,
  coreSessionNew,
  coreSessionPrompt,
  coreStart,
  pickDirectory,
} from "./api";
import { errorMessage, formatRaw } from "./helpers";
import {
  mergeRunState,
  useCoresStore,
  type SessionTranscript,
  type TranscriptEntry,
} from "./store";
import { SessionConfigBar } from "./session-config-bar";

const TOOL_STATUS_TEXT: Record<string, string> = {
  pending: "排队中",
  in_progress: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const PLAN_STATUS_TEXT: Record<string, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
};

function toolStatusVariant(status: string): "secondary" | "destructive" | "outline" {
  if (status === "failed" || status === "cancelled") return "destructive";
  if (status === "completed") return "secondary";
  return "outline";
}

function RawDetails({ raw }: { raw: unknown }) {
  if (raw === undefined || raw === null) return null;
  return (
    <Collapsible className="mt-2">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="text-muted-foreground">
          <ChevronRight className="transition-transform group-data-[state=open]/button:rotate-90" />
          原始数据
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="bg-muted/60 mt-1.5 max-h-56 overflow-auto rounded-lg p-2 font-mono text-xs leading-relaxed">
          {formatRaw(raw)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One transcript node. Each stream kind gets its own visual treatment. */
function EntryView({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap">
            {entry.text}
          </div>
        </div>
      );

    case "message":
      return (
        <div className="bg-card rounded-2xl px-3 py-2 ring-1 ring-foreground/10">
          <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-medium">
            <Sparkles className="size-3" />
            回复
          </div>
          <div className="text-sm leading-relaxed whitespace-pre-wrap">{entry.text}</div>
        </div>
      );

    case "thought":
      return (
        <div className="border-muted-foreground/40 bg-muted/40 rounded-r-2xl border-l-2 px-3 py-2">
          <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-medium">
            <Brain className="size-3" />
            思考过程
          </div>
          <div className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap italic">
            {entry.text}
          </div>
        </div>
      );

    case "tool":
      return (
        <div className="rounded-2xl border border-dashed px-3 py-2">
          <div className="flex items-center gap-2">
            <Wrench className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.title}</span>
            <Badge variant={toolStatusVariant(entry.status)}>
              {TOOL_STATUS_TEXT[entry.status] ?? entry.status}
            </Badge>
          </div>
          <RawDetails raw={entry.raw} />
        </div>
      );

    case "plan":
      return (
        <div className="rounded-2xl border px-3 py-2">
          <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
            <ListChecks className="size-3" />
            执行计划
          </div>
          {entry.steps.length === 0 ? (
            <RawDetails raw={entry.raw} />
          ) : (
            <ol className="flex flex-col gap-1">
              {entry.steps.map((step, index) => (
                <li key={`${entry.id}-${index}`} className="flex items-start gap-2 text-sm">
                  <span className="text-muted-foreground w-4 shrink-0 text-right font-mono text-xs">
                    {index + 1}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 leading-relaxed",
                      step.status === "completed" && "text-muted-foreground line-through",
                    )}
                  >
                    {step.content}
                  </span>
                  <Badge variant="outline">{PLAN_STATUS_TEXT[step.status] ?? step.status}</Badge>
                </li>
              ))}
            </ol>
          )}
        </div>
      );

    case "turn-ended":
      return (
        <div className="flex items-center gap-2 py-1">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-xs">本轮结束 · {entry.stopReason}</span>
          <Separator className="flex-1" />
        </div>
      );

    case "error":
      return (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>出错了</AlertTitle>
          <AlertDescription>{entry.message}</AlertDescription>
        </Alert>
      );
  }
}

function Transcript({ session }: { session: SessionTranscript }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const last = session.entries[session.entries.length - 1];
  // Deltas merge into the last entry, so entry count alone misses streaming
  // growth — track the tail length as well to keep the view pinned.
  const tailLength =
    last && (last.kind === "message" || last.kind === "thought" || last.kind === "user")
      ? last.text.length
      : 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [session.entries.length, tailLength]);

  if (session.entries.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        会话已就绪，输入内容开始对话。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 pr-3 pb-2">
      {session.entries.map((entry) => (
        <EntryView key={entry.id} entry={entry} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

/** Session workbench for the selected core: open, prompt, watch the stream. */
export function CoreSessionPanel({ className }: { className?: string }) {
  const queryClient = useQueryClient();
  const [cwd, setCwd] = useState("");
  const [draft, setDraft] = useState("");
  const [pickerHint, setPickerHint] = useState<string | null>(null);

  const selectedCoreId = useCoresStore((state) => state.selectedCoreId);
  const runOverrides = useCoresStore((state) => state.runState);
  const sessions = useCoresStore((state) => state.sessions);
  const activeSessionId = useCoresStore((state) => state.activeSessionId);
  const setActiveSession = useCoresStore((state) => state.setActiveSession);
  const registerSession = useCoresStore((state) => state.registerSession);
  const dropSession = useCoresStore((state) => state.dropSession);
  const appendUserText = useCoresStore((state) => state.appendUserText);
  const setSessionBusy = useCoresStore((state) => state.setSessionBusy);
  const pushSessionError = useCoresStore((state) => state.pushSessionError);

  const coreSessions = useMemo(
    () =>
      Object.values(sessions)
        .filter((session) => session.handle.coreId === selectedCoreId)
        .sort((a, b) => a.handle.createdAt - b.handle.createdAt),
    [sessions, selectedCoreId],
  );

  const active =
    activeSessionId !== null && sessions[activeSessionId]?.handle.coreId === selectedCoreId
      ? sessions[activeSessionId]
      : coreSessions[0];

  // The list query is the baseline (a core may already be up when the page
  // mounts); live events override it as the process lifecycle moves on.
  const coresQuery = useQuery({ queryKey: CORES_QUERY_KEY, queryFn: coreList });
  const baseline = coresQuery.data?.find((row) => row.descriptor.id === selectedCoreId)?.run ?? {
    status: "stopped" as const,
  };
  const runState = mergeRunState(
    baseline,
    selectedCoreId === null ? undefined : runOverrides[selectedCoreId],
  );
  const running = runState.status === "ready";

  const start = useMutation({
    mutationFn: coreStart,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: CORES_QUERY_KEY }),
  });

  const newSession = useMutation({
    mutationFn: (input: { coreId: string; cwd: string }) =>
      coreSessionNew(input.coreId, input.cwd),
    onSuccess: (handle) => {
      registerSession(handle);
      void queryClient.invalidateQueries({ queryKey: CORES_QUERY_KEY });
    },
  });

  const prompt = useMutation({
    mutationFn: (input: { sessionId: string; text: string }) =>
      coreSessionPrompt(input.sessionId, input.text),
    onMutate: (input) => {
      appendUserText(input.sessionId, input.text);
      setSessionBusy(input.sessionId, true);
    },
    onError: (error, input) => {
      pushSessionError(input.sessionId, errorMessage(error));
    },
    onSettled: (_data, _error, input) => {
      setSessionBusy(input.sessionId, false);
    },
  });

  const cancel = useMutation({ mutationFn: coreSessionCancel });

  const pick = useMutation({
    mutationFn: pickDirectory,
    onSuccess: (directory) => {
      setPickerHint(null);
      if (directory) setCwd(directory);
    },
    onError: () => setPickerHint("当前环境无法打开目录选择器，请直接填写绝对路径。"),
  });

  const submit = () => {
    const text = draft.trim();
    if (!active || text.length === 0 || active.busy) return;
    setDraft("");
    prompt.mutate({ sessionId: active.handle.sessionId, text });
  };

  if (selectedCoreId === null) {
    return (
      <div
        className={cn(
          "text-muted-foreground flex min-h-0 items-center justify-center rounded-xl border border-dashed p-8 text-sm",
          className,
        )}
      >
        请先在左侧选择一个核心。
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="flex flex-col gap-2 rounded-xl border p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageSquare className="size-4" />
            <span className="text-sm font-medium">会话</span>
            <Badge variant="outline">{selectedCoreId}</Badge>
          </div>
          {!running && (
            <Button size="sm" onClick={() => start.mutate(selectedCoreId)} disabled={start.isPending}>
              {start.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}
              启动核心
            </Button>
          )}
        </div>

        {!running && (
          <p className="text-muted-foreground text-xs">
            核心尚未就绪。启动后才能新建会话；若启动失败，可在左侧卡片查看日志。
          </p>
        )}

        {start.error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>启动失败</AlertTitle>
            <AlertDescription>{errorMessage(start.error)}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="core-session-cwd">工作目录（绝对路径）</Label>
          <div className="flex items-center gap-2">
            <Input
              id="core-session-cwd"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder="/Users/you/projects/demo"
              spellCheck={false}
              className="font-mono"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => pick.mutate()}
              disabled={pick.isPending}
              aria-label="选择目录"
              title="选择目录"
            >
              {pick.isPending ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
            </Button>
            <Button
              onClick={() => newSession.mutate({ coreId: selectedCoreId, cwd: cwd.trim() })}
              disabled={!running || cwd.trim().length === 0 || newSession.isPending}
            >
              {newSession.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
              新建会话
            </Button>
          </div>
          {pickerHint && <p className="text-muted-foreground text-xs">{pickerHint}</p>}
        </div>

        {newSession.error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>无法新建会话</AlertTitle>
            <AlertDescription>{errorMessage(newSession.error)}</AlertDescription>
          </Alert>
        )}

        {coreSessions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {coreSessions.map((session) => {
              const isActive = session.handle.sessionId === active?.handle.sessionId;
              return (
                <div key={session.handle.sessionId} className="flex items-center">
                  <Button
                    size="xs"
                    variant={isActive ? "secondary" : "ghost"}
                    onClick={() => setActiveSession(session.handle.sessionId)}
                    className="max-w-56"
                  >
                    <span className="truncate font-mono">{session.handle.cwd}</span>
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => dropSession(session.handle.sessionId)}
                    aria-label="从列表移除会话"
                    title="从列表移除"
                  >
                    <X />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!active ? (
        <div className="text-muted-foreground flex min-h-40 flex-1 items-center justify-center rounded-xl border border-dashed p-8 text-sm">
          还没有会话。填写工作目录后点击「新建会话」。
        </div>
      ) : (
        <>
          {/* Model and mode live above the transcript: they apply to the next
              turn, so they belong with the composer rather than the history. */}
          <SessionConfigBar
            sessionId={active.handle.sessionId}
            className="rounded-xl border px-3 py-2"
          />

          <ScrollArea className="min-h-40 flex-1 rounded-xl border p-3">
            <Transcript session={active} />
          </ScrollArea>

          <div className="flex flex-col gap-2 rounded-xl border p-3">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="输入内容，Enter 发送，Shift+Enter 换行"
              spellCheck={false}
              className="min-h-20"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground truncate font-mono text-xs">
                {active.handle.sessionId}
              </span>
              <div className="flex items-center gap-2">
                {active.busy && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => cancel.mutate(active.handle.sessionId)}
                    disabled={cancel.isPending}
                  >
                    <CircleStop />
                    中断
                  </Button>
                )}
                <Button size="sm" onClick={submit} disabled={active.busy || draft.trim().length === 0}>
                  {active.busy ? <LoaderCircle className="animate-spin" /> : <Send />}
                  发送
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
