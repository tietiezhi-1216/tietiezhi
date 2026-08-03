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

type OrbitTokenKind = "heart" | "star" | "gear" | "check";

const TIETIEZHI_ORBIT_TOKENS = [
  { kind: "heart", x: 38.344, y: 47.906, rotation: 14, scale: 1, duration: "6s", begin: "-3.2s" },
  { kind: "check", x: 168.938, y: 75.469, rotation: 14, scale: 1, duration: "7s", begin: "-1.6s" },
  { kind: "star", x: 22.406, y: 77.438, rotation: -10, scale: 1, duration: "6.4s", begin: "-1s" },
  { kind: "gear", x: 157.219, y: 46.125, rotation: 12, scale: 1, duration: "6.2s", begin: "-4.1s" },
  { kind: "star", x: 72.562, y: 26.625, rotation: -8, scale: 0.76, duration: "6.8s", begin: "-2s" },
] as const satisfies readonly {
  kind: OrbitTokenKind;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  duration: string;
  begin: string;
}[];

const TIETIEZHI_ORBIT_SPARKLES = [
  { kind: "diamond", x: 136.031, y: 44.344, width: 8.8, height: 9.2, rotation: 0, fill: "#f0a04d", begin: "-0.8s" },
  { kind: "diamond", x: 171.188, y: 94.406, width: 6.8, height: 7, rotation: 0, fill: "#fff0c6", begin: "-2.4s" },
  { kind: "diamond", x: 58.969, y: 42.094, width: 6.5, height: 7, rotation: 0, fill: "#f2a14c", begin: "-3.7s" },
  { kind: "diamond", x: 38.438, y: 69, width: 5.5, height: 6.5, rotation: 0, fill: "#ffe07c", begin: "-1.5s" },
  { kind: "streak", x: 16.219, y: 108.281, width: 8, height: 4, rotation: 8, fill: "#91e9ed", begin: "-4.2s" },
  { kind: "streak", x: 19.125, y: 102.188, width: 6, height: 3.8, rotation: 48, fill: "#78dce7", begin: "-2.9s" },
  { kind: "streak", x: 25.969, y: 99.375, width: 6, height: 2.8, rotation: 82, fill: "#68d3e1", begin: "-1.9s" },
] as const;

function driftSeed(index: number, salt: number): number {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function createIrregularDrift(index: number, amplitude: number): string {
  const phaseX = driftSeed(index, 1) * Math.PI * 2;
  const phaseY = driftSeed(index, 2) * Math.PI * 2;
  const radiusX = amplitude * (0.72 + driftSeed(index, 3) * 0.42);
  const radiusY = amplitude * (0.58 + driftSeed(index, 4) * 0.36);

  return Array.from({ length: 13 }, (_, step) => {
    const angle = (step / 12) * Math.PI * 2;
    const x =
      Math.cos(angle + phaseX) * radiusX +
      Math.sin(angle * 2 + phaseY) * radiusX * 0.24;
    const y =
      Math.sin(angle + phaseY) * radiusY +
      Math.cos(angle * 3 + phaseX) * radiusY * 0.16;
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(";");
}

function OrbitTokenIcon({ kind }: { kind: OrbitTokenKind }) {
  if (kind === "heart") {
    return (
      <path
        d="M5.8 9.3c0-3.2 4.2-3.7 4.6-.8.4-2.9 4.6-2.4 4.6.8 0 2.8-4.6 5.4-4.6 5.4s-4.6-2.6-4.6-5.4Z"
        fill="#378cb3"
      />
    );
  }
  if (kind === "gear") {
    return (
      <>
        <circle
          cx="10.4"
          cy="10.4"
          r="4.2"
          fill="none"
          stroke="#337fa4"
          strokeWidth="2.2"
          strokeDasharray="2.2 1.6"
        />
        <circle cx="10.4" cy="10.4" r="1.5" fill="#337fa4" />
      </>
    );
  }
  if (kind === "check") {
    return (
      <path
        d="m5.5 10.2 2.8 2.8 6-6.2"
        fill="none"
        stroke="#c86726"
        strokeWidth="2.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  return (
    <path
      d="m10.4 4.2 1.6 3.3 3.7.5-2.7 2.5.6 3.6-3.2-1.7-3.3 1.7.6-3.6L5.1 8l3.7-.5 1.6-3.3Z"
      fill="#dc7a29"
    />
  );
}

function TietiezhiOrbitTokens() {
  return (
    <svg
      viewBox="0 0 420 240"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
    >
      <defs>
        <linearGradient id="token-cyan" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c2f5f2" />
          <stop offset="1" stopColor="#62bed4" />
        </linearGradient>
        <linearGradient id="token-amber" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe69a" />
          <stop offset="1" stopColor="#f4a04d" />
        </linearGradient>
      </defs>

      <g transform="translate(130 40) scale(0.833333)">
        <g>
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 0;2.1 -2.4;2.8 -3.7;0 -4.6;-2.8 -3.5;-2.1 -1.8;0 0"
            keyTimes="0;0.17;0.32;0.5;0.68;0.84;1"
            dur="7.8s"
            repeatCount="indefinite"
          />
          {TIETIEZHI_ORBIT_TOKENS.map((token, index) => {
            const cyan = token.kind === "heart" || token.kind === "gear";
            return (
              <g
                key={`${token.kind}-${index}`}
                transform={`translate(${token.x} ${token.y}) rotate(${token.rotation}) scale(${token.scale})`}
              >
                <g>
                  <animateTransform
                    attributeName="transform"
                    type="translate"
                    values={createIrregularDrift(index, 2.2)}
                    dur={token.duration}
                    begin={token.begin}
                    repeatCount="indefinite"
                  />
                  <g transform="translate(-10 -10)">
                    <rect
                      x="1"
                      y="1.8"
                      width="20"
                      height="20"
                      rx="4.5"
                      fill={cyan ? "#174c69" : "#8f5428"}
                      opacity="0.48"
                    />
                    <rect
                      width="20"
                      height="20"
                      rx="4.5"
                      fill={cyan ? "url(#token-cyan)" : "url(#token-amber)"}
                      stroke={cyan ? "#174c69" : "#9b5e27"}
                      strokeWidth="1.45"
                    />
                    <OrbitTokenIcon kind={token.kind} />
                    <path
                      d="M3.5 3.6h7.5"
                      stroke="#fff"
                      strokeWidth="1"
                      strokeLinecap="round"
                      opacity="0.5"
                    />
                  </g>
                </g>
              </g>
            );
          })}
          {TIETIEZHI_ORBIT_SPARKLES.map((sparkle, index) => (
            <g
              key={`${sparkle.kind}-${index}`}
              transform={`translate(${sparkle.x} ${sparkle.y}) rotate(${sparkle.rotation})`}
            >
              <g>
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  values={createIrregularDrift(index + TIETIEZHI_ORBIT_TOKENS.length, 1.65)}
                  dur={`${5.3 + index * 0.47}s`}
                  begin={sparkle.begin}
                  repeatCount="indefinite"
                />
                {sparkle.kind === "diamond" ? (
                  <path
                    d={`M 0 ${-sparkle.height / 2} C ${sparkle.width * 0.12} ${-sparkle.height * 0.12}, ${sparkle.width * 0.38} ${-sparkle.height * 0.12}, ${sparkle.width / 2} 0 C ${sparkle.width * 0.12} ${sparkle.height * 0.12}, ${sparkle.width * 0.12} ${sparkle.height * 0.38}, 0 ${sparkle.height / 2} C ${-sparkle.width * 0.12} ${sparkle.height * 0.12}, ${-sparkle.width * 0.38} ${sparkle.height * 0.12}, ${-sparkle.width / 2} 0 C ${-sparkle.width * 0.12} ${-sparkle.height * 0.12}, ${-sparkle.width * 0.12} ${-sparkle.height * 0.38}, 0 ${-sparkle.height / 2} Z`}
                    fill={sparkle.fill}
                    stroke="#9a6338"
                    strokeWidth="0.45"
                  />
                ) : (
                  <ellipse
                    rx={sparkle.width / 2}
                    ry={sparkle.height / 2}
                    fill={sparkle.fill}
                    stroke="#2d8da5"
                    strokeWidth="0.45"
                  />
                )}
              </g>
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}

export function ProductOrbitStage({
  variant,
  className,
}: {
  variant: "workspace" | "create" | "tietiezhi";
  className?: string;
}) {
  if (variant === "tietiezhi") {
    return (
      <div
        aria-hidden="true"
        className={cn(
          "relative h-60 w-[28rem] max-w-full shrink-0 overflow-hidden",
          className,
        )}
      >
        <span className="absolute top-[52%] left-1/2 h-24 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-300/[0.055] blur-3xl" />
        <span className="absolute top-[60%] left-1/2 h-12 w-36 -translate-x-1/2 -translate-y-1/2 rounded-full bg-teal-200/[0.04] blur-2xl" />
        <svg viewBox="0 0 420 240" className="absolute inset-0 size-full">
          <ellipse
            cx="210"
            cy="158"
            rx="74"
            ry="16"
            className="fill-none stroke-cyan-200/12 stroke-[0.7]"
          />
          <ellipse
            cx="210"
            cy="158"
            rx="74"
            ry="16"
            className="fill-none stroke-cyan-200/18 stroke-[0.8] motion-reduce:hidden"
          >
            <animate attributeName="rx" values="68;118" dur="6s" repeatCount="indefinite" />
            <animate attributeName="ry" values="14;28" dur="6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.42;0" dur="6s" repeatCount="indefinite" />
          </ellipse>
          <ellipse
            cx="210"
            cy="158"
            rx="74"
            ry="16"
            className="fill-none stroke-teal-200/14 stroke-[0.65] motion-reduce:hidden"
          >
            <animate
              attributeName="rx"
              values="68;118"
              dur="6s"
              begin="-3s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="ry"
              values="14;28"
              dur="6s"
              begin="-3s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.32;0"
              dur="6s"
              begin="-3s"
              repeatCount="indefinite"
            />
          </ellipse>
        </svg>
        <ProductMascotMotion
          src="./tietiezhi-sprite/poster.png"
          blinkSrc="./tietiezhi-sprite/closed-poster.png"
          variant="tietiezhi"
          intensity="stage"
          className="absolute top-1/2 left-1/2 size-40 -translate-x-1/2 -translate-y-1/2"
        />
        <TietiezhiOrbitTokens />
      </div>
    );
  }

  const create = variant === "create";
  const src = create
    ? "./mode-mascots/paper-plane/create.png"
    : "./mode-mascots/paper-plane/code.png";
  const blinkSrc = create
    ? "./mode-mascots/paper-plane/create-blink.png"
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
