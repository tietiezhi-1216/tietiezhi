import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Brain, Eye, Loader2, ListRestart, Trash2, Wrench, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { modelCapabilities } from "@/lib/model-capabilities";
import type {
  ModelMetadata,
  ProviderAccount,
  ProviderType,
} from "@shared/contracts";

interface VendorPreset {
  id: string;
  name: string;
  providerType: ProviderType;
  baseURL: string;
}

/**
 * Vendor catalog: every entry maps to one of the four wire protocols the AI
 * SDK engine already speaks, so adding a vendor never needs a new dependency.
 */
export const VENDOR_PRESETS: VendorPreset[] = [
  { id: "custom", name: "自定义", providerType: "openai-compatible", baseURL: "" },
  { id: "openai", name: "OpenAI", providerType: "openai", baseURL: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic Claude", providerType: "anthropic", baseURL: "https://api.anthropic.com/v1" },
  { id: "google", name: "Google Gemini", providerType: "google", baseURL: "https://generativelanguage.googleapis.com/v1beta" },
  { id: "deepseek", name: "DeepSeek 深度求索", providerType: "openai-compatible", baseURL: "https://api.deepseek.com/v1" },
  { id: "kimi", name: "Kimi 月之暗面", providerType: "openai-compatible", baseURL: "https://api.moonshot.cn/v1" },
  { id: "zhipu", name: "智谱 GLM", providerType: "openai-compatible", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "qwen", name: "通义千问（阿里云百炼）", providerType: "openai-compatible", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "doubao", name: "豆包（火山方舟）", providerType: "openai-compatible", baseURL: "https://ark.cn-beijing.volces.com/api/v3" },
  { id: "ernie", name: "文心一言（百度千帆）", providerType: "openai-compatible", baseURL: "https://qianfan.baidubce.com/v2" },
  { id: "hunyuan", name: "腾讯混元", providerType: "openai-compatible", baseURL: "https://api.hunyuan.cloud.tencent.com/v1" },
  { id: "minimax", name: "MiniMax", providerType: "openai-compatible", baseURL: "https://api.minimaxi.com/v1" },
  { id: "stepfun", name: "阶跃星辰", providerType: "openai-compatible", baseURL: "https://api.stepfun.com/v1" },
  { id: "xai", name: "xAI Grok", providerType: "openai-compatible", baseURL: "https://api.x.ai/v1" },
  { id: "mistral", name: "Mistral", providerType: "openai-compatible", baseURL: "https://api.mistral.ai/v1" },
  { id: "groq", name: "Groq", providerType: "openai-compatible", baseURL: "https://api.groq.com/openai/v1" },
  { id: "openrouter", name: "OpenRouter", providerType: "openai-compatible", baseURL: "https://openrouter.ai/api/v1" },
  { id: "siliconflow", name: "SiliconFlow 硅基流动", providerType: "openai-compatible", baseURL: "https://api.siliconflow.cn/v1" },
  { id: "ollama", name: "Ollama（本地）", providerType: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1" },
];

const PROTOCOL_LABELS: Record<ProviderType, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "openai-compatible": "OpenAI-compatible",
};

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
  const [presetId, setPresetId] = useState("custom");
  const [providerType, setProviderType] = useState<ProviderType>("openai-compatible");
  const [displayName, setDisplayName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [fetchedMetadata, setFetchedMetadata] =
    useState<Record<string, ModelMetadata>>();
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    if (provider === undefined) {
      setPresetId("custom");
      setProviderType("openai-compatible");
      setDisplayName("");
      setBaseURL("");
      setModels("");
    } else {
      setProviderType(provider.providerType);
      setDisplayName(provider.displayName);
      setBaseURL(provider.baseURL);
      setModels(provider.models.join(", "));
    }
    setApiKey("");
    setFetchedMetadata(undefined);
    setError("");
  }, [open, provider]);

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = VENDOR_PRESETS.find((item) => item.id === id);
    if (!preset || preset.id === "custom") return;
    setProviderType(preset.providerType);
    setBaseURL(preset.baseURL);
    setDisplayName((current) => current.trim() === "" ? preset.name : current);
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
      setFetchedMetadata(result.modelMetadata);
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
        providerType,
        displayName,
        baseURL,
        apiKey: apiKey || undefined,
        enabled: true,
        models: modelList,
        modelMetadata: fetchedMetadata,
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

  const metadataFor = (model: string): ModelMetadata | undefined =>
    fetchedMetadata?.[model] ?? provider?.modelMetadata[model];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogTitle>
          {provider ? `编辑 ${provider.displayName}` : "添加供应商"}
        </DialogTitle>
        <div className="grid gap-4 py-2">
          {provider === undefined && (
            <Field label="供应商">
              <Select value={presetId} onValueChange={applyPreset}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {VENDOR_PRESETS.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="接口协议">
            <Select
              value={providerType}
              onValueChange={(value) => setProviderType(value as ProviderType)}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(PROTOCOL_LABELS) as ProviderType[]).map((type) => (
                  <SelectItem key={type} value={type}>
                    {PROTOCOL_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="名称">
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
          <Field label="Base URL">
            <Input
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
              placeholder="https://example.com/v1"
            />
          </Field>
          <Field label={provider ? "API Key（留空则保持原值）" : "API Key"}>
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="模型">
            <div className="flex items-start gap-2">
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
              >
                {fetching ? <Loader2 className="animate-spin" /> : <ListRestart />}
                获取模型列表
              </Button>
            </div>
          </Field>
          {modelList.length > 0 && (
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border p-2">
              {modelList.map((model) => (
                <div
                  key={model}
                  className="flex items-center justify-between gap-3 px-1 py-0.5"
                >
                  <span className="min-w-0 truncate text-xs">{model}</span>
                  <ModelCapabilityBadges
                    model={model}
                    metadata={metadataFor(model)}
                    detailed
                  />
                </div>
              ))}
            </div>
          )}
          {error && <p className="text-destructive text-xs">{error}</p>}
          <div className="flex items-center justify-between">
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
