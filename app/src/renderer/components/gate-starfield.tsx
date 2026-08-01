import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

interface Star {
  /** Normalized [0,1] position so stars survive canvas resizes. */
  x: number;
  y: number;
  /** Depth 0..1 — deeper stars are smaller, dimmer, drift slower. */
  depth: number;
  radius: number;
  twinklePhase: number;
  twinkleSpeed: number;
  accent: boolean;
}

const ACCENT_COLOR = "34, 211, 238"; // cyan-400
const DRIFT_PER_MS = 0.0000032;
const POINTER_EASE = 0.045;
const POINTER_RANGE = 18;

function createStars(count: number, random: () => number): Star[] {
  return Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    depth: 0.25 + random() * 0.75,
    radius: 0.4 + random() * 1.1,
    twinklePhase: random() * Math.PI * 2,
    twinkleSpeed: 0.4 + random() * 1.2,
    accent: random() < 0.16,
  }));
}

/**
 * Canvas particle starfield for the onboarding gate: layered parallax drift
 * with gentle pointer follow. Renders a single static frame under
 * prefers-reduced-motion and pauses entirely while the document is hidden.
 */
export function GateStarfield({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stars = createStars(150, Math.random);
    let width = 0;
    let height = 0;
    let baseColor = "148, 163, 184";
    let baseAlpha = 1;
    let pointerX = 0;
    let pointerY = 0;
    let easedX = 0;
    let easedY = 0;
    let frame = 0;
    let cancelled = false;

    const sampleColor = () => {
      // The canvas carries a text-* class; currentColor doubles as star tint
      // so the field adapts to theme switches without hardcoded palettes.
      const parsed = getComputedStyle(canvas).color.match(
        /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/,
      );
      if (!parsed) return;
      baseColor = `${parsed[1]}, ${parsed[2]}, ${parsed[3]}`;
      baseAlpha = parsed[4] === undefined ? 1 : Number(parsed[4]);
    };

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      easedX += (pointerX - easedX) * POINTER_EASE;
      easedY += (pointerY - easedY) * POINTER_EASE;
      const drift = time * DRIFT_PER_MS;
      for (const star of stars) {
        const twinkle = motionQuery.matches
          ? 0.75
          : 0.55 +
            0.45 *
              Math.sin(star.twinklePhase + (time / 1000) * star.twinkleSpeed);
        const x =
          ((star.x + drift * star.depth) % 1) * width +
          easedX * star.depth * POINTER_RANGE;
        const y =
          ((star.y + drift * star.depth * 0.42) % 1) * height +
          easedY * star.depth * POINTER_RANGE;
        const alpha =
          baseAlpha * star.depth * twinkle * (star.accent ? 0.9 : 0.65);
        const radius = star.radius * (0.7 + star.depth * 0.6);
        context.beginPath();
        context.fillStyle = `rgba(${star.accent ? ACCENT_COLOR : baseColor}, ${alpha.toFixed(3)})`;
        if (star.accent && star.radius > 1.1) {
          context.shadowColor = `rgba(${ACCENT_COLOR}, 0.8)`;
          context.shadowBlur = 6;
        } else {
          context.shadowBlur = 0;
        }
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
      context.shadowBlur = 0;
    };

    const animate = (time: number) => {
      if (cancelled) return;
      draw(time);
      if (motionQuery.matches || document.hidden) return;
      frame = window.requestAnimationFrame(animate);
    };

    const restart = () => {
      window.cancelAnimationFrame(frame);
      if (motionQuery.matches || document.hidden) {
        draw(performance.now());
        return;
      }
      frame = window.requestAnimationFrame(animate);
    };

    const handlePointer = (event: PointerEvent) => {
      pointerX = (event.clientX / window.innerWidth) * 2 - 1;
      pointerY = (event.clientY / window.innerHeight) * 2 - 1;
    };

    const observer = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });
    const themeObserver = new MutationObserver(sampleColor);

    resize();
    sampleColor();
    restart();
    observer.observe(canvas);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    motionQuery.addEventListener("change", restart);
    document.addEventListener("visibilitychange", restart);
    window.addEventListener("pointermove", handlePointer, { passive: true });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      motionQuery.removeEventListener("change", restart);
      document.removeEventListener("visibilitychange", restart);
      window.removeEventListener("pointermove", handlePointer);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 size-full",
        className,
      )}
    />
  );
}
