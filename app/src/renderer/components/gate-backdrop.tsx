import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

interface Mote {
  x: number;
  y: number;
  radius: number;
  speed: number;
  drift: number;
  phase: number;
  opacity: number;
  bubble: boolean;
}

function createMotes(count: number): Mote[] {
  return Array.from({ length: count }, (_, index) => ({
    x: Math.random(),
    y: Math.random(),
    radius: 0.55 + Math.random() * 1.15,
    speed: 0.000006 + Math.random() * 0.000009,
    drift: 4 + Math.random() * 8,
    phase: Math.random() * Math.PI * 2,
    opacity: 0.12 + Math.random() * 0.2,
    bubble: index % 5 === 0,
  }));
}

export function GateBackdrop({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motes = createMotes(22);
    let width = 0;
    let height = 0;
    let frame = 0;
    let cancelled = false;

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
      for (const mote of motes) {
        const travel = motionQuery.matches ? 0 : time * mote.speed;
        const y = ((mote.y - travel) % 1 + 1) % 1;
        const x = mote.x * width + Math.sin(time / 7_000 + mote.phase) * mote.drift;
        const alpha = mote.opacity * (0.82 + Math.sin(time / 3_800 + mote.phase) * 0.18);

        context.beginPath();
        context.arc(x, y * height, mote.radius, 0, Math.PI * 2);
        if (mote.bubble) {
          context.strokeStyle = `rgba(103, 232, 249, ${alpha.toFixed(3)})`;
          context.lineWidth = 0.65;
          context.stroke();
        } else {
          context.fillStyle = `rgba(148, 210, 211, ${(alpha * 0.72).toFixed(3)})`;
          context.fill();
        }
      }
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

    const observer = new ResizeObserver(() => {
      resize();
      draw(performance.now());
    });

    resize();
    restart();
    observer.observe(canvas);
    motionQuery.addEventListener("change", restart);
    document.addEventListener("visibilitychange", restart);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      motionQuery.removeEventListener("change", restart);
      document.removeEventListener("visibilitychange", restart);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <span className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_43%,rgba(21,94,99,0.12)_0%,rgba(8,47,51,0.055)_34%,transparent_64%)] dark:bg-[radial-gradient(ellipse_at_50%_43%,rgba(34,211,238,0.075)_0%,rgba(8,47,51,0.055)_34%,transparent_64%)]" />
      <span className="absolute top-[3%] left-1/2 h-[58%] w-[48%] -translate-x-1/2 bg-cyan-200/[0.025] blur-3xl [clip-path:polygon(39%_0,61%_0,88%_100%,12%_100%)] dark:bg-cyan-200/[0.018]" />
      <span className="absolute top-[31%] left-1/2 h-72 w-[32rem] max-w-[72vw] -translate-x-1/2 rounded-full bg-teal-300/[0.025] blur-[80px] dark:bg-teal-300/[0.035]" />
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
    </div>
  );
}
