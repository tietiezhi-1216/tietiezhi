import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/utils";

interface ChannelSetupMascotProps {
  children?: ReactNode;
  className?: string;
  mascotClassName?: string;
  mascotRef?: Ref<HTMLSpanElement>;
}

type ParticleKind = "dot" | "ring" | "star";

interface PathSpec {
  radiusX: number;
  radiusY: number;
  rotation: number;
}

interface ParticleSpec {
  kind: ParticleKind;
  pathIndex: number;
  phase: number;
  speed: number;
  size: number;
  opacity: number;
  lifeOffset: number;
  lifeDuration: number;
  radialDrift: number;
  orange: boolean;
}

const TAU = Math.PI * 2;
const PATHS: PathSpec[] = [
  { radiusX: 0.43, radiusY: 0.19, rotation: -0.08 },
  { radiusX: 0.38, radiusY: 0.27, rotation: 0.13 },
  { radiusX: 0.47, radiusY: 0.13, rotation: 0.03 },
];

const seededRandom = (seed: number) => {
  let value = seed || 0x6d2b79f5;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4_294_967_296;
  };
};

const makeParticles = (seed: number): ParticleSpec[] => {
  const random = seededRandom(seed);
  return Array.from({ length: 10 }, (_, index) => ({
    kind: index % 5 === 0 ? "ring" : index % 4 === 0 ? "star" : "dot",
    pathIndex: Math.floor(random() * PATHS.length),
    phase: random() * TAU,
    speed: (0.055 + random() * 0.075) * (random() > 0.28 ? 1 : -1),
    size: 1.8 + random() * 3.8,
    opacity: 0.34 + random() * 0.5,
    lifeOffset: random(),
    lifeDuration: 5.8 + random() * 7.2,
    radialDrift: random() * TAU,
    orange: index === 7,
  }));
};

const smoothstep = (value: number) => value * value * (3 - 2 * value);

const particleFade = (life: number) => {
  const fadeIn = smoothstep(Math.min(1, life / 0.16));
  const fadeOut = smoothstep(Math.min(1, (1 - life) / 0.22));
  return Math.min(fadeIn, fadeOut);
};

const drawStar = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
) => {
  context.beginPath();
  context.moveTo(x, y - size);
  context.quadraticCurveTo(x + size * 0.18, y - size * 0.18, x + size, y);
  context.quadraticCurveTo(x + size * 0.18, y + size * 0.18, x, y + size);
  context.quadraticCurveTo(x - size * 0.18, y + size * 0.18, x - size, y);
  context.quadraticCurveTo(x - size * 0.18, y - size * 0.18, x, y - size);
  context.closePath();
  context.fill();
};

export function ChannelSetupMascot({
  children,
  className,
  mascotClassName,
  mascotRef,
}: ChannelSetupMascotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const particles = makeParticles(seed);
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let startTime = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const drawPath = (path: PathSpec, dark: boolean) => {
      context.save();
      context.translate(width / 2, height * 0.48);
      context.rotate(path.rotation);
      context.beginPath();
      context.ellipse(0, 0, width * path.radiusX, height * path.radiusY, 0, 0, TAU);
      context.strokeStyle = dark ? "rgb(91 190 212 / 0.12)" : "rgb(16 116 140 / 0.13)";
      context.lineWidth = 0.75;
      context.stroke();
      context.restore();
    };

    const draw = (time: number) => {
      startTime ||= time;
      const seconds = motionQuery.matches ? 0 : (time - startTime) / 1_000;
      const dark = document.documentElement.classList.contains("dark");
      const cyan = dark ? "113 215 235" : "8 137 165";
      const orange = "249 115 22";
      context.clearRect(0, 0, width, height);

      PATHS.forEach((path) => drawPath(path, dark));
      particles.forEach((particle) => {
        const path = PATHS[particle.pathIndex];
        const life = motionQuery.matches
          ? (particle.lifeOffset + 0.42) % 1
          : (seconds / particle.lifeDuration + particle.lifeOffset) % 1;
        const fade = particleFade(life) * particle.opacity;
        if (fade <= 0.01) return;

        const angle = particle.phase + seconds * particle.speed;
        const radialPulse = 1 + Math.sin(seconds * 0.47 + particle.radialDrift) * 0.045;
        const pathX = Math.cos(angle) * width * path.radiusX * radialPulse;
        const pathY = Math.sin(angle) * height * path.radiusY * radialPulse;
        const rotationCos = Math.cos(path.rotation);
        const rotationSin = Math.sin(path.rotation);
        const x = width / 2 + pathX * rotationCos - pathY * rotationSin;
        const y = height * 0.48 + pathX * rotationSin + pathY * rotationCos;
        const color = particle.orange ? orange : cyan;

        context.save();
        context.globalAlpha = fade;
        context.fillStyle = `rgb(${color})`;
        context.strokeStyle = `rgb(${color})`;
        context.shadowColor = `rgb(${color} / 0.8)`;
        context.shadowBlur = particle.size * 2.4;

        if (particle.kind === "ring") {
          context.lineWidth = 0.9;
          context.beginPath();
          context.arc(x, y, particle.size * 1.35, 0, TAU);
          context.stroke();
        } else if (particle.kind === "star") {
          drawStar(context, x, y, particle.size * 1.25);
        } else {
          context.beginPath();
          context.arc(x, y, particle.size, 0, TAU);
          context.fill();
          context.globalAlpha = fade * 0.7;
          context.fillStyle = "white";
          context.beginPath();
          context.arc(
            x - particle.size * 0.25,
            y - particle.size * 0.3,
            Math.max(0.6, particle.size * 0.24),
            0,
            TAU,
          );
          context.fill();
        }
        context.restore();
      });

      if (!motionQuery.matches) animationFrame = window.requestAnimationFrame(draw);
    };

    resize();
    draw(0);
    const observer = new ResizeObserver(() => {
      resize();
      if (motionQuery.matches) draw(0);
    });
    observer.observe(canvas);

    const handleMotionChange = () => {
      window.cancelAnimationFrame(animationFrame);
      startTime = 0;
      draw(0);
    };
    motionQuery.addEventListener("change", handleMotionChange);

    return () => {
      observer.disconnect();
      motionQuery.removeEventListener("change", handleMotionChange);
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <span
      aria-hidden
      className={cn(
        "animate-channel-arrive pointer-events-none relative block h-72 w-[26rem] max-w-[calc(100vw-2rem)] shrink-0 select-none motion-reduce:animate-none",
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 size-full"
      />
      <span className="animate-channel-breathe pointer-events-none absolute inset-0 grid place-items-center motion-reduce:animate-none">
        <span
          ref={mascotRef}
          data-mascot-motion="float"
          className={cn(
            "pointer-events-none relative z-10 block size-56 drop-shadow-md will-change-transform motion-reduce:will-change-auto",
            mascotClassName,
          )}
        >
          {children ?? (
            <img
              src="/octopus-channel-setup/body.webp"
              alt=""
              decoding="async"
              draggable={false}
              className="pointer-events-none absolute inset-0 size-full -translate-x-[3%] -translate-y-[7%] select-none object-contain"
            />
          )}
        </span>
      </span>
    </span>
  );
}
