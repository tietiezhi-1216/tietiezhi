import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import type { ProductArea } from "@/App";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getProductArea,
  PRODUCT_AREAS,
  type ProductAreaDefinition,
} from "@/lib/product-area";
import { cn } from "@/lib/utils";

export function ProductSwitcher({
  area,
  onSwitch,
  variant = "header",
  compact = false,
}: {
  area: ProductArea;
  onSwitch: (area: ProductArea) => void;
  variant?: "header" | "sidebar";
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const activeArea = getProductArea(area);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`当前功能分区：${activeArea.name}，点击切换`}
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-md text-left outline-none transition-[color,background-color,transform] active:translate-y-px [-webkit-app-region:no-drag]",
            compact && "gap-1.5",
            variant === "sidebar"
              ? "h-10 w-full px-2 hover:bg-sidebar-accent/70 data-[state=open]:bg-sidebar-accent/70"
              : "h-8 max-w-full px-1.5 hover:bg-accent data-[state=open]:bg-accent/70",
          )}
        >
          <img
            src={activeArea.mascotSrc}
            alt=""
            decoding="async"
            draggable={false}
            className={cn(
              "size-7 shrink-0 object-contain",
              compact && "hidden",
              variant === "sidebar" && "@max-[255px]/sidebar:hidden",
            )}
          />
          <ProductAreaTitle
            area={activeArea}
            sweep
            className="min-w-0 flex-1 truncate text-sm font-semibold"
          />
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "text-muted-foreground size-3.5 shrink-0 transition-[rotate,color] duration-200",
              variant === "sidebar" && "@max-[215px]/sidebar:hidden",
              open && "text-foreground rotate-180",
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={variant === "sidebar" ? "end" : "start"}
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          "max-w-[calc(100vw-1rem)] p-1 shadow-none",
          variant === "sidebar"
            ? "w-[min(16rem,calc(var(--radix-dropdown-menu-trigger-width)+5.5rem))]"
            : "w-64",
        )}
      >
        {PRODUCT_AREAS.map((item) => {
          const selected = item.id === area;
          return (
            <DropdownMenuItem
              key={item.id}
              aria-current={selected ? "true" : undefined}
              onSelect={() => onSwitch(item.id)}
              className={cn(
                "min-h-12 cursor-pointer gap-3 px-2 py-1.5",
                selected && "bg-accent",
              )}
            >
              <img
                src={item.mascotSrc}
                alt=""
                decoding="async"
                draggable={false}
                className="size-7 shrink-0 object-contain"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <ProductAreaTitle
                  area={item}
                  sweep={selected}
                  className="min-w-0 truncate text-sm font-semibold"
                />
                <span className="text-muted-foreground truncate text-xs">
                  {item.description}
                </span>
              </span>
              <Check
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0 transition-[opacity,transform] duration-200",
                  selected ? "scale-100 opacity-100" : "scale-75 opacity-0",
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProductAreaTitle({
  area,
  sweep,
  className,
}: {
  area: ProductAreaDefinition;
  sweep: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative grid whitespace-nowrap", className)}>
      <span
        className={cn(
          "col-start-1 row-start-1 bg-linear-to-r bg-clip-text text-transparent",
          area.gradientClassName,
        )}
      >
        {area.name}
      </span>
      {sweep && (
        <span
          aria-hidden="true"
          className="animate-model-label-sweep pointer-events-none col-start-1 row-start-1 text-white/90 [mask-image:linear-gradient(90deg,transparent,black_42%,black_58%,transparent)] [mask-repeat:no-repeat] [mask-size:52%_100%] motion-reduce:hidden"
        >
          {area.name}
        </span>
      )}
    </span>
  );
}
