import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BriefcaseBusiness,
  CheckCircle2,
  CircleAlert,
  Code2,
  FileOutput,
  Files,
  FolderGit2,
  GitBranch,
  GitFork,
  History,
  Loader2,
  MapPin,
  Milestone,
  RotateCcw,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  createTaskWorkspaceSnapshot,
  errorMessage,
  handoffTaskWorkspace,
  restoreTaskWorkspaceSnapshot,
  setTaskWorkspaceEnvironment,
  taskWorkspaceOverview,
} from "@/lib/api";
import type {
  ExecutionEnvironment,
  WorkspaceFileEntry,
  WorkspaceSnapshot,
} from "@/lib/api";
import { getTaskMode } from "@/lib/task-mode";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat";
import { WorkspaceGitPanel } from "@/features/chat/workspace-git-panel";

const formatBytes = (bytes: number): string => {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
};

const shortCommit = (commit: string): string => commit.slice(0, 8);

export function WorkspaceModePanel() {
  const queryClient = useQueryClient();
  const activeId = useChatStore((state) => state.activeId);
  const taskMode = useChatStore((state) => state.taskMode);
  const streaming = useChatStore((state) => state.streaming);
  const [operation, setOperation] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<WorkspaceSnapshot | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const definition = getTaskMode(taskMode);
  const Icon = taskMode === "work" ? BriefcaseBusiness : Code2;

  const overviewQuery = useQuery({
    queryKey: ["task-workspace-overview", activeId],
    queryFn: () => taskWorkspaceOverview(activeId!),
    enabled: activeId != null,
    refetchInterval: streaming ? 1_500 : false,
  });
  const overview = overviewQuery.data;
  const activeStatus = overview?.[taskMode];
  const resultFiles: WorkspaceFileEntry[] =
    taskMode === "work"
      ? (activeStatus?.deliverables ?? [])
      : (activeStatus?.changedFiles ?? []).map((path) => ({
          path,
          size: 0,
          modifiedAt: 0,
        }));
  const environment = overview?.environment ?? "worktree";
  const environmentName = environment === "worktree" ? "Worktree" : "Local";
  const canOperate = Boolean(activeId) && !streaming && operation == null;
  const canSnapshot = canOperate && Boolean(activeStatus?.isGit);

  const statusText = activeStatus?.initialized
    ? taskMode === "work"
      ? `${activeStatus.deliverables.length} 个成果 · ${activeStatus.fileCount}${activeStatus.fileCountCapped ? "+" : ""} 个文件`
      : activeStatus.isGit
        ? `${activeStatus.changedFiles.length} 项变更 · ${activeStatus.fileCount}${activeStatus.fileCountCapped ? "+" : ""} 个文件`
        : `普通目录 · ${activeStatus.fileCount}${activeStatus.fileCountCapped ? "+" : ""} 个文件`
    : activeId
      ? `首次执行时创建 ${environmentName} 环境`
      : "发送第一条消息后创建工作区";

  useEffect(() => {
    setFeedback(null);
  }, [activeId, taskMode]);

  useEffect(() => {
    if (activeId && !streaming) void overviewQuery.refetch();
  }, [activeId, streaming]);

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["task-workspace-overview", activeId],
    });
  };

  const runOperation = async (
    key: string,
    action: () => Promise<string>,
  ): Promise<void> => {
    if (!activeId || operation) return;
    setOperation(key);
    setFeedback(null);
    try {
      setFeedback({ kind: "success", text: await action() });
      await refresh();
    } catch (error) {
      setFeedback({ kind: "error", text: errorMessage(error) });
    } finally {
      setOperation(null);
    }
  };

  const switchEnvironment = (next: ExecutionEnvironment) =>
    runOperation(`environment-${next}`, async () => {
      await setTaskWorkspaceEnvironment({ taskId: activeId!, environment: next });
      return `已切换到 ${next === "worktree" ? "Worktree" : "Local"} 环境`;
    });

  const createSnapshot = () =>
    runOperation("snapshot", async () => {
      const snapshot = await createTaskWorkspaceSnapshot({
        taskId: activeId!,
        label: `手动快照 ${new Date().toLocaleString()}`,
      });
      return `已创建快照 ${shortCommit(snapshot.commit)}`;
    });

  const createHandoff = () =>
    runOperation("handoff", async () => {
      const handoff = await handoffTaskWorkspace({
        taskId: activeId!,
        label: "Codex handoff",
      });
      return `已创建分支 ${handoff.branch}`;
    });

  const restoreSnapshot = () => {
    const snapshot = pendingRestore;
    setPendingRestore(null);
    if (!snapshot) return;
    void runOperation(`restore-${snapshot.id}`, async () => {
      await restoreTaskWorkspaceSnapshot({
        taskId: activeId!,
        snapshotId: snapshot.id,
      });
      return `已恢复快照 ${shortCommit(snapshot.commit)}`;
    });
  };

  return (
    <>
      <section
        className={cn(
          "relative z-10 mx-1 mb-2 overflow-hidden rounded-xl border px-3 py-2.5 shadow-sm",
          taskMode === "work"
            ? "border-cyan-500/20 bg-cyan-500/[0.045]"
            : "border-violet-500/20 bg-violet-500/[0.045]",
        )}
      >
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-lg border",
              taskMode === "work"
                ? "border-cyan-500/20 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
                : "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300",
            )}
          >
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold">{definition.name}</span>
              <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-normal">
                {taskMode === "work" ? "无通用终端" : "终端可用"}
              </Badge>
              <Badge
                variant="secondary"
                className="h-4 gap-1 px-1.5 text-[9px] font-normal"
              >
                {environment === "worktree" ? <GitFork /> : <MapPin />}
                {environmentName}
              </Badge>
            </div>
            <p className="text-muted-foreground truncate text-[11px]">
              {definition.description} · {statusText}
            </p>
          </div>
          {(overviewQuery.isFetching || operation) && (
            <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
          )}

          {resultFiles.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[11px]">
                  {taskMode === "work" ? <FileOutput /> : <GitBranch />}
                  {taskMode === "work" ? "成果" : "变更"}
                  <span className="text-muted-foreground">{resultFiles.length}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" side="top" className="w-80 p-2">
                <WorkspaceFileList
                  title={taskMode === "work" ? "共享工作区成果" : "共享工作区变更"}
                  files={resultFiles}
                  showSize={taskMode === "work"}
                />
              </PopoverContent>
            </Popover>
          )}

          {activeId && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-[11px]">
                  {environment === "worktree" ? <FolderGit2 /> : <MapPin />}
                  环境
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" side="top" className="w-80 p-3">
                <p className="text-xs font-medium">执行环境</p>
                <p className="text-muted-foreground mt-1 text-[10px] leading-4">
                  Work 与 Code 共享此环境。Worktree 隔离修改，Local 直接使用项目目录。
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {(["worktree", "local"] as const).map((item) => (
                    <Button
                      key={item}
                      type="button"
                      variant={environment === item ? "default" : "outline"}
                      size="sm"
                      disabled={!canOperate || (item === "worktree" && !overview?.projectRoot)}
                      onClick={() => void switchEnvironment(item)}
                      className="justify-start"
                    >
                      {item === "worktree" ? <GitFork /> : <MapPin />}
                      {item === "worktree" ? "Worktree" : "Local"}
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {activeId && activeStatus?.isGit && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-[11px]">
                  <History />
                  快照
                  {overview && overview.snapshots.length > 0 && (
                    <span className="text-muted-foreground">{overview.snapshots.length}</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" side="top" className="w-96 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium">工作区快照</p>
                    <p className="text-muted-foreground mt-0.5 text-[10px]">
                      使用私有 Git 引用，不修改用户暂存区。
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canSnapshot}
                    onClick={() => void createSnapshot()}
                  >
                    <Milestone />
                    创建快照
                  </Button>
                </div>
                <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
                  {overview?.snapshots.length ? (
                    [...overview.snapshots].reverse().map((snapshot) => (
                      <div
                        key={snapshot.id}
                        className="hover:bg-accent flex items-center gap-2 rounded-md px-2 py-2"
                      >
                        <History className="text-muted-foreground size-3.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs">{snapshot.label}</p>
                          <p className="text-muted-foreground text-[10px]">
                            {shortCommit(snapshot.commit)}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={
                            !canOperate ||
                            environment !== "worktree" ||
                            operation === `restore-${snapshot.id}`
                          }
                          onClick={() => setPendingRestore(snapshot)}
                        >
                          <RotateCcw />
                          恢复
                        </Button>
                      </div>
                    ))
                  ) : (
                    <p className="text-muted-foreground py-5 text-center text-xs">暂无快照</p>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {activeId && environment === "worktree" && activeStatus?.isGit && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canOperate}
              onClick={() => void createHandoff()}
              className="h-7 gap-1.5 px-2 text-[11px]"
            >
              <GitBranch />
              Handoff
            </Button>
          )}
          {activeId && activeStatus?.isGit && (
            <WorkspaceGitPanel taskId={activeId} disabled={!canOperate} />
          )}
        </div>

        <div className="mt-2 flex items-center gap-1.5 overflow-hidden">
          {definition.capabilities.map((capability) => (
            <span
              key={capability}
              className="bg-background/70 text-muted-foreground rounded-md border px-1.5 py-0.5 text-[10px]"
            >
              {capability}
            </span>
          ))}
          <span className="text-muted-foreground ml-auto truncate text-[10px]">
            {overview?.detached ? "detached HEAD" : overview?.branch || definition.toolSummary}
          </span>
        </div>
        {feedback && (
          <p
            className={cn(
              "text-muted-foreground mt-1.5 flex items-center gap-1 text-[10px]",
              feedback.kind === "error" && "text-destructive",
            )}
          >
            {feedback.kind === "success" ? (
              <CheckCircle2 className="size-3" />
            ) : (
              <CircleAlert className="size-3" />
            )}
            <span className="truncate">{feedback.text}</span>
          </p>
        )}
      </section>

      <AlertDialog
        open={pendingRestore != null}
        onOpenChange={(open) => {
          if (!open) setPendingRestore(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>恢复工作区快照？</AlertDialogTitle>
            <AlertDialogDescription>
              当前未保存修改会先自动创建快照，然后工作区恢复到{" "}
              {pendingRestore ? shortCommit(pendingRestore.commit) : ""}。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={restoreSnapshot}>恢复</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function WorkspaceFileList({
  title,
  files,
  showSize,
}: {
  title: string;
  files: WorkspaceFileEntry[];
  showSize: boolean;
}) {
  return (
    <div>
      <p className="px-2 pt-1 pb-2 text-xs font-medium">{title}</p>
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {files.map((file) => (
          <div key={file.path} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <Files className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-xs">{file.path}</span>
            {showSize && (
              <span className="text-muted-foreground shrink-0 text-[10px]">
                {formatBytes(file.size)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
