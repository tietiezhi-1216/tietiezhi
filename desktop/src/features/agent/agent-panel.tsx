import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  Brain,
  Check,
  ChevronRight,
  FolderOpen,
  Loader2,
  Plus,
  Send,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { pickWorkspaceDir } from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  agentApprove,
  agentCancel,
  agentPrompt,
  agentSessionDelete,
  agentSessionList,
  agentSessionLoad,
  agentSessionNew,
} from "./api";
import { useAgentEventBridge, useAgentStore } from "./store";
import type { SessionMeta, TranscriptEntry, TranscriptState } from "./types";

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The first-party agent's surface.
 *
 * Sits next to the external cores rather than in its own product area: switching
 * between "our agent" and "Claude Code" should feel like changing a setting, not
 * changing applications.
 */
export function AgentPanel({ className }: { className?: string }) {
  useAgentEventBridge();
  const queryClient = useQueryClient();

  const sessions = useAgentStore((state) => state.sessions);
  const activeId = useAgentStore((state) => state.activeId);
  const openSession = useAgentStore((state) => state.openSession);
  const closeSession = useAgentStore((state) => state.closeSession);
  const setActive = useAgentStore((state) => state.setActive);

  const active = activeId === null ? null : (sessions[activeId] ?? null);

  const list = useQuery({ queryKey: ["agentSessions"], queryFn: agentSessionList });

  const [cwd, setCwd] = useState("");

  const create = useMutation({
    mutationFn: async (dir: string) => {
      const meta = await agentSessionNew({ cwd: dir });
      return meta;
    },
    onSuccess: (meta) => {
      openSession(meta, []);
      void queryClient.invalidateQueries({ queryKey: ["agentSessions"] });
    },
  });

  const open = useMutation({
    mutationFn: async (sessionId: string) => {
      const loaded = await agentSessionLoad(sessionId);
      if (loaded === null) throw new Error("会话已不存在");
      return loaded;
    },
    onSuccess: (loaded) => openSession(loaded.meta, loaded.messages),
  });

  const remove = useMutation({
    mutationFn: agentSessionDelete,
    onSuccess: (_ok, sessionId) => {
      closeSession(sessionId);
      void queryClient.invalidateQueries({ queryKey: ["agentSessions"] });
    },
  });

  return (
    <div className={cn("grid min-h-0 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]", className)}>
      <div className="flex min-h-0 flex-col gap-3 rounded-xl border p-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="agent-cwd">工作目录</Label>
          <div className="flex items-center gap-2">
            <Input
              id="agent-cwd"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder="/Users/you/project"
              className="font-mono text-xs"
            />
            <Button
              size="icon"
              variant="outline"
              title="选择文件夹"
              onClick={() => {
                void pickWorkspaceDir().then((picked) => {
                  if (picked !== null) setCwd(picked);
                });
              }}
            >
              <FolderOpen />
            </Button>
          </div>
          <Button
            size="sm"
            disabled={cwd.trim() === "" || create.isPending}
            onClick={() => create.mutate(cwd.trim())}
          >
            {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            新建会话
          </Button>
          {create.isError && (
            <p className="text-destructive text-xs">{errorText(create.error)}</p>
          )}
        </div>

        <div className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-1 pr-2">
              {(list.data ?? []).map((meta) => (
                <SessionRow
                  key={meta.id}
                  meta={meta}
                  active={meta.id === activeId}
                  opened={sessions[meta.id] !== undefined}
                  onOpen={() => {
                    if (sessions[meta.id] !== undefined) setActive(meta.id);
                    else open.mutate(meta.id);
                  }}
                  onDelete={() => remove.mutate(meta.id)}
                />
              ))}
              {(list.data ?? []).length === 0 && (
                <p className="text-muted-foreground px-1 py-4 text-xs">
                  还没有会话。选一个工作目录开始。
                </p>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      {active === null ? (
        <div className="text-muted-foreground flex min-h-40 items-center justify-center rounded-xl border border-dashed p-8 text-sm">
          选择或新建一个会话。
        </div>
      ) : (
        <Conversation session={active} />
      )}
    </div>
  );
}

function SessionRow({
  meta,
  active,
  opened,
  onOpen,
  onDelete,
}: {
  meta: SessionMeta;
  active: boolean;
  opened: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={cn("group flex items-center gap-1 rounded-lg px-1", active && "bg-accent")}>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 py-1.5 text-left"
      >
        <span className="w-full truncate text-sm">{meta.title}</span>
        <span className="text-muted-foreground w-full truncate font-mono text-[11px]">
          {meta.cwd}
        </span>
      </button>
      {opened && <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />}
      <Button
        size="icon-xs"
        variant="ghost"
        className="opacity-0 group-hover:opacity-100"
        aria-label="删除会话"
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function Conversation({ session }: { session: TranscriptState }) {
  const appendUser = useAgentStore((state) => state.appendUser);
  const setBusy = useAgentStore((state) => state.setBusy);
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement | null>(null);

  // Follow the stream. `entries.length` alone would not fire while the trailing
  // bubble grows in place, so the streaming text length is part of the key.
  const tail = session.entries[session.entries.length - 1];
  const tailLength = tail !== undefined && "text" in tail ? tail.text.length : 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [session.entries.length, tailLength]);

  const send = useMutation({
    mutationFn: async (text: string) => {
      appendUser(session.meta.id, text);
      setBusy(session.meta.id, true);
      return agentPrompt({ sessionId: session.meta.id, text });
    },
    onError: () => setBusy(session.meta.id, false),
  });

  const submit = () => {
    const text = draft.trim();
    if (text === "" || session.busy) return;
    setDraft("");
    send.mutate(text);
  };

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm">{session.meta.title}</p>
          <p className="text-muted-foreground truncate font-mono text-[11px]">{session.meta.cwd}</p>
        </div>
        {session.busy && (
          <Button size="sm" variant="outline" onClick={() => void agentCancel(session.meta.id)}>
            <Square />
            停止
          </Button>
        )}
      </div>

      {session.approval !== null && (
        <ApprovalBar sessionId={session.meta.id} request={session.approval} />
      )}

      <ScrollArea className="min-h-40 flex-1 rounded-xl border p-3">
        <div className="flex flex-col gap-3">
          {session.entries.map((entry) => (
            <Entry key={entry.id} entry={entry} />
          ))}
          <div ref={bottom} />
        </div>
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
          placeholder={session.busy ? "正在处理…" : "说明你想做什么（Enter 发送，Shift+Enter 换行）"}
          rows={3}
          className="resize-none text-sm"
        />
        <div className="flex items-center justify-between gap-2">
          {send.isError ? (
            <p className="text-destructive min-w-0 truncate text-xs">{errorText(send.error)}</p>
          ) : (
            <span />
          )}
          <Button size="sm" disabled={draft.trim() === "" || session.busy} onClick={submit}>
            {session.busy ? <Loader2 className="animate-spin" /> : <Send />}
            发送
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Approval is inline rather than a modal dialog: the user needs to read the
 * transcript above it to judge whether the command is reasonable, and a modal
 * would cover exactly that.
 */
function ApprovalBar({
  sessionId,
  request,
}: {
  sessionId: string;
  request: TranscriptState["approval"];
}) {
  const setApproval = useAgentStore((state) => state.setApproval);
  const [pending, setPending] = useState(false);
  if (request === null) return null;

  const answer = async (
    decision: "allow" | "allow-always" | { outcome: "deny"; reason?: string },
  ) => {
    setPending(true);
    try {
      await agentApprove(sessionId, request.id, decision);
      setApproval(sessionId, null);
    } finally {
      setPending(false);
    }
  };

  return (
    <Alert>
      <AlertTriangle />
      <AlertTitle>需要你确认</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span className="font-mono text-xs break-all">{request.summary}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" disabled={pending} onClick={() => void answer("allow")}>
            <Check />
            允许一次
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => void answer("allow-always")}
          >
            本轮内不再询问
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => void answer({ outcome: "deny" })}
          >
            <Ban />
            拒绝
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "user") {
    return (
      <div className="bg-accent ml-auto max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap">
        {entry.text}
      </div>
    );
  }

  if (entry.kind === "assistant") {
    return (
      <div className="max-w-[92%] text-sm whitespace-pre-wrap">
        {entry.text}
        {entry.streaming && <span className="bg-foreground/60 ml-0.5 inline-block h-3 w-1.5 animate-pulse" />}
      </div>
    );
  }

  if (entry.kind === "reasoning") {
    return (
      <details className="text-muted-foreground rounded-lg border border-dashed px-3 py-2 text-xs">
        <summary className="flex cursor-pointer items-center gap-1.5 select-none">
          <Brain className="size-3.5" />
          思考过程
          {entry.streaming && <Loader2 className="size-3 animate-spin" />}
        </summary>
        <div className="mt-2 whitespace-pre-wrap">{entry.text}</div>
      </details>
    );
  }

  if (entry.kind === "notice") {
    return (
      <p
        className={cn(
          "rounded-lg px-3 py-2 text-xs",
          entry.tone === "error" ? "bg-destructive/10 text-destructive" : "text-muted-foreground bg-muted",
        )}
      >
        {entry.text}
      </p>
    );
  }

  return <ToolEntry entry={entry} />;
}

function ToolEntry({ entry }: { entry: Extract<TranscriptEntry, { kind: "tool" }> }) {
  const status =
    entry.status === "awaiting-approval"
      ? "等待确认"
      : entry.status === "pending"
        ? "执行中"
        : entry.status === "error"
          ? "失败"
          : "完成";

  return (
    <details className="rounded-lg border px-3 py-2 text-xs">
      <summary className="flex cursor-pointer items-center gap-1.5 select-none">
        <Terminal className="size-3.5 shrink-0" />
        <span className="font-mono">{entry.toolName}</span>
        <span
          className={cn(
            "ml-auto shrink-0",
            entry.status === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {entry.status === "pending" || entry.status === "awaiting-approval" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            status
          )}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <pre className="bg-muted overflow-x-auto rounded p-2 text-[11px]">
          {JSON.stringify(entry.input, null, 2)}
        </pre>
        {entry.output !== null && (
          <pre className="bg-muted max-h-64 overflow-auto rounded p-2 text-[11px] whitespace-pre-wrap">
            {typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}

export { X as CloseIcon };
