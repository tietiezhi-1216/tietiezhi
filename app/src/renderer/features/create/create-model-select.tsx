import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Clapperboard,
  Image as ImageIcon,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { mediaModelCapabilities } from "@shared/media-model-capabilities";
import type { MediaType } from "@shared/contracts";

import type { CreateProvider } from "./create-types";

const VENDOR_ORDER = ["agnes", "google", "openai", "other"] as const;

export function CreateModelSelect({
  mode,
  providers,
  providerId,
  model,
  onSelect,
}: {
  mode: MediaType;
  providers: CreateProvider[];
  providerId: string;
  model: string;
  onSelect: (providerId: string, model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeProviderId, setActiveProviderId] = useState(providerId);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const activeProvider =
    providers.find((provider) => provider.id === activeProviderId) ??
    selectedProvider ??
    providers[0];
  const hasMultipleProviders = providers.length > 1;
  const groups = useMemo(() => {
    if (!activeProvider) return [];
    const models =
      mode === "video" ? activeProvider.videoModels : activeProvider.imageModels;
    const grouped = new Map<
      string,
      { label: string; models: string[] }
    >();
    for (const candidate of models) {
      const capability = mediaModelCapabilities(candidate, mode);
      const current = grouped.get(capability.vendorId);
      grouped.set(capability.vendorId, {
        label: capability.vendorLabel,
        models: [...(current?.models ?? []), candidate],
      });
    }
    const query = search.trim().toLowerCase();
    return VENDOR_ORDER.flatMap((vendorId) => {
      const group = grouped.get(vendorId);
      if (!group) return [];
      const filtered = group.models.filter((candidate) =>
        `${group.label} ${candidate}`.toLowerCase().includes(query),
      );
      return filtered.length > 0
        ? [{ id: vendorId, label: group.label, models: filtered }]
        : [];
    });
  }, [activeProvider, mode, search]);

  if (providers.length === 0) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled
        className="h-8 text-xs text-muted-foreground"
      >
        暂无可用{mode === "video" ? "视频" : "图片"}模型
      </Button>
    );
  }

  const modelLabel =
    hasMultipleProviders && selectedProvider
      ? `${selectedProvider.builtIn ? "tietiezhi" : selectedProvider.displayName} · ${model}`
      : model || "选择模型";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        setSearch("");
        if (nextOpen) {
          setActiveProviderId(selectedProvider?.id ?? providers[0]?.id ?? "");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={modelLabel}
          className="h-8 max-w-64 min-w-0 gap-1.5 bg-muted/70 px-2.5 text-xs text-foreground hover:bg-muted"
        >
          {mode === "video" ? (
            <Clapperboard className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{modelLabel}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "dark block max-h-[min(36rem,calc(100vh-4rem))] gap-0 overflow-hidden bg-popover p-0 text-popover-foreground",
          hasMultipleProviders
            ? "w-[min(34rem,calc(100vw-2rem))] sm:max-w-[34rem]"
            : "w-[min(25rem,calc(100vw-2rem))] sm:max-w-[25rem]",
        )}
      >
        <DialogTitle className="sr-only">
          选择{mode === "video" ? "视频" : "图片"}模型
        </DialogTitle>
        <div className="flex min-h-0">
          {hasMultipleProviders && (
            <aside className="w-36 shrink-0 border-r border-border/60 p-2">
              <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                渠道
              </p>
              <nav className="flex max-h-96 flex-col gap-0.5 overflow-y-auto">
                {providers.map((provider) => {
                  const models =
                    mode === "video"
                      ? provider.videoModels
                      : provider.imageModels;
                  const active = provider.id === activeProvider?.id;
                  return (
                    <Button
                      key={provider.id}
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setActiveProviderId(provider.id);
                        setSearch("");
                      }}
                      className={cn(
                        "h-auto w-full min-w-0 justify-between px-2 py-2 font-normal",
                        active && "bg-muted text-foreground",
                      )}
                    >
                      <span className="truncate">
                        {provider.builtIn ? "tietiezhi" : provider.displayName}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {models.length}
                      </span>
                    </Button>
                  );
                })}
              </nav>
            </aside>
          )}
          <Command shouldFilter={false} className="min-w-0 flex-1 rounded-none">
            <div className="border-b p-1">
              <CommandInput
                value={search}
                onValueChange={setSearch}
                placeholder="搜索模型…"
                autoFocus
              />
            </div>
            <CommandList className="max-h-96 px-1 py-2">
              <CommandEmpty>没有找到匹配的模型</CommandEmpty>
              {groups.map((group) => (
                <CommandGroup key={group.id} heading={group.label}>
                  {group.models.map((candidate) => {
                    if (!activeProvider) return null;
                    const selected =
                      activeProvider.id === providerId && candidate === model;
                    return (
                      <CommandItem
                        key={`${activeProvider.id}:${candidate}`}
                        value={`${group.label} ${candidate}`}
                        onSelect={() => {
                          onSelect(activeProvider.id, candidate);
                          setOpen(false);
                        }}
                        className="py-2 [&>svg:last-child]:hidden"
                      >
                        <span
                          className={cn(
                            "min-w-0 flex-1 break-all font-mono text-xs",
                            selected &&
                              "font-semibold text-cyan-700 dark:text-cyan-200",
                          )}
                        >
                          {candidate}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                          {activeProvider.builtIn && (
                            <Sparkles
                              aria-label="内置渠道"
                              className="size-3.5"
                            />
                          )}
                          {selected && <Check className="size-3.5 text-cyan-600" />}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </div>
      </DialogContent>
    </Dialog>
  );
}
