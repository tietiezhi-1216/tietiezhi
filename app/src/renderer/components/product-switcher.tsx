import { ChevronDown, Image, PanelsTopLeft } from "lucide-react";

import type { ProductArea } from "@/App";
import { cn } from "@/lib/utils";

export function ProductSwitcher({
  area,
  onSwitch,
}: {
  area: ProductArea;
  onSwitch: (area: ProductArea) => void;
}) {
  const target = area === "workspace" ? "create" : "workspace";
  return (
    <button
      type="button"
      className="group flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-white/6 [-webkit-app-region:no-drag]"
      onClick={() => onSwitch(target)}
      title={`切换到 ${target === "workspace" ? "Workspace" : "Create"}`}
    >
      <img src="./tietiezhi.png" alt="" className="size-6 shrink-0 rounded-md object-contain" />
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold">
          {area === "workspace" ? "Workspace" : "Create"}
        </span>
        <span className="flex items-center gap-1 text-[9px] text-white/30">
          {area === "workspace" ? (
            <PanelsTopLeft className="size-2.5" />
          ) : (
            <Image className="size-2.5" />
          )}
          Tietiezhi
        </span>
      </span>
      <ChevronDown className="ml-auto size-3 text-white/25 transition-transform group-hover:translate-y-0.5" />
    </button>
  );
}
