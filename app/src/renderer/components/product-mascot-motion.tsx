import { useEffect, useRef, useState } from "react";
type ProductMotionVariant = "tietiezhi" | "workspace" | "automations" | "create";
import { cn } from "@/lib/utils";

const CANVAS_SIZE = 512;
const TAU = Math.PI * 2;

type MotionIntensity = "compact" | "stage";

interface MascotFrame {
  translateX: number;
  translateY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  waveAmplitude: number;
  waveSpread: number;
  waveStart: number;
  waveTurns: number;
}

interface MotionDefinition {
  duration: number;
  frame: (phase: number) => MascotFrame;
}

const liftProgress = (phase: number): number => (1 - Math.cos(phase)) / 2;

const MOTIONS: Record<ProductMotionVariant, MotionDefinition> = {
  tietiezhi: {
    duration: 7_800,
    frame: (phase) => ({
      translateX:
        Math.sin(phase) * 6 +
        Math.sin(phase * 2) * 1.2 +
        Math.sin(phase * 3) * 0.5,
      translateY:
        -liftProgress(phase) * 11 +
        Math.sin(phase * 2) * 1.4 +
        Math.sin(phase * 3) * 0.5,
      rotation: Math.sin(phase) * 0.007 + Math.sin(phase * 2) * 0.0025,
      scaleX:
        1 + liftProgress(phase) * 0.006 + Math.sin(phase * 2) * 0.0015,
      scaleY:
        1 + liftProgress(phase) * 0.016 - Math.sin(phase * 2) * 0.002,
      waveAmplitude: 0,
      waveSpread: 0,
      waveStart: 0.53,
      waveTurns: 2,
    }),
  },
  workspace: {
    duration: 6_400,
    frame: (phase) => ({
      translateX:
        Math.sin(phase) * 2.8 +
        Math.sin(phase * 2) * 1.1 +
        Math.sin(phase * 4) * 0.55,
      translateY:
        -liftProgress(phase) * 6.4 -
        Math.sin(phase * 2) * 1.1 +
        Math.sin(phase * 4) * 0.9,
      rotation:
        -Math.sin(phase) * 0.014 +
        Math.sin(phase * 2) * 0.006 +
        Math.sin(phase * 4) * 0.003,
      scaleX: 1 + Math.sin(phase * 4) * 0.004 - liftProgress(phase) * 0.006,
      scaleY: 1 - Math.sin(phase * 4) * 0.003 + liftProgress(phase) * 0.012,
      waveAmplitude: 4.6,
      waveSpread: 2.6,
      waveStart: 0.48,
      waveTurns: 3,
    }),
  },
  automations: {
    duration: 7_200,
    frame: (phase) => ({
      translateX: Math.sin(phase) * 3.1,
      translateY: -liftProgress(phase) * 5.8 + Math.sin(phase * 3) * 0.8,
      rotation: Math.sin(phase) * 0.016 + Math.sin(phase * 3) * 0.004,
      scaleX: 1 - liftProgress(phase) * 0.007 + Math.sin(phase * 2) * 0.004,
      scaleY: 1 + liftProgress(phase) * 0.011 - Math.sin(phase * 2) * 0.003,
      waveAmplitude: 3.2,
      waveSpread: 2,
      waveStart: 0.5,
      waveTurns: 2,
    }),
  },
  create: {
    duration: 5_600,
    frame: (phase) => ({
      translateX:
        Math.sin(phase) * 3.6 -
        Math.sin(phase * 2) * 1.2 +
        Math.sin(phase * 3) * 0.8,
      translateY:
        -liftProgress(phase) * 9.2 +
        Math.sin(phase * 2) * 1.2 +
        Math.sin(phase * 3) * 1.05,
      rotation:
        Math.sin(phase) * 0.022 -
        Math.sin(phase * 2) * 0.008 +
        Math.sin(phase * 3) * 0.004,
      scaleX: 1 - liftProgress(phase) * 0.009 + Math.sin(phase * 2) * 0.006,
      scaleY: 1 + liftProgress(phase) * 0.018 - Math.sin(phase * 2) * 0.004,
      waveAmplitude: 5.4,
      waveSpread: 3.2,
      waveStart: 0.43,
      waveTurns: 3,
    }),
  },
};

const BLINK_SCHEDULES: Partial<Record<ProductMotionVariant, number[]>> = {
  tietiezhi: [0.32],
  workspace: [0.18, 0.61, 0.665],
  create: [0.22, 0.54, 0.595],
};

function smoothstep(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function blinkAmount(
  progress: number,
  variant: ProductMotionVariant,
  duration: number,
): number {
  const starts = BLINK_SCHEDULES[variant];
  if (!starts) return 0;

  const closeDuration = 65 / duration;
  const holdDuration = 38 / duration;
  const openDuration = 92 / duration;
  const totalDuration = closeDuration + holdDuration + openDuration;

  return starts.reduce((amount, start) => {
    const elapsed = (progress - start + 1) % 1;
    if (elapsed >= totalDuration) return amount;
    if (elapsed < closeDuration) {
      return Math.max(amount, smoothstep(elapsed / closeDuration));
    }
    if (elapsed < closeDuration + holdDuration) return 1;
    return Math.max(
      amount,
      1 - smoothstep((elapsed - closeDuration - holdDuration) / openDuration),
    );
  }, 0);
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadMascotImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached) return cached;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`无法加载章鱼动画资源：${src}`));
    image.src = src;
  });
  imageCache.set(src, promise);
  return promise;
}

function scaleFrame(frame: MascotFrame, intensity: MotionIntensity): MascotFrame {
  const amount = intensity === "compact" ? 0.76 : 1;
  return {
    ...frame,
    translateX: frame.translateX * amount,
    translateY: frame.translateY * amount,
    rotation: frame.rotation * amount,
    scaleX: 1 + (frame.scaleX - 1) * amount,
    scaleY: 1 + (frame.scaleY - 1) * amount,
    waveAmplitude: frame.waveAmplitude * amount,
    waveSpread: frame.waveSpread * amount,
  };
}

function drawWarpedMascot(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  frame: MascotFrame,
  phase: number,
  stripStep: number,
) {
  const sourceScaleY = image.naturalHeight / CANVAS_SIZE;

  context.save();
  context.translate(
    CANVAS_SIZE / 2 + frame.translateX,
    CANVAS_SIZE / 2 + frame.translateY,
  );
  context.rotate(frame.rotation);
  context.scale(frame.scaleX, frame.scaleY);
  context.translate(-CANVAS_SIZE / 2, -CANVAS_SIZE / 2);

  for (let y = 0; y < CANVAS_SIZE; y += stripStep) {
    const stripHeight = Math.min(stripStep, CANVAS_SIZE - y);
    const progress = y / CANVAS_SIZE;
    const waveProgress = Math.max(
      0,
      Math.min(1, (progress - frame.waveStart) / (1 - frame.waveStart)),
    );
    const envelope = waveProgress * waveProgress * (3 - 2 * waveProgress);
    const wavePhase = phase * frame.waveTurns + progress * Math.PI * 2.35;
    const offsetX = Math.sin(wavePhase) * frame.waveAmplitude * envelope;
    const spread =
      Math.sin(phase * 2 - progress * Math.PI * 1.7) *
      frame.waveSpread *
      envelope;

    context.drawImage(
      image,
      0,
      y * sourceScaleY,
      image.naturalWidth,
      stripHeight * sourceScaleY,
      offsetX - spread / 2,
      y,
      CANVAS_SIZE + spread,
      stripHeight + 0.5,
    );
  }
  context.restore();
}

function drawStableMascot(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  frame: MascotFrame,
) {
  const anchorX = CANVAS_SIZE / 2;
  const anchorY = CANVAS_SIZE * 0.82;

  context.save();
  context.translate(anchorX + frame.translateX, anchorY + frame.translateY);
  context.rotate(frame.rotation);
  context.scale(frame.scaleX, frame.scaleY);
  context.translate(-anchorX, -anchorY);
  context.drawImage(image, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
  context.restore();
}

export function ProductMascotMotion({
  src,
  blinkSrc,
  variant,
  alt = "",
  className,
  imageClassName,
  intensity = "compact",
  paused = false,
}: {
  src: string;
  blinkSrc?: string;
  variant: ProductMotionVariant;
  alt?: string;
  className?: string;
  imageClassName?: string;
  intensity?: MotionIntensity;
  paused?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const displayContext = canvas?.getContext("2d");
    if (!canvas || !displayContext) return;

    const frameBuffer = document.createElement("canvas");
    frameBuffer.width = CANVAS_SIZE;
    frameBuffer.height = CANVAS_SIZE;
    const frameContext = frameBuffer.getContext("2d");
    if (!frameContext) return;

    const motion = MOTIONS[variant];
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationFrame = 0;
    let cancelled = false;
    let visible = true;
    let image: HTMLImageElement | null = null;
    let blinkImage: HTMLImageElement | null = null;
    let startedAt = performance.now();

    setReady(false);

    const renderFrame = (progress: number) => {
      if (!image) return;
      const phase = progress * TAU;
      const frame = scaleFrame(motion.frame(phase), intensity);
      frameContext.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      frameContext.imageSmoothingEnabled = true;
      frameContext.imageSmoothingQuality = "high";
      if (variant === "tietiezhi") {
        drawStableMascot(frameContext, image, frame);
      } else {
        drawWarpedMascot(
          frameContext,
          image,
          frame,
          phase,
          intensity === "compact" ? 8 : 4,
        );
      }

      const expressionAmount = blinkImage
        ? blinkAmount(progress, variant, motion.duration)
        : 0;
      const eyeState =
        expressionAmount >= 0.96
          ? "closed"
          : expressionAmount > 0.04
            ? "transitioning"
            : "open";
      if (canvas.dataset.mascotEyeState !== eyeState) {
        canvas.dataset.mascotEyeState = eyeState;
      }
      if (blinkImage && expressionAmount > 0) {
        frameContext.save();
        frameContext.globalAlpha = expressionAmount;
        frameContext.globalCompositeOperation = "source-atop";
        if (variant === "tietiezhi") {
          drawStableMascot(frameContext, blinkImage, frame);
        } else {
          drawWarpedMascot(
            frameContext,
            blinkImage,
            frame,
            phase,
            intensity === "compact" ? 8 : 4,
          );
        }
        frameContext.restore();
      }

      displayContext.save();
      displayContext.globalCompositeOperation = "copy";
      displayContext.drawImage(frameBuffer, 0, 0);
      displayContext.restore();
    };

    const animate = (time: number) => {
      if (cancelled) return;
      if (paused || motionQuery.matches || document.hidden || !visible) {
        renderFrame(0);
        return;
      }
      const elapsed = (time - startedAt) % motion.duration;
      renderFrame(elapsed / motion.duration);
      animationFrame = window.requestAnimationFrame(animate);
    };

    const restart = () => {
      window.cancelAnimationFrame(animationFrame);
      if (!image) return;
      if (paused || motionQuery.matches || document.hidden || !visible) {
        renderFrame(0);
        return;
      }
      startedAt = performance.now();
      animationFrame = window.requestAnimationFrame(animate);
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      restart();
    });
    observer.observe(canvas);
    motionQuery.addEventListener("change", restart);
    document.addEventListener("visibilitychange", restart);

    const blinkPromise = blinkSrc
      ? loadMascotImage(blinkSrc).catch((error: unknown) => {
          console.warn(error);
          return null;
        })
      : Promise.resolve(null);

    void Promise.all([loadMascotImage(src), blinkPromise])
      .then(([loadedImage, loadedBlinkImage]) => {
        if (cancelled) return;
        image = loadedImage;
        blinkImage = loadedBlinkImage;
        renderFrame(0);
        setReady(true);
        restart();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(error);
      });

    return () => {
      cancelled = true;
      observer.disconnect();
      motionQuery.removeEventListener("change", restart);
      document.removeEventListener("visibilitychange", restart);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [blinkSrc, intensity, paused, src, variant]);

  return (
    <span
      data-mascot-animation={variant}
      data-mascot-blink={blinkSrc ? "true" : "false"}
      data-mascot-intensity={intensity}
      data-mascot-paused={paused ? "true" : "false"}
      data-mascot-loop-ms={MOTIONS[variant].duration}
      className={cn(
        "relative block shrink-0 overflow-visible motion-reduce:transform-none",
        className,
      )}
    >
      <img
        src={src}
        alt={alt}
        decoding="async"
        draggable={false}
        className={cn(
          "absolute inset-0 size-full object-contain transition-opacity duration-200",
          ready && "opacity-0",
          imageClassName,
        )}
      />
      <canvas
        ref={canvasRef}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 size-full object-contain transition-opacity duration-200",
          ready ? "opacity-100" : "opacity-0",
        )}
      />
    </span>
  );
}
