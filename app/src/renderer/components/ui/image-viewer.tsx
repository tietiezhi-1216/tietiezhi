import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ImageViewerControls {
  open: () => void;
}

interface ImageViewerProps {
  src: string;
  alt: string;
  children: (controls: ImageViewerControls) => ReactNode;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SCALE_STEP = 0.25;

export function ImageViewer({ src, alt, children }: ImageViewerProps) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const draggedRef = useRef(false);

  const reset = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
    dragRef.current = undefined;
    draggedRef.current = false;
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const openViewer = () => {
    if (!src) return;
    reset();
    setOpen(true);
  };

  const updateScale = (nextScale: number) => {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    setScale(clamped);
    if (clamped <= 1) setPosition({ x: 0, y: 0 });
  };

  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    image.style.transform = `translate3d(${position.x}px, ${position.y}px, 0) scale(${scale})`;
  }, [position, scale]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "+" || event.key === "=") {
        updateScale(scale + SCALE_STEP);
      }
      if (event.key === "-") updateScale(scale - SCALE_STEP);
      if (event.key === "0") reset();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, scale]);

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : 1;
    updateScale(scale + direction * SCALE_STEP);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    };
    draggedRef.current = false;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const x = drag.originX + event.clientX - drag.startX;
    const y = drag.originY + event.clientY - drag.startY;
    if (Math.abs(x - drag.originX) > 3 || Math.abs(y - drag.originY) > 3) {
      draggedRef.current = true;
    }
    setPosition({ x, y });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <>
      {children({ open: openViewer })}
      {open &&
        createPortal(
          <div
            aria-label={`图片查看器：${alt}`}
            className="fixed inset-0 z-[100] flex touch-none items-center justify-center overflow-hidden bg-black/55 backdrop-blur-xl"
            onWheel={handleWheel}
            onClick={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-end p-4">
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="pointer-events-auto rounded-full bg-black/45 text-white shadow-lg backdrop-blur-md hover:bg-black/65 hover:text-white"
                onClick={close}
                aria-label="关闭图片查看器"
              >
                <X />
              </Button>
            </div>
            <img
              ref={imageRef}
              src={src}
              alt={alt}
              draggable={false}
              className={cn(
                "max-h-[calc(100vh-7rem)] max-w-[calc(100vw-4rem)] rounded-md object-contain shadow-2xl select-none will-change-transform",
                dragRef.current
                  ? "cursor-grabbing"
                  : scale > 1
                    ? "cursor-grab"
                    : "cursor-zoom-in",
              )}
              onDoubleClick={() =>
                scale === 1 ? updateScale(2) : reset()
              }
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => {
                dragRef.current = undefined;
                draggedRef.current = false;
              }}
              onClick={(event) => event.stopPropagation()}
            />
            <div className="pointer-events-auto absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/50 p-1.5 text-white shadow-2xl ring-1 ring-white/12 backdrop-blur-xl">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rounded-full text-white hover:bg-white/12 hover:text-white"
                disabled={scale <= MIN_SCALE}
                onClick={() => updateScale(scale - SCALE_STEP)}
                aria-label="缩小图片"
              >
                <Minus />
              </Button>
              <span className="w-14 text-center text-xs tabular-nums">
                {Math.round(scale * 100)}%
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rounded-full text-white hover:bg-white/12 hover:text-white"
                disabled={scale >= MAX_SCALE}
                onClick={() => updateScale(scale + SCALE_STEP)}
                aria-label="放大图片"
              >
                <Plus />
              </Button>
              <span className="mx-1 h-4 w-px bg-white/15" />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rounded-full text-white hover:bg-white/12 hover:text-white"
                onClick={reset}
                aria-label="重置图片"
              >
                <RotateCcw />
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
