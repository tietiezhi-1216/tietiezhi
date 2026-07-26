import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import claudeIcon from "@lobehub/icons-static-svg/icons/claude-color.svg?raw";
import codexIcon from "@lobehub/icons-static-svg/icons/codex-color.svg?raw";
import deepseekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg?raw";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg?raw";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import metaIcon from "@lobehub/icons-static-svg/icons/meta-color.svg?raw";
import openaiIcon from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import qwenIcon from "@lobehub/icons-static-svg/icons/qwen-color.svg?raw";
import sensenovaIcon from "@lobehub/icons-static-svg/icons/sensenova-color.svg?raw";
import xaiIcon from "@lobehub/icons-static-svg/icons/xai.svg?raw";
import xiaomiMimoIcon from "@lobehub/icons-static-svg/icons/xiaomimimo.svg?raw";
import {
  Bot,
  Boxes,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  ImageIcon,
  Wrench,
} from "lucide-react";
import agnesIcon from "./agnes.svg?raw";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { saveSettings } from "@/lib/api";
import type { AppSettings, ModelInfo, ReasoningEffort } from "@/lib/api";
import {
  effectiveModelKind,
  modelHasCapability,
  modelInputModalities,
  modelReasoning,
} from "@/lib/model-capabilities";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";

interface ChatProvider {
  id: string;
  name: string;
  builtIn: boolean;
  models: ModelInfo[];
}

interface ModelFamily {
  id: string;
  label: string;
  icon?: string;
  matches: (modelId: string) => boolean;
}

interface ModelGroup {
  key: string;
  providerId: string;
  providerName: string;
  family: ModelFamily;
  models: ModelInfo[];
}

interface ModelSelectProps {
  prominent?: boolean;
  promptText?: string;
  settings?: AppSettings;
  lockedSelection?: { providerId: string; model: string };
  /** Reasoning effort forced by the active agent — shown read-only when set. */
  effortOverride?: ReasoningEffort;
}

// Family rules affect presentation only. The untouched model id is always sent
// back to the provider, so newly introduced names remain compatible.
const MODEL_FAMILIES: ModelFamily[] = [
  {
    id: "claude",
    label: "Claude",
    icon: claudeIcon,
    matches: (id) => /^claude(?:[-_.]|$)/.test(id),
  },
  {
    id: "codex",
    label: "Codex",
    icon: codexIcon,
    matches: (id) => /(?:^|[-_.])codex(?:[-_.]|$)/.test(id),
  },
  {
    id: "gpt",
    label: "GPT / OpenAI",
    icon: openaiIcon,
    matches: (id) => /^(?:gpt|chatgpt|o[134])(?:[-_.]|$)/.test(id),
  },
  {
    id: "gemini",
    label: "Gemini",
    icon: geminiIcon,
    matches: (id) => /^gemini(?:[-_.]|$)/.test(id),
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    icon: deepseekIcon,
    matches: (id) => /^deepseek(?:[-_.]|$)/.test(id),
  },
  {
    id: "qwen",
    label: "Qwen / QwQ",
    icon: qwenIcon,
    matches: (id) => /^(?:qwen|qwq)(?:[-_.]|$)/.test(id),
  },
  {
    id: "kimi",
    label: "Kimi / Moonshot",
    icon: kimiIcon,
    matches: (id) => /^(?:kimi|moonshot)(?:[-_.]|$)/.test(id),
  },
  {
    id: "grok",
    label: "Grok",
    icon: xaiIcon,
    matches: (id) => /^grok(?:[-_.]|$)/.test(id),
  },
  {
    id: "llama",
    label: "Llama",
    icon: metaIcon,
    matches: (id) => /^llama(?:[-_.]|$)/.test(id),
  },
  {
    id: "mimo",
    label: "MiMo",
    icon: xiaomiMimoIcon,
    matches: (id) => /^mimo(?:[-_.]|$)/.test(id),
  },
  {
    id: "agnes",
    label: "Agnes",
    icon: agnesIcon,
    matches: (id) => /^agnes(?:[-_.]|$)/.test(id),
  },
  {
    id: "sensenova",
    label: "SenseNova",
    icon: sensenovaIcon,
    matches: (id) => /^sensenova(?:[-_.]|$)/.test(id),
  },
];

const OTHER_FAMILY: ModelFamily = {
  id: "other",
  label: "其他模型",
  matches: () => true,
};

function familyFor(modelId: string): ModelFamily {
  const normalized = modelId.trim().toLowerCase();
  return MODEL_FAMILIES.find((family) => family.matches(normalized)) ?? OTHER_FAMILY;
}

function providerLabel(provider: ChatProvider): string {
  return provider.builtIn ? "tietiezhi" : provider.name;
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  auto: "auto",
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** Efforts a model lets the user pick, "auto" first; empty when not selectable. */
function selectableEfforts(model: ModelInfo): ReasoningEffort[] {
  const reasoning = modelReasoning(model);
  if (!reasoning || reasoning.mode !== "effort") return [];
  return ["auto", ...reasoning.supportedEfforts.filter((effort) => effort !== "auto")];
}

function ModelFamilyIcon({ family }: { family: ModelFamily }) {
  if (family.icon) {
    return (
      <span
        aria-hidden
        className="flex size-3.5 shrink-0 items-center justify-center text-foreground [&_svg]:size-3.5"
        dangerouslySetInnerHTML={{ __html: family.icon }}
      />
    );
  }

  return family.id === "other" ? (
    <Boxes aria-hidden className="size-3.5 shrink-0" />
  ) : (
    <Bot aria-hidden className="size-3.5 shrink-0" />
  );
}

/** Searchable chat model picker grouped by provider and model family. */
export function ModelSelect({
  prominent = false,
  promptText,
  settings,
  lockedSelection,
  effortOverride,
}: ModelSelectProps) {
  const queryClient = useQueryClient();
  const openSettings = useUiStore((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeProviderId, setActiveProviderId] = useState("");
  const currentProviderId = lockedSelection?.providerId ?? settings?.chatProviderId ?? "";
  const currentModel = lockedSelection?.model ?? settings?.chatModel ?? "";

  const save = useMutation({
    mutationFn: async ({ providerId, model }: { providerId: string; model: string }) => {
      if (!settings) return;
      await saveSettings({ ...settings, chatProviderId: providerId, chatModel: model });
    },
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  // Picking an effort from a model's hover submenu selects that model AND its
  // effort in one go, then closes the panel.
  const saveWithEffort = useMutation({
    mutationFn: async (next: { providerId: string; model: string; effort: ReasoningEffort }) => {
      if (!settings) return;
      await saveSettings({
        ...settings,
        chatProviderId: next.providerId,
        chatModel: next.model,
        chatReasoningEffort: next.effort,
      });
    },
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  // A relay catalog can also contain image, video, and ASR models. Only models
  // known to support chat belong in this picker.
  const chatProviders: ChatProvider[] = useMemo(
    () =>
      (settings?.providers ?? [])
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          builtIn: provider.builtIn,
          models: provider.models
            .filter((model) => effectiveModelKind(model) === "chat")
            .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })),
        }))
        .filter((provider) => provider.models.length > 0),
    [settings],
  );

  const groups = useMemo<ModelGroup[]>(
    () =>
      chatProviders.flatMap((provider) => {
        const grouped = new Map<string, ModelInfo[]>();
        provider.models.forEach((model) => {
          const family = familyFor(model.id);
          grouped.set(family.id, [...(grouped.get(family.id) ?? []), model]);
        });

        return [...MODEL_FAMILIES, OTHER_FAMILY].flatMap((family) => {
          const models = grouped.get(family.id);
          return models
            ? [{
                key: `${provider.id}:${family.id}`,
                providerId: provider.id,
                providerName: provider.name,
                family,
                models,
              }]
            : [];
        });
      }),
    [chatProviders],
  );

  const selectedProvider = chatProviders.find((provider) => provider.id === currentProviderId);
  const activeProvider =
    chatProviders.find((provider) => provider.id === activeProviderId) ??
    selectedProvider ??
    chatProviders[0];
  const hasMultipleProviders = chatProviders.length > 1;

  const visibleGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const providerGroups = hasMultipleProviders
      ? groups.filter((group) => group.providerId === activeProvider?.id)
      : groups;
    if (!query) return providerGroups;
    return providerGroups.flatMap((group) => {
      const groupText = `${group.providerName} ${group.family.label}`.toLowerCase();
      const models = group.models.filter((model) =>
        `${groupText} ${model.id}`.toLowerCase().includes(query),
      );
      return models.length > 0 ? [{ ...group, models }] : [];
    });
  }, [activeProvider?.id, groups, hasMultipleProviders, search]);

  if (!settings || chatProviders.length === 0) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          "text-muted-foreground hover:text-foreground px-2 text-xs",
          prominent
            ? "h-auto px-0 py-1 text-sm hover:bg-transparent focus-visible:ring-0"
            : "h-7",
        )}
        onClick={() => openSettings("providers")}
      >
        {(settings?.providers.length ?? 0) === 0 ? "去添加供应商" : "去获取模型"}
      </Button>
    );
  }

  const selectedModel = selectedProvider?.models.find((candidate) => candidate.id === currentModel);

  // The effort segment appended to the button label with a "·" separator.
  const effortForLabel = (model: ModelInfo): string | null => {
    const reasoning = modelReasoning(model);
    if (!reasoning) return null;
    if (effortOverride) return EFFORT_LABELS[effortOverride];
    if (reasoning.mode === "fixed") return "Fixed";
    const supported = selectableEfforts(model);
    const configured = settings.chatReasoningEffort ?? "auto";
    return EFFORT_LABELS[supported.includes(configured) ? configured : "auto"];
  };

  const modelText = selectedModel
    ? hasMultipleProviders && selectedProvider
      ? `${providerLabel(selectedProvider)} · ${selectedModel.id}`
      : selectedModel.id
    : lockedSelection
      ? `智能体模型不可用 · ${currentModel}`
    : "选择模型";
  const selectedEffort = selectedModel ? effortForLabel(selectedModel) : null;
  const label = selectedEffort ? `${modelText} · ${selectedEffort}` : modelText;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        setSearch("");
        if (nextOpen) {
          setActiveProviderId(selectedProvider?.id ?? chatProviders[0]?.id ?? "");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(lockedSelection) || save.isPending}
          title={
            lockedSelection
              ? "当前智能体已固定模型，请在智能体设置中修改"
              : label
          }
          aria-label={prominent ? promptText ?? "选择聊天模型" : undefined}
          className={cn(
            "text-muted-foreground hover:text-foreground min-w-0 gap-1 focus-visible:border-transparent focus-visible:ring-0 focus-visible:shadow-[0_5px_16px_rgba(52,129,140,0.17)] data-[state=open]:shadow-[0_5px_16px_rgba(52,129,140,0.17)] dark:focus-visible:shadow-[0_5px_18px_rgba(75,164,176,0.15)] dark:data-[state=open]:shadow-[0_5px_18px_rgba(75,164,176,0.15)]",
            prominent
              ? "group text-foreground h-auto max-w-[min(36rem,calc(100vw-2rem))] gap-0 bg-transparent px-0 py-1 text-lg font-semibold tracking-tight hover:!bg-transparent data-[state=open]:!bg-transparent"
              : "h-7 shrink-0 px-2 text-xs",
          )}
        >
          {prominent ? (
            <span className="relative truncate text-foreground/90 transition-colors group-hover:text-foreground">
              {promptText ?? "选择聊天模型"}
              <span
                aria-hidden
                className="animate-model-label-sweep absolute inset-0 text-cyan-600 [filter:drop-shadow(0_0_5px_color-mix(in_oklab,var(--color-cyan-400)_45%,transparent))] [mask-image:linear-gradient(90deg,transparent,black_42%,black_58%,transparent)] [mask-repeat:no-repeat] [mask-size:52%_100%] motion-reduce:hidden dark:text-cyan-200"
              >
                {promptText ?? "选择聊天模型"}
              </span>
            </span>
          ) : (
            <>
              <span className="whitespace-nowrap">{modelText}</span>
              {selectedEffort && (
                <>
                  <span aria-hidden className="shrink-0">·</span>
                  <span className="shrink-0 tabular-nums">{selectedEffort}</span>
                </>
              )}
              <ChevronDown className="size-3 shrink-0" />
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-label="选择聊天模型"
        showCloseButton={false}
        onInteractOutside={(event) => {
          // The effort hover submenu portals outside this popover. Keep the panel
          // open while it's used; selecting an effort closes it explicitly.
          const target = event.detail.originalEvent.target as Element | null;
          if (target?.closest("[data-slot='hover-card-content']")) event.preventDefault();
        }}
        className={cn(
          "block max-h-[min(36rem,calc(100vh-4rem))] gap-0 overflow-hidden p-0",
          hasMultipleProviders
            ? "w-[min(34rem,calc(100vw-2rem))] sm:max-w-[34rem]"
            : "w-[min(24rem,calc(100vw-2rem))] sm:max-w-[24rem]",
        )}
      >
        <DialogTitle className="sr-only">选择聊天模型</DialogTitle>
        <div className="flex min-h-0">
          {hasMultipleProviders && (
            <aside className="border-border/60 flex w-36 shrink-0 flex-col border-r p-2">
              <p className="text-muted-foreground px-2 py-1.5 text-xs font-medium">渠道</p>
              <nav
                aria-label="选择模型渠道"
                className="flex max-h-96 flex-col gap-0.5 overflow-y-auto"
              >
                {chatProviders.map((provider) => {
                  const active = provider.id === activeProvider?.id;
                  return (
                    <Button
                      key={provider.id}
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-current={active ? "true" : undefined}
                      onClick={() => {
                        setActiveProviderId(provider.id);
                        setSearch("");
                      }}
                      className={cn(
                        "h-auto w-full min-w-0 justify-between gap-1.5 px-2 py-2 font-normal",
                        active && "bg-muted text-foreground",
                      )}
                    >
                      <span className="truncate">{providerLabel(provider)}</span>
                      <span className="text-muted-foreground shrink-0 text-[0.65rem] tabular-nums">
                        {provider.models.length}
                      </span>
                    </Button>
                  );
                })}
              </nav>
            </aside>
          )}
          <Command label="选择聊天模型" shouldFilter={false} className="min-w-0 flex-1">
            <div className="bg-popover relative z-10 pb-1 shadow-lg shadow-black/25 dark:shadow-black/50">
              <CommandInput
                aria-label="搜索模型"
                autoFocus
                placeholder={
                  hasMultipleProviders && activeProvider
                    ? `搜索 ${providerLabel(activeProvider)} 的模型…`
                    : "搜索模型…"
                }
                value={search}
                onValueChange={setSearch}
              />
              <div
                aria-hidden
                className="from-popover via-popover/80 pointer-events-none absolute inset-x-0 top-full h-6 bg-linear-to-b to-transparent"
              />
            </div>
            <CommandList className="max-h-96 scroll-pt-4 px-1 pt-3 pb-1">
              {visibleGroups.length === 0 && (
                <p role="status" className="text-muted-foreground py-6 text-center text-sm">
                  没有找到匹配的聊天模型
                </p>
              )}
              {visibleGroups.map((group) => (
                <CommandGroup
                  key={group.key}
                  heading={
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ModelFamilyIcon family={group.family} />
                      <span className="truncate">{group.family.label}</span>
                    </span>
                  }
                  className="border-border/60 border-t first:border-t-0"
                >
                  {group.models.map((model) => {
                    const active =
                      group.providerId === currentProviderId && model.id === currentModel;
                    const efforts = selectableEfforts(model);
                    const canPickEffort =
                      !effortOverride && !lockedSelection && efforts.length > 0;
                    const configuredEffort = settings.chatReasoningEffort ?? "auto";
                    // Tick the live effort on the active model; nothing on others.
                    const markedEffort: ReasoningEffort | null = active
                      ? efforts.includes(configuredEffort)
                        ? configuredEffort
                        : "auto"
                      : null;
                    const reasoning = modelReasoning(model);
                    const visibleEffort = modelHasCapability(model, "reasoning")
                      ? active && effortOverride
                        ? EFFORT_LABELS[effortOverride]
                        : reasoning?.mode === "fixed"
                          ? "Fixed"
                          : EFFORT_LABELS[
                              markedEffort ?? reasoning?.defaultEffort ?? "auto"
                            ]
                      : null;
                    const item = (
                      <CommandItem
                        key={`${group.providerId}:${model.id}`}
                        value={`${group.providerName} ${group.family.label} ${model.id}`}
                        data-checked={active}
                        onSelect={() =>
                          save.mutate({ providerId: group.providerId, model: model.id })
                        }
                        className={cn(
                          "items-center py-2",
                          // Drop shadcn's always-reserved trailing check slot
                          // (opacity-0 but still occupies width) so the capability
                          // icons sit flush at the row's right padding.
                          "[&>svg:last-child]:hidden",
                          // Mark the active model with a soft octopus-cyan tint —
                          // lighter than a solid fill, with distinct light/dark hues.
                          // Important keeps it from reverting to the grey
                          // data-selected hover background.
                          "data-[checked=true]:bg-cyan-500/10! dark:data-[checked=true]:bg-cyan-400/15!",
                        )}
                      >
                        <span className="relative min-w-0 flex-1 whitespace-normal break-all font-mono text-xs leading-5 group-data-[checked=true]/command-item:font-semibold group-data-[checked=true]/command-item:text-cyan-700 dark:group-data-[checked=true]/command-item:text-cyan-200">
                          {model.id}
                          {/* Selected id gets a white glint sweeping across the
                              text — a masked duplicate, same trick as the prominent
                              model label. */}
                          {active && (
                            <span
                              aria-hidden
                              className="animate-model-label-sweep pointer-events-none absolute inset-0 text-white [filter:drop-shadow(0_0_5px_color-mix(in_oklab,white_55%,transparent))] [mask-image:linear-gradient(90deg,transparent,black_42%,black_58%,transparent)] [mask-repeat:no-repeat] [mask-size:52%_100%] motion-reduce:hidden"
                            >
                              {model.id}
                            </span>
                          )}
                        </span>
                        <span className="text-muted-foreground group-data-[checked=true]/command-item:text-cyan-600 dark:group-data-[checked=true]/command-item:text-cyan-300 flex shrink-0 items-center gap-1.5">
                          {visibleEffort && (
                            <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums group-data-[checked=true]/command-item:bg-cyan-500/10">
                              {visibleEffort}
                            </span>
                          )}
                          {modelInputModalities(model).includes("image") && (
                            <ImageIcon aria-label="支持图片输入" className="size-3.5" />
                          )}
                          {modelHasCapability(model, "tool-call") && (
                            <Wrench aria-label="支持工具和 MCP" className="size-3.5" />
                          )}
                          {/* Reasoning brain sits last; on hover of a pickable row it
                              turns into the trailing arrow that reveals the submenu. */}
                          {modelHasCapability(model, "reasoning") && (
                            <BrainCircuit
                              aria-label="支持思考"
                              className={cn(
                                "size-3.5",
                                canPickEffort && "group-hover/command-item:hidden",
                              )}
                            />
                          )}
                          {canPickEffort && (
                            <ChevronRight
                              aria-hidden
                              className="hidden size-3.5 text-cyan-600 group-hover/command-item:block dark:text-cyan-300"
                            />
                          )}
                        </span>
                      </CommandItem>
                    );

                    // Non-reasoning (or locked) models: plain row, no submenu.
                    if (!canPickEffort) return item;

                    // Reasoning models: hovering the row flies out an effort submenu
                    // on the right. Picking one selects that model + effort at once.
                    return (
                      <HoverCard
                        key={`${group.providerId}:${model.id}`}
                        openDelay={80}
                        closeDelay={140}
                      >
                        <HoverCardTrigger asChild>{item}</HoverCardTrigger>
                        <HoverCardContent
                          side="right"
                          align="start"
                          sideOffset={4}
                          className="w-32 p-1"
                        >
                          <p className="text-muted-foreground px-2 py-1 text-xs font-medium">
                            思考等级
                          </p>
                          {efforts.map((effort) => {
                            const current = effort === markedEffort;
                            return (
                              <button
                                key={effort}
                                type="button"
                                onClick={() =>
                                  saveWithEffort.mutate({
                                    providerId: group.providerId,
                                    model: model.id,
                                    effort,
                                  })
                                }
                                className={cn(
                                  "hover:bg-muted flex w-full items-center justify-between gap-1.5 rounded-md px-2 py-1.5 text-left text-sm",
                                  current && "text-cyan-700 dark:text-cyan-200",
                                )}
                              >
                                {EFFORT_LABELS[effort]}
                                {current && (
                                  <Check className="size-3.5 text-cyan-600 dark:text-cyan-300" />
                                )}
                              </button>
                            );
                          })}
                        </HoverCardContent>
                      </HoverCard>
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
