import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VISIBLE_PRODUCT_AREAS, getProductArea } from "@/lib/product-area";
import type { ProductAreaDefinition } from "@/lib/product-area";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";

export function ProductAreaSwitcher({
  variant = "sidebar",
}: {
  variant?: "sidebar" | "header";
}) {
  const productArea = useUiStore((state) => state.productArea);
  const setProductArea = useUiStore((state) => state.setProductArea);
  const [open, setOpen] = useState(false);
  const activeArea = getProductArea(productArea);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`当前功能分区：${activeArea.name}，点击切换`}
          className={cn(
            "flex items-center gap-2 rounded-md text-left outline-none transition-[color,background-color,box-shadow,transform] focus-visible:ring-0 focus-visible:shadow-[0_5px_16px_rgba(52,129,140,0.17)] active:translate-y-px data-[state=open]:shadow-[0_5px_16px_rgba(52,129,140,0.17)] dark:focus-visible:shadow-[0_5px_18px_rgba(75,164,176,0.15)] dark:data-[state=open]:shadow-[0_5px_18px_rgba(75,164,176,0.15)]",
            variant === "sidebar"
              ? "h-10 w-full px-2 hover:bg-sidebar-accent/70 data-[state=open]:bg-sidebar-accent/70"
              : "h-8 min-w-0 max-w-full px-1.5 hover:bg-accent data-[state=open]:bg-accent/70",
          )}
        >
          <img
            src={activeArea.mascotSrc}
            alt=""
            decoding="async"
            draggable={false}
            className="size-7 shrink-0 object-contain"
          />
          <ProductAreaTitle
            area={activeArea}
            sweep
            className="flex-1 text-sm font-semibold"
          />

          <ChevronDown
            aria-hidden="true"
            className={cn(
              "text-muted-foreground size-3.5 transition-[rotate,color] duration-200 ease-out",
              open && "text-foreground rotate-180",
            )}
          />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-64 p-1"
      >
        {VISIBLE_PRODUCT_AREAS.map((area) => {
          const selected = area.id === productArea;
          return (
            <DropdownMenuItem
              key={area.id}
              aria-current={selected ? "true" : undefined}
              onSelect={() => setProductArea(area.id)}
              className={cn(
                "min-h-12 cursor-pointer gap-3 px-2 py-1.5",
                selected && "bg-accent",
              )}
            >
              <img
                src={area.mascotSrc}
                alt=""
                decoding="async"
                draggable={false}
                className="size-8 shrink-0 object-contain"
              />

              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <ProductAreaTitle
                  area={area}
                  sweep={selected}
                  className="text-sm font-semibold"
                />
                <span className="text-muted-foreground truncate text-xs">
                  {area.description}
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
    <span className={cn("relative grid min-w-0 whitespace-nowrap", className)}>
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
