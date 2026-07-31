import { useState } from "react";
import {
  ArrowUp,
  Clapperboard,
  Image as ImageIcon,
  Images,
  LoaderCircle,
  Plus,
  Square,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { LocalMediaAsset } from "@shared/contracts";

import { CreateModelSelect } from "./create-model-select";
import {
  CreateAssetDialog,
  CreateAssetThumbnail,
  mediaAssetDisplayName,
} from "./create-asset-sheet";
import type { CreateController } from "./create-types";

const DECK_POSITIONS = [
  "left-6 z-30 -rotate-12",
  "left-[5.75rem] z-20 rotate-8",
  "left-[10rem] z-10 -rotate-9",
  "left-[14.25rem] z-[5] rotate-[11deg]",
] as const;
const COMPACT_DECK_POSITIONS = [
  "left-5 z-30 -rotate-12",
  "left-[4.5rem] z-20 rotate-8",
  "left-[7.75rem] z-10 -rotate-9",
  "left-[11rem] z-[5] rotate-[11deg]",
] as const;
const ADD_POSITIONS = [
  "left-6",
  "left-[5.75rem]",
  "left-[10rem]",
  "left-[14.25rem]",
  "left-[18.5rem]",
] as const;
const COMPACT_ADD_POSITIONS = [
  "left-5",
  "left-[4.5rem]",
  "left-[7.75rem]",
  "left-[11rem]",
  "left-[14.25rem]",
] as const;

function CreateReferenceDeck({
  assets,
  compact,
  onAddLocal,
  onManage,
  onRemove,
}: {
  assets: LocalMediaAsset[];
  compact: boolean;
  onAddLocal: () => void;
  onManage: () => void;
  onRemove: (assetId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (assets.length === 0) {
    return (
      <div
        data-composer-media-deck
        className={cn(
          "relative z-20 max-w-full shrink-0 transition-[height] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:z-40",
          compact ? "h-16 w-[92px]" : "h-[104px] w-[100px]",
        )}
      >
        <div
          className={cn(
            "absolute top-1/2 transition-transform duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-[56%] hover:scale-105",
            compact
              ? "left-5 -translate-y-1/2 -rotate-12"
              : "left-6 -translate-y-1/2 -rotate-12",
          )}
        >
          <button
            type="button"
            onClick={onAddLocal}
            className={cn(
              "flex flex-col items-center justify-center rounded-[3px] border-0 bg-muted font-medium text-muted-foreground shadow-sm transition-[width,height,gap,font-size,color,background-color,box-shadow] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-accent hover:text-foreground disabled:opacity-50",
              compact
                ? "h-14 w-10 gap-0.5 text-[9px] [&_svg]:size-4"
                : "h-[78px] w-[54px] gap-1 text-[10px] leading-tight [&_svg]:size-5",
            )}
            aria-label="上传添加图片"
          >
            <Plus />
            <span className="max-w-full px-1 text-center">添加图片</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/deck relative z-20 max-w-full shrink-0 overflow-visible transition-[height] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:z-40",
        compact ? "h-16 w-[92px]" : "h-[104px] w-[100px]",
      )}
      onPointerLeave={() => setExpanded(false)}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-0 left-0 z-0 h-full",
          compact ? "w-[18rem]" : "w-[23rem]",
          expanded && "pointer-events-auto",
        )}
      />
      {assets.slice(0, 4).map((asset, index) => (
        <div
          key={asset.id}
          className={cn(
            "group/card absolute top-1/2 -translate-y-1/2 transition-[left,transform] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:z-50 hover:-translate-y-[56%] hover:scale-105",
            expanded
              ? compact
                ? COMPACT_DECK_POSITIONS[index]
                : DECK_POSITIONS[index]
              : cn(
                  compact ? "left-5" : "left-6",
                  index === 0 && "z-30 -rotate-12",
                  index === 1 && "z-20 rotate-8",
                  index === 2 && "z-10 -rotate-9",
                  index === 3 && "z-[5] rotate-[11deg]",
                ),
          )}
          onPointerEnter={() => setExpanded(true)}
        >
          <button
            type="button"
            onClick={onManage}
            className={cn(
              "relative overflow-hidden rounded-[3px] border border-white/80 bg-muted shadow-md ring-1 ring-border/60",
              compact ? "h-14 w-10" : "h-[78px] w-[54px]",
            )}
            aria-label={`管理 ${mediaAssetDisplayName(asset)}`}
          >
            <CreateAssetThumbnail asset={asset} />
          </button>
          <span
            className="pointer-events-none absolute -top-2 -right-2 z-50 grid size-6 place-items-center rounded-full border border-white/70 bg-background/95 opacity-0 shadow-md transition-opacity group-hover/card:pointer-events-auto group-hover/card:opacity-100"
          >
            <button
              type="button"
              className="pointer-events-auto grid size-full place-items-center"
              onClick={() => onRemove(asset.id)}
              aria-label={`移除 ${mediaAssetDisplayName(asset)}`}
            >
              <X className="size-3.5" />
            </button>
          </span>
        </div>
      ))}
      <button
        type="button"
        onClick={onAddLocal}
        aria-label="从文件添加图片"
        className={cn(
          "absolute z-40 grid -translate-y-1/2 place-items-center rounded-full bg-muted text-muted-foreground shadow-sm ring-1 ring-border/60 transition-[top,left,transform,width,height] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-[65%] hover:bg-accent hover:text-foreground",
          compact ? "size-[22px]" : "size-[30px]",
          expanded
            ? compact
              ? cn(
                  "top-1/2",
                  COMPACT_ADD_POSITIONS[Math.min(assets.length, 4)],
                )
              : cn("top-1/2", ADD_POSITIONS[Math.min(assets.length, 4)])
            : compact
              ? "top-[calc(50%+9px)] left-[3.25rem]"
              : "top-[calc(50%+14px)] left-[4.75rem]",
        )}
        onPointerEnter={() => setExpanded(true)}
      >
        <Plus className={compact ? "size-3" : "size-3.5"} />
      </button>
    </div>
  );
}

export function CreateComposer({
  controller,
}: {
  controller: CreateController;
}) {
  const [assetDialogOpen, setAssetDialogOpen] = useState(false);
  const {
    mode,
    providers,
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
    collapsed,
    error,
    setMode,
    setProvider,
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
    expand,
  } = controller;
  const mediaLabel = mode === "video" ? "视频" : "图片";
  const highResolutionVideo =
    mode === "video" &&
    (resolution === "1920x1080" || resolution === "3840x2160");
  const aspectRatios =
    mode === "video" &&
    model.toLowerCase().includes("veo-3.0") &&
    resolution === "1920x1080"
      ? capabilities.aspectRatios.filter((option) => option.value === "16:9")
      : capabilities.aspectRatios;
  const durations = highResolutionVideo
    ? capabilities.durations.filter((option) => option.value === 8)
    : capabilities.durations;
  const referenceAssets = references
    .map((reference) => ({
      reference,
      asset: assets.find((asset) => asset.id === reference.assetId),
    }))
    .filter(
      (
        item,
      ): item is typeof item & { asset: NonNullable<typeof item.asset> } =>
        item.asset !== undefined,
    );
  const mention = prompt.match(/(?:^|\s)@([^\s@]*)$/);
  const mentionQuery = mention?.[1]?.toLowerCase() ?? "";
  const mentionAssets = assets
    .filter(
      (asset) =>
        capabilities.acceptedReferenceTypes.includes(asset.type) &&
        mediaAssetDisplayName(asset).toLowerCase().includes(mentionQuery) &&
        !references.some((reference) => reference.assetId === asset.id),
    )
    .slice(0, 8);
  const addMention = (assetId: string) => {
    if (references.length >= capabilities.maxReferences) return;
    const nextPrompt =
      mention === null
        ? prompt
        : `${prompt.slice(0, mention.index)}${mention[0].startsWith(" ") ? " " : ""}`;
    setPrompt(nextPrompt);
    setReferences([...references, { assetId, role: "reference" }]);
  };

  return (
    <form
      className={cn(
        "relative w-full overflow-visible bg-card/72 shadow-2xl backdrop-blur-xl transition-[border-radius,max-height,padding] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        collapsed
          ? "max-h-24 rounded-[18px] p-2"
          : "max-h-[min(46svh,19rem)] rounded-[22px] p-3",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void generate();
      }}
    >
      <div
        className={cn(
          "relative flex min-h-0 transition-[min-height,gap] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
          collapsed
            ? "min-h-14 items-center gap-4 pr-14"
            : "min-h-24 items-start gap-4",
        )}
      >
        <div
          className={cn(
            "grid shrink-0 place-items-center transition-[padding] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            collapsed ? "pt-0" : "pt-5",
          )}
        >
          <CreateReferenceDeck
            assets={referenceAssets.map(({ asset }) => asset)}
            compact={collapsed}
            onAddLocal={() => void importAssets()}
            onManage={() => setAssetDialogOpen(true)}
            onRemove={(assetId) =>
              setReferences(
                references.filter(
                  (reference) => reference.assetId !== assetId,
                ),
              )
            }
          />
        </div>
        <div
          className={cn(
            "relative min-h-0 min-w-0 flex-1 self-stretch",
            collapsed && "flex items-center",
          )}
        >
          <Popover
            open={
              mention !== null &&
              capabilities.maxReferences > references.length
            }
          >
            <PopoverAnchor asChild>
              <Textarea
                id="create-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={`描述你想生成的${mediaLabel}，输入 @ 引用本地素材`}
                aria-label={`${mediaLabel}描述`}
                onFocus={expand}
                className={cn(
                  "resize-none border-0 bg-transparent px-0 pr-2 text-base leading-7 shadow-none transition-[min-height,max-height] duration-[360ms] placeholder:text-muted-foreground/65 focus-visible:ring-0 dark:bg-transparent",
                  collapsed
                    ? "max-h-8 min-h-8 py-0 leading-8"
                    : "max-h-44 min-h-24 py-3",
                )}
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    void generate();
                  }
                }}
              />
            </PopoverAnchor>
            <PopoverContent
              align="start"
              side="top"
              onOpenAutoFocus={(event) => event.preventDefault()}
              className="w-80 p-0"
            >
              <Command>
                <CommandList>
                  <CommandEmpty>没有匹配的本地素材</CommandEmpty>
                  <CommandGroup heading="引用素材">
                    {mentionAssets.map((asset) => (
                      <CommandItem
                        key={asset.id}
                        value={mediaAssetDisplayName(asset)}
                        onSelect={() => addMention(asset.id)}
                      >
                        <span className="size-8 overflow-hidden rounded-md bg-muted">
                          <CreateAssetThumbnail asset={asset} />
                        </span>
                        <span className="truncate">
                          {mediaAssetDisplayName(asset)}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        {collapsed && (
          <Button
            type={running ? "button" : "submit"}
            size="icon"
            variant={running ? "outline" : "default"}
            disabled={!running && (busy || !prompt.trim() || !providerId || !model)}
            onClick={running ? () => void cancel() : undefined}
            className="absolute top-1/2 right-2 size-9 -translate-y-1/2 rounded-full"
            aria-label={running ? "停止生成" : `生成${mediaLabel}`}
          >
            {running ? (
              <Square className="size-3.5 fill-current" />
            ) : busy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        )}
      </div>
      {!collapsed && error && (
        <p role="alert" className="px-5 pb-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div
        aria-hidden={collapsed}
        className={cn(
          "flex items-center gap-2 overflow-x-auto overflow-y-hidden transition-[max-height,margin,opacity] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] [scrollbar-width:none] [&>*]:shrink-0 [&::-webkit-scrollbar]:hidden",
          collapsed
            ? "pointer-events-none mt-0 max-h-0 opacity-0"
            : "mt-3 max-h-12 opacity-100",
        )}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 border-0 bg-muted/70"
          onClick={() => setAssetDialogOpen(true)}
        >
          <Images className="size-3.5" />
          素材库
          {references.length > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
              {references.length}
            </span>
          )}
        </Button>
        <div className="flex shrink-0 rounded-lg bg-muted/70 p-0.5">
          {([
            ["image", "图片", ImageIcon],
            ["video", "视频", Clapperboard],
          ] as const).map(([value, label, Icon]) => (
            <Button
              key={value}
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy || running}
              onClick={() => setMode(value)}
              className={cn(
                "h-7 gap-1.5 rounded-md px-2.5 text-xs",
                mode === value
                  ? "bg-background text-foreground shadow-sm hover:bg-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </Button>
          ))}
        </div>
        <CreateModelSelect
          mode={mode}
          providers={providers}
          providerId={providerId}
          model={model}
          onSelect={(nextProvider, nextModel) => {
            setProvider(nextProvider);
            setModel(nextModel);
          }}
        />
        {capabilities.resolutions.length > 0 && resolution !== undefined && (
          <Select
            value={resolution}
            onValueChange={(value) =>
              setResolution(value as typeof resolution)
            }
          >
            <SelectTrigger
              size="sm"
              className="w-auto min-w-20 border-0 bg-muted/70 shadow-none"
              aria-label="选择分辨率"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark">
              {capabilities.resolutions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {aspectRatios.length > 0 && aspectRatio !== undefined && (
          <Select
            value={aspectRatio}
            onValueChange={(value) =>
              setAspectRatio(value as `${number}:${number}`)
            }
          >
            <SelectTrigger
              size="sm"
              className="w-auto min-w-24 border-0 bg-muted/70 shadow-none"
              aria-label="选择画面比例"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark">
              {aspectRatios.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {capabilities.qualities.length > 0 && quality !== undefined && (
          <Select
            value={quality}
            onValueChange={(value) =>
              setQuality(value as typeof quality)
            }
          >
            <SelectTrigger
              size="sm"
              className="w-auto min-w-24 border-0 bg-muted/70 shadow-none"
              aria-label="选择生成质量"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark">
              {capabilities.qualities.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {durations.length > 0 && duration !== undefined && (
          <Select
            value={String(duration)}
            onValueChange={(value) => setDuration(Number(value))}
          >
            <SelectTrigger
              size="sm"
              className="w-auto min-w-20 border-0 bg-muted/70 shadow-none"
              aria-label="选择视频时长"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark">
              {durations.map((option) => (
                <SelectItem key={option.value} value={String(option.value)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {capabilities.counts.length > 1 && (
          <Select
            value={String(count)}
            onValueChange={(value) => setCount(Number(value))}
          >
            <SelectTrigger
              size="sm"
              className="w-auto min-w-16 border-0 bg-muted/70 shadow-none"
              aria-label="选择生成数量"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark">
              {capabilities.counts.map((option) => (
                <SelectItem key={option.value} value={String(option.value)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {running ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => void cancel()}
            className="ml-auto size-9 rounded-full"
            aria-label="停止生成"
            title="停止生成"
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={busy || !prompt.trim() || !providerId || !model}
            className="ml-auto size-9 rounded-full"
            aria-label={`生成${mediaLabel}`}
            title={`生成${mediaLabel}（⌘/Ctrl + Enter）`}
          >
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        )}
      </div>
      <CreateAssetDialog
        open={assetDialogOpen}
        onOpenChange={setAssetDialogOpen}
        assets={assets}
        references={references}
        acceptedTypes={capabilities.acceptedReferenceTypes}
        maxReferences={capabilities.maxReferences}
        referenceRoles={capabilities.referenceRoles}
        onChange={setReferences}
        onImport={importAssets}
        onRemove={removeAsset}
      />
    </form>
  );
}
