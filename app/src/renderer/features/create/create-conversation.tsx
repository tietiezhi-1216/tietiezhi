import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Download,
  Info,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { MediaJob } from "@shared/contracts";

import { CreateAssetPreview } from "./create-asset-preview";
import {
  CreateAssetThumbnail,
  mediaAssetDisplayName,
} from "./create-asset-sheet";

const FRAME_CLASSES: Record<string, string> = {
  "9:16": "aspect-[9/16] w-[240px]",
  "2:3": "aspect-[2/3] w-[261px]",
  "3:4": "aspect-[3/4] w-[277px]",
  "4:5": "aspect-[4/5] w-[286px]",
  "1:1": "aspect-square w-[320px]",
  "5:4": "aspect-[5/4] w-[358px]",
  "4:3": "aspect-[4/3] w-[370px]",
  "3:2": "aspect-[3/2] w-[392px]",
  "21:9": "aspect-[21/9] w-[489px]",
  "16:9": "aspect-video w-[427px]",
};

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "今天";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatJobDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(timestamp))
    .replace(/\//g, "-");
}

const QUALITY_LABELS: Record<string, string> = {
  auto: "自动",
  low: "低",
  medium: "中",
  high: "高",
};

/** 元信息行里那一格「头条规格」：视频看时长，图片看分辨率。 */
function headlineSpec(job: MediaJob): string {
  if (job.type === "video") {
    return job.duration !== undefined ? `${job.duration}s` : "智能";
  }
  return job.resolution ?? "标准";
}

function MediaDetailsPopover({ job }: { job: MediaJob }) {
  const [open, setOpen] = useState(false);
  const rows: Array<{ label: string; value: string }> = [
    { label: "画面比例", value: job.aspectRatio ?? "自适应" },
    { label: "分辨率", value: job.resolution ?? "标准" },
  ];
  if (job.duration !== undefined) {
    rows.push({ label: "时长", value: `${job.duration}s` });
  }
  if (job.quality !== undefined) {
    rows.push({ label: "画质", value: QUALITY_LABELS[job.quality] ?? job.quality });
  }
  if (job.count > 1) {
    rows.push({ label: "生成数量", value: `${job.count} 张` });
  }
  rows.push({ label: "生成时间", value: formatJobDateTime(job.createdAt) });

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1 text-muted-foreground",
          open && "text-foreground",
        )}
      >
        详细信息
        <Info className="size-3.5" />
      </span>
      <span
        className={cn(
          // before 伪元素补上触发器和面板之间的 8px 空档，鼠标移过去时不会先离开再进入。
          "pointer-events-auto absolute top-7 right-0 z-15 w-72 rounded-[14px] bg-popover/95 p-4 text-[13px] leading-5 text-popover-foreground shadow-2xl ring-1 ring-border/80 backdrop-blur-md before:absolute before:-top-2 before:left-0 before:h-2 before:w-full before:content-['']",
          open ? "block" : "hidden",
        )}
      >
        <span className="grid gap-3">
          {rows.map(({ label, value }) => (
            <span
              key={label}
              className="grid grid-cols-[5rem_1fr] items-center gap-5"
            >
              <span className="text-muted-foreground">{label}</span>
              <span className="min-w-0 text-right text-foreground">
                {value}
              </span>
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

function frameClass(job: MediaJob): string {
  return (
    FRAME_CLASSES[job.aspectRatio ?? "16:9"] ??
    "aspect-video w-[427px]"
  );
}

function statusLabel(job: MediaJob): string {
  if (job.status === "queued") return "排队中";
  if (job.status === "running") return "生成中";
  return "处理中";
}

function PendingMediaFrame({ status }: { status: string }) {
  return (
    <div
      aria-label={status}
      className="relative size-full overflow-hidden rounded-[6px] bg-[#111217]"
    >
      <div className="absolute inset-0 bg-[#151519]" />
      <div className="absolute -top-[24%] -left-[15%] h-[72%] w-[46%] animate-[spin_9s_ease-in-out_infinite] rounded-full bg-[#28559f] opacity-80 blur-3xl motion-reduce:animate-none" />
      <div className="absolute -top-[28%] left-[28%] h-[74%] w-[60%] animate-[spin_11s_ease-in-out_infinite_reverse] rounded-[48%_52%_44%_56%/42%_48%_52%_58%] bg-[#d6a2a0] opacity-70 blur-3xl motion-reduce:animate-none" />
      <div className="absolute top-[20%] -right-[16%] h-[68%] w-[48%] animate-[spin_8s_ease-in-out_infinite] rounded-full bg-[#08a1c3] opacity-75 blur-3xl motion-reduce:animate-none" />
      <div className="absolute right-[4%] -bottom-[22%] h-[44%] w-[66%] animate-[spin_12s_ease-in-out_infinite_reverse] rounded-[42%_58%_52%_48%/62%_40%_60%_38%] bg-[#2534a3] opacity-80 blur-3xl motion-reduce:animate-none" />
      <div className="absolute -bottom-[16%] -left-[12%] h-[45%] w-[34%] animate-[spin_10s_ease-in-out_infinite] rounded-[34%_66%_58%_42%/38%_48%_52%_62%] bg-[#0d0f12] opacity-90 blur-2xl motion-reduce:animate-none" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_54%_34%,transparent_0,transparent_42%,rgba(0,0,0,0.48)_100%)]" />
      <div className="absolute inset-0 bg-black/18 backdrop-blur-[22px]" />
      <div className="absolute top-2 left-2 rounded-[5px] bg-slate-700/65 px-2 py-1 text-xs font-medium leading-none text-white/90 shadow-sm ring-1 ring-white/10 backdrop-blur-md">
        {status}...
      </div>
    </div>
  );
}

function ReferenceStack({ job }: { job: MediaJob }) {
  if (job.references.length === 0) return null;
  return (
    <div className="flex h-[66px] w-fit shrink-0 items-center gap-1">
      {job.references.slice(0, 3).map((reference, index) => (
        <span
          key={`${reference.assetId}-${reference.role}`}
          className={cn(
            "relative block h-[50px] w-[38px] shrink-0 overflow-hidden rounded-xs border border-white bg-muted shadow-md transition-transform duration-150 ease-out hover:z-50 hover:-translate-y-1 hover:scale-[1.16]",
            index === 0 && "-rotate-12",
            index === 1 && "rotate-8",
            index === 2 && "-rotate-9",
          )}
          title={mediaAssetDisplayName(reference.asset)}
        >
          <CreateAssetThumbnail asset={reference.asset} />
        </span>
      ))}
    </div>
  );
}

function CreateMediaTurn({
  job,
  onRetry,
  onRemove,
  onReuse,
  onSave,
}: {
  job: MediaJob;
  onRetry: (job: MediaJob) => Promise<void>;
  onRemove: (job: MediaJob) => Promise<void>;
  onReuse: (job: MediaJob) => void;
  onSave: (path: string) => Promise<void>;
}) {
  const pending = job.status === "queued" || job.status === "running";
  const hasReferences = job.references.length > 0;

  return (
    <article
      className={cn(
        "group mx-auto flex w-full max-w-5xl scroll-mt-28 flex-col gap-1.5 pb-2",
        hasReferences ? "pt-7" : "pt-2",
      )}
    >
      <div
        className={cn(
          "grid items-center gap-2",
          hasReferences
            ? "grid-cols-[max-content_minmax(0,1fr)]"
            : "grid-cols-1",
        )}
      >
        <ReferenceStack job={job} />
        {/* 外层不能裁剪：详细信息浮层要溢出到提示词框外面。裁剪只加在里面这层。 */}
        <div className="relative min-w-0 max-w-full rounded-[6px]">
          <div className="relative h-[66px] overflow-hidden rounded-[6px] border border-transparent p-2">
            <p className="max-h-12 overflow-hidden whitespace-pre-wrap text-[15px] leading-6 text-foreground">
              {job.prompt || "无提示词"}
            </p>
          </div>
          <div
            className="absolute right-[9px] bottom-[9px] z-[9] inline-flex shrink-0 items-center gap-2 pl-24 text-[15px] leading-6 whitespace-nowrap text-muted-foreground"
            style={{
              background:
                "linear-gradient(to right, transparent 0, var(--background) 4rem, var(--background) 100%)",
            }}
          >
            <span>{job.modelId}</span>
            <span className="text-border">|</span>
            <span>{headlineSpec(job)}</span>
            <span className="text-border">|</span>
            <MediaDetailsPopover job={job} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="任务操作"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="dark">
                <DropdownMenuItem onSelect={() => onReuse(job)}>
                  <RotateCcw />
                  复用参数
                </DropdownMenuItem>
                {job.status !== "running" && (
                  <DropdownMenuItem onSelect={() => void onRetry(job)}>
                    <RefreshCw />
                    重新生成
                  </DropdownMenuItem>
                )}
                {job.artifacts.map((artifact, index) => (
                  <DropdownMenuItem
                    key={artifact.id}
                    onSelect={() => void onSave(artifact.filePath)}
                  >
                    <Download />
                    导出{job.artifacts.length > 1 ? `结果 ${index + 1}` : "结果"}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => void onRemove(job)}
                >
                  <Trash2 />
                  删除记录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {pending && (
        <>
          <div
            className={cn(
              "ml-2 max-w-[calc(100%-0.5rem)] overflow-hidden rounded-[6px] bg-background",
              frameClass(job),
            )}
          >
            <PendingMediaFrame status={statusLabel(job)} />
          </div>
          <div className="ml-2 flex items-center gap-2 text-[13px] leading-5 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {statusLabel(job)} · 请等待结果返回
          </div>
        </>
      )}
      {job.status === "failed" && (
        <Alert variant="destructive" className="ml-2 max-w-2xl">
          <AlertTitle>生成失败</AlertTitle>
          <AlertDescription>{job.error?.message ?? "请求未完成"}</AlertDescription>
        </Alert>
      )}
      {job.status === "cancelled" && (
        <div className="ml-2 flex items-center gap-2 text-[13px] leading-5 text-muted-foreground">
          <Info className="size-4" />
          生成已取消
        </div>
      )}
      {job.artifacts.map((artifact) => (
        <div
          key={artifact.id}
          className={cn(
            "ml-2 max-w-[calc(100%-0.5rem)] overflow-hidden rounded-[6px] bg-muted",
            frameClass(job),
          )}
        >
          <CreateAssetPreview
            artifact={artifact}
            alt={job.prompt}
            thumbnail={false}
            viewable
            className="size-full bg-black"
          />
        </div>
      ))}
    </article>
  );
}

export interface CreateConversationHandle {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export const CreateConversation = forwardRef<
  CreateConversationHandle,
  {
    jobs: MediaJob[];
    onRetry: (job: MediaJob) => Promise<void>;
    onRemove: (job: MediaJob) => Promise<void>;
    onReuse: (job: MediaJob) => void;
    onSave: (path: string) => Promise<void>;
    onBottomChange: (atBottom: boolean) => void;
    bottomInset: number;
  }
>(function CreateConversation(
  { jobs, onRetry, onRemove, onReuse, onSave, onBottomChange, bottomInset },
  ref,
) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const autoScrolling = useRef(false);
  const forcedScroll = useRef(false);
  const autoScrollFrame = useRef<number | undefined>(undefined);
  const ordered = [...jobs].sort(
    (left, right) => left.createdAt - right.createdAt,
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior, forced = false) => {
      const node = viewport.current;
      if (!node) return;

      if (autoScrollFrame.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrame.current);
        autoScrollFrame.current = undefined;
      }

      autoScrolling.current = true;
      forcedScroll.current = forced;
      onBottomChange(true);

      const finish = () => {
        node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
        autoScrolling.current = false;
        forcedScroll.current = false;
        autoScrollFrame.current = undefined;
        atBottom.current = true;
        onBottomChange(true);
      };

      if (behavior !== "smooth") {
        finish();
        return;
      }

      atBottom.current = false;
      const startedAt = performance.now();
      const startTop = node.scrollTop;
      const duration = 520;
      const animate = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        const target = Math.max(0, node.scrollHeight - node.clientHeight);
        node.scrollTop = startTop + (target - startTop) * eased;
        if (progress < 1) {
          autoScrollFrame.current = window.requestAnimationFrame(animate);
          return;
        }
        finish();
      };
      autoScrollFrame.current = window.requestAnimationFrame(animate);
    },
    [onBottomChange],
  );

  const updateScrollPosition = useCallback(() => {
    const node = viewport.current;
    if (!node || autoScrolling.current) return;
    const nextAtBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    atBottom.current = nextAtBottom;
    onBottomChange(nextAtBottom);
  }, [onBottomChange]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: (behavior = "smooth") => scrollToBottom(behavior, true),
    }),
    [scrollToBottom],
  );

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      scrollToBottom("auto");
      window.requestAnimationFrame(() => scrollToBottom("auto"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollToBottom]);

  useEffect(() => {
    if (atBottom.current) scrollToBottom("smooth");
  }, [jobs.length, scrollToBottom]);

  // 输入框展开/收起会改变底部留白，进而改变 scrollHeight；贴底时要重新贴住。
  useLayoutEffect(() => {
    if (atBottom.current) scrollToBottom("auto");
  }, [bottomInset, scrollToBottom]);

  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) scrollToBottom("auto");
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  useEffect(
    () => () => {
      if (autoScrollFrame.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrame.current);
      }
    },
    [],
  );

  let previousDay = "";
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={viewport}
        onScroll={updateScrollPosition}
        onWheel={(event) => {
          // 触控板抬手后仍会继续派发惯性 wheel 事件，若不豁免「点章鱼回到底部」
          // 这类主动滚动，动画会在刚启动时就被残余惯性打断，停在半路。
          if (event.deltaY >= 0 || forcedScroll.current) return;
          autoScrolling.current = false;
          if (autoScrollFrame.current !== undefined) {
            window.cancelAnimationFrame(autoScrollFrame.current);
            autoScrollFrame.current = undefined;
          }
        }}
        // 底部留白按输入框实测高度走，而不是固定 pb-80：输入框收起时只有 72px，
        // 固定留 320px 会在最后一条记录和输入框之间空出一大截。
        style={{ paddingBottom: bottomInset }}
        className="size-full overflow-y-auto scroll-pb-72 px-4 pt-24 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div ref={content} className="flex flex-col gap-1">
          {ordered.length === 0 && (
            <div className="grid min-h-52 place-items-center text-sm text-muted-foreground">
              没有匹配的生成记录
            </div>
          )}
          {ordered.map((job) => {
            const day = dayLabel(job.createdAt);
            const showDay = day !== previousDay;
            previousDay = day;
            return (
              <div key={job.id}>
                {showDay && (
                  <div className="mx-auto mt-2 w-full max-w-5xl text-lg font-semibold tracking-tight text-foreground">
                    {day}
                  </div>
                )}
                <CreateMediaTurn
                  job={job}
                  onRetry={onRetry}
                  onRemove={onRemove}
                  onReuse={onReuse}
                  onSave={onSave}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
