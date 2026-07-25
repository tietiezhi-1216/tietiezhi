import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ExternalLink,
  FileDiff,
  GitCommitHorizontal,
  Loader2,
  MessageSquareText,
  RotateCcw,
  Upload,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  commitTaskWorkspace,
  discardTaskWorkspacePaths,
  errorMessage,
  pushTaskWorkspace,
  stageTaskWorkspacePaths,
  taskWorkspaceGitDiff,
  taskWorkspacePullRequestUrl,
  unstageTaskWorkspacePaths,
  type WorkspaceGitDiff,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export const GIT_REVIEW_PROMPT_EVENT = "tietiezhi:git-review-prompt";

function defaultBranch(taskId: string): string {
  return `codex/${taskId.slice(0, 8)}-changes`;
}

export function WorkspaceGitPanel({
  taskId,
  disabled,
}: {
  taskId: string;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [activePath, setActivePath] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [operation, setOperation] = useState("");
  const [feedback, setFeedback] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [remote, setRemote] = useState("origin");
  const [branch, setBranch] = useState(() => defaultBranch(taskId));
  const [comment, setComment] = useState("");
  const [commentContext, setCommentContext] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const query = useQuery({
    queryKey: ["task-workspace-git-diff", taskId],
    queryFn: () => taskWorkspaceGitDiff(taskId),
    enabled: open,
  });
  const diff = query.data;
  const active =
    diff?.changes.find((change) => change.path === activePath) ?? diff?.changes[0];
  const staged = diff?.changes.filter((change) => change.staged) ?? [];
  const selectedChanges =
    diff?.changes.filter((change) => selected.includes(change.path)) ?? [];
  const stagePaths = selectedChanges
    .filter((change) => !change.staged || change.unstaged)
    .map((change) => change.path);
  const unstagePaths = selectedChanges
    .filter((change) => change.staged)
    .map((change) => change.path);

  useEffect(() => {
    if (!diff) return;
    if (!diff.changes.some((change) => change.path === activePath)) {
      setActivePath(diff.changes[0]?.path ?? "");
    }
    setSelected((current) =>
      current.filter((path) => diff.changes.some((change) => change.path === path)),
    );
    if (diff.remotes.length > 0 && !diff.remotes.includes(remote)) {
      setRemote(diff.remotes[0]);
    }
  }, [diff, activePath, remote]);

  useEffect(() => {
    setBranch(defaultBranch(taskId));
  }, [taskId]);

  const updateDiff = (next: WorkspaceGitDiff) => {
    queryClient.setQueryData(["task-workspace-git-diff", taskId], next);
    void queryClient.invalidateQueries({ queryKey: ["task-workspace-overview", taskId] });
  };

  const run = async (key: string, action: () => Promise<void>) => {
    if (operation) return;
    setOperation(key);
    setFeedback("");
    try {
      await action();
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setOperation("");
    }
  };

  const toggle = (path: string) =>
    setSelected((current) =>
      current.includes(path)
        ? current.filter((candidate) => candidate !== path)
        : [...current, path],
    );

  const sendComment = () => {
    if (!active || !comment.trim()) return;
    const prompt = [
      `请根据代码审查意见修改 ${active.path}${commentContext ? `（${commentContext}）` : ""}：`,
      comment.trim(),
      "",
      "先检查当前工作区 Diff，只修改与该意见相关的内容，完成后运行对应测试并总结。",
    ].join("\n");
    window.dispatchEvent(
      new CustomEvent(GIT_REVIEW_PROMPT_EVENT, {
        detail: { taskId, prompt },
      }),
    );
    setComment("");
    setFeedback("审查意见已放入当前任务输入框");
  };

  const selectedSummary = useMemo(
    () => `${selected.length} 个已选择 · ${staged.length} 个已暂存`,
    [selected.length, staged.length],
  );

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="h-7 gap-1.5 px-2 text-[11px]"
          >
            <FileDiff />
            Diff
          </Button>
        </SheetTrigger>
        <SheetContent className="w-[min(96vw,76rem)] gap-0 sm:max-w-none">
          <SheetHeader className="border-b">
            <SheetTitle className="flex items-center gap-2">
              <FileDiff className="size-4" /> 工作区 Diff
            </SheetTitle>
            <SheetDescription>
              {selectedSummary}。回退仅作用于明确选择的文件，不修改其他工作区内容。
            </SheetDescription>
          </SheetHeader>

          <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)]">
            <aside className="border-r">
              <div className="flex items-center gap-2 border-b p-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={stagePaths.length === 0 || Boolean(operation)}
                  onClick={() =>
                    void run("stage", async () => {
                      updateDiff(
                        await stageTaskWorkspacePaths({ taskId, paths: stagePaths }),
                      );
                    })
                  }
                >
                  <Check /> 暂存
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={unstagePaths.length === 0 || Boolean(operation)}
                  onClick={() =>
                    void run("unstage", async () => {
                      updateDiff(
                        await unstageTaskWorkspacePaths({ taskId, paths: unstagePaths }),
                      );
                    })
                  }
                >
                  取消暂存
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={selected.length === 0 || Boolean(operation)}
                  onClick={() => setConfirmDiscard(true)}
                  className="text-destructive"
                >
                  <RotateCcw /> 回退
                </Button>
              </div>
              <div className="h-[calc(100vh-17rem)] overflow-y-auto p-2">
                {query.isLoading ? (
                  <Loader2 className="text-muted-foreground mx-auto mt-8 size-4 animate-spin" />
                ) : diff?.changes.length ? (
                  diff.changes.map((change) => (
                    <label
                      key={change.path}
                      className={cn(
                        "hover:bg-accent flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2",
                        active?.path === change.path && "bg-accent",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(change.path)}
                        onChange={() => toggle(change.path)}
                        className="mt-0.5"
                      />
                      <button
                        type="button"
                        onClick={() => setActivePath(change.path)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="block truncate text-xs">{change.path}</span>
                        <span className="mt-1 flex gap-1">
                          {change.staged && <Badge variant="secondary">staged</Badge>}
                          {change.unstaged && <Badge variant="outline">modified</Badge>}
                          {change.untracked && <Badge variant="outline">untracked</Badge>}
                        </span>
                      </button>
                    </label>
                  ))
                ) : (
                  <p className="text-muted-foreground py-8 text-center text-xs">
                    工作区没有变更
                  </p>
                )}
              </div>
            </aside>

            <main className="flex min-w-0 flex-col">
              <div className="min-h-0 flex-1 overflow-auto p-3">
                {active ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-mono text-xs font-semibold">
                        {active.path}
                      </p>
                      {active.truncated && <Badge variant="outline">Diff 已截断</Badge>}
                    </div>
                    {active.stagedDiff && (
                      <DiffBlock
                        title="已暂存"
                        diff={active.stagedDiff}
                        onContext={setCommentContext}
                      />
                    )}
                    {active.unstagedDiff && (
                      <DiffBlock
                        title={active.untracked ? "未跟踪" : "未暂存"}
                        diff={active.unstagedDiff}
                        onContext={setCommentContext}
                      />
                    )}
                    <div className="bg-muted/30 rounded-xl border p-3">
                      <p className="mb-2 flex items-center gap-2 text-xs font-semibold">
                        <MessageSquareText className="size-4" />
                        文件或 Hunk 审查意见
                        {commentContext && (
                          <Badge variant="outline">{commentContext}</Badge>
                        )}
                      </p>
                      <Textarea
                        value={comment}
                        onChange={(event) => setComment(event.target.value)}
                        placeholder="说明需要修改的内容"
                        className="min-h-20"
                      />
                      <Button
                        size="sm"
                        className="mt-2"
                        disabled={!comment.trim()}
                        onClick={sendComment}
                      >
                        作为新一轮输入
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground py-12 text-center text-sm">
                    选择文件查看 Diff
                  </p>
                )}
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t p-3">
                <Input
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder="提交说明"
                />
                <Button
                  size="sm"
                  disabled={!commitMessage.trim() || staged.length === 0 || Boolean(operation)}
                  onClick={() =>
                    void run("commit", async () => {
                      const committed = await commitTaskWorkspace({
                        taskId,
                        message: commitMessage,
                      });
                      setCommitMessage("");
                      setFeedback(`已提交 ${committed.commit.slice(0, 8)}`);
                      updateDiff(await taskWorkspaceGitDiff(taskId));
                    })
                  }
                >
                  <GitCommitHorizontal /> Commit
                </Button>
                <div className="col-span-2 grid grid-cols-[10rem_minmax(0,1fr)_auto_auto] gap-2">
                  <Input
                    value={remote}
                    onChange={(event) => setRemote(event.target.value)}
                    placeholder="remote"
                  />
                  <Input
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    placeholder="branch"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!remote || !branch || Boolean(operation)}
                    onClick={() =>
                      void run("push", async () => {
                        updateDiff(
                          await pushTaskWorkspace({ taskId, remote, branch }),
                        );
                        setFeedback(`已推送 ${remote}/${branch}`);
                      })
                    }
                  >
                    <Upload /> Push
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!remote || !branch || Boolean(operation)}
                    onClick={() =>
                      void run("pr", async () => {
                        const url = await taskWorkspacePullRequestUrl({
                          taskId,
                          remote,
                          branch,
                        });
                        window.open(url, "_blank", "noopener,noreferrer");
                        setFeedback("已打开 Pull Request 页面");
                      })
                    }
                  >
                    <ExternalLink /> PR
                  </Button>
                </div>
                {(feedback || operation) && (
                  <p
                    role="status"
                    className="text-muted-foreground col-span-2 flex items-center gap-2 text-xs"
                  >
                    {operation && <Loader2 className="size-3 animate-spin" />}
                    {feedback || "正在执行 Git 操作"}
                  </p>
                )}
              </div>
            </main>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>回退所选文件？</AlertDialogTitle>
            <AlertDialogDescription>
              将丢弃 {selected.length} 个明确选择文件的工作区和暂存区修改。其他文件不会改变。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void run("discard", async () => {
                  setConfirmDiscard(false);
                  updateDiff(
                    await discardTaskWorkspacePaths({ taskId, paths: selected }),
                  );
                  setSelected([]);
                })
              }
            >
              回退所选文件
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function DiffBlock({
  title,
  diff,
  onContext,
}: {
  title: string;
  diff: string;
  onContext: (context: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border">
      <header className="bg-muted/50 border-b px-3 py-2 text-xs font-semibold">{title}</header>
      <div className="overflow-x-auto bg-[#111713] py-2 font-mono text-[11px] text-[#d7e4da]">
        {diff.split("\n").map((line, index) => (
          <button
            key={`${index}-${line}`}
            type="button"
            onClick={() => onContext(line.startsWith("@@") ? line : `Diff 第 ${index + 1} 行`)}
            className={cn(
              "block w-full min-w-max px-3 text-left whitespace-pre hover:bg-white/5",
              line.startsWith("+") && !line.startsWith("+++") && "bg-emerald-500/10",
              line.startsWith("-") && !line.startsWith("---") && "bg-rose-500/10",
              line.startsWith("@@") && "bg-sky-500/10 text-sky-200",
            )}
          >
            {line || " "}
          </button>
        ))}
      </div>
    </section>
  );
}
