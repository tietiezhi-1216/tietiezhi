import { Image as ImageIcon } from "lucide-react";

import { ImageViewer } from "@/components/ui/image-viewer";
import { cn } from "@/lib/utils";
import type { MediaArtifact } from "@shared/contracts";

export function CreateAssetPreview({
  artifact,
  alt,
  thumbnail = true,
  viewable = false,
  className,
}: {
  artifact?: MediaArtifact;
  alt: string;
  thumbnail?: boolean;
  viewable?: boolean;
  className?: string;
}) {
  if (!artifact) {
    return (
      <div className={cn("relative grid place-items-center overflow-hidden bg-[#101216]", className)}>
        <span className="absolute -top-8 -left-8 size-28 rounded-full bg-cyan-400/10 blur-3xl" />
        <span className="absolute -right-8 -bottom-8 size-32 rounded-full bg-blue-500/12 blur-3xl" />
        <ImageIcon className="relative size-6 text-white/28" />
      </div>
    );
  }
  if (artifact.type === "video") {
    return (
      <video
        src={window.tietiezhi.media.assetURL(artifact.filePath)}
        controls
        playsInline
        preload="metadata"
        className={cn("size-full bg-black object-contain", className)}
      >
        当前系统无法播放此视频。
      </video>
    );
  }
  const source = thumbnail
    ? window.tietiezhi.media.thumbnailURL(artifact.filePath)
    : window.tietiezhi.media.assetURL(artifact.filePath);
  if (viewable) {
    return (
      <ImageViewer
        src={window.tietiezhi.media.assetURL(artifact.filePath)}
        alt={alt}
      >
        {({ open }) => (
          <button
            type="button"
            className={cn(
              "group/media block w-fit max-w-full cursor-zoom-in overflow-hidden text-left",
              className,
            )}
            aria-label={`查看图片：${alt}`}
            onClick={open}
          >
            <img
              src={source}
              alt={alt}
              loading={thumbnail ? "lazy" : "eager"}
              decoding="async"
              draggable={false}
              className="block size-full object-cover transition-transform duration-300 group-hover/media:scale-[1.01]"
            />
          </button>
        )}
      </ImageViewer>
    );
  }
  return (
    <img
      src={source}
      alt={alt}
      loading={thumbnail ? "lazy" : "eager"}
      decoding="async"
      draggable={false}
      className={cn("size-full object-cover", className)}
    />
  );
}
