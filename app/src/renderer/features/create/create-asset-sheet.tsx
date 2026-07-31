import { useMemo, useState } from "react";
import {
  Check,
  Eye,
  Film,
  Image as ImageIcon,
  Plus,
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
import { ImageViewer } from "@/components/ui/image-viewer";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type {
  LocalMediaAsset,
  MediaReferenceInput,
  MediaReferenceRole,
  MediaType,
} from "@shared/contracts";

export function mediaAssetDisplayName(asset: LocalMediaAsset): string {
  if (asset.source === "imported") return asset.name;
  return `${asset.type === "video" ? "生成视频" : "生成图片"}-${asset.id.slice(0, 8)}`;
}

export function CreateAssetThumbnail({
  asset,
  className,
}: {
  asset: LocalMediaAsset;
  className?: string;
}) {
  if (asset.type === "video") {
    return (
      <video
        src={window.tietiezhi.media.assetURL(asset.filePath)}
        className={cn("h-full w-full object-cover", className)}
        muted
        preload="metadata"
      />
    );
  }
  return (
    <img
      src={window.tietiezhi.media.thumbnailURL(asset.filePath)}
      alt={mediaAssetDisplayName(asset)}
      className={cn("h-full w-full object-cover", className)}
    />
  );
}

export function CreateAssetDialog({
  assets,
  references,
  acceptedTypes,
  maxReferences,
  onChange,
  onImport,
  onRemove,
  referenceRoles,
  open,
  onOpenChange,
}: {
  assets: LocalMediaAsset[];
  references: MediaReferenceInput[];
  acceptedTypes: MediaType[];
  maxReferences: number;
  onChange: (references: MediaReferenceInput[]) => void;
  onImport: () => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  referenceRoles: MediaReferenceRole[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | MediaType>("all");
  const [previewAsset, setPreviewAsset] = useState<LocalMediaAsset>();
  const selected = new Set(references.map((reference) => reference.assetId));
  const visible = useMemo(
    () =>
      assets.filter(
        (asset) =>
          (type === "all" || asset.type === type) &&
          mediaAssetDisplayName(asset)
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [assets, query, type],
  );

  const toggle = (asset: LocalMediaAsset) => {
    if (selected.has(asset.id)) {
      onChange(references.filter((reference) => reference.assetId !== asset.id));
      return;
    }
    if (!acceptedTypes.includes(asset.type) || references.length >= maxReferences) return;
    onChange([...references, { assetId: asset.id, role: "reference" }]);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="dark flex h-[760px] max-h-[90vh] flex-col gap-0 overflow-hidden p-0 text-foreground sm:max-w-5xl">
          <DialogHeader className="shrink-0 gap-1 border-b px-7 py-4 text-left">
            <DialogTitle className="text-base">本地素材库</DialogTitle>
            <DialogDescription>
              素材只保存在本机。当前模型最多引用 {maxReferences} 个素材。
            </DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 gap-2 px-7 py-4">
            <div className="flex min-w-0 flex-1">
              <Select
                value={type}
                onValueChange={(value) => setType(value as "all" | MediaType)}
              >
                <SelectTrigger
                  aria-label="筛选素材类型"
                  className="h-9 w-28 rounded-r-none border-r-0 bg-muted/50"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="dark">
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="image">图片</SelectItem>
                  <SelectItem value="video">视频</SelectItem>
                </SelectContent>
              </Select>
              <div className="relative min-w-0 flex-1">
                <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索素材"
                  className="h-9 rounded-l-none pl-9"
                />
              </div>
            </div>
            <Button type="button" onClick={() => void onImport()}>
              <Plus />
              导入
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1 border-t px-7 py-5">
            {visible.length === 0 ? (
              <div className="flex min-h-[30rem] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <ImageIcon className="size-8 opacity-50" />
                <p>暂无本地素材</p>
                <p className="text-xs">导入图片或视频后，可在生成时重复引用。</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 pt-1 sm:grid-cols-3 lg:grid-cols-4">
                {visible.map((asset) => {
                  const label = mediaAssetDisplayName(asset);
                  const isSelected = selected.has(asset.id);
                  const disabled =
                    !acceptedTypes.includes(asset.type) ||
                    (!isSelected && references.length >= maxReferences);
                  return (
                    <div key={asset.id} className="group relative">
                      <div
                        className={cn(
                          "overflow-hidden rounded-lg border bg-muted transition-colors",
                          isSelected && "border-primary ring-1 ring-primary",
                          disabled && "opacity-40",
                        )}
                      >
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => toggle(asset)}
                          className="block w-full text-left"
                        >
                          <div className="relative aspect-square overflow-hidden">
                            <CreateAssetThumbnail asset={asset} />
                            <span className="absolute top-2 left-2 rounded-md bg-black/65 p-1 text-white">
                              {asset.type === "video" ? (
                                <Film className="size-3.5" />
                              ) : (
                                <ImageIcon className="size-3.5" />
                              )}
                            </span>
                            {isSelected && (
                              <span className="absolute top-2 right-2 rounded-full bg-primary p-1 text-primary-foreground">
                                <Check className="size-3.5" />
                              </span>
                            )}
                          </div>
                        </button>
                        <div className="flex min-h-9 items-center gap-1 px-2 py-1">
                          <p className="min-w-0 flex-1 truncate text-xs">{label}</p>
                          {isSelected && referenceRoles.length > 1 && (
                            <Select
                              value={
                                references.find(
                                  (reference) => reference.assetId === asset.id,
                                )?.role ?? "reference"
                              }
                              onValueChange={(role) =>
                                onChange(
                                  references.map((reference) =>
                                    reference.assetId === asset.id
                                      ? {
                                          ...reference,
                                          role: role as MediaReferenceRole,
                                        }
                                      : reference,
                                  ),
                                )
                              }
                            >
                              <SelectTrigger
                                size="sm"
                                aria-label={`${label} 的引用方式`}
                                className="h-6 border-0 bg-background/70 px-1.5 text-[10px]"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="dark">
                                {referenceRoles.map((role) => (
                                  <SelectItem key={role} value={role}>
                                    {role === "first-frame"
                                      ? "首帧"
                                      : role === "last-frame"
                                        ? "尾帧"
                                        : "参考"}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      </div>
                      <div className="absolute right-2 bottom-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        {asset.type === "image" ? (
                          <ImageViewer
                            src={window.tietiezhi.media.assetURL(asset.filePath)}
                            alt={label}
                          >
                            {({ open }) => (
                              <Button
                                type="button"
                                variant="secondary"
                                size="icon-sm"
                                aria-label={`预览 ${label}`}
                                onClick={open}
                              >
                                <Eye />
                              </Button>
                            )}
                          </ImageViewer>
                        ) : (
                          <Button
                            type="button"
                            variant="secondary"
                            size="icon-sm"
                            aria-label={`预览 ${label}`}
                            onClick={() => setPreviewAsset(asset)}
                          >
                            <Eye />
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="secondary"
                          size="icon-sm"
                          aria-label={`删除 ${label}`}
                          onClick={() => void onRemove(asset.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
      <Dialog
        open={previewAsset !== undefined}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPreviewAsset(undefined);
        }}
      >
        <DialogContent className="dark flex h-[88vh] w-[92vw] max-w-[92vw] items-center justify-center overflow-hidden bg-black/95 p-10 sm:max-w-[92vw]">
          <DialogHeader className="sr-only">
            <DialogTitle>素材预览</DialogTitle>
            <DialogDescription>
              {previewAsset
                ? mediaAssetDisplayName(previewAsset)
                : "本地素材"}
            </DialogDescription>
          </DialogHeader>
          {previewAsset?.type === "video" ? (
            <video
              src={window.tietiezhi.media.assetURL(previewAsset.filePath)}
              controls
              autoPlay
              playsInline
              className="max-h-full max-w-full object-contain"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
