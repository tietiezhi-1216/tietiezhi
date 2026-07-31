import { useMemo, useState } from "react";
import {
  Ban,
  Clock3,
  Image as ImageIcon,
  LoaderCircle,
  MoreHorizontal,
  RefreshCcw,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { MediaJob } from "@shared/contracts";

import { CreateAssetPreview } from "./create-asset-preview";
import { CreateComposer } from "./create-composer";
import type { CreateController } from "./create-types";

type TaskFilter = "all" | "running" | "completed" | "failed";

const STATUS_META: Record<
  MediaJob["status"],
  { label: string; className: string }
> = {
  queued: { label: "等待中", className: "border-white/12 text-white/50" },
  running: { label: "生成中", className: "border-cyan-300/20 bg-cyan-300/6 text-cyan-200" },
  completed: { label: "已完成", className: "border-emerald-300/16 bg-emerald-300/5 text-emerald-200" },
  failed: { label: "失败", className: "border-rose-300/16 bg-rose-300/5 text-rose-200" },
  cancelled: { label: "已取消", className: "border-white/10 text-white/40" },
};

export function CreateGenerations({ controller }: { controller: CreateController }) {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const visibleJobs = useMemo(
    () =>
      controller.jobs.filter((job) => {
        if (filter === "all") return true;
        if (filter === "running") return job.status === "queued" || job.status === "running";
        if (filter === "failed") return job.status === "failed" || job.status === "cancelled";
        return job.status === "completed";
      }),
    [controller.jobs, filter],
  );

  return (
    <div className="h-full overflow-y-auto bg-[#0d0e11] text-white">
      <div className="mx-auto w-full max-w-[92rem] px-4 py-7 sm:px-7 lg:px-10 lg:py-10">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium tracking-[0.18em] text-cyan-300/70 uppercase">
              Generation
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">生成记录</h1>
            <p className="mt-2 text-sm text-white/36">
              查看进度、重试任务，或基于历史描述继续创作。
            </p>
          </div>
          <div className="w-full xl:max-w-2xl">
            <CreateComposer controller={controller} compact />
          </div>
        </div>
        <div className="mt-8 flex gap-1 border-b border-white/7 pb-3">
          {([
            ["all", "全部"],
            ["running", "进行中"],
            ["completed", "已完成"],
            ["failed", "失败"],
          ] as const).map(([id, label]) => (
            <Button
              key={id}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setFilter(id)}
              className={cn(
                "rounded-xl px-4 text-white/42 hover:bg-white/6 hover:text-white",
                filter === id && "bg-white/9 text-white hover:bg-white/9",
              )}
            >
              {label}
            </Button>
          ))}
        </div>
        {visibleJobs.length === 0 ? (
          <div className="grid min-h-96 place-items-center">
            <div className="max-w-sm text-center">
              <span className="mx-auto grid size-14 place-items-center rounded-2xl border border-white/7 bg-white/4">
                <Sparkles className="size-5 text-white/35" />
              </span>
              <h2 className="mt-4 text-sm font-semibold">还没有生成记录</h2>
              <p className="mt-1 text-xs leading-5 text-white/35">
                在上方描述想法，第一条任务会出现在这里。
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-5 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {visibleJobs.map((job) => (
              <TaskCard key={job.id} job={job} controller={controller} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskCard({
  job,
  controller,
}: {
  job: MediaJob;
  controller: CreateController;
}) {
  const active = job.status === "queued" || job.status === "running";
  const status = STATUS_META[job.status];
  const artifact = job.artifacts[0];

  return (
    <article className="overflow-hidden rounded-2xl border border-white/7 bg-[#15171b]">
      <div className="grid min-h-44 grid-cols-[8.5rem_minmax(0,1fr)] sm:grid-cols-[11rem_minmax(0,1fr)]">
        {artifact ? (
          <CreateAssetPreview
            artifact={artifact}
            alt={job.prompt}
            className="h-full min-h-44"
          />
        ) : (
          <div className="relative grid min-h-44 place-items-center overflow-hidden bg-[#101216]">
            <span className="absolute -top-8 -left-8 size-28 rounded-full bg-cyan-400/10 blur-3xl" />
            <span className="absolute -right-8 -bottom-8 size-32 rounded-full bg-blue-500/12 blur-3xl" />
            {active ? (
              <LoaderCircle className="relative size-5 animate-spin text-cyan-300/65" />
            ) : (
              <ImageIcon className="relative size-6 text-white/28" />
            )}
          </div>
        )}
        <div className="flex min-w-0 flex-col p-4">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={cn("rounded-lg", status.className)}>
              {active && <LoaderCircle className="size-3 animate-spin" />}
              {status.label}
            </Badge>
            <span className="ml-auto flex items-center gap-1 text-[10px] text-white/28">
              <Clock3 className="size-3" />
              {formatRelativeTime(job.createdAt)}
            </span>
          </div>
          <p className="mt-3 line-clamp-3 text-xs leading-5 text-white/72">{job.prompt}</p>
          <p className="mt-2 truncate text-[10px] text-white/28">
            {job.modelId} · {job.aspectRatio ?? "自动比例"} · {job.count} 张
          </p>
          {active && (
            <p className="text-shimmer mt-auto pt-4 text-[10px]">正在等待模型生成作品</p>
          )}
          {job.error && (
            <p className="mt-3 line-clamp-2 text-[10px] leading-4 text-rose-300/75">
              {job.error.message}
            </p>
          )}
          <div className="mt-auto flex items-center gap-1.5 pt-4">
            {active ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 rounded-lg text-[10px] text-white/50 hover:bg-white/7 hover:text-white"
                onClick={() => void controller.cancel(job.id)}
              >
                <Ban className="size-3" />
                取消
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-lg text-[10px] text-white/50 hover:bg-white/7 hover:text-white"
                  onClick={() => controller.reuse(job)}
                >
                  <RotateCcw className="size-3" />
                  再次创作
                </Button>
                {(job.status === "failed" || job.status === "cancelled") && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-lg text-[10px] text-white/50 hover:bg-white/7 hover:text-white"
                    onClick={() => void controller.retry(job.id)}
                  >
                    <RefreshCcw className="size-3" />
                    重试
                  </Button>
                )}
              </>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto text-white/35 hover:bg-white/7 hover:text-white"
                  aria-label="任务操作"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => controller.reuse(job)}>
                  <RotateCcw /> 再次创作
                </DropdownMenuItem>
                {(job.status === "failed" || job.status === "cancelled") && (
                  <DropdownMenuItem onSelect={() => void controller.retry(job.id)}>
                    <RefreshCcw /> 重试
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => void controller.remove(job.id)}>
                  <Trash2 /> 删除记录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </article>
  );
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}
