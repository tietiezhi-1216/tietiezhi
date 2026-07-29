import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Boxes,
  CircleAlert,
  CircleCheck,
  CircleStop,
  Download,
  LoaderCircle,
  Play,
  RefreshCw,
  ScrollText,
  Trash2,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  CORES_QUERY_KEY,
  coreInstall,
  coreList,
  coreStart,
  coreStderr,
  coreStop,
  coreUninstall,
} from "./api";
import {
  INSTALL_STAGE_TEXT,
  INSTALL_STAGE_WIDTH,
  configFormatLabel,
  errorMessage,
  formatTimestamp,
  installStage,
  sourceLabel,
} from "./helpers";
import { mergeInstallState, mergeRunState, useCoresStore } from "./store";
import type { CoreCapabilities, CoreInstallState, CoreListRow, CoreRunState } from "./types";

function InstallBadge({ state }: { state: CoreInstallState }) {
  switch (state.status) {
    case "installed":
      return (
        <Badge variant="secondary" className="text-emerald-600 dark:text-emerald-400">
          <CircleCheck data-icon="inline-start" />
          已安装 {state.version}
        </Badge>
      );
    case "installing":
      return (
        <Badge variant="secondary">
          <LoaderCircle data-icon="inline-start" className="animate-spin" />
          安装中
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <CircleAlert data-icon="inline-start" />
          安装失败
        </Badge>
      );
    case "not-installed":
      return <Badge variant="outline">未安装</Badge>;
  }
}

function RunBadge({ state }: { state: CoreRunState }) {
  switch (state.status) {
    case "ready":
      return (
        <Badge variant="secondary" className="text-emerald-600 dark:text-emerald-400">
          运行中 · PID {state.pid} · 协议 v{state.protocolVersion}
        </Badge>
      );
    case "starting":
      return (
        <Badge variant="secondary">
          <LoaderCircle data-icon="inline-start" className="animate-spin" />
          启动中
        </Badge>
      );
    case "crashed":
      return (
        <Badge variant="destructive">已崩溃{state.code === null ? "" : ` · 退出码 ${state.code}`}</Badge>
      );
    case "stopped":
      return <Badge variant="outline">未运行</Badge>;
  }
}

function CapabilityBadges({ capabilities }: { capabilities: CoreCapabilities | null }) {
  if (!capabilities) {
    return <span className="text-muted-foreground text-xs">启动后才能读取核心能力。</span>;
  }
  const items: Array<{ label: string; on: boolean }> = [
    { label: "会话恢复", on: capabilities.loadSession },
    { label: "图片输入", on: capabilities.promptImage },
    { label: "音频输入", on: capabilities.promptAudio },
    { label: "内嵌上下文", on: capabilities.promptEmbeddedContext },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Badge key={item.label} variant={item.on ? "secondary" : "outline"}>
          {item.on ? <CircleCheck data-icon="inline-start" /> : <Ban data-icon="inline-start" />}
          {item.label}
        </Badge>
      ))}
    </div>
  );
}

/** Heuristic install feedback — never rendered as an exact percentage. */
function InstallProgress({ progress }: { progress: number | undefined }) {
  const stage = installStage(progress);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed px-3 py-2">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <LoaderCircle className="size-3 animate-spin" />
        <span>{INSTALL_STAGE_TEXT[stage]}</span>
      </div>
      <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
        <div className={cn("bg-primary h-full animate-pulse rounded-full", INSTALL_STAGE_WIDTH[stage])} />
      </div>
      <p className="text-muted-foreground text-xs">进度为粗略估算，仅表示阶段，不代表实际完成比例。</p>
    </div>
  );
}

function StderrDialog({ coreId, onClose }: { coreId: string | null; onClose: () => void }) {
  const logQuery = useQuery({
    queryKey: ["cores", "stderr", coreId],
    queryFn: () => coreStderr(coreId ?? ""),
    enabled: coreId !== null,
    refetchInterval: 2000,
  });

  const lines = logQuery.data ?? [];

  return (
    <Dialog open={coreId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>核心输出日志</DialogTitle>
          <DialogDescription>
            {coreId ?? ""} 的标准错误输出，用于排查启动失败。
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="h-80 rounded-lg border">
          {logQuery.isError ? (
            <p className="text-destructive p-3 text-sm">{errorMessage(logQuery.error)}</p>
          ) : lines.length === 0 ? (
            <p className="text-muted-foreground p-3 text-sm">暂无输出。</p>
          ) : (
            <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {lines.join("\n")}
            </pre>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

interface CoreCardProps {
  row: CoreListRow;
  install: CoreInstallState;
  run: CoreRunState;
  selected: boolean;
  busy: boolean;
  error: string | null;
  onSelect: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  onStart: () => void;
  onStop: () => void;
  onShowLog: () => void;
}

function CoreCard(props: CoreCardProps) {
  const { descriptor, capabilities } = props.row;
  const installed = props.install.status === "installed";
  const installing = props.install.status === "installing";
  const running = props.run.status === "ready";
  const starting = props.run.status === "starting";

  return (
    <Card
      className={cn(
        "transition-shadow",
        props.selected && "ring-primary/50 ring-2",
      )}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Boxes className="size-4 shrink-0" />
          <span className="truncate">{descriptor.name}</span>
          {descriptor.firstParty && <Badge variant="default">官方核心</Badge>}
        </CardTitle>
        <CardDescription className="text-xs">{descriptor.summary}</CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant={props.selected ? "secondary" : "outline"}
            onClick={props.onSelect}
          >
            {props.selected ? "当前核心" : "选为当前"}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{sourceLabel(descriptor.source)}</Badge>
          <Badge variant="outline">{configFormatLabel(descriptor.configFormat)}</Badge>
          <InstallBadge state={props.install} />
          <RunBadge state={props.run} />
        </div>

        <div className="text-muted-foreground truncate font-mono text-xs">
          {descriptor.command} {descriptor.args.join(" ")}
        </div>

        {props.install.status === "installed" && props.install.installedAt > 0 && (
          <p className="text-muted-foreground text-xs">
            安装于 {formatTimestamp(props.install.installedAt)}
          </p>
        )}

        {props.install.status === "installing" && (
          <InstallProgress progress={props.install.progress} />
        )}

        {props.install.status === "failed" && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>安装失败</AlertTitle>
            <AlertDescription>{props.install.message}</AlertDescription>
          </Alert>
        )}

        {props.run.status === "crashed" && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>核心已崩溃</AlertTitle>
            <AlertDescription>{props.run.message || "核心进程异常退出。"}</AlertDescription>
          </Alert>
        )}

        {props.error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>操作失败</AlertTitle>
            <AlertDescription>{props.error}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs font-medium">能力</span>
          <CapabilityBadges capabilities={capabilities} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {descriptor.source === "npm" && !installed && (
            <Button size="sm" onClick={props.onInstall} disabled={props.busy || installing}>
              {installing ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Download />
              )}
              安装
            </Button>
          )}

          {running || starting ? (
            <Button size="sm" variant="outline" onClick={props.onStop} disabled={props.busy}>
              <CircleStop />
              停止
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={props.onStart}
              disabled={props.busy || installing || !installed}
            >
              <Play />
              启动
            </Button>
          )}

          {running && (
            <Button size="sm" variant="ghost" onClick={props.onStart} disabled={props.busy}>
              <RefreshCw />
              重启
            </Button>
          )}

          <Button size="sm" variant="ghost" onClick={props.onShowLog}>
            <ScrollText />
            日志
          </Button>

          {descriptor.source === "npm" && installed && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={props.onUninstall}
              disabled={props.busy}
            >
              <Trash2 />
              卸载
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Core catalogue: install / uninstall / start / stop, plus capability readout. */
export function CorePicker({ className }: { className?: string }) {
  const queryClient = useQueryClient();
  const [logCoreId, setLogCoreId] = useState<string | null>(null);

  const installOverrides = useCoresStore((state) => state.installState);
  const runOverrides = useCoresStore((state) => state.runState);
  const selectedCoreId = useCoresStore((state) => state.selectedCoreId);
  const selectCore = useCoresStore((state) => state.selectCore);

  const coresQuery = useQuery({ queryKey: CORES_QUERY_KEY, queryFn: coreList });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: CORES_QUERY_KEY });
  };

  const install = useMutation({ mutationFn: coreInstall, onSettled: invalidate });
  const uninstall = useMutation({ mutationFn: coreUninstall, onSettled: invalidate });
  const start = useMutation({ mutationFn: coreStart, onSettled: invalidate });
  const stop = useMutation({ mutationFn: coreStop, onSettled: invalidate });

  const mutations = [install, uninstall, start, stop];

  const busyFor = (coreId: string): boolean =>
    mutations.some((mutation) => mutation.isPending && mutation.variables === coreId);

  const errorFor = (coreId: string): string | null => {
    for (const mutation of mutations) {
      if (mutation.error && mutation.variables === coreId) return errorMessage(mutation.error);
    }
    return null;
  };

  const rows = coresQuery.data ?? [];

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base leading-none font-semibold">Agent 核心</h2>
          <p className="text-muted-foreground text-xs">
            选择、安装并启动一个核心，随后即可在右侧开始会话。
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void coresQuery.refetch()}
          disabled={coresQuery.isFetching}
        >
          {coresQuery.isFetching ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          刷新
        </Button>
      </div>

      {coresQuery.isError && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>无法读取核心列表</AlertTitle>
          <AlertDescription>{errorMessage(coresQuery.error)}</AlertDescription>
        </Alert>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 pr-3">
          {coresQuery.isLoading && (
            <>
              <Skeleton className="h-40 w-full rounded-xl" />
              <Skeleton className="h-40 w-full rounded-xl" />
            </>
          )}

          {!coresQuery.isLoading && rows.length === 0 && !coresQuery.isError && (
            <p className="text-muted-foreground py-6 text-sm">当前没有可用的核心。</p>
          )}

          {rows.map((row) => {
            const coreId = row.descriptor.id;
            return (
              <CoreCard
                key={coreId}
                row={row}
                install={mergeInstallState(row.install, installOverrides[coreId])}
                run={mergeRunState(row.run, runOverrides[coreId])}
                selected={selectedCoreId === coreId}
                busy={busyFor(coreId)}
                error={errorFor(coreId)}
                onSelect={() => selectCore(coreId)}
                onInstall={() => install.mutate(coreId)}
                onUninstall={() => uninstall.mutate(coreId)}
                onStart={() => start.mutate(coreId)}
                onStop={() => stop.mutate(coreId)}
                onShowLog={() => setLogCoreId(coreId)}
              />
            );
          })}
        </div>
      </ScrollArea>

      <StderrDialog coreId={logCoreId} onClose={() => setLogCoreId(null)} />
    </div>
  );
}
