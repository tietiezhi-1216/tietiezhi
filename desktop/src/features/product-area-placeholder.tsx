import { Cable, ImagePlus, Sparkles } from "lucide-react";
import { ProductMascotMotion } from "@/components/product-mascot-motion";
import type { ProductArea } from "@/lib/product-area";
import { getProductArea } from "@/lib/product-area";
import { cn } from "@/lib/utils";

const CONTENT: Record<Exclude<ProductArea, "workspace" | "tietiezhi" | "cores">, {
  eyebrow: string;
  title: string;
  description: string;
  icon: typeof Sparkles;
}> = {
  automations: {
    eyebrow: "自由编排",
    title: "让工作自己流动",
    description: "连接模型、工具和设备，用触发器、审批与运行记录搭建工作流。",
    icon: Cable,
  },
  create: {
    eyebrow: "多媒体生成",
    title: "把想法变成作品",
    description: "图片、视频、音频和其它创意资产将在统一生成空间中组织与迭代。",
    icon: ImagePlus,
  },
};

export function ProductAreaPlaceholder({
  area,
}: {
  area: Exclude<ProductArea, "workspace" | "tietiezhi" | "cores">;
}) {
  const definition = getProductArea(area);
  const content = CONTENT[area];
  const Icon = content.icon;

  return (
    <main className="relative grid h-full place-items-center overflow-hidden px-6">
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,color-mix(in_oklab,var(--color-cyan-400)_10%,transparent),transparent_42%)]"
      />
      <section className="relative flex max-w-xl flex-col items-center text-center">
        <div className="relative mb-6 grid size-24 place-items-center">
          <div
            className={cn(
              "absolute inset-2 rounded-full bg-linear-to-br opacity-25 blur-2xl",
              definition.gradientClassName,
            )}
          />
          <ProductMascotMotion
            src={definition.mascotSrc}
            blinkSrc={definition.blinkMascotSrc}
            variant={area}
            intensity="stage"
            className="relative size-24 drop-shadow-xl"
          />
        </div>
        <p className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium tracking-[0.18em] uppercase">
          <Icon className="size-3.5" />
          {content.eyebrow}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{content.title}</h1>
        <p className="text-muted-foreground mt-3 max-w-md text-sm leading-6">
          {content.description}
        </p>
        <span className="bg-muted text-muted-foreground mt-6 rounded-full border px-3 py-1 text-xs">
          功能入口已就位
        </span>
      </section>
    </main>
  );
}
