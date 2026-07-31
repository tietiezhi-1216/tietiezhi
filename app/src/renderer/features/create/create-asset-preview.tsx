import { Image as ImageIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { MediaArtifact } from "@shared/contracts";

export function CreateAssetPreview({
  artifact,
  alt,
  thumbnail = true,
  className,
}: {
  artifact?: MediaArtifact;
  alt: string;
  thumbnail?: boolean;
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
  return (
    <img
      src={
        thumbnail
          ? window.tietiezhi.media.thumbnailURL(artifact.filePath)
          : window.tietiezhi.media.assetURL(artifact.filePath)
      }
      alt={alt}
      loading={thumbnail ? "lazy" : "eager"}
      decoding="async"
      draggable={false}
      className={cn("size-full object-cover", className)}
    />
  );
}
