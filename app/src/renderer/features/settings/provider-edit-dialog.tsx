import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AudioLines,
  Brain,
  ChevronDown,
  Eye,
  File,
  FileText,
  Image,
  Loader2,
  ListRestart,
  RotateCcw,
  Trash2,
  Video,
  Wrench,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { modelCapabilities } from "@/lib/model-capabilities";
import type {
  ModelMetadata,
  ModelMetadataOverrides,
  ModelModality,
  ProviderAccount,
  ProviderType,
} from "@shared/contracts";

interface VendorPreset {
  id: string;
  name: string;
  group: "recommended" | "domestic" | "international" | "local";
  providerType: ProviderType;
  baseURL: string;
}

/**
 * Vendor catalog: the adapter is an implementation detail derived from the
 * selected vendor and is never exposed as a second user choice.
 */
const DEFAULT_VENDOR_PRESET: VendorPreset = {
  id: "openai",
  name: "OpenAI",
  group: "recommended",
  providerType: "openai",
  baseURL: "https://api.openai.com/v1",
};

export const VENDOR_PRESETS: VendorPreset[] = [
  DEFAULT_VENDOR_PRESET,
  {
    id: "anthropic",
    name: "Anthropic",
    group: "recommended",
    providerType: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
  },
  {
    id: "google",
    name: "Google",
    group: "recommended",
    providerType: "google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    group: "recommended",
    providerType: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
  },
  { id: "moonshot", name: "月之暗面 Kimi", group: "domestic", providerType: "moonshotai", baseURL: "https://api.moonshot.cn/v1" },
  { id: "zhipu", name: "智谱 AI", group: "domestic", providerType: "zhipu", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "alibaba", name: "阿里云百炼", group: "domestic", providerType: "alibaba", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "minimax", name: "MiniMax", group: "domestic", providerType: "minimax", baseURL: "https://api.minimaxi.com/v1" },
  { id: "xai", name: "xAI", group: "international", providerType: "xai", baseURL: "https://api.x.ai/v1" },
  { id: "mistral", name: "Mistral AI", group: "international", providerType: "mistral", baseURL: "https://api.mistral.ai/v1" },
  { id: "groq", name: "Groq", group: "international", providerType: "groq", baseURL: "https://api.groq.com/openai/v1" },
  { id: "openrouter", name: "OpenRouter", group: "international", providerType: "openrouter", baseURL: "https://openrouter.ai/api/v1" },
  { id: "together", name: "Together AI", group: "international", providerType: "togetherai", baseURL: "https://api.together.xyz/v1" },
  { id: "cerebras", name: "Cerebras", group: "international", providerType: "cerebras", baseURL: "https://api.cerebras.ai/v1" },
  { id: "ollama", name: "Ollama（本地）", group: "local", providerType: "ollama", baseURL: "http://127.0.0.1:11434/api" },
];

const VENDOR_GROUPS = [
  { id: "recommended", label: "常用" },
  { id: "domestic", label: "国内厂商" },
  { id: "international", label: "海外厂商与模型平台" },
  { id: "local", label: "本地模型" },
] as const;

function sdkProviderPackage(type: ProviderType): string {
  switch (type) {
    case "openai": return "@ai-sdk/openai";
    case "anthropic": return "@ai-sdk/anthropic";
    case "google": return "@ai-sdk/google";
    case "deepseek": return "@ai-sdk/deepseek";
    case "moonshotai": return "@ai-sdk/moonshotai";
    case "zhipu": return "zhipu-ai-provider";
    case "alibaba": return "@ai-sdk/alibaba";
    case "minimax": return "vercel-minimax-ai-provider";
    case "xai": return "@ai-sdk/xai";
    case "mistral": return "@ai-sdk/mistral";
    case "groq": return "@ai-sdk/groq";
    case "openrouter": return "@openrouter/ai-sdk-provider";
    case "togetherai": return "@ai-sdk/togetherai";
    case "cerebras": return "@ai-sdk/cerebras";
    case "ollama": return "ollama-ai-provider-v2";
    case "openai-compatible": return "@ai-sdk/openai-compatible";
  }
}

const MODALITY_OPTIONS: Array<{
  value: ModelModality;
  label: string;
  icon: typeof FileText;
}> = [
  { value: "text", label: "文本", icon: FileText },
  { value: "image", label: "图片", icon: Image },
  { value: "audio", label: "音频", icon: AudioLines },
  { value: "video", label: "视频", icon: Video },
  { value: "file", label: "文件", icon: File },
];

const REASONING_EFFORT_OPTIONS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function matchingPresetId(provider: ProviderAccount): string {
  if (VENDOR_PRESETS.some((preset) => preset.id === provider.vendorId)) {
    return provider.vendorId;
  }
  const baseURL = provider.baseURL.replace(/\/+$/, "");
  const exactMatch = VENDOR_PRESETS.find(
    (preset) => preset.baseURL !== "" && preset.baseURL.replace(/\/+$/, "") === baseURL,
  );
  if (exactMatch) return exactMatch.id;
  if (provider.providerType !== "openai-compatible") {
    return VENDOR_PRESETS.find((preset) => preset.providerType === provider.providerType)?.id ?? "other";
  }
  return `legacy:${provider.id}`;
}

/** Compact capability badges for one model, shared by settings and pickers. */
export function ModelCapabilityBadges({
  model,
  metadata,
  detailed = false,
}: {
  model: string;
  metadata?: ModelMetadata;
  detailed?: boolean;
}) {
  const capabilities = modelCapabilities(model, metadata);
  const multimodal = capabilities.inputModalities.some((item) => item !== "text");
  const efforts = capabilities.reasoningEfforts?.join(" / ");
  return (
    <span className="inline-flex items-center gap-1">
      {multimodal && (
        <CapabilityBadge
          detailed={detailed}
          label="多模态"
          title={`支持输入：${capabilities.inputModalities.join("、")}`}
        >
          <Eye />
        </CapabilityBadge>
      )}
      {capabilities.toolCall && (
        <CapabilityBadge detailed={detailed} label="工具" title="支持工具调用">
          <Wrench />
        </CapabilityBadge>
      )}
      {capabilities.streaming && detailed && (
        <CapabilityBadge detailed={detailed} label="流式" title="支持流式输出">
          <Zap />
        </CapabilityBadge>
      )}
      {capabilities.reasoning && (
        <CapabilityBadge
          detailed={detailed}
          label="思考"
          title={efforts ? `支持思考，等级：${efforts}` : "支持思考"}
        >
          <Brain />
        </CapabilityBadge>
      )}
    </span>
  );
}

function CapabilityBadge({
  children,
  label,
  title,
  detailed,
}: {
  children: ReactNode;
  label: string;
  title: string;
  detailed: boolean;
}) {
  return (
    <Badge
      variant="secondary"
      title={title}
      className="text-muted-foreground gap-0.5 px-1 py-0 text-[10px] [&_svg]:size-2.5"
    >
      {children}
      {detailed && label}
    </Badge>
  );
}

function emptyMetadata(): ModelMetadata {
  return { wireAPIs: [], supportedParameters: [] };
}

function ModelRuleEditor({
  model,
  metadata,
  onChange,
}: {
  model: string;
  metadata?: ModelMetadata;
  onChange: (overrides: ModelMetadataOverrides | undefined) => void;
}) {
  const capabilities = modelCapabilities(model, metadata);
  const overrides = metadata?.overrides;
  const setOverrides = (patch: Partial<ModelMetadataOverrides>) => {
    onChange({ ...overrides, ...patch });
  };
  const toggleModality = (modality: ModelModality) => {
    const selected = capabilities.inputModalities.includes(modality);
    const inputModalities = selected
      ? capabilities.inputModalities.filter((item) => item !== modality)
      : [...capabilities.inputModalities, modality];
    setOverrides({ inputModalities });
  };
  const toggleEffort = (effort: string) => {
    const current = capabilities.reasoningEfforts ?? [];
    const reasoningEfforts = current.includes(effort)
      ? current.filter((item) => item !== effort)
      : [...current, effort];
    setOverrides({ reasoning: true, reasoningEfforts });
  };

  return (
    <div className="bg-muted/30 grid gap-3 border-t px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">
          {overrides ? "已手动调整" : "当前使用自动识别结果"}
        </span>
        {overrides && (
          <Button type="button" variant="ghost" size="xs" onClick={() => onChange(undefined)}>
            <RotateCcw /> 恢复自动识别
          </Button>
        )}
      </div>

      <div className="grid gap-1.5">
        <span className="text-xs font-medium">输入模态</span>
        <div className="flex flex-wrap gap-1.5">
          {MODALITY_OPTIONS.map((option) => {
            const active = capabilities.inputModalities.includes(option.value);
            const Icon = option.icon;
            return (
              <Button
                key={option.value}
                type="button"
                variant={active ? "secondary" : "outline"}
                size="xs"
                aria-pressed={active}
                onClick={() => toggleModality(option.value)}
              >
                <Icon /> {option.label}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-2">
        <CapabilitySwitch
          label="工具调用"
          description="关闭后运行时不会向该模型发送 Workspace 工具"
          checked={capabilities.toolCall}
          onCheckedChange={(toolCall) => setOverrides({ toolCall })}
        />
        <CapabilitySwitch
          label="思考能力"
          description="用于展示并应用该模型支持的思考等级"
          checked={capabilities.reasoning}
          onCheckedChange={(reasoning) => setOverrides({ reasoning })}
        />
      </div>

      {capabilities.reasoning && (
        <div className="grid gap-2 rounded-lg border bg-background/60 p-2.5">
          <span className="text-xs font-medium">支持的思考等级</span>
          <div className="flex flex-wrap gap-1.5">
            {REASONING_EFFORT_OPTIONS.map((effort) => {
              const active = capabilities.reasoningEfforts?.includes(effort) ?? false;
              return (
                <Button
                  key={effort}
                  type="button"
                  variant={active ? "secondary" : "outline"}
                  size="xs"
                  aria-pressed={active}
                  onClick={() => toggleEffort(effort)}
                >
                  {effort}
                </Button>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium">默认等级</span>
            <Select
              value={capabilities.defaultReasoningEffort ?? "auto"}
              onValueChange={(value) =>
                setOverrides({
                  defaultReasoningEffort: value === "auto" ? undefined : value,
                })
              }
            >
              <SelectTrigger size="sm" className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动</SelectItem>
                {(capabilities.reasoningEfforts ?? []).map((effort) => (
                  <SelectItem key={effort} value={effort}>{effort}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}

function CapabilitySwitch({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="grid gap-0.5">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-muted-foreground text-[11px]">{description}</span>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/**
 * Standalone add/edit dialog for a custom provider. Used from the settings
 * panel and mounted directly on the onboarding gate, so it must not assume
 * the settings dialog is open behind it.
 */
export function ProviderEditDialog({
  open,
  onOpenChange,
  provider,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Undefined creates a new provider. */
  provider?: ProviderAccount;
  onSaved: () => void;
}) {
  const [presetId, setPresetId] = useState(DEFAULT_VENDOR_PRESET.id);
  const [providerType, setProviderType] = useState<ProviderType>("openai-compatible");
  const [displayName, setDisplayName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [modelMetadata, setModelMetadata] =
    useState<Record<string, ModelMetadata>>({});
  const [editingModel, setEditingModel] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const apiKeyOptional =
    presetId === "ollama" || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/.test(baseURL);

  useEffect(() => {
    if (!open) return;
    if (provider === undefined) {
      setPresetId(DEFAULT_VENDOR_PRESET.id);
      setProviderType(DEFAULT_VENDOR_PRESET.providerType);
      setDisplayName(DEFAULT_VENDOR_PRESET.name);
      setBaseURL(DEFAULT_VENDOR_PRESET.baseURL);
      setModels("");
      setModelMetadata({});
    } else {
      const matchedPresetId = matchingPresetId(provider);
      const matchedPreset = VENDOR_PRESETS.find((item) => item.id === matchedPresetId);
      setPresetId(matchedPresetId);
      setProviderType(matchedPreset?.providerType ?? provider.providerType);
      setDisplayName(provider.displayName);
      setBaseURL(provider.baseURL);
      setModels(provider.models.join(", "));
      setModelMetadata(provider.modelMetadata);
    }
    setApiKey("");
    setEditingModel(undefined);
    setError("");
  }, [open, provider]);

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = VENDOR_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setProviderType(preset.providerType);
    setBaseURL(preset.baseURL);
    setDisplayName(preset.id === "other" ? "" : preset.name);
  };

  const modelList = useMemo(
    () => models.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean),
    [models],
  );

  const fetchModels = async () => {
    setFetching(true);
    setError("");
    try {
      const result = await window.tietiezhi.providers.fetchModels({
        id: provider?.id,
        providerType,
        baseURL: baseURL || undefined,
        apiKey: apiKey || undefined,
      });
      setModels(result.models.join(", "));
      setModelMetadata(result.modelMetadata);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await window.tietiezhi.providers.save({
        id: provider?.id,
        vendorId: presetId.startsWith("legacy:") ? provider?.vendorId ?? "legacy" : presetId,
        providerType,
        displayName,
        baseURL,
        apiKey: apiKey || undefined,
        enabled: true,
        models: modelList,
        modelMetadata,
      });
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!provider || provider.builtIn) return;
    setBusy(true);
    try {
      await window.tietiezhi.providers.remove(provider.id);
      onOpenChange(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const updateModelOverrides = (
    model: string,
    overrides: ModelMetadataOverrides | undefined,
  ) => {
    setModelMetadata((current) => {
      const metadata = current[model] ?? emptyMetadata();
      const nextMetadata = { ...metadata };
      if (overrides === undefined) delete nextMetadata.overrides;
      else nextMetadata.overrides = overrides;
      return { ...current, [model]: nextMetadata };
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[calc(50%+1.5rem)] flex max-h-[calc(100vh-5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="shrink-0 border-b px-5 py-4 pr-12">
          {provider ? `编辑 ${provider.displayName}` : "添加供应商"}
        </DialogTitle>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 py-4">
          <div className="grid gap-1.5">
            <Field label="供应商">
              <Select value={presetId} onValueChange={applyPreset}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-80">
                  {presetId.startsWith("legacy:") && provider && (
                    <>
                      <SelectGroup>
                        <SelectLabel>已有配置</SelectLabel>
                        <SelectItem value={presetId}>
                          {provider.displayName}（旧配置）
                        </SelectItem>
                      </SelectGroup>
                      <SelectSeparator />
                    </>
                  )}
                  {VENDOR_GROUPS.map((group, index) => (
                    <SelectGroup key={group.id}>
                      {index > 0 && <SelectSeparator />}
                      <SelectLabel>{group.label}</SelectLabel>
                      {VENDOR_PRESETS.filter((preset) => preset.group === group.id).map(
                        (preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.name}
                          </SelectItem>
                        ),
                      )}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <p className="text-muted-foreground text-xs">
              使用 {sdkProviderPackage(providerType)}，连接配置已自动填充。
            </p>
          </div>
          <Field
            label={
              provider
                ? "API Key（留空则保持原值）"
                : apiKeyOptional
                  ? "API Key（可选）"
                  : "API Key"
            }
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              placeholder={
                provider
                  ? "已安全保存"
                  : apiKeyOptional
                    ? "本地服务通常无需填写"
                    : "请输入 API Key"
              }
            />
          </Field>
          <div>
            <Field label="模型">
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
                <Input
                  value={models}
                  onChange={(event) => setModels(event.target.value)}
                  placeholder="gpt-5, claude-sonnet-4-5"
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={fetching}
                  onClick={() => void fetchModels()}
                  className="shrink-0"
                >
                  {fetching ? <Loader2 className="animate-spin" /> : <ListRestart />}
                  获取模型列表
                </Button>
              </div>
            </Field>
          </div>
          {modelList.length > 0 && (
            <div className="grid gap-1.5">
              <span className="text-muted-foreground text-xs font-medium">
                模型规则 · {modelList.length}
              </span>
              <div className="flex max-h-64 flex-col overflow-y-auto rounded-lg border">
                {modelList.map((model) => (
                  <div key={model} className="border-b last:border-b-0">
                    <button
                      type="button"
                      className="hover:bg-muted/50 flex w-full items-center gap-3 px-3 py-2 text-left transition-colors"
                      aria-expanded={editingModel === model}
                      onClick={() =>
                        setEditingModel((current) => current === model ? undefined : model)
                      }
                    >
                      <span className="min-w-0 flex-1 truncate text-xs">{model}</span>
                      <ModelCapabilityBadges
                        model={model}
                        metadata={modelMetadata[model]}
                        detailed
                      />
                      <ChevronDown
                        className={`text-muted-foreground size-3.5 transition-transform ${editingModel === model ? "rotate-180" : ""}`}
                      />
                    </button>
                    {editingModel === model && (
                      <ModelRuleEditor
                        model={model}
                        metadata={modelMetadata[model]}
                        onChange={(overrides) => updateModelOverrides(model, overrides)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <details className="group border-t pt-3">
            <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1.5 text-xs transition-colors">
              <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
              高级设置
            </summary>
            <div className="mt-3 grid gap-4">
              <Field label="显示名称">
                <Input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
              <Field label="API 地址">
                <Input
                  value={baseURL}
                  onChange={(event) => setBaseURL(event.target.value)}
                  placeholder="https://example.com/v1"
                />
              </Field>
            </div>
          </details>
          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3">
          <div>
            {provider && !provider.builtIn && (
              <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
                <Trash2 /> 删除
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button onClick={() => void save()} disabled={busy || !displayName.trim()}>
              {busy && <Loader2 className="animate-spin" />} 保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      {children}
    </div>
  );
}
