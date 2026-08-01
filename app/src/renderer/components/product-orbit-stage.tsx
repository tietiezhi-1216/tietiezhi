import { ProductMascotMotion } from "@/components/product-mascot-motion";
import { cn } from "@/lib/utils";

const ORBIT_STARS = [
  "top-[12%] left-[14%] size-1 motion-safe:[animation-delay:-0.6s]",
  "top-[22%] right-[12%] size-0.5 motion-safe:[animation-delay:-2.4s]",
  "top-[42%] left-[5%] size-0.5 motion-safe:[animation-delay:-1.2s]",
  "top-[49%] right-[4%] size-1 motion-safe:[animation-delay:-3.7s]",
  "bottom-[18%] left-[19%] size-0.5 motion-safe:[animation-delay:-4.1s]",
  "right-[21%] bottom-[12%] size-1 motion-safe:[animation-delay:-1.8s]",
] as const;

export function ProductOrbitStage({
  variant,
  className,
}: {
  variant: "workspace" | "create" | "tietiezhi";
  className?: string;
}) {
  const create = variant === "create";
  const src = create
    ? "./mode-mascots/paper-plane/create.png"
    : variant === "tietiezhi"
      ? "./tietiezhi.png"
      : "./mode-mascots/paper-plane/code.png";
  const blinkSrc = create
    ? "./mode-mascots/paper-plane/create-blink.png"
    : variant === "tietiezhi"
      ? undefined
      : "./mode-mascots/paper-plane/code-blink.png";

  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative h-60 w-[28rem] max-w-full shrink-0 overflow-hidden",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 left-1/2 h-28 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl",
          create ? "bg-fuchsia-400/10" : "bg-cyan-400/10",
        )}
      />
      <span
        className={cn(
          "absolute top-[38%] left-[58%] h-16 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full blur-2xl",
          create ? "bg-amber-300/10" : "bg-sky-300/10",
        )}
      />

      <svg
        viewBox="0 0 420 240"
        className="absolute inset-0 size-full overflow-visible"
      >
        <g transform="rotate(-9 210 118)">
          <ellipse
            cx="210"
            cy="118"
            rx="184"
            ry="43"
            className={cn(
              "fill-none stroke-[0.8]",
              create
                ? "stroke-fuchsia-300/20"
                : "stroke-cyan-400/18 dark:stroke-cyan-300/20",
            )}
          />
          <circle
            r="2.6"
            className={cn(
              "motion-reduce:hidden",
              create ? "fill-amber-300" : "fill-cyan-300",
            )}
          >
            <animateMotion
              dur="12s"
              begin="-3s"
              repeatCount="indefinite"
              path="M 26 118 A 184 43 0 1 0 394 118 A 184 43 0 1 0 26 118"
            />
          </circle>
          <circle
            r="1.7"
            className={cn(
              "motion-reduce:hidden",
              create ? "fill-cyan-300" : "fill-orange-300",
            )}
          >
            <animateMotion
              dur="16s"
              begin="-9s"
              repeatCount="indefinite"
              path="M 394 118 A 184 43 0 1 1 26 118 A 184 43 0 1 1 394 118"
            />
          </circle>
        </g>

        <g transform="rotate(11 210 118)">
          <ellipse
            cx="210"
            cy="118"
            rx="142"
            ry="72"
            className={cn(
              "fill-none stroke-[0.75]",
              create
                ? "stroke-amber-300/16"
                : "stroke-sky-400/14 dark:stroke-sky-300/16",
            )}
          />
          <circle
            r="2.1"
            className={cn(
              "motion-reduce:hidden",
              create ? "fill-fuchsia-300" : "fill-sky-300",
            )}
          >
            <animateMotion
              dur="19s"
              begin="-7s"
              repeatCount="indefinite"
              path="M 68 118 A 142 72 0 1 0 352 118 A 142 72 0 1 0 68 118"
            />
          </circle>
        </g>

        <g transform="rotate(5 210 118)">
          <ellipse
            cx="210"
            cy="118"
            rx="196"
            ry="27"
            className={cn(
              "fill-none stroke-[0.65]",
              create
                ? "stroke-cyan-300/14"
                : "stroke-cyan-500/12 dark:stroke-cyan-200/14",
            )}
          />
          <circle
            r="1.5"
            className="fill-cyan-200 motion-reduce:hidden"
          >
            <animateMotion
              dur="14s"
              begin="-5s"
              repeatCount="indefinite"
              path="M 14 118 A 196 27 0 1 0 406 118 A 196 27 0 1 0 14 118"
            />
          </circle>
        </g>
      </svg>

      {ORBIT_STARS.map((star) => (
        <span
          key={star}
          className={cn(
            "absolute rounded-full shadow-[0_0_7px_currentColor] motion-safe:animate-orbit-star-twinkle",
            create ? "bg-white text-fuchsia-200" : "bg-current text-cyan-300",
            star,
          )}
        />
      ))}

      <ProductMascotMotion
        src={src}
        blinkSrc={blinkSrc}
        variant={variant}
        intensity="stage"
        className="absolute top-1/2 left-1/2 size-40 -translate-x-1/2 -translate-y-1/2"
      />
    </div>
  );
}
