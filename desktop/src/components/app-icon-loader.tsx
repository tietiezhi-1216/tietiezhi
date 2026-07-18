import { useEffect, useRef, useState } from "react";
import { AppIcon } from "@/components/app-icon";
import { cn } from "@/lib/utils";

const ART_SCALE = 4;
const CANVAS_SIZE = 192 * ART_SCALE;
const CENTER = CANVAS_SIZE / 2;
const LOOP_DURATION_MS = 12_000;
const TAU = Math.PI * 2;
const ENTER_DURATION_MS = 850;
const EXIT_DURATION_MS = 700;
const LOGO_HOLD_MS = 220;

interface DecorationAsset {
  src: string;
  originX: number;
  originY: number;
}

interface DecorationSpec {
  assetIndex: number;
  isOriginal: boolean;
  radiusX: number;
  radiusY: number;
  phase: number;
  loopTurns: number;
  loopDirection: 1 | -1;
  spinTurns: number;
  spinDirection: 1 | -1;
  bobTurns: number;
  bobAmount: number;
  scale: number;
  opacity: number;
}

const DECORATION_ORIGINS = [
  [38.344, 47.906],
  [168.938, 75.469],
  [22.406, 77.438],
  [157.219, 46.125],
  [72.562, 26.625],
  [136.031, 44.344],
  [171.188, 94.406],
  [58.969, 42.094],
  [38.438, 69.0],
  [16.219, 108.281],
  [19.125, 102.188],
  [25.969, 99.375],
] as const;

const DECORATION_ASSETS: DecorationAsset[] = DECORATION_ORIGINS.map(
  ([originX, originY], index) => ({
    src: `/octopus-loader/decor-${String(index + 1).padStart(2, "0")}.png`,
    originX: originX * ART_SCALE,
    originY: originY * ART_SCALE,
  }),
);

const seeded = (index: number, salt: number): number => {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43_758.5453;
  return value - Math.floor(value);
};

const createDecoration = (
  index: number,
  assetIndex: number,
  isOriginal: boolean,
): DecorationSpec => {
  const isLarge = assetIndex < 5;
  const speedOptions = isLarge ? [1, 1, 2] : [1, 2, 3, 4];
  const radiusX = isLarge
    ? 72 + seeded(index, 1) * 18
    : isOriginal
      ? 58 + seeded(index, 1) * 31
      : 65 + seeded(index, 1) * 27;
  const radiusY = isLarge
    ? 56 + seeded(index, 2) * 21
    : isOriginal
      ? 47 + seeded(index, 2) * 31
      : 50 + seeded(index, 2) * 29;
  const scale = isLarge
    ? isOriginal
      ? 0.8 + seeded(index, 10) * 0.2
      : 0.42 + seeded(index, 10) * 0.34
    : isOriginal
      ? 0.9 + seeded(index, 10) * 0.42
      : 1.15 + seeded(index, 10) * 1.35;
  return {
    assetIndex,
    isOriginal,
    radiusX: radiusX * ART_SCALE,
    radiusY: radiusY * ART_SCALE,
    phase: seeded(index, 3) * TAU,
    loopTurns: speedOptions[Math.floor(seeded(index, 4) * speedOptions.length)],
    loopDirection: seeded(index, 5) > 0.46 ? 1 : -1,
    spinTurns: 1 + Math.floor(seeded(index, 6) * 4),
    spinDirection: seeded(index, 7) > 0.5 ? 1 : -1,
    bobTurns: 1 + Math.floor(seeded(index, 8) * 4),
    bobAmount: 0.018 + seeded(index, 9) * 0.062,
    scale,
    opacity: isOriginal
      ? 0.82 + seeded(index, 11) * 0.18
      : 0.38 + seeded(index, 11) * 0.42,
  };
};

const DECORATIONS: DecorationSpec[] = [
  ...DECORATION_ASSETS.map((_, index) => createDecoration(index, index, true)),
  ...Array.from({ length: 18 }, (_, index) =>
    createDecoration(
      DECORATION_ASSETS.length + index,
      (index * 5 + 2) % DECORATION_ASSETS.length,
      false,
    ),
  ),
];

interface LoaderAssets {
  baseOpen: HTMLImageElement;
  baseHalf: HTMLImageElement;
  baseClosed: HTMLImageElement;
  baseLookLeft: HTMLImageElement;
  baseLookRight: HTMLImageElement;
  decorationImages: HTMLImageElement[];
}

interface AppIconLoaderProps {
  active: boolean;
  className?: string;
  idle?: boolean;
  onExitComplete?: () => void;
}

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`无法加载动画资源：${src}`));
    image.src = src;
  });

let loaderAssetsPromise: Promise<LoaderAssets> | null = null;

const loadAssets = (): Promise<LoaderAssets> => {
  loaderAssetsPromise ??= Promise.all([
    loadImage("/octopus-loader/base-open.png"),
    loadImage("/octopus-loader/base-half.png"),
    loadImage("/octopus-loader/base-closed.png"),
    loadImage("/octopus-loader/base-look-left.png"),
    loadImage("/octopus-loader/base-look-right.png"),
    ...DECORATION_ASSETS.map(({ src }) => loadImage(src)),
  ]).then(
    ([baseOpen, baseHalf, baseClosed, baseLookLeft, baseLookRight, ...decorationImages]) => ({
      baseOpen,
      baseHalf,
      baseClosed,
      baseLookLeft,
      baseLookRight,
      decorationImages,
    }),
  );
  return loaderAssetsPromise;
};

const smoothstep = (value: number): number =>
  value * value * value * (value * (value * 6 - 15) + 10);

const mix = (from: number, to: number, progress: number): number =>
  from + (to - from) * progress;

interface BaseExpression {
  image: HTMLImageElement;
  amount: number;
}

const pickBase = (assets: LoaderAssets, loadingElapsed: number): BaseExpression => {
  const loopTime = loadingElapsed % LOOP_DURATION_MS;
  const blinkStarts = [1_550, 5_180, 9_880, 10_170];
  for (const start of blinkStarts) {
    const blinkTime = loopTime - start;
    if (blinkTime >= 0 && blinkTime < 55) return { image: assets.baseHalf, amount: 1 };
    if (blinkTime >= 55 && blinkTime < 155) {
      return { image: assets.baseClosed, amount: 1 };
    }
    if (blinkTime >= 155 && blinkTime < 215) {
      return { image: assets.baseHalf, amount: 1 };
    }
  }

  const gaze = (start: number, end: number, image: HTMLImageElement): BaseExpression | null => {
    if (loopTime < start || loopTime >= end) return null;
    const fadeDuration = 180;
    const fadeIn = Math.min(1, (loopTime - start) / fadeDuration);
    const fadeOut = Math.min(1, (end - loopTime) / fadeDuration);
    return { image, amount: smoothstep(Math.min(fadeIn, fadeOut)) };
  };

  return (
    gaze(2_800, 4_050, assets.baseLookLeft) ??
    gaze(7_350, 8_650, assets.baseLookRight) ?? { image: assets.baseOpen, amount: 0 }
  );
};

const pickIdleBase = (assets: LoaderAssets, idleElapsed: number): BaseExpression => {
  const loopTime = idleElapsed % LOOP_DURATION_MS;
  const blinkStarts = [2_350, 8_760, 9_040];
  for (const start of blinkStarts) {
    const blinkTime = loopTime - start;
    if (blinkTime >= 0 && blinkTime < 65) return { image: assets.baseHalf, amount: 1 };
    if (blinkTime >= 65 && blinkTime < 145) {
      return { image: assets.baseClosed, amount: 1 };
    }
    if (blinkTime >= 145 && blinkTime < 210) {
      return { image: assets.baseHalf, amount: 1 };
    }
  }

  if (loopTime >= 5_150 && loopTime < 6_350) {
    const fadeDuration = 240;
    const fadeIn = Math.min(1, (loopTime - 5_150) / fadeDuration);
    const fadeOut = Math.min(1, (6_350 - loopTime) / fadeDuration);
    return {
      image: assets.baseLookRight,
      amount: smoothstep(Math.min(fadeIn, fadeOut)),
    };
  }

  return { image: assets.baseOpen, amount: 0 };
};

const drawWavingBase = (
  context: CanvasRenderingContext2D,
  base: HTMLImageElement,
  elapsed: number,
  waveAmount: number,
) => {
  const waveStart = 122 * ART_SCALE;
  const waveHeight = CANVAS_SIZE - waveStart;
  const waveFast = (elapsed * TAU) / 2_000;
  const waveSlow = (elapsed * TAU) / 3_000;
  const spreadPhase = (elapsed * TAU) / 4_000;

  context.drawImage(
    base,
    0,
    0,
    CANVAS_SIZE,
    waveStart + 8,
    0,
    0,
    CANVAS_SIZE,
    waveStart + 8,
  );
  for (let y = waveStart; y < CANVAS_SIZE; y += 4) {
    const progress = (y - waveStart) / waveHeight;
    const envelope = Math.sin(progress * Math.PI);
    const offset =
      (Math.sin(waveFast + progress * 1.8) * 5.1 +
        Math.sin(waveSlow - progress * 2.6) * 2.4) *
      envelope *
      ART_SCALE *
      waveAmount;
    const spread =
      Math.sin(spreadPhase + progress * Math.PI) *
      envelope *
      2.6 *
      ART_SCALE *
      waveAmount;
    const stripHeight = Math.min(4, CANVAS_SIZE - y);
    context.drawImage(
      base,
      0,
      y,
      CANVAS_SIZE,
      stripHeight,
      offset - spread / 2,
      y,
      CANVAS_SIZE + spread,
      stripHeight,
    );
  }
};

const drawLoader = (
  context: CanvasRenderingContext2D,
  baseContext: CanvasRenderingContext2D,
  assets: LoaderAssets,
  blend: number,
  loadingElapsed: number,
  idleElapsed: number,
  idleEnabled: boolean,
) => {
  const easedBlend = smoothstep(blend);
  const loopProgress = (loadingElapsed % LOOP_DURATION_MS) / LOOP_DURATION_MS;
  const idleProgress = (idleElapsed % LOOP_DURATION_MS) / LOOP_DURATION_MS;
  context.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  DECORATIONS.forEach((spec, index) => {
    const image = assets.decorationImages[spec.assetIndex];
    const asset = DECORATION_ASSETS[spec.assetIndex];
    const radiusPulse =
      1 +
      Math.sin(loopProgress * TAU * spec.bobTurns + spec.phase * 0.7) * spec.bobAmount;
    const loopAngle =
      spec.phase + loopProgress * TAU * spec.loopTurns * spec.loopDirection;
    const loopX = CENTER + spec.radiusX * radiusPulse * Math.cos(loopAngle);
    const loopY = CENTER + spec.radiusY * radiusPulse * Math.sin(loopAngle);
    const originX = spec.isOriginal ? asset.originX : CENTER;
    const originY = spec.isOriginal ? asset.originY : CENTER;
    const idleAngle = idleProgress * TAU * (index % 3 === 0 ? 2 : 1) + spec.phase;
    const idleOffsetX =
      spec.isOriginal && idleEnabled ? Math.cos(idleAngle) * 0.9 * ART_SCALE : 0;
    const idleOffsetY =
      spec.isOriginal && idleEnabled ? Math.sin(idleAngle) * 1.15 * ART_SCALE : 0;
    const x = mix(originX + idleOffsetX, loopX, easedBlend);
    const y = mix(originY + idleOffsetY, loopY, easedBlend);
    const depthScale = 1 + Math.sin(loopAngle) * 0.065 * easedBlend;
    const targetScale = spec.scale * depthScale;
    const idleScale =
      spec.isOriginal && idleEnabled ? 1 + Math.sin(idleAngle + 0.7) * 0.012 : 1;
    const spriteScale = mix(spec.isOriginal ? idleScale : 0.3, targetScale, easedBlend);
    const targetOpacity =
      spec.opacity * (0.82 + Math.sin(loopProgress * TAU * spec.bobTurns + index) * 0.18);
    const opacity = spec.isOriginal
      ? mix(1, targetOpacity, easedBlend)
      : targetOpacity * easedBlend;
    const loadingRotation =
      loopProgress * TAU * spec.spinTurns * spec.spinDirection +
      Math.sin(loopProgress * TAU * spec.bobTurns + spec.phase) * 0.12;
    const idleRotation =
      spec.isOriginal && idleEnabled ? Math.sin(idleAngle - 0.4) * 0.025 : 0;
    const rotation = mix(idleRotation, loadingRotation, easedBlend);

    context.save();
    context.translate(x, y);
    context.globalAlpha = opacity;
    context.rotate(rotation);
    context.drawImage(
      image,
      (-image.width * spriteScale) / 2,
      (-image.height * spriteScale) / 2,
      image.width * spriteScale,
      image.height * spriteScale,
    );
    context.restore();
  });

  const loadingExpression = pickBase(assets, loadingElapsed);
  const idleExpression = pickIdleBase(assets, idleElapsed);
  const loadingExpressionAlpha = loadingExpression.amount * easedBlend;
  const idleExpressionAlpha =
    idleExpression.amount * (1 - easedBlend) * (idleEnabled ? 1 : 0);
  const openAlpha = Math.max(0, 1 - loadingExpressionAlpha - idleExpressionAlpha);
  const idleWave = idleEnabled
    ? 0.13 + ((Math.sin(idleProgress * TAU * 2 - Math.PI / 2) + 1) / 2) * 0.05
    : 0;
  const waveAmount = mix(idleWave, 1, easedBlend);
  const baseElapsed = mix(idleElapsed, loadingElapsed, easedBlend);

  // Draw expressions onto an isolated, fully opaque base silhouette. A normal
  // source-over crossfade between transparent PNGs loses alpha at midpoints,
  // which makes the mascot briefly dim during blinks and gaze transitions.
  baseContext.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  baseContext.imageSmoothingEnabled = true;
  baseContext.imageSmoothingQuality = "high";
  drawWavingBase(baseContext, assets.baseOpen, baseElapsed, waveAmount);

  if (idleExpression.image !== assets.baseOpen && idleExpressionAlpha > 0) {
    const nonLoadingAlpha = openAlpha + idleExpressionAlpha;
    baseContext.save();
    baseContext.globalCompositeOperation = "source-atop";
    baseContext.globalAlpha =
      nonLoadingAlpha > 0 ? idleExpressionAlpha / nonLoadingAlpha : 0;
    drawWavingBase(baseContext, idleExpression.image, baseElapsed, waveAmount);
    baseContext.restore();
  }

  if (loadingExpression.image !== assets.baseOpen && loadingExpressionAlpha > 0) {
    baseContext.save();
    baseContext.globalCompositeOperation = "source-atop";
    baseContext.globalAlpha = loadingExpressionAlpha;
    drawWavingBase(baseContext, loadingExpression.image, baseElapsed, waveAmount);
    baseContext.restore();
  }

  context.drawImage(baseContext.canvas, 0, 0);

  const cheekPulse = (Math.sin(loopProgress * TAU * 2 - Math.PI / 2) + 1) / 2;
  const idleCheekPulse = (Math.sin(idleProgress * TAU * 2 - Math.PI / 2) + 1) / 2;
  context.save();
  context.globalAlpha =
    cheekPulse * 0.1 * easedBlend +
    idleCheekPulse * 0.035 * (1 - easedBlend) * (idleEnabled ? 1 : 0);
  context.fillStyle = "rgb(255 116 96)";
  context.beginPath();
  context.ellipse(267, 419, 35, 17, 0, 0, TAU);
  context.ellipse(499, 419, 35, 17, 0, 0, TAU);
  context.fill();
  context.restore();
};

export function AppIconLoader({
  active,
  className,
  idle = true,
  onExitComplete,
}: AppIconLoaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  const idleRef = useRef(idle);
  const onExitCompleteRef = useRef(onExitComplete);
  const reducedMotionRef = useRef(false);
  const wakeAnimationRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  activeRef.current = active;
  idleRef.current = idle;
  onExitCompleteRef.current = onExitComplete;

  useEffect(() => {
    wakeAnimationRef.current?.();
  }, [active, idle]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotionPreference = () => {
      reducedMotionRef.current = mediaQuery.matches;
      wakeAnimationRef.current?.();
    };

    updateMotionPreference();
    mediaQuery.addEventListener("change", updateMotionPreference);
    return () => mediaQuery.removeEventListener("change", updateMotionPreference);
  }, []);

  useEffect(() => {
    if (!loadFailed || active) return;
    const timer = window.setTimeout(() => onExitCompleteRef.current?.(), LOGO_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [active, loadFailed]);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;

    const frameBuffer = document.createElement("canvas");
    frameBuffer.width = CANVAS_SIZE;
    frameBuffer.height = CANVAS_SIZE;
    const frameContext = frameBuffer.getContext("2d");
    const baseBuffer = document.createElement("canvas");
    baseBuffer.width = CANVAS_SIZE;
    baseBuffer.height = CANVAS_SIZE;
    const baseContext = baseBuffer.getContext("2d");
    if (!frameContext || !baseContext) return;

    let cancelled = false;
    let animationFrame = 0;

    void loadAssets()
      .then((assets) => {
        if (cancelled) return;

        let blend = 0;
        let loadingElapsed = 0;
        let idleElapsed = 0;
        let previousTime: number | null = null;
        let logoReachedAt: number | null = null;
        let exitNotified = false;
        let running = false;
        let previousMotionActive = activeRef.current;

        const renderFrame = () => {
          drawLoader(
            frameContext,
            baseContext,
            assets,
            blend,
            loadingElapsed,
            idleElapsed,
            idleRef.current,
          );
          context.save();
          context.globalCompositeOperation = "copy";
          context.drawImage(frameBuffer, 0, 0);
          context.restore();
        };

        renderFrame();
        setReady(true);

        const animate = (time: number) => {
          if (cancelled) return;

          const delta = previousTime == null ? 0 : Math.min(time - previousTime, 50);
          previousTime = time;
          if (reducedMotionRef.current) {
            blend = activeRef.current ? 1 : 0;
            loadingElapsed = 0;
            idleElapsed = 0;
            renderFrame();
            running = false;
            if (!activeRef.current) onExitCompleteRef.current?.();
            return;
          }

          const motionActive = activeRef.current;

          if (motionActive !== previousMotionActive) {
            if (motionActive) {
              loadingElapsed = idleElapsed;
            } else {
              idleElapsed = loadingElapsed;
            }
            previousMotionActive = motionActive;
          }

          if (motionActive) {
            blend = Math.min(1, blend + delta / ENTER_DURATION_MS);
            loadingElapsed += delta;
            logoReachedAt = null;
            exitNotified = false;
          } else {
            blend = Math.max(0, blend - delta / EXIT_DURATION_MS);
            if (idleRef.current) {
              idleElapsed += delta;
            }
          }

          renderFrame();

          if (!activeRef.current && blend === 0) {
            logoReachedAt ??= time;
            if (!exitNotified && time - logoReachedAt >= LOGO_HOLD_MS) {
              exitNotified = true;
              onExitCompleteRef.current?.();
              loadingElapsed = 0;
            }
            if (exitNotified && !idleRef.current) {
              idleElapsed = 0;
              running = false;
              renderFrame();
              return;
            }
          }

          animationFrame = window.requestAnimationFrame(animate);
        };

        wakeAnimationRef.current = () => {
          if (running) return;
          running = true;
          previousTime = null;
          animationFrame = window.requestAnimationFrame(animate);
        };
        wakeAnimationRef.current();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(error);
        setLoadFailed(true);
      });

    return () => {
      cancelled = true;
      wakeAnimationRef.current = null;
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <span className={cn("relative grid size-32 shrink-0 place-items-center", className)}>
      <AppIcon
        size="md"
        alt=""
        aria-hidden
        className={cn("absolute inset-0 size-full", ready && !loadFailed && "opacity-0")}
      />
      <canvas
        ref={canvasRef}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        aria-hidden
        className={cn("absolute inset-0 size-full", ready ? "opacity-100" : "opacity-0")}
      />
    </span>
  );
}
