import { useMemo, useState } from "react";
import {
  Bot,
  Boxes,
  BrainCircuit,
  Check,
  ChevronDown,
  Eye,
  Sparkles,
  Wrench,
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
import { chatModels, modelCapabilities } from "@/lib/model-capabilities";
import { cn } from "@/lib/utils";
import type { ProviderAccount } from "@shared/contracts";

interface ModelFamily {
  id: string;
  label: string;
  matches: (model: string) => boolean;
}

const MODEL_FAMILIES: ModelFamily[] = [
  { id: "claude", label: "Claude", matches: (model) => /^claude(?:[-_.]|$)/.test(model) },
  { id: "codex", label: "Codex", matches: (model) => /(?:^|[-_.])codex(?:[-_.]|$)/.test(model) },
  { id: "gpt", label: "GPT / OpenAI", matches: (model) => /^(?:gpt|chatgpt|o[134])(?:[-_.]|$)/.test(model) },
  { id: "gemini", label: "Gemini", matches: (model) => /^gemini(?:[-_.]|$)/.test(model) },
  { id: "deepseek", label: "DeepSeek", matches: (model) => /^deepseek(?:[-_.]|$)/.test(model) },
  { id: "qwen", label: "Qwen", matches: (model) => /^(?:qwen|qwq)(?:[-_.]|$)/.test(model) },
  { id: "kimi", label: "Kimi", matches: (model) => /^(?:kimi|moonshot)(?:[-_.]|$)/.test(model) },
  { id: "grok", label: "Grok", matches: (model) => /^grok(?:[-_.]|$)/.test(model) },
  { id: "llama", label: "Llama", matches: (model) => /^llama(?:[-_.]|$)/.test(model) },
];

const OTHER_FAMILY: ModelFamily = {
  id: "other",
  label: "其他模型",
  matches: () => true,
};

function familyFor(model: string): ModelFamily {
  const normalized = model.trim().toLowerCase();
  return MODEL_FAMILIES.find((family) => family.matches(normalized)) ?? OTHER_FAMILY;
}

function ModelCapabilityIcons({
  model,
  metadata,
  builtIn,
  selected,
}: {
  model: string;
  metadata: ProviderAccount["modelMetadata"][string] | undefined;
  builtIn: boolean;
  selected: boolean;
}) {
  const capabilities = modelCapabilities(model, metadata);
  const multimodal = capabilities.inputModalities.some((item) => item !== "text");
  const efforts = capabilities.reasoningEfforts?.join(" / ");
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-1.5">
      {multimodal && (
        <Eye
          aria-label="支持多模态输入"
          className="size-3.5"
        >
          <title>{`支持输入：${capabilities.inputModalities.join("、")}`}</title>
        </Eye>
      )}
      {capabilities.toolCall && (
        <Wrench aria-label="支持工具调用" className="size-3.5">
          <title>支持工具调用</title>
        </Wrench>
      )}
      {capabilities.reasoning && (
        <BrainCircuit aria-label="支持思考" className="size-3.5">
          <title>{efforts ? `支持思考，等级：${efforts}` : "支持思考"}</title>
        </BrainCircuit>
      )}
      {builtIn && <Sparkles aria-label="内置渠道" className="size-3.5" />}
      {selected && <Check className="size-3.5 text-cyan-600" />}
    </span>
  );
}

export function WorkspaceModelSelect({
  providers,
  providerId,
  model,
  prominent = false,
  onSelect,
  onOpenSettings,
}: {
  providers: ProviderAccount[];
  providerId: string;
  model: string;
  prominent?: boolean;
  onSelect: (providerId: string, model: string) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeProviderId, setActiveProviderId] = useState(providerId);
  const chatProviders = useMemo(
    () =>
      providers
        .map((provider) => ({
          provider,
          models: chatModels(provider.models).sort((left, right) =>
            left.localeCompare(right, "en", { numeric: true }),
          ),
        }))
        .filter((entry) => entry.models.length > 0),
    [providers],
  );
  const selectedProvider = chatProviders.find((entry) => entry.provider.id === providerId);
  const activeProvider =
    chatProviders.find((entry) => entry.provider.id === activeProviderId) ??
    selectedProvider ??
    chatProviders[0];
  const hasMultipleProviders = chatProviders.length > 1;
  const groups = useMemo(() => {
    if (!activeProvider) return [];
    const grouped = new Map<string, string[]>();
    for (const candidate of activeProvider.models) {
      const family = familyFor(candidate);
      grouped.set(family.id, [...(grouped.get(family.id) ?? []), candidate]);
    }
    const query = search.trim().toLowerCase();
    return [...MODEL_FAMILIES, OTHER_FAMILY].flatMap((family) => {
      const models = (grouped.get(family.id) ?? []).filter((candidate) =>
        `${family.label} ${candidate}`.toLowerCase().includes(query),
      );
      return models.length > 0 ? [{ family, models }] : [];
    });
  }, [activeProvider, search]);

  if (chatProviders.length === 0) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          "text-muted-foreground hover:text-foreground",
          prominent ? "h-auto px-0 text-sm" : "h-7 px-2 text-xs",
        )}
        onClick={onOpenSettings}
      >
        去添加供应商和模型
      </Button>
    );
  }

  const modelLabel = model
    ? hasMultipleProviders && selectedProvider
      ? `${selectedProvider.provider.builtIn ? "tietiezhi" : selectedProvider.provider.displayName} · ${model}`
      : model
    : "选择模型";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        setSearch("");
        if (nextOpen) {
          setActiveProviderId(selectedProvider?.provider.id ?? chatProviders[0]?.provider.id ?? "");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={modelLabel}
          className={cn(
            "text-muted-foreground hover:text-foreground min-w-0 gap-1.5",
            prominent
              ? "group h-auto max-w-[min(38rem,calc(100vw-3rem))] bg-transparent px-0 py-1 text-lg font-semibold hover:bg-transparent"
              : "h-7 max-w-64 shrink-0 px-2 text-xs",
          )}
        >
          {prominent ? (
            <span className="relative truncate text-foreground/90">
              选择和铁铁汁一起探索世界的方式
              <span
                aria-hidden
                className="animate-model-label-sweep pointer-events-none absolute inset-0 text-cyan-600 [mask-image:linear-gradient(90deg,transparent,black_42%,black_58%,transparent)] [mask-repeat:no-repeat] [mask-size:52%_100%] motion-reduce:hidden dark:text-cyan-200"
              >
                选择和铁铁汁一起探索世界的方式
              </span>
            </span>
          ) : (
            <>
              <span className="truncate">{modelLabel}</span>
              <ChevronDown className="size-3 shrink-0" />
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "block max-h-[min(36rem,calc(100vh-4rem))] gap-0 overflow-hidden p-0",
          hasMultipleProviders
            ? "w-[min(34rem,calc(100vw-2rem))] sm:max-w-[34rem]"
            : "w-[min(25rem,calc(100vw-2rem))] sm:max-w-[25rem]",
        )}
      >
        <DialogTitle className="sr-only">选择聊天模型</DialogTitle>
        <div className="flex min-h-0">
          {hasMultipleProviders && (
            <aside className="border-border/60 w-36 shrink-0 border-r p-2">
              <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium">渠道</p>
              <nav className="flex max-h-96 flex-col gap-0.5 overflow-y-auto">
                {chatProviders.map((entry) => {
                  const active = entry.provider.id === activeProvider?.provider.id;
                  return (
                    <Button
                      key={entry.provider.id}
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setActiveProviderId(entry.provider.id);
                        setSearch("");
                      }}
                      className={cn(
                        "h-auto w-full min-w-0 justify-between px-2 py-2 font-normal",
                        active && "bg-muted text-foreground",
                      )}
                    >
                      <span className="truncate">
                        {entry.provider.builtIn ? "tietiezhi" : entry.provider.displayName}
                      </span>
                      <span className="text-muted-foreground text-[10px]">{entry.models.length}</span>
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
                <CommandGroup
                  key={group.family.id}
                  heading={
                    <span className="flex items-center gap-1.5">
                      {group.family.id === "other" ? (
                        <Boxes className="size-3.5" />
                      ) : (
                        <Bot className="size-3.5" />
                      )}
                      {group.family.label}
                    </span>
                  }
                >
                  {group.models.map((candidate) => {
                    if (!activeProvider) return null;
                    const selected =
                      activeProvider.provider.id === providerId && candidate === model;
                    const metadata = activeProvider.provider.modelMetadata[candidate];
                    return (
                      <CommandItem
                        key={`${activeProvider.provider.id}:${candidate}`}
                        value={`${activeProvider.provider.displayName} ${candidate}`}
                        onSelect={() => {
                          onSelect(activeProvider.provider.id, candidate);
                          setOpen(false);
                        }}
                        className="py-2 [&>svg:last-child]:hidden"
                      >
                        <span
                          className={cn(
                            "min-w-0 flex-1 break-all font-mono text-xs",
                            selected && "font-semibold text-cyan-700 dark:text-cyan-200",
                          )}
                        >
                          {candidate}
                        </span>
                        <ModelCapabilityIcons
                          model={candidate}
                          metadata={metadata}
                          builtIn={activeProvider.provider.builtIn}
                          selected={selected}
                        />
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
