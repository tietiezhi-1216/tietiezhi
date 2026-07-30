import { useEffect, useState } from "react";
import {
  Download,
  Clock3,
  Images,
  Library,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  Trash2,
  WandSparkles,
} from "lucide-react";

import type { ProductArea } from "@/App";
import { ProductSwitcher } from "@/components/product-switcher";
import { GatewayAccountButton } from "@/components/gateway-account-button";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Card,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { providerImageModels } from "@/lib/model-capabilities";
import type {
  ImageGenerationRequest,
  MediaJob,
  ProviderAccount,
} from "@shared/contracts";

type ImageRatio = NonNullable<ImageGenerationRequest["aspectRatio"]>;
const OPENAI_RATIOS = ["1:1", "3:2", "2:3"] as const satisfies readonly ImageRatio[];
const GOOGLE_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const satisfies readonly ImageRatio[];
type CreateView = "inspiration" | "generations" | "assets";

const SHOWCASE = [
  ["quiet-station.webp", "雨夜车站", "电影摄影", "aspect-[4/5]"],
  ["blue-portrait.webp", "海风人像", "人像摄影", "aspect-[3/4]"],
  ["fruit-market.webp", "水果店奇遇", "动态叙事", "aspect-[4/3]"],
  ["paper-city.webp", "纸艺城市", "创意设计", "aspect-square"],
  ["little-explorer.webp", "云端探险", "3D 动画", "aspect-[4/5]"],
  ["glass-flower.webp", "玻璃花园", "产品视觉", "aspect-[3/4]"],
  ["ink-crane.webp", "水墨仙鹤", "东方美学", "aspect-[4/3]"],
  ["desert-train.webp", "荒漠列车", "概念艺术", "aspect-square"],
] as const;

function ratiosFor(provider: ProviderAccount | undefined, model: string): readonly ImageRatio[] {
  const wireAPIs = provider?.modelMetadata[model]?.wireAPIs ?? [];
  return provider?.providerType === "google" || wireAPIs.includes("gemini_generate_content")
    ? GOOGLE_RATIOS
    : OPENAI_RATIOS;
}

export function CreatePage({
  providerVersion,
  onOpenSettings,
  onProviderChanged,
  onSwitchArea,
}: {
  providerVersion: number;
  onOpenSettings: () => void;
  onProviderChanged: () => void;
  onSwitchArea: (area: ProductArea) => void;
}) {
  const [view, setView] = useState<CreateView>("inspiration");
  const [providers, setProviders] = useState<ProviderAccount[]>([]);
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<ImageRatio>("1:1");
  const [count, setCount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [taskFilter, setTaskFilter] = useState("all");
  const [selectedJob, setSelectedJob] = useState<MediaJob>();
  const imageProviders = providers
    .map((provider) => ({ ...provider, models: providerImageModels(provider) }))
    .filter((provider) => provider.models.length > 0);
  const selectedProvider = imageProviders.find((provider) => provider.id === providerId);
  const availableRatios = ratiosFor(selectedProvider, model);

  const refresh = async () => {
    const [nextProviders, nextJobs] = await Promise.all([
      window.tietiezhi.providers.list(),
      window.tietiezhi.media.list(),
    ]);
    setProviders(nextProviders);
    setJobs(nextJobs);
    setProviderId(
      (current) =>
        current ||
        nextProviders.find((provider) => providerImageModels(provider).length > 0)?.id ||
        "",
    );
  };

  useEffect(() => {
    void refresh();
  }, [providerVersion]);

  useEffect(() => {
    if (!jobs.some((job) => job.status === "queued" || job.status === "running")) return;
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(timer);
  }, [jobs]);

  useEffect(() => {
    if (!selectedProvider) {
      setModel("");
      return;
    }
    if (!selectedProvider.models.includes(model)) setModel(selectedProvider.models[0] ?? "");
  }, [selectedProvider, model]);

  useEffect(() => {
    if (!availableRatios.includes(ratio)) setRatio(availableRatios[0] ?? "1:1");
  }, [availableRatios, ratio]);

  const generate = async () => {
    if (!prompt.trim() || !providerId || !model || busy) return;
    setBusy(true);
    setError("");
    try {
      const job = await window.tietiezhi.media.generateImage({
        providerAccountId: providerId,
        model,
        prompt,
        aspectRatio: ratio,
        count: Number.parseInt(count, 10),
      });
      setJobs((current) => [job, ...current.filter((candidate) => candidate.id !== job.id)]);
      setView("generations");
      if (job.error) setError(job.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const visibleJobs =
    view === "assets"
      ? jobs.filter((job) => job.artifacts.length > 0)
      : jobs.filter((job) => taskFilter === "all" || job.status === taskFilter);
  const filteredShowcase = SHOWCASE.filter((item) =>
    `${item[1]} ${item[2]}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <main className="flex h-full min-h-0 bg-[#0d0e11] text-white">
      <aside className="flex w-20 shrink-0 flex-col items-center border-r border-white/6 bg-[#0b0c0f] px-2 py-5">
        <div className="grid size-9 place-items-center rounded-xl bg-linear-to-br from-cyan-300 via-sky-400 to-blue-600 text-slate-950 shadow-lg shadow-cyan-500/10">
          <Sparkles className="size-4" />
        </div>
        <nav className="mt-14 flex w-full flex-col gap-2">
          <CreateNav
            active={view === "inspiration"}
            icon={Sparkles}
            label="创作"
            onClick={() => setView("inspiration")}
          />
          <CreateNav
            active={view === "generations"}
            icon={Images}
            label="任务"
            count={jobs.filter((job) => job.status === "running").length}
            onClick={() => setView("generations")}
          />
          <CreateNav
            active={view === "assets"}
            icon={Library}
            label="资产"
            count={jobs.reduce((sum, job) => sum + job.artifacts.length, 0)}
            onClick={() => setView("assets")}
          />
        </nav>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-white/7 px-4 pr-5 [-webkit-app-region:drag]">
          <div className="w-44">
            <ProductSwitcher area="create" onSwitch={onSwitchArea} />
          </div>
          <span className="text-xs text-white/30">
            {view === "inspiration" ? "创作" : view === "generations" ? "任务" : "资产"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto [-webkit-app-region:no-drag]"
            onClick={onOpenSettings}
            aria-label="供应商设置"
          >
            <Settings />
          </Button>
          <GatewayAccountButton
            compact
            onOpenSettings={onOpenSettings}
            onChanged={onProviderChanged}
          />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === "inspiration" ? (
            <div className="mx-auto w-full max-w-6xl px-6 py-10">
              <section className="text-center">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/15 bg-cyan-300/5 px-3 py-1 text-xs text-cyan-200">
                  <Sparkles className="size-3" /> AI SDK Image
                </span>
                <h1 className="mt-5 text-3xl font-semibold tracking-[-0.04em]">
                  从一个念头开始创作
                </h1>
                <p className="mt-2 text-sm text-white/38">
                  描述画面、选择模型，让 AI SDK 将想法变成作品。
                </p>
              </section>
              <CreateComposer
                providers={imageProviders}
                selectedProvider={selectedProvider}
                providerId={providerId}
                model={model}
                prompt={prompt}
                ratio={ratio}
                ratios={availableRatios}
                count={count}
                busy={busy}
                error={error}
                onProvider={setProviderId}
                onModel={setModel}
                onPrompt={setPrompt}
                onRatio={setRatio}
                onCount={setCount}
                onGenerate={generate}
              />
              <section className="mt-10">
                <div className="flex items-end gap-4">
                  <div>
                    <p className="text-lg font-semibold">灵感模板</p>
                    <p className="text-muted-foreground mt-1 text-xs">选择模板后继续调整 Prompt</p>
                  </div>
                  <div className="relative ml-auto">
                    <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-white/30" />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索灵感"
                      className="h-9 w-52 bg-white/4 pl-9 text-xs"
                    />
                  </div>
                </div>
                <div className="mt-5 columns-2 gap-4 lg:columns-3 xl:columns-4">
                  {filteredShowcase.map(([image, title, tag, ratioClass]) => (
                    <button
                      key={image}
                      type="button"
                      className="group relative mb-4 block w-full break-inside-avoid overflow-hidden rounded-2xl border border-white/7 bg-white/4 text-left"
                      onClick={() => {
                        setPrompt(`${title}，${tag}，精细构图，高质量画面`);
                        document.getElementById("create-prompt")?.focus();
                      }}
                    >
                      <img
                        src={`./create-showcase/${image}`}
                        alt={title}
                        className={cn(
                          "w-full object-cover transition-transform duration-500 group-hover:scale-[1.025]",
                          ratioClass,
                        )}
                      />
                      <span className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/85 via-black/20 to-transparent px-3 pt-12 pb-3">
                        <span className="block text-xs font-semibold">{title}</span>
                        <span className="mt-1 block text-[10px] text-white/50">{tag}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <JobGallery
              jobs={visibleJobs}
              assets={view === "assets"}
              filter={taskFilter}
              onFilter={setTaskFilter}
              onSelect={setSelectedJob}
              onCancel={async (id) => {
                await window.tietiezhi.media.cancel(id);
                await refresh();
              }}
              onRetry={async (id) => {
                await window.tietiezhi.media.retry(id);
                await refresh();
              }}
              onRemove={async (id) => {
                await window.tietiezhi.media.remove(id);
                await refresh();
              }}
            />
          )}
        </div>
      </section>
      <AssetDialog job={selectedJob} onOpenChange={(open) => !open && setSelectedJob(undefined)} />
    </main>
  );
}

function CreateComposer({
  providers,
  selectedProvider,
  providerId,
  model,
  prompt,
  ratio,
  ratios,
  count,
  busy,
  error,
  onProvider,
  onModel,
  onPrompt,
  onRatio,
  onCount,
  onGenerate,
}: {
  providers: ProviderAccount[];
  selectedProvider?: ProviderAccount;
  providerId: string;
  model: string;
  prompt: string;
  ratio: ImageRatio;
  ratios: readonly ImageRatio[];
  count: string;
  busy: boolean;
  error: string;
  onProvider: (value: string) => void;
  onModel: (value: string) => void;
  onPrompt: (value: string) => void;
  onRatio: (value: ImageRatio) => void;
  onCount: (value: string) => void;
  onGenerate: () => Promise<void>;
}) {
  return (
    <section className="mt-9 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="min-h-80">
        <CardHeader>
          <CardTitle>描述画面</CardTitle>
          <CardDescription>写下主体、环境、风格、构图、光线和细节。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col">
          <Textarea
            id="create-prompt"
            value={prompt}
            onChange={(event) => onPrompt(event.target.value)}
            placeholder="例如：雨夜的未来城市车站，湿润地面倒映霓虹灯，一位撑透明伞的旅人站在画面中央，电影感广角构图……"
            rows={9}
            className="min-h-52 flex-1 resize-none border-0 bg-muted/30 text-[15px] leading-7 shadow-none focus-visible:ring-1"
          />
          <div className="text-muted-foreground mt-3 flex items-center justify-between text-[11px]">
            <span>建议描述主体、镜头、风格与光线</span>
            <span>{prompt.length} 字</span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>生成设置</CardTitle>
          <CardDescription>仅展示当前图片模型支持的基础参数。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="供应商">
            <Select value={providerId} onValueChange={onProvider}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择供应商" /></SelectTrigger>
              <SelectContent>
                {providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.displayName}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="图片模型">
            <Select value={model} onValueChange={onModel}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择图片模型" /></SelectTrigger>
              <SelectContent>
                {(selectedProvider?.models ?? []).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="画面比例">
              <Select
                value={ratio}
                onValueChange={(value) => {
                  const selected = ratios.find((item) => item === value);
                  if (selected) onRatio(selected);
                }}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{ratios.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="生成数量">
              <Select value={count} onValueChange={onCount}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["1", "2", "3", "4"].map((item) => <SelectItem key={item} value={item}>{item} 张</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
          <Button
            type="button"
            className="w-full"
            onClick={() => void onGenerate()}
            disabled={busy || !prompt.trim() || !providerId || !model}
          >
            {busy ? <Loader2 className="animate-spin" /> : <WandSparkles />}
            {busy ? "正在创建任务" : `生成 ${count} 张图片`}
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}

function JobGallery({
  jobs,
  assets,
  filter,
  onFilter,
  onSelect,
  onCancel,
  onRetry,
  onRemove,
}: {
  jobs: MediaJob[];
  assets: boolean;
  filter: string;
  onFilter: (value: string) => void;
  onSelect: (job: MediaJob) => void;
  onCancel: (id: string) => Promise<void>;
  onRetry: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="flex items-end gap-4">
        <div>
          <p className="text-2xl font-semibold">{assets ? "资产库" : "生成任务"}</p>
          <p className="text-muted-foreground mt-1 text-sm">
            {assets ? `${jobs.reduce((sum, job) => sum + job.artifacts.length, 0)} 个本地资产` : "查看进度、重试失败任务或管理生成记录"}
          </p>
        </div>
        {!assets && (
          <Tabs value={filter} onValueChange={onFilter} className="ml-auto">
            <TabsList>
              <TabsTrigger value="all">全部</TabsTrigger>
              <TabsTrigger value="running">进行中</TabsTrigger>
              <TabsTrigger value="completed">已完成</TabsTrigger>
              <TabsTrigger value="failed">失败</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </div>
      {jobs.length === 0 ? (
        <div className="text-muted-foreground mt-8 grid min-h-80 place-items-center rounded-xl border border-dashed">
          <div className="text-center"><Images className="mx-auto size-8" /><p className="mt-3 text-sm">这里还没有内容</p></div>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onSelect={() => onSelect(job)}
              onCancel={() => onCancel(job.id)}
              onRetry={() => onRetry(job.id)}
              onRemove={() => onRemove(job.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function JobCard({
  job,
  onSelect,
  onCancel,
  onRetry,
  onRemove,
}: {
  job: MediaJob;
  onSelect: () => void;
  onCancel: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  return (
    <AlertDialog>
      <Card className="group">
      {job.artifacts.length > 0 ? (
        <div className="grid gap-px bg-white/5">
          {job.artifacts.map((artifact) => (
            <div key={artifact.id} className="group/image relative">
              <button type="button" className="block w-full" onClick={onSelect}>
                <img src={window.tietiezhi.media.assetURL(artifact.filePath)} alt={job.prompt} className="aspect-square w-full object-cover" />
              </button>
              <button
                type="button"
                onClick={() => void window.tietiezhi.media.saveArtifact(artifact.filePath)}
                className="absolute top-3 right-3 grid size-8 place-items-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100"
                aria-label="下载图片"
              >
                <Download className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-muted/30 grid aspect-square place-items-center">
          {job.status === "running" ? <Loader2 className="text-muted-foreground animate-spin" /> : <Images className="text-muted-foreground" />}
        </div>
      )}
      <CardContent>
        <div className="flex items-start gap-2">
          <Badge variant={statusVariant(job.status)}>{statusLabel(job.status)}</Badge>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" className="ml-auto"><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(job.status === "running" || job.status === "queued") && (
                <DropdownMenuItem onSelect={() => void onCancel()}><Square />停止任务</DropdownMenuItem>
              )}
              {(job.status === "failed" || job.status === "cancelled" || job.status === "completed") && (
                <DropdownMenuItem onSelect={() => void onRetry()}><RefreshCw />重新生成</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <AlertDialogTrigger asChild>
                <DropdownMenuItem variant="destructive" onSelect={(event) => event.preventDefault()}><Trash2 />删除</DropdownMenuItem>
              </AlertDialogTrigger>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p className="line-clamp-2 text-sm leading-6">{job.prompt}</p>
        <p className="text-muted-foreground mt-2 flex items-center gap-1 text-[11px]"><Clock3 className="size-3" />{new Date(job.createdAt).toLocaleString()} · {job.modelId}</p>
        {job.error && <p className="text-destructive mt-2 line-clamp-2 text-xs">{job.error.message}</p>}
      </CardContent>
      </Card>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除这个生成任务？</AlertDialogTitle>
          <AlertDialogDescription>任务记录和保存在本机的所有图片都会被永久删除。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void onRemove()}>删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AssetDialog({
  job,
  onOpenChange,
}: {
  job?: MediaJob;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={job !== undefined} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>资产详情</DialogTitle>
          <DialogDescription>
            {job ? `${job.modelId} · ${job.aspectRatio ?? "默认比例"} · ${job.count} 张` : ""}
          </DialogDescription>
        </DialogHeader>
        {job && (
          <div className="grid min-h-0 gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="bg-muted/30 grid min-h-80 place-items-center overflow-hidden rounded-xl">
              {job.artifacts[0] && (
                <img
                  src={window.tietiezhi.media.assetURL(job.artifacts[0].filePath)}
                  alt={job.prompt}
                  className="max-h-[65vh] w-full object-contain"
                />
              )}
            </div>
            <div className="space-y-5">
              <div>
                <Label>Prompt</Label>
                <p className="text-muted-foreground mt-2 select-text text-sm leading-6">
                  {job.prompt}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><p className="text-muted-foreground">模型</p><p className="mt-1 break-all">{job.modelId}</p></div>
                <div><p className="text-muted-foreground">比例</p><p className="mt-1">{job.aspectRatio ?? "默认"}</p></div>
                <div><p className="text-muted-foreground">数量</p><p className="mt-1">{job.count}</p></div>
                <div><p className="text-muted-foreground">状态</p><p className="mt-1">{statusLabel(job.status)}</p></div>
              </div>
              {job.artifacts[0] && (
                <Button
                  type="button"
                  className="w-full"
                  onClick={() =>
                    void window.tietiezhi.media.saveArtifact(job.artifacts[0]!.filePath)
                  }
                >
                  <Download /> 下载原图
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateNav({
  active,
  icon: Icon,
  label,
  count = 0,
  onClick,
}: {
  active: boolean;
  icon: typeof Sparkles;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={cn("relative flex h-14 w-full flex-col items-center justify-center gap-1 rounded-xl text-[10px] text-white/40 transition-colors hover:bg-white/5 hover:text-white/75", active && "bg-white/8 text-white")}>
      <Icon className="size-4" /><span>{label}</span>
      {count > 0 && <span className="absolute top-1.5 right-2 min-w-4 rounded-full bg-cyan-300 px-1 text-center text-[8px] leading-4 text-slate-950">{count > 99 ? "99+" : count}</span>}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label className="text-[11px] text-white/40">{label}</Label>{children}</div>;
}

function statusLabel(status: MediaJob["status"]): string {
  if (status === "queued") return "排队中";
  if (status === "running") return "生成中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "已取消";
}

function statusVariant(
  status: MediaJob["status"],
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "completed") return "default";
  if (status === "running") return "secondary";
  return "outline";
}
