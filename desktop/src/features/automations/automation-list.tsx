import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  Ban,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  History,
  LoaderCircle,
  MoreHorizontal,
  MousePointerClick,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  Workflow,
  XCircle,
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ProductMotionStage } from "@/components/product-motion-stage";
import { ProductMascotMotion } from "@/components/product-mascot-motion";
import { Skeleton } from "@/components/ui/skeleton";
import {
  cancelAutomationRun,
  errorMessage,
  listAutomationRuns,
  pauseAutomation,
  runAutomation,
  type AutomationMeta,
  type AutomationRun,
  type AutomationRunStatus,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { useAutomationStore } from "@/stores/automations";

type AutomationTab = "workflows" | "runs";

export function AutomationList() {
  const automations = useAutomationStore((state) => state.automations);
  const loading = useAutomationStore((state) => state.loading);
  const init = useAutomationStore((state) => state.init);
  const create = useAutomationStore((state) => state.create);
  const open = useAutomationStore((state) => state.open);
  const archive = useAutomationStore((state) => state.archive);
  const remove = useAutomationStore((state) => state.remove);
  const [tab, setTab] = useState<AutomationTab>("workflows");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState("");
  const [actionError, setActionError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AutomationMeta | null>(null);
  const runsQuery = useQuery({
    queryKey: ["automation-runs"],
    queryFn: () => listAutomationRuns(undefined, 200),
    enabled: tab === "runs",
    refetchInterval: tab === "runs" ? 2_000 : false,
  });
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return automations;
    return automations.filter((item) =>
      `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle),
    );
  }, [automations, query]);
  const automationById = useMemo(
    () => new Map(automations.map((item) => [item.id, item])),
    [automations],
  );

  const runNow = async (item: AutomationMeta) => {
    setBusyId(item.id);
    setActionError("");
    try {
      await runAutomation(item.id);
      await Promise.all([init(), runsQuery.refetch()]);
      setTab("runs");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyId("");
    }
  };

  const togglePaused = async (item: AutomationMeta) => {
    setBusyId(item.id);
    setActionError("");
    try {
      await pauseAutomation(item.id, !item.paused);
      await init();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyId("");
    }
  };

  const cancelRun = async (run: AutomationRun) => {
    setBusyId(run.id);
    setActionError("");
    try {
      await cancelAutomationRun(run.automationId, run.id);
      await Promise.all([init(), runsQuery.refetch()]);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyId("");
    }
  };

  return (
    <main className="h-full overflow-auto bg-muted/15">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 lg:px-10">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 sm:grid-cols-[minmax(0,1fr)_14rem_auto]">
          <div className="col-start-1 row-start-1">
            <h1 className="text-2xl font-semibold tracking-tight">工作流</h1>
            <p className="text-muted-foreground mt-1.5 text-sm">
              在选定项目目录或共享 Local 工作区中运行 Agent、Skills、MCP 和本地工具。
            </p>
          </div>
          <ProductMotionStage
            variant="automations"
            className="col-span-2 row-start-2 h-24 w-full sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:h-32 sm:w-56"
            mascotClassName="size-20 sm:size-24"
          >
            <ProductMascotMotion
              src="/mode-mascots/paper-plane/automations.png"
              variant="automations"
              intensity="stage"
              className="absolute inset-0 size-full"
            />
          </ProductMotionStage>
          <Button
            type="button"
            className="col-start-2 row-start-1 sm:col-start-3"
            onClick={() => void create()}
          >
            <Plus />
            新建工作流
          </Button>
        </header>

        <nav className="mt-7 flex items-center gap-1 border-b" aria-label="Automation 导航">
          <TabButton
            active={tab === "workflows"}
            icon={Workflow}
            label="工作流"
            count={automations.length}
            onClick={() => setTab("workflows")}
          />
          <TabButton
            active={tab === "runs"}
            icon={History}
            label="运行记录"
            count={runsQuery.data?.length}
            onClick={() => setTab("runs")}
          />
        </nav>

        {actionError && (
          <Alert variant="destructive" className="mt-4">
            <CircleAlert />
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}

        {tab === "workflows" ? (
          <section className="mt-5 overflow-hidden rounded-xl border bg-background">
            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-medium">全部工作流</h2>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  草稿与已发布快照相互隔离
                </p>
              </div>
              <InputGroup className="sm:w-64">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索工作流"
                  aria-label="搜索工作流"
                />
              </InputGroup>
            </div>

            {loading ? (
              <LoadingRows />
            ) : visible.length === 0 ? (
              <EmptyWorkflows query={query} onCreate={() => void create()} />
            ) : (
              <div className="divide-y">
                {visible.map((item) => (
                  <WorkflowRow
                    key={item.id}
                    item={item}
                    busy={busyId === item.id}
                    onOpen={() => void open(item.id)}
                    onRun={() => void runNow(item)}
                    onTogglePaused={() => void togglePaused(item)}
                    onArchive={() => void archive(item.id)}
                    onDelete={() => setDeleteTarget(item)}
                  />
                ))}
              </div>
            )}
          </section>
        ) : (
          <RunsPanel
            runs={runsQuery.data ?? []}
            loading={runsQuery.isLoading}
            error={runsQuery.error ? errorMessage(runsQuery.error) : ""}
            automationById={automationById}
            busyId={busyId}
            onCancel={(run) => void cancelRun(run)}
            onRefresh={() => void runsQuery.refetch()}
          />
        )}
      </div>

      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>永久删除 Automation？</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.name}”的草稿、发布快照、本地工作目录与运行记录都将被删除，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTarget) void remove(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function WorkflowRow({
  item,
  busy,
  onOpen,
  onRun,
  onTogglePaused,
  onArchive,
  onDelete,
}: {
  item: AutomationMeta;
  busy: boolean;
  onOpen: () => void;
  onRun: () => void;
  onTogglePaused: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const TriggerIcon =
    item.triggerType === "scheduleTrigger" ? CalendarClock : MousePointerClick;
  const published = item.publishedRevision > 0;
  return (
    <div className="hover:bg-muted/35 group flex items-center gap-3 px-4 py-3 transition-colors">
      <button
        type="button"
        onClick={onOpen}
        className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-md border">
          <TriggerIcon className="text-muted-foreground size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{item.name}</span>
            <Badge
              variant={published && !item.paused ? "default" : "outline"}
              className="shrink-0 px-1.5 py-0 text-[10px]"
            >
              {!published ? "草稿" : item.paused ? "已暂停" : `已启用 r${item.publishedRevision}`}
            </Badge>
            {item.lastRunStatus && (
              <RunStatusBadge status={item.lastRunStatus as AutomationRunStatus} />
            )}
          </span>
          <span className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 text-xs">
            <span>{triggerLabel(item.triggerType)}</span>
            <span>{item.nodeCount} 个节点</span>
            <span>{formatRelativeTime(item.updatedAt) ?? "刚刚"}更新</span>
            {item.nextRunAt > 0 && (
              <span>下次 {formatDateTime(item.nextRunAt)}</span>
            )}
          </span>
        </span>
      </button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!published || busy}
        onClick={onRun}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : <Play />}
        运行
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${item.name} 操作`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {published && (
            <DropdownMenuItem disabled={busy} onSelect={onTogglePaused}>
              {item.paused ? <Play /> : <Pause />}
              {item.paused ? "恢复定时运行" : "暂停定时运行"}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onArchive}>
            <Archive />
            归档
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 />
            永久删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RunsPanel({
  runs,
  loading,
  error,
  automationById,
  busyId,
  onCancel,
  onRefresh,
}: {
  runs: AutomationRun[];
  loading: boolean;
  error: string;
  automationById: Map<string, AutomationMeta>;
  busyId: string;
  onCancel: (run: AutomationRun) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="mt-5 overflow-hidden rounded-xl border bg-background">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">运行记录</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            每次运行关联独立 Thread、Turn 和 Local 工作目录
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
          <History />
          刷新
        </Button>
      </div>
      {error ? (
        <div className="p-4">
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : loading ? (
        <LoadingRows />
      ) : runs.length === 0 ? (
        <div className="grid min-h-64 place-items-center p-8 text-center">
          <div>
            <History className="text-muted-foreground mx-auto size-5" />
            <p className="mt-3 text-sm font-medium">还没有运行记录</p>
            <p className="text-muted-foreground mt-1 text-xs">
              发布工作流后可手动运行，定时任务也会显示在这里。
            </p>
          </div>
        </div>
      ) : (
        <div className="divide-y">
          {runs.map((run) => {
            const active = run.status === "queued" || run.status === "running";
            return (
              <article key={run.id} className="space-y-3 px-4 py-4">
                <div className="flex items-start gap-3">
                  <RunStatusIcon status={run.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium">
                        {automationById.get(run.automationId)?.name ??
                          "已删除的 Automation"}
                      </h3>
                      <RunStatusBadge status={run.status} />
                      <Badge variant="outline" className="font-mono text-[10px]">
                        r{run.revision}
                      </Badge>
                      <span className="text-muted-foreground text-[10px]">
                        {run.trigger === "schedule" ? "定时" : "手动"}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {formatDateTime(run.startedAt)}
                      {run.finishedAt > 0 &&
                        ` · ${formatDuration(run.finishedAt - run.startedAt)}`}
                    </p>
                  </div>
                  {active && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busyId === run.id}
                      onClick={() => onCancel(run)}
                    >
                      {busyId === run.id ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Ban />
                      )}
                      取消
                    </Button>
                  )}
                </div>
                {(run.output || run.error) && (
                  <div
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-xs leading-5 whitespace-pre-wrap",
                      run.error
                        ? "border-destructive/25 bg-destructive/5 text-destructive"
                        : "bg-muted/35",
                    )}
                  >
                    {run.error ?? run.output}
                  </div>
                )}
                <dl className="grid gap-1.5 font-mono text-[10px] sm:grid-cols-2">
                  <RunDetail label="Thread" value={run.threadId || "尚未创建"} />
                  <RunDetail label="Turn" value={run.turnId || "尚未创建"} />
                  <RunDetail
                    label="Local"
                    value={run.workspacePath}
                    className="sm:col-span-2"
                  />
                </dl>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RunDetail({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("bg-muted/30 min-w-0 rounded-md border px-2.5 py-2", className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate" title={value}>
        {value}
      </dd>
    </div>
  );
}

function RunStatusIcon({ status }: { status: AutomationRunStatus }) {
  const classes = "mt-0.5 size-4 shrink-0";
  if (status === "completed")
    return <CheckCircle2 className={cn(classes, "text-emerald-600")} />;
  if (status === "failed")
    return <XCircle className={cn(classes, "text-destructive")} />;
  if (status === "cancelled")
    return <Ban className={cn(classes, "text-muted-foreground")} />;
  return <LoaderCircle className={cn(classes, "text-primary animate-spin")} />;
}

function RunStatusBadge({ status }: { status: AutomationRunStatus }) {
  const labels: Record<AutomationRunStatus, string> = {
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return (
    <Badge
      variant={status === "failed" ? "destructive" : "secondary"}
      className="px-1.5 py-0 text-[10px]"
    >
      {labels[status] ?? status}
    </Badge>
  );
}

function TabButton({
  active,
  icon: Icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: typeof Workflow;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-10 items-center gap-2 border-b-2 px-3 text-sm transition-colors",
        active
          ? "border-foreground font-medium"
          : "text-muted-foreground border-transparent hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
      {label}
      {count != null && (
        <span className="bg-muted rounded px-1.5 py-0.5 text-[10px] tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
}

function EmptyWorkflows({
  query,
  onCreate,
}: {
  query: string;
  onCreate: () => void;
}) {
  return (
    <div className="grid min-h-64 place-items-center p-8 text-center">
      <div className="max-w-sm">
        <span className="bg-muted mx-auto grid size-10 place-items-center rounded-lg border">
          <Workflow className="text-muted-foreground size-4" />
        </span>
        <h3 className="mt-3 text-sm font-medium">
          {query ? "没有匹配的工作流" : "还没有工作流"}
        </h3>
        <p className="text-muted-foreground mt-1.5 text-xs leading-5">
          {query
            ? "尝试使用其它名称或描述搜索。"
            : "创建后，从触发器开始拖入需要的节点。"}
        </p>
        {!query && (
          <Button size="sm" className="mt-4" onClick={onCreate}>
            <Plus />
            新建工作流
          </Button>
        )}
      </div>
    </div>
  );
}

function triggerLabel(type: string): string {
  if (type === "manualTrigger") return "手动触发";
  if (type === "scheduleTrigger") return "定时触发";
  return "未配置触发器";
}

function formatDateTime(timestamp: number): string {
  if (!timestamp) return "未安排";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)} 秒`;
  return `${Math.round(milliseconds / 60_000)} 分钟`;
}
