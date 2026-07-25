import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  CircleStop,
  Loader2,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  errorMessage,
  terminalClose,
  terminalList,
  terminalRead,
  terminalResize,
  terminalStart,
  terminalTerminate,
  terminalWrite,
} from "@/lib/api";
import type { TerminalSession } from "@/lib/api";
import { cn } from "@/lib/utils";

const MAX_RENDERED_OUTPUT = 160_000;

export function IntegratedTerminalPanel({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const cursors = useRef<Record<string, number>>({});
  const preRef = useRef<HTMLPreElement>(null);

  const sessionsQuery = useQuery({
    queryKey: ["thread-terminals", taskId],
    queryFn: () => terminalList(taskId),
    enabled: open,
    refetchInterval: open ? 1_000 : false,
  });
  const sessions = sessionsQuery.data ?? [];
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0],
    [activeSessionId, sessions],
  );

  useEffect(() => {
    setOpen(false);
    setActiveSessionId(null);
    setOutputs({});
    setInput("");
    setFailure(null);
    cursors.current = {};
  }, [taskId]);

  useEffect(() => {
    if (!activeSessionId && sessions[0]) setActiveSessionId(sessions[0].id);
    if (activeSessionId && !sessions.some((session) => session.id === activeSessionId)) {
      setActiveSessionId(sessions[0]?.id ?? null);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    const session = activeSession;
    if (!open || !session) return;
    let disposed = false;
    let reading = false;
    const read = async () => {
      if (disposed || reading) return;
      reading = true;
      try {
        const result = await terminalRead({
          taskId,
          sessionId: session.id,
          cursor: cursors.current[session.id] ?? 0,
          waitMs: 150,
        });
        if (disposed) return;
        cursors.current[session.id] = result.nextCursor;
        if (result.chunks.length > 0) {
          const delta = `${normalizeTerminalText(
            result.chunks.map((chunk) => chunk.data).join(""),
          )}${
            result.chunks.some((chunk) => chunk.capReached)
              ? "\n[terminal output cap reached]\n"
              : ""
          }`;
          setOutputs((current) => ({
            ...current,
            [session.id]: `${current[session.id] ?? ""}${delta}`.slice(
              -MAX_RENDERED_OUTPUT,
            ),
          }));
        }
        if (!result.running) {
          await queryClient.invalidateQueries({
            queryKey: ["thread-terminals", taskId],
          });
        }
      } catch (error) {
        if (!disposed) setFailure(errorMessage(error));
      } finally {
        reading = false;
      }
    };
    void terminalResize({
      taskId,
      sessionId: session.id,
      rows: 24,
      cols: 100,
    }).catch(() => undefined);
    void read();
    const timer = window.setInterval(() => void read(), 200);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeSession?.id, open, queryClient, taskId]);

  useEffect(() => {
    const element = preRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activeSession?.id, outputs]);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["thread-terminals", taskId] });

  const start = async () => {
    if (busy) return;
    setBusy("start");
    setFailure(null);
    try {
      const session = await terminalStart({ taskId, rows: 24, cols: 100 });
      setActiveSessionId(session.id);
      cursors.current[session.id] = 0;
      await refresh();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    const session = activeSession;
    if (!session?.running || !input || busy) return;
    const value = input;
    setInput("");
    try {
      await terminalWrite({ taskId, sessionId: session.id, data: `${value}\n` });
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  const stop = async (session: TerminalSession) => {
    setBusy(`stop-${session.id}`);
    try {
      await terminalTerminate({ taskId, sessionId: session.id });
      await refresh();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const close = async (session: TerminalSession) => {
    setBusy(`close-${session.id}`);
    try {
      await terminalClose({ taskId, sessionId: session.id });
      delete cursors.current[session.id];
      setOutputs((current) => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      await refresh();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const interrupt = async () => {
    if (!activeSession?.running) return;
    try {
      await terminalWrite({
        taskId,
        sessionId: activeSession.id,
        data: "\u0003",
      });
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  return (
    <section className="relative z-10 mx-3 -mb-2 overflow-hidden rounded-t-xl border bg-zinc-950 text-zinc-100 shadow-lg">
      <div className="flex h-9 items-center gap-1 border-b border-white/10 px-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen((value) => !value)}
          className="h-7 gap-1.5 text-[11px] text-zinc-300 hover:bg-white/10 hover:text-white"
        >
          <SquareTerminal />
          Terminal
          {open ? <ChevronDown /> : <ChevronUp />}
        </Button>
        {open &&
          sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => setActiveSessionId(session.id)}
              className={cn(
                "flex h-6 max-w-36 items-center gap-1 rounded px-2 text-[10px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100",
                activeSession?.id === session.id && "bg-white/10 text-zinc-100",
              )}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  session.running ? "bg-emerald-400" : "bg-zinc-600",
                )}
              />
              <span className="truncate">{session.title}</span>
              {busy === `close-${session.id}` ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <X
                  className="size-3"
                  onClick={(event) => {
                    event.stopPropagation();
                    void close(session);
                  }}
                />
              )}
            </button>
          ))}
        {open && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={busy != null}
            onClick={() => void start()}
            className="size-6 text-zinc-400 hover:bg-white/10 hover:text-white"
            aria-label="新建终端"
          >
            {busy === "start" ? <Loader2 className="animate-spin" /> : <Plus />}
          </Button>
        )}
        {open && activeSession?.running && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void stop(activeSession)}
            className="ml-auto h-6 gap-1 text-[10px] text-zinc-400 hover:bg-red-500/15 hover:text-red-300"
          >
            <CircleStop />
            停止
          </Button>
        )}
      </div>

      {open && (
        <div className="h-64">
          {activeSession ? (
            <div className="flex h-full flex-col">
              <pre
                ref={preRef}
                className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-zinc-200"
              >
                {outputs[activeSession.id] || "终端已启动，等待输出…"}
                {!activeSession.running &&
                  `\n[process exited with code ${activeSession.exitCode ?? "unknown"}]\n`}
              </pre>
              <div className="flex items-center gap-2 border-t border-white/10 px-2 py-1.5">
                <span className="text-[10px] text-emerald-400">$</span>
                <Input
                  value={input}
                  disabled={!activeSession.running}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder={
                    activeSession.running ? "输入命令并回车" : "该终端已退出"
                  }
                  className="h-7 flex-1 border-white/10 bg-transparent font-mono text-[11px] text-zinc-100 shadow-none placeholder:text-zinc-600 focus-visible:border-white/20 focus-visible:ring-0"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!activeSession.running}
                  onClick={() => void interrupt()}
                  className="h-7 text-[10px] text-zinc-400 hover:bg-white/10 hover:text-white"
                >
                  Ctrl+C
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <SquareTerminal className="size-8 text-zinc-700" />
              <p className="text-xs text-zinc-500">该任务还没有终端会话</p>
              <Button
                type="button"
                size="sm"
                disabled={busy != null}
                onClick={() => void start()}
              >
                <Plus />
                新建终端
              </Button>
            </div>
          )}
        </div>
      )}
      {open && failure && (
        <p className="border-t border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[10px] text-red-300">
          {failure}
        </p>
      )}
    </section>
  );
}

export function normalizeTerminalText(value: string): string {
  const withoutOsc = value.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
  const withoutCsi = withoutOsc.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  const normalized = withoutCsi.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let result = "";
  for (const character of normalized) {
    if (character === "\b") result = result.slice(0, -1);
    else if (character === "\n" || character === "\t" || character >= " ") {
      result += character;
    }
  }
  return result;
}
