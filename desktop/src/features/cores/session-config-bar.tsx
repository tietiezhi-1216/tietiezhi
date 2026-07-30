import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { coreSessionConfig, coreSessionSetConfig, coreSessionSetMode } from "./api";
import { useCoresStore } from "./store";
import type { CoreConfigChoice, CoreConfigOption, CoreSessionConfig } from "./types";

/**
 * The session's switchable knobs, model picker first.
 *
 * Every core names and scopes these itself — Claude Code offers Claude models,
 * Gemini CLI offers Gemini models — so this switches models *within* the running
 * core rather than moving a model between cores. Cores that expose nothing
 * render nothing rather than a disabled shell.
 */
export function SessionConfigBar({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const config = useCoresStore((state) => state.sessions[sessionId]?.config ?? null);
  const setSessionConfig = useCoresStore((state) => state.setSessionConfig);
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load once per session; later changes arrive as stream events.
  useEffect(() => {
    if (config !== null) return;
    let cancelled = false;
    setLoading(true);
    void coreSessionConfig(sessionId)
      .then((loaded) => {
        if (cancelled) return;
        // An unsupported core still gets an empty record, so the effect does
        // not re-fire on every render.
        setSessionConfig(
          sessionId,
          loaded ?? { sessionId, coreId: "", options: [], currentModeId: null, modes: [] },
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, config, setSessionConfig]);

  const { model, others } = useMemo(() => split(config), [config]);

  if (loading && config === null) {
    return (
      <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
        <Loader2 className="size-3.5 animate-spin" />
        正在读取核心能力…
      </div>
    );
  }

  if (error !== null) {
    return (
      <p className={cn("text-xs text-destructive", className)} role="status">
        读取核心能力失败：{error}
      </p>
    );
  }

  const hasAnything = model !== null || others.length > 0 || (config?.modes.length ?? 0) > 0;
  if (!hasAnything) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        这个核心没有申报可切换的模型或模式。
      </p>
    );
  }

  const apply = async (optionId: string, value: string | boolean) => {
    setPendingId(optionId);
    setError(null);
    try {
      setSessionConfig(sessionId, await coreSessionSetConfig(sessionId, optionId, value));
    } catch (cause: unknown) {
      setError(String(cause));
    } finally {
      setPendingId(null);
    }
  };

  const applyMode = async (modeId: string) => {
    setPendingId("__mode__");
    setError(null);
    try {
      setSessionConfig(sessionId, await coreSessionSetMode(sessionId, modeId));
    } catch (cause: unknown) {
      setError(String(cause));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      {model !== null && (
        <ChoiceControl
          option={model}
          icon={<Sparkles className="size-3.5 shrink-0 text-muted-foreground" />}
          busy={pendingId === model.id}
          onChange={(value) => void apply(model.id, value)}
        />
      )}

      {config !== null && config.modes.length > 0 && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          模式
          <Select
            value={config.currentModeId ?? undefined}
            disabled={pendingId === "__mode__"}
            onValueChange={(value) => void applyMode(value)}
          >
            <SelectTrigger className="h-7 w-auto min-w-28 text-xs" size="sm">
              <SelectValue placeholder="选择模式" />
            </SelectTrigger>
            <SelectContent>
              {config.modes.map((mode) => (
                <SelectItem key={mode.id} value={mode.id} className="text-xs">
                  {mode.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}

      {others.map((option) =>
        option.kind === "boolean" ? (
          <label key={option.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              checked={option.currentValue === true}
              disabled={pendingId === option.id}
              onCheckedChange={(next) => void apply(option.id, next)}
            />
            {option.name}
          </label>
        ) : (
          <ChoiceControl
            key={option.id}
            option={option}
            busy={pendingId === option.id}
            onChange={(value) => void apply(option.id, value)}
          />
        ),
      )}

      {error !== null && (
        <span className="text-xs text-destructive" role="status">
          {error}
        </span>
      )}
    </div>
  );
}

function ChoiceControl({
  option,
  icon,
  busy,
  onChange,
}: {
  option: CoreConfigOption;
  icon?: React.ReactNode;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const groups = useMemo(() => groupChoices(option.choices), [option.choices]);
  const current = typeof option.currentValue === "string" ? option.currentValue : "";

  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {icon}
      <span className="sr-only">{option.name}</span>
      <Select value={current === "" ? undefined : current} disabled={busy} onValueChange={onChange}>
        <SelectTrigger
          className="h-7 w-auto min-w-36 text-xs"
          size="sm"
          title={option.description ?? option.name}
        >
          <SelectValue placeholder={option.name} />
        </SelectTrigger>
        <SelectContent>
          {groups.map(([group, choices]) =>
            group === null ? (
              choices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value} className="text-xs">
                  {choice.name}
                </SelectItem>
              ))
            ) : (
              <SelectGroup key={group}>
                <SelectLabel className="text-xs">{group}</SelectLabel>
                {choices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value} className="text-xs">
                    {choice.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ),
          )}
        </SelectContent>
      </Select>
      {busy && <Loader2 className="size-3.5 animate-spin" />}
    </label>
  );
}

/** The model selector is pulled out so it always leads the bar. */
function split(config: CoreSessionConfig | null): {
  model: CoreConfigOption | null;
  others: CoreConfigOption[];
} {
  if (config === null) return { model: null, others: [] };
  const model =
    config.options.find((option) => option.category === "model" && option.kind === "select") ?? null;
  return {
    model,
    others: config.options.filter((option) => option !== model),
  };
}

/** Preserves the core's grouping without the caller handling two shapes. */
function groupChoices(choices: CoreConfigChoice[]): Array<[string | null, CoreConfigChoice[]]> {
  const order: Array<string | null> = [];
  const buckets = new Map<string | null, CoreConfigChoice[]>();
  for (const choice of choices) {
    const key = choice.group;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)?.push(choice);
  }
  return order.map((key) => [key, buckets.get(key) ?? []]);
}
