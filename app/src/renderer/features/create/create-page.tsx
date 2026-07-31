import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock3, Search } from "lucide-react";

import { OctopusPeekButton } from "@/components/octopus-peek-button";
import { ProductOrbitStage } from "@/components/product-orbit-stage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  providerImageModels,
  providerVideoModels,
} from "@/lib/model-capabilities";
import {
  aspectRatioForResolution,
  mediaModelCapabilities,
} from "@shared/media-model-capabilities";
import type {
  ImageGenerationRequest,
  LocalMediaAsset,
  MediaJob,
  MediaReferenceInput,
  MediaResolution,
  MediaType,
  ProviderAccount,
  VideoGenerationRequest,
} from "@shared/contracts";

import { CreateComposer } from "./create-composer";
import {
  CreateConversation,
  type CreateConversationHandle,
} from "./create-conversation";
import type { CreateController, CreateProvider } from "./create-types";

type HistoryTimeFilter = "all" | "today" | "7d" | "30d";
type HistoryStatusFilter = "all" | "pending" | "completed" | "failed";

const HISTORY_TIME_LABELS: Record<HistoryTimeFilter, string> = {
  all: "全部时间",
  today: "今天",
  "7d": "近 7 天",
  "30d": "近 30 天",
};

/** 输入框浮层距底距离（bottom-5）+ 最后一条记录和输入框之间的呼吸位。 */
const COMPOSER_INSET_GAP = 44;
/** 首帧测量完成前的兜底留白，取输入框收起时的高度。 */
const COMPOSER_INSET_FALLBACK = 116;

export function CreatePage({
  active,
  providerVersion,
}: {
  /** 本页在后台待命时仍然挂载，全局监听要靠它避让。 */
  active: boolean;
  providerVersion: number;
}) {
  const [providers, setProviders] = useState<ProviderAccount[]>([]);
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [assets, setAssets] = useState<LocalMediaAsset[]>([]);
  const [references, setReferences] = useState<MediaReferenceInput[]>([]);
  const [mode, setMode] = useState<MediaType>("image");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<`${number}:${number}`>();
  const [resolution, setResolution] = useState<MediaResolution>();
  const [quality, setQuality] = useState<
    "auto" | "low" | "medium" | "high"
  >();
  const [duration, setDuration] = useState<number>();
  const [count, setCount] = useState(1);
  const [activeJobId, setActiveJobId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [atHistoryBottom, setAtHistoryBottom] = useState(true);
  const [composerExpandedByInput, setComposerExpandedByInput] = useState(false);
  const [historyType, setHistoryType] = useState<"all" | MediaType>("all");
  const [historyTime, setHistoryTime] = useState<HistoryTimeFilter>("all");
  const [historyStatus, setHistoryStatus] =
    useState<HistoryStatusFilter>("all");
  const [historyQuery, setHistoryQuery] = useState("");
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const conversationRef = useRef<CreateConversationHandle>(null);
  const historyFilterRef = useRef<HTMLDivElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const [composerInset, setComposerInset] = useState(COMPOSER_INSET_FALLBACK);

  const createProviders = useMemo(
    () =>
      providers
        .map((provider): CreateProvider => ({
          ...provider,
          imageModels: providerImageModels(provider),
          videoModels: providerVideoModels(provider),
        }))
        .filter(
          (provider) =>
            provider.imageModels.length > 0 || provider.videoModels.length > 0,
        ),
    [providers],
  );
  const availableProviders = useMemo(
    () =>
      createProviders.filter((provider) =>
        mode === "image"
          ? provider.imageModels.length > 0
          : provider.videoModels.length > 0,
      ),
    [createProviders, mode],
  );
  const selectedProvider = availableProviders.find(
    (provider) => provider.id === providerId,
  );
  const activeJob = jobs.find((job) => job.id === activeJobId);
  const running =
    activeJob?.status === "queued" || activeJob?.status === "running";
  const capabilities = useMemo(
    () => mediaModelCapabilities(model, mode),
    [mode, model],
  );
  const visibleJobs = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    const now = Date.now();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return jobs.filter(
      (job) => {
        const matchesType = historyType === "all" || job.type === historyType;
        const matchesQuery =
          query.length === 0 ||
          job.prompt.toLowerCase().includes(query) ||
          job.modelId.toLowerCase().includes(query);
        const matchesTime =
          historyTime === "all" ||
          (historyTime === "today"
            ? job.createdAt >= today.getTime()
            : job.createdAt >=
              now - (historyTime === "7d" ? 7 : 30) * 24 * 60 * 60 * 1_000);
        const matchesStatus =
          historyStatus === "all" ||
          (historyStatus === "pending"
            ? job.status === "queued" || job.status === "running"
            : historyStatus === "completed"
              ? job.status === "completed"
              : job.status === "failed" || job.status === "cancelled");
        return matchesType && matchesQuery && matchesTime && matchesStatus;
      },
    );
  }, [historyQuery, historyStatus, historyTime, historyType, jobs]);

  useEffect(() => {
    if (!active) return;
    const closeSearch = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (historyFilterRef.current?.contains(target)) return;
      setHistorySearchOpen(false);
    };
    document.addEventListener("pointerdown", closeSearch);
    return () => document.removeEventListener("pointerdown", closeSearch);
  }, [active]);

  const upsertJob = useCallback((job: MediaJob) => {
    setJobs((current) => [
      job,
      ...current.filter((candidate) => candidate.id !== job.id),
    ]);
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      window.tietiezhi.providers.list(),
      window.tietiezhi.media.list(),
      window.tietiezhi.media.listAssets(),
    ])
      .then(([nextProviders, nextJobs, nextAssets]) => {
        if (!active) return;
        setProviders(nextProviders);
        setJobs(nextJobs);
        setAssets(nextAssets);
        const runningJob = nextJobs.find(
          (job) => job.status === "queued" || job.status === "running",
        );
        setActiveJobId(runningJob?.id);
        if (runningJob) setMode(runningJob.type);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [providerVersion]);

  useEffect(
    () =>
      window.tietiezhi.onMediaEvent((event) => {
        if (event.type === "media.job.updated") {
          upsertJob(event.job);
          if (event.job.status === "completed") {
            void window.tietiezhi.media.listAssets().then(setAssets);
          }
          return;
        }
        setJobs((current) =>
          current.filter((job) => job.id !== event.jobId),
        );
      }),
    [upsertJob],
  );

  useEffect(() => {
    const selectedModels =
      mode === "image"
        ? selectedProvider?.imageModels
        : selectedProvider?.videoModels;
    if (selectedProvider && selectedModels?.includes(model)) return;
    const nextProvider = availableProviders[0];
    const nextModels =
      mode === "image" ? nextProvider?.imageModels : nextProvider?.videoModels;
    setProviderId(nextProvider?.id ?? "");
    setModel(nextModels?.[0] ?? "");
  }, [availableProviders, mode, model, selectedProvider]);

  useEffect(() => {
    setResolution((current) =>
      capabilities.resolutions.some((option) => option.value === current)
        ? current
        : capabilities.defaultResolution,
    );
    setAspectRatio((current) =>
      capabilities.aspectRatios.some((option) => option.value === current)
        ? current
        : capabilities.defaultAspectRatio,
    );
    setQuality((current) =>
      capabilities.qualities.some((option) => option.value === current)
        ? current
        : capabilities.defaultQuality,
    );
    setDuration((current) =>
      capabilities.durations.some((option) => option.value === current)
        ? current
        : capabilities.defaultDuration,
    );
    setCount((current) =>
      capabilities.counts.some((option) => option.value === current)
        ? current
        : capabilities.defaultCount,
    );
  }, [capabilities]);

  useEffect(() => {
    const derivedAspectRatio = aspectRatioForResolution(resolution);
    if (mode === "image" && derivedAspectRatio !== undefined) {
      setAspectRatio(derivedAspectRatio);
    }
    if (
      mode === "video" &&
      (resolution === "1920x1080" || resolution === "3840x2160")
    ) {
      setDuration(8);
    }
    if (
      mode === "video" &&
      model.toLowerCase().includes("veo-3.0") &&
      resolution === "1920x1080"
    ) {
      setAspectRatio("16:9");
    }
  }, [mode, model, resolution]);

  const generate = useCallback(async () => {
    if (!prompt.trim() || !providerId || !model || busy || running) return;
    setBusy(true);
    setError("");
    try {
      const job =
        mode === "video"
          ? await window.tietiezhi.media.generateVideo({
              providerAccountId: providerId,
              model,
              prompt: prompt.trim(),
              aspectRatio,
              resolution:
                resolution !== undefined && /^\d+x\d+$/.test(resolution)
                  ? (resolution as `${number}x${number}`)
                  : undefined,
              duration,
              count,
              references,
            } satisfies VideoGenerationRequest)
          : await window.tietiezhi.media.generateImage({
              providerAccountId: providerId,
              model,
              prompt: prompt.trim(),
              aspectRatio,
              resolution,
              quality,
              count,
              references,
            } satisfies ImageGenerationRequest);
      upsertJob(job);
      setActiveJobId(job.id);
      setPrompt("");
      setReferences([]);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [
    aspectRatio,
    busy,
    count,
    duration,
    mode,
    model,
    prompt,
    providerId,
    quality,
    resolution,
    references,
    running,
    upsertJob,
  ]);

  const cancel = useCallback(async () => {
    if (!activeJobId) return;
    setError("");
    try {
      await window.tietiezhi.media.cancel(activeJobId);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [activeJobId]);

  const saveArtifact = useCallback(async (path: string) => {
    setError("");
    try {
      await window.tietiezhi.media.saveArtifact(path);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const changeMode = useCallback((nextMode: MediaType) => {
    setMode(nextMode);
    setReferences([]);
    setError("");
  }, []);

  const importAssets = useCallback(async () => {
    setError("");
    try {
      const imported = await window.tietiezhi.media.importAssets();
      if (imported.length > 0) {
        setAssets(await window.tietiezhi.media.listAssets());
        setReferences((current) => {
          const selected = new Set(current.map((reference) => reference.assetId));
          const available = imported.filter(
            (asset) =>
              capabilities.acceptedReferenceTypes.includes(asset.type) &&
              !selected.has(asset.id),
          );
          const remaining = Math.max(
            0,
            capabilities.maxReferences - current.length,
          );
          return [
            ...current,
            ...available.slice(0, remaining).map((asset) => ({
              assetId: asset.id,
              role: "reference" as const,
            })),
          ];
        });
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [capabilities]);

  const removeAsset = useCallback(async (id: string) => {
    setError("");
    try {
      await window.tietiezhi.media.removeAsset(id);
      setAssets((current) => current.filter((asset) => asset.id !== id));
      setReferences((current) =>
        current.filter((reference) => reference.assetId !== id),
      );
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const retryJob = useCallback(
    async (job: MediaJob) => {
      if (busy || running) return;
      setBusy(true);
      setError("");
      try {
        const next = await window.tietiezhi.media.retry(job.id);
        upsertJob(next);
        setActiveJobId(next.id);
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, running, upsertJob],
  );

  const removeJob = useCallback(async (job: MediaJob) => {
    setError("");
    try {
      await window.tietiezhi.media.remove(job.id);
      setJobs((current) => current.filter((candidate) => candidate.id !== job.id));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const reuseJob = useCallback((job: MediaJob) => {
    setMode(job.type);
    setProviderId(job.providerId);
    setModel(job.modelId);
    setPrompt(job.prompt);
    setAspectRatio(job.aspectRatio);
    setResolution(job.resolution);
    setQuality(job.quality);
    setDuration(job.duration);
    setCount(job.count);
    setReferences(
      job.references.map(({ assetId, role }) => ({ assetId, role })),
    );
  }, []);

  const hasHistory = jobs.length > 0;
  const composerCollapsed =
    hasHistory && !atHistoryBottom && !composerExpandedByInput;

  useEffect(() => {
    if (atHistoryBottom) setComposerExpandedByInput(false);
  }, [atHistoryBottom]);

  useEffect(() => {
    const node = composerWrapRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setComposerInset(node.getBoundingClientRect().height + COMPOSER_INSET_GAP);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasHistory]);

  const handleHistoryBottomChange = useCallback((atBottom: boolean) => {
    setAtHistoryBottom(atBottom);
    if (!atBottom) setComposerExpandedByInput(false);
  }, []);

  const controller: CreateController = {
    mode,
    providers: availableProviders,
    providerId,
    model,
    prompt,
    assets,
    references,
    capabilities,
    aspectRatio,
    resolution,
    quality,
    duration,
    count,
    busy,
    running,
    collapsed: composerCollapsed,
    error,
    setMode: changeMode,
    setProvider: setProviderId,
    setModel,
    setPrompt,
    setReferences,
    importAssets,
    removeAsset,
    setAspectRatio,
    setResolution,
    setQuality,
    setDuration,
    setCount,
    generate,
    cancel,
    expand: () => setComposerExpandedByInput(true),
  };

  return (
    <main className="dark relative isolate h-full min-h-0 overflow-hidden bg-[#080a10] text-white">
      {hasHistory ? (
        <div className="relative z-10 flex h-full min-h-0 flex-col">
          <div
            ref={historyFilterRef}
            className="pointer-events-none absolute top-4 right-4 z-30 flex items-center justify-end gap-2"
          >
            <div className="pointer-events-auto flex h-11 items-center gap-1 rounded-[10px] bg-background/72 px-1 shadow-sm ring-1 ring-border/70 backdrop-blur-md transition-shadow hover:shadow-lg">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 rounded-[8px] text-muted-foreground hover:bg-muted/55 hover:text-foreground"
                onClick={() => setHistorySearchOpen(true)}
                aria-label="展开搜索"
              >
                <Search className="size-4" />
              </Button>
              <Input
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
                onFocus={() => setHistorySearchOpen(true)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  if (historyQuery) {
                    setHistoryQuery("");
                    return;
                  }
                  setHistorySearchOpen(false);
                }}
                placeholder="搜索"
                className={cn(
                  "h-9 border-0 bg-transparent px-0 text-sm shadow-none transition-[width,opacity,padding] duration-200 ease-out focus-visible:ring-0",
                  historySearchOpen
                    ? "w-52 px-1 opacity-100"
                    : "w-0 opacity-0",
                )}
              />
              <Select
                value={historyTime}
                onValueChange={(value) =>
                  setHistoryTime(value as HistoryTimeFilter)
                }
              >
                <SelectTrigger
                  size="sm"
                  className="h-9 min-w-24 border-0 bg-transparent shadow-none hover:bg-muted/55 focus-visible:ring-0"
                  aria-label="筛选生成时间"
                >
                  <Clock3 className="size-3.5" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="dark">
                  {(Object.keys(HISTORY_TIME_LABELS) as HistoryTimeFilter[]).map(
                    (value) => (
                      <SelectItem key={value} value={value}>
                        {HISTORY_TIME_LABELS[value]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              <span className="h-5 w-px bg-border/70" />
              <Select
                value={historyStatus}
                onValueChange={(value) =>
                  setHistoryStatus(value as HistoryStatusFilter)
                }
              >
                <SelectTrigger
                  size="sm"
                  className="h-9 min-w-24 border-0 bg-transparent shadow-none hover:bg-muted/55 focus-visible:ring-0"
                  aria-label="筛选生成状态"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="dark">
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="pending">生成中</SelectItem>
                  <SelectItem value="completed">已完成</SelectItem>
                  <SelectItem value="failed">异常</SelectItem>
                </SelectContent>
              </Select>
              <span className="h-5 w-px bg-border/70" />
              <Select
                value={historyType}
                onValueChange={(value) =>
                  setHistoryType(value as "all" | MediaType)
                }
              >
                <SelectTrigger
                  size="sm"
                  className="h-9 min-w-24 border-0 bg-transparent shadow-none hover:bg-muted/55 focus-visible:ring-0"
                  aria-label="筛选生成类型"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="dark">
                  <SelectItem value="all">全部类型</SelectItem>
                  <SelectItem value="image">图片</SelectItem>
                  <SelectItem value="video">视频</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <CreateConversation
            ref={conversationRef}
            jobs={visibleJobs}
            onRetry={retryJob}
            onRemove={removeJob}
            onReuse={reuseJob}
            onSave={saveArtifact}
            onBottomChange={handleHistoryBottomChange}
            bottomInset={composerInset}
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-4">
            <div
              ref={composerWrapRef}
              className={cn(
                "pointer-events-auto relative mx-auto w-full transition-[max-width] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                composerCollapsed ? "max-w-3xl" : "max-w-5xl",
              )}
            >
              <OctopusPeekButton
                visible={composerCollapsed}
                onClick={() => conversationRef.current?.scrollToBottom("smooth")}
              />
              <CreateComposer controller={controller} />
            </div>
          </div>
        </div>
      ) : (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-5xl flex-col items-center justify-center px-4 pb-12">
          <ProductOrbitStage variant="create" className="-mb-5" />
          <CreateComposer controller={controller} />
        </div>
      )}
    </main>
  );
}
