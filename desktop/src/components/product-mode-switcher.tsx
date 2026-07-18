import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PRODUCT_MODES, getProductMode } from "@/lib/product-mode";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";

export function ProductModeSwitcher() {
  const productMode = useUiStore((state) => state.productMode);
  const setProductMode = useUiStore((state) => state.setProductMode);
  const [open, setOpen] = useState(false);
  const activeMode = getProductMode(productMode);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`当前功能分区：${activeMode.name}，点击切换`}
          className={cn(
            "group/mode-trigger flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left",
            "hover:bg-sidebar-accent/70 focus-visible:ring-sidebar-ring transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none",
          )}
        >
          <span className="relative size-7 shrink-0" aria-hidden="true">
            {PRODUCT_MODES.map((mode) => (
              <img
                key={mode.id}
                src={mode.mascotSrc}
                alt=""
                draggable={false}
                className={cn(
                  "absolute inset-0 size-7 object-contain transition-[opacity,transform,filter] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                  mode.id === productMode
                    ? "scale-100 rotate-0 opacity-100 drop-shadow-[0_0_8px_rgba(56,189,248,0.16)]"
                    : "pointer-events-none scale-75 -rotate-6 opacity-0",
                )}
              />
            ))}
          </span>

          <span className="relative h-5 min-w-0 flex-1 overflow-hidden">
            {PRODUCT_MODES.map((mode) => (
              <span
                key={mode.id}
                aria-hidden={mode.id !== productMode}
                className={cn(
                  "absolute inset-0 truncate bg-linear-to-r bg-size-[200%_100%] bg-clip-text text-sm leading-5 font-semibold tracking-[0.035em] text-transparent",
                  "transition-[opacity,transform,background-position] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                  mode.gradientClassName,
                  mode.id === productMode
                    ? "translate-y-0 bg-position-[100%_0] opacity-100"
                    : "translate-y-1 bg-position-[0_0] opacity-0",
                )}
              >
                {mode.name}
              </span>
            ))}
          </span>

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
        className="mode-menu-content p-1.5"
      >
        {PRODUCT_MODES.map((mode) => {
          const selected = mode.id === productMode;
          return (
            <DropdownMenuItem
              key={mode.id}
              aria-current={selected ? "true" : undefined}
              onSelect={() => setProductMode(mode.id)}
              className={cn(
                "group/mode-item min-h-14 cursor-pointer gap-3 rounded-lg px-2.5 py-2",
                "transition-colors duration-150",
                selected && mode.selectedSurfaceClassName,
              )}
            >
              <span className="relative grid size-9 shrink-0 place-items-center" aria-hidden="true">
                <span
                  className={cn(
                    "absolute inset-1 rounded-full opacity-0 blur-md",
                    selected && "opacity-25",
                    mode.id === "work" && "bg-cyan-400",
                    mode.id === "code" && "bg-violet-400",
                    mode.id === "automations" && "bg-orange-400",
                    mode.id === "create" && "bg-fuchsia-400",
                  )}
                />
                <img
                  src={mode.mascotSrc}
                  alt=""
                  draggable={false}
                  className="relative size-9 object-contain"
                />
              </span>

              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className={cn(
                    "w-fit bg-linear-to-r bg-clip-text text-sm font-semibold tracking-[0.035em] text-transparent",
                    mode.gradientClassName,
                  )}
                >
                  {mode.name}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {mode.description}
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
