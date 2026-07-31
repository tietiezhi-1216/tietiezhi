import { useMemo, useState } from "react";
import {
  Download,
  Heart,
  Library,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { CreateAssetPreview } from "./create-asset-preview";
import type { CreateAsset, CreateController } from "./create-types";

type LibraryFilter = "all" | "favorite";

export function CreateLibrary({
  controller,
  onCreate,
}: {
  controller: CreateController;
  onCreate: () => void;
}) {
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const assets = useMemo<CreateAsset[]>(
    () =>
      controller.jobs.flatMap((job) =>
        job.artifacts.map((artifact) => ({ artifact, job })),
      ),
    [controller.jobs],
  );
  const selected = assets.find((asset) => asset.artifact.id === selectedId);
  const visibleAssets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return assets.filter(({ artifact, job }) => {
      const matchesFilter = filter === "all" || controller.favorites.has(artifact.id);
      const matchesQuery =
        !normalized ||
        job.prompt.toLocaleLowerCase().includes(normalized) ||
        job.modelId.toLocaleLowerCase().includes(normalized);
      return matchesFilter && matchesQuery;
    });
  }, [assets, controller.favorites, filter, query]);

  return (
    <div className="h-full overflow-y-auto bg-[#0d0e11] text-white">
      <div className="mx-auto w-full max-w-[92rem] px-4 py-7 sm:px-7 lg:px-10 lg:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-[0.18em] text-cyan-300/70 uppercase">
              Assets
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">我的资产</h1>
            <p className="mt-2 text-sm text-white/36">图片保存在本地，随时下载或再次创作。</p>
          </div>
          <Button type="button" onClick={onCreate} className="rounded-xl bg-white text-black hover:bg-cyan-100">
            <Plus />
            新建创作
          </Button>
        </div>
        {controller.error && (
          <p className="mt-5 rounded-xl border border-rose-400/15 bg-rose-400/6 px-4 py-3 text-xs text-rose-200">
            {controller.error}
          </p>
        )}
        <div className="mt-8 flex flex-col gap-3 border-b border-white/7 pb-4 sm:flex-row sm:items-center">
          <div className="flex flex-1 gap-1">
            {([
              ["all", "全部"],
              ["favorite", "收藏"],
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
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-white/28" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索作品或 Prompt"
              className="h-9 rounded-xl border-white/7 bg-white/4 pl-9 text-xs text-white shadow-none placeholder:text-white/25 focus-visible:border-white/14 focus-visible:ring-0 dark:bg-white/4"
            />
          </div>
        </div>
        {visibleAssets.length === 0 ? (
          <div className="grid min-h-96 place-items-center">
            <div className="max-w-xs text-center">
              <span className="mx-auto grid size-14 place-items-center rounded-2xl border border-white/7 bg-white/4">
                <Library className="size-5 text-white/30" />
              </span>
              <h2 className="mt-4 text-sm font-semibold">没有找到作品</h2>
              <p className="mt-1 text-xs leading-5 text-white/35">
                调整筛选条件，或者开始一次新的图片生成。
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-5 columns-2 gap-3 md:columns-3 xl:columns-4">
            {visibleAssets.map(({ artifact, job }, index) => (
              <article
                key={artifact.id}
                className="group relative mb-3 break-inside-avoid overflow-hidden rounded-2xl bg-[#17191d]"
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(artifact.id)}
                  className="block w-full text-left"
                >
                  <CreateAssetPreview
                    artifact={artifact}
                    alt={job.prompt}
                    className={
                      index % 3 === 0
                        ? "aspect-[4/5]"
                        : index % 3 === 1
                          ? "aspect-square"
                          : "aspect-[4/3]"
                    }
                  />
                </button>
                <div className="absolute inset-x-0 bottom-0 flex items-end gap-2 bg-linear-to-t from-black/90 via-black/30 to-transparent px-3 pt-12 pb-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <button
                    type="button"
                    onClick={() => setSelectedId(artifact.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-xs font-semibold">
                      {job.prompt.slice(0, 30)}
                    </span>
                    <span className="mt-1 block truncate text-[10px] text-white/52">
                      {job.modelId}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={controller.favorites.has(artifact.id) ? "取消收藏" : "收藏"}
                    onClick={() => controller.toggleFavorite(artifact.id)}
                    className="grid size-8 place-items-center rounded-full border border-white/12 bg-black/35 text-white/75 backdrop-blur-sm"
                  >
                    <Heart
                      className={cn(
                        "size-3.5",
                        controller.favorites.has(artifact.id) && "fill-rose-400 text-rose-400",
                      )}
                    />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      <Dialog open={selected !== undefined} onOpenChange={(open) => !open && setSelectedId(undefined)}>
        {selected && (
          <DialogContent className="max-h-[90vh] max-w-5xl overflow-hidden border-white/10 bg-[#111318] p-0 text-white sm:max-w-5xl">
            <div className="grid min-h-0 md:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.55fr)]">
              <CreateAssetPreview
                artifact={selected.artifact}
                alt={selected.job.prompt}
                thumbnail={false}
                className="max-h-[76vh] min-h-80 bg-black object-contain"
              />
              <div className="flex min-h-0 flex-col p-5">
                <DialogHeader className="text-left">
                  <DialogTitle className="line-clamp-2 text-base">
                    {selected.job.prompt}
                  </DialogTitle>
                  <DialogDescription className="text-xs text-white/38">
                    图片 · {new Date(selected.artifact.createdAt).toLocaleString("zh-CN")}
                  </DialogDescription>
                </DialogHeader>
                <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
                  <p className="text-[10px] tracking-[0.14em] text-white/30 uppercase">Prompt</p>
                  <p className="mt-2 text-xs leading-5 text-white/70">{selected.job.prompt}</p>
                  <dl className="mt-6 grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <dt className="text-white/30">模型</dt>
                      <dd className="mt-1 break-all text-white/64">{selected.job.modelId}</dd>
                    </div>
                    <div>
                      <dt className="text-white/30">画面比例</dt>
                      <dd className="mt-1 text-white/64">{selected.job.aspectRatio ?? "自动"}</dd>
                    </div>
                  </dl>
                </div>
                <div className="mt-6 grid grid-cols-2 gap-2 border-t border-white/7 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="border-white/10 bg-white/4 text-white hover:bg-white/8 hover:text-white"
                    onClick={() => {
                      controller.reuse(selected.job);
                      setSelectedId(undefined);
                    }}
                  >
                    <RotateCcw />
                    再次创作
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="border-white/10 bg-white/4 text-white hover:bg-white/8 hover:text-white"
                    onClick={() => void controller.saveArtifact(selected.artifact.filePath)}
                  >
                    <Download />
                    导出
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="border-white/10 bg-white/4 text-white hover:bg-white/8 hover:text-white"
                    onClick={() => controller.toggleFavorite(selected.artifact.id)}
                  >
                    <Heart
                      className={cn(
                        controller.favorites.has(selected.artifact.id) &&
                          "fill-rose-400 text-rose-400",
                      )}
                    />
                    {controller.favorites.has(selected.artifact.id) ? "取消收藏" : "收藏"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="border-rose-400/12 bg-rose-400/5 text-rose-300 hover:bg-rose-400/10 hover:text-rose-200"
                    onClick={() => {
                      const id = selected.job.id;
                      setSelectedId(undefined);
                      void controller.remove(id);
                    }}
                  >
                    <Trash2 />
                    删除
                  </Button>
                </div>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
