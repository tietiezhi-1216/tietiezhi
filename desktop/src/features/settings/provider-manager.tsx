import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BrainCircuit,
  CheckCircle2,
  Eye,
  EyeOff,
  FileText,
  ImageIcon,
  Loader2,
  LogIn,
  Pencil,
  Plus,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  UserRound,
  Video,
  Volume2,
  Wrench,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { message } from "@/components/app-message";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteProvider,
  errorMessage,
  fetchProviderModels,
  gatewayAccount,
  gatewayLogin,
  gatewayLogout,
  listProviders,
  providerKey,
  upsertProvider,
} from "@/lib/api";
import type {
  ModelInfo,
  ModelKind,
  Provider,
  ProviderType,
  ProviderView,
  WireApi,
} from "@/lib/api";
import type {
  ModelCapability,
  ModelModality,
  ReasoningEffort,
  ReasoningProtocol,
  ReasoningProfile,
  ReasoningTransport,
} from "@/lib/api";
import {
  effectiveModelKind,
  hasModelOverrides,
  modelHasCapability,
  modelInputModalities,
  modelOutputModalities,
  modelReasoning,
  modelWireApi,
} from "@/lib/model-capabilities";
import { SettingsSection } from "@/features/settings/settings-section";
import { notifyGatewayError } from "@/lib/gateway-feedback";

const TYPE_LABELS: Record<ProviderType, string> = {
  openai: "OpenAI 兼容",
  mimo: "小米 MiMo",
};

const WIRE_API_LABELS: Record<WireApi, string> = {
  auto: "按模型 / 自动探测",
  responses: "Responses API",
  chatCompletions: "OpenAI Chat Completions",
  anthropicMessages: "Anthropic Messages",
  geminiGenerateContent: "Gemini GenerateContent",
};

const KIND_LABELS: Record<ModelKind, string> = {
  chat: "对话",
  asr: "语音识别",
  tts: "语音合成",
  audio: "音乐与声音",
  image: "图像",
  video: "视频",
  embedding: "向量",
  other: "其它",
};

const CAPABILITY_OPTIONS: {
  value: ModelCapability;
  label: string;
  icon: typeof Wrench;
}[] = [
  { value: "tool-call", label: "工具 / MCP", icon: Wrench },
  { value: "reasoning", label: "思考", icon: BrainCircuit },
  { value: "structured-output", label: "结构化输出", icon: FileText },
  { value: "web-search", label: "联网搜索", icon: Settings2 },
];

const MODALITY_OPTIONS: { value: ModelModality; label: string; icon: typeof ImageIcon }[] = [
  { value: "text", label: "文本", icon: FileText },
  { value: "image", label: "图片", icon: ImageIcon },
  { value: "audio", label: "音频", icon: Volume2 },
  { value: "video", label: "视频", icon: Video },
  { value: "file", label: "文件", icon: FileText },
];

const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
];

const REASONING_PROTOCOLS: Array<{
  value: ReasoningProtocol;
  label: string;
  options: Array<{ value: ReasoningTransport; label: string }>;
}> = [
  {
    value: "responses",
    label: "Responses",
    options: [
      {
        value: "responses-reasoning",
        label: "reasoning.effort + summary",
      },
    ],
  },
  {
    value: "chat_completions",
    label: "Chat Completions",
    options: [
      { value: "openai-reasoning-effort", label: "reasoning_effort" },
      { value: "openrouter-reasoning", label: "reasoning.effort" },
      { value: "enable-thinking", label: "enable_thinking" },
    ],
  },
  {
    value: "anthropic_messages",
    label: "Anthropic Messages",
    options: [
      {
        value: "anthropic-adaptive",
        label: "output_config.effort + adaptive",
      },
      {
        value: "anthropic-thinking-budget",
        label: "thinking.budget_tokens",
      },
    ],
  },
  {
    value: "gemini_generate_content",
    label: "Gemini GenerateContent",
    options: [
      { value: "gemini-thinking-level", label: "thinkingLevel" },
      { value: "gemini-thinking-budget", label: "thinkingBudget" },
    ],
  },
];

const SOURCE_LABELS: Record<string, string> = {
  inferred: "名称推断",
  registry: "Tietiezhi 模型表",
  provider: "渠道元数据",
};

function sameValues<T extends string>(left: T[], right: T[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

function setKindOverride(model: ModelInfo, kind: ModelKind): ModelInfo {
  const overrides = { ...model.overrides };
  if (kind === model.kind) delete overrides.kind;
  else overrides.kind = kind;
  return { ...model, overrides };
}

function setCapabilityOverride(
  model: ModelInfo,
  capability: ModelCapability,
  enabled: boolean,
): ModelInfo {
  const capabilities = { ...(model.overrides?.capabilities ?? {}) };
  const detected = model.capabilities?.includes(capability) ?? false;
  if (enabled === detected) delete capabilities[capability];
  else capabilities[capability] = enabled;
  return {
    ...model,
    overrides: { ...model.overrides, capabilities },
  };
}

function setModalityOverride(
  model: ModelInfo,
  direction: "input" | "output",
  modality: ModelModality,
  enabled: boolean,
): ModelInfo {
  const detected =
    direction === "input"
      ? (model.inputModalities ?? ["text"])
      : (model.outputModalities ?? ["text"]);
  const effective =
    direction === "input" ? modelInputModalities(model) : modelOutputModalities(model);
  const next = enabled
    ? [...new Set([...effective, modality])]
    : effective.filter((candidate) => candidate !== modality);
  const overrides = { ...model.overrides };
  const key = direction === "input" ? "inputModalities" : "outputModalities";
  if (sameValues(next, detected)) delete overrides[key];
  else overrides[key] = next;
  return { ...model, overrides };
}

function defaultReasoningProfile(model: ModelInfo): ReasoningProfile {
  return (
    modelReasoning(model) ?? {
      mode: "effort",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "auto",
      transport: "openai-reasoning-effort",
      protocolTransports: {
        responses: "responses-reasoning",
        chat_completions: "openai-reasoning-effort",
        anthropic_messages: "anthropic-adaptive",
        gemini_generate_content: "gemini-thinking-level",
      },
    }
  );
}

function setReasoningOverride(model: ModelInfo, reasoning: ReasoningProfile): ModelInfo {
  return {
    ...model,
    overrides: { ...model.overrides, reasoning },
  };
}

function ModelCapabilityEditor({
  model,
  onChange,
}: {
  model: ModelInfo;
  onChange: (model: ModelInfo) => void;
}) {
  const reasoning = modelReasoning(model);
  const source = SOURCE_LABELS[model.capabilitySource ?? "inferred"] ?? "自动识别";

  const renderModalities = (direction: "input" | "output") => {
    const selected =
      direction === "input" ? modelInputModalities(model) : modelOutputModalities(model);
    return MODALITY_OPTIONS.map((option) => {
      const active = selected.includes(option.value);
      const Icon = option.icon;
      return (
        <Button
          key={option.value}
          type="button"
          variant={active ? "secondary" : "outline"}
          size="xs"
          aria-pressed={active}
          onClick={() =>
            onChange(setModalityOverride(model, direction, option.value, !active))
          }
        >
          <Icon />
          {option.label}
        </Button>
      );
    });
  };

  return (
    <div className="bg-muted/30 flex flex-col gap-3 border-t px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">
          识别来源：{source}{hasModelOverrides(model) ? " · 已手动修改" : ""}
        </span>
        {hasModelOverrides(model) && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onChange({ ...model, overrides: {} })}
          >
            <RotateCcw />
            恢复自动识别
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">模型协议</span>
        <Select
          value={model.overrides?.wireApi ?? "auto"}
          onValueChange={(wireApi) => {
            const overrides = { ...model.overrides };
            if (wireApi === "auto") delete overrides.wireApi;
            else overrides.wireApi = wireApi as WireApi;
            onChange({ ...model, overrides });
          }}
        >
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">
              自动（当前：{WIRE_API_LABELS[modelWireApi(model)]}）
            </SelectItem>
            <SelectItem value="responses">{WIRE_API_LABELS.responses}</SelectItem>
            <SelectItem value="chatCompletions">
              {WIRE_API_LABELS.chatCompletions}
            </SelectItem>
            <SelectItem value="anthropicMessages">
              {WIRE_API_LABELS.anthropicMessages}
            </SelectItem>
            <SelectItem value="geminiGenerateContent">
              {WIRE_API_LABELS.geminiGenerateContent}
            </SelectItem>
          </SelectContent>
        </Select>
        {model.supportedWireApis && model.supportedWireApis.length > 0 && (
          <span className="text-xs text-muted-foreground">
            网关声明：
            {model.supportedWireApis.map((wireApi) => WIRE_API_LABELS[wireApi]).join("、")}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">输入模态</span>
        <div className="flex flex-wrap gap-1.5">{renderModalities("input")}</div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">输出模态</span>
        <div className="flex flex-wrap gap-1.5">{renderModalities("output")}</div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">高级能力</span>
        <div className="flex flex-wrap gap-1.5">
          {CAPABILITY_OPTIONS.map((option) => {
            const active = modelHasCapability(model, option.value);
            const Icon = option.icon;
            return (
              <Button
                key={option.value}
                type="button"
                variant={active ? "secondary" : "outline"}
                size="xs"
                aria-pressed={active}
                onClick={() => {
                  let next = setCapabilityOverride(model, option.value, !active);
                  if (option.value === "reasoning" && !active && !modelReasoning(next)) {
                    next = setReasoningOverride(next, defaultReasoningProfile(model));
                  }
                  onChange(next);
                }}
              >
                <Icon />
                {option.label}
              </Button>
            );
          })}
        </div>
      </div>

      {reasoning && (
        <div className="flex flex-col gap-2 rounded-md border bg-background/60 p-2.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">Reasoning Mode</span>
              <Select
                value={reasoning.mode}
                onValueChange={(mode) =>
                  onChange(
                    setReasoningOverride(model, {
                      ...defaultReasoningProfile(model),
                      mode: mode as ReasoningProfile["mode"],
                    }),
                  )
                }
              >
                <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="effort">Adjustable</SelectItem>
                  <SelectItem value="fixed">Fixed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {REASONING_PROTOCOLS.map((protocol) => {
              const current = defaultReasoningProfile(model);
              const selected =
                current.protocolTransports?.[protocol.value] ??
                protocol.options[0].value;
              return (
                <div key={protocol.value} className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">{protocol.label} 参数</span>
                  <Select
                    value={selected}
                    onValueChange={(transport) =>
                      onChange(
                        setReasoningOverride(model, {
                          ...current,
                          protocolTransports: {
                            ...current.protocolTransports,
                            [protocol.value]: transport as ReasoningTransport,
                          },
                        }),
                      )
                    }
                  >
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {protocol.options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
          {reasoning.mode === "effort" && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">Supported Effort</span>
                <div className="flex flex-wrap gap-1.5">
                  {REASONING_EFFORT_OPTIONS.map((option) => {
                    const active = reasoning.supportedEfforts.includes(option.value);
                    return (
                      <Button
                        key={option.value}
                        type="button"
                        variant={active ? "secondary" : "outline"}
                        size="xs"
                        aria-pressed={active}
                        onClick={() => {
                          const current = defaultReasoningProfile(model);
                          const supportedEfforts = active
                            ? current.supportedEfforts.filter((effort) => effort !== option.value)
                            : [...current.supportedEfforts, option.value];
                          onChange(setReasoningOverride(model, { ...current, supportedEfforts }));
                        }}
                      >
                        {option.label}
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium">Default Effort</span>
                <Select
                  value={reasoning.defaultEffort ?? "auto"}
                  onValueChange={(defaultEffort) =>
                    onChange(
                      setReasoningOverride(model, {
                        ...defaultReasoningProfile(model),
                        defaultEffort: defaultEffort as ReasoningEffort,
                      }),
                    )
                  }
                >
                  <SelectTrigger size="sm" className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    {REASONING_EFFORT_OPTIONS.filter((option) =>
                      reasoning.supportedEfforts.includes(option.value),
                    ).map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** API key input: masked by default, with an eye toggle to reveal it. */
function ApiKeyField({
  value,
  hasKey,
  onChange,
}: {
  value: string;
  hasKey: boolean;
  onChange: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="p-key">API Key</Label>
      <div className="relative">
        <Input
          id="p-key"
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={hasKey ? "已保存（留空保持不变）" : "sk-…"}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="pr-9 font-mono"
        />
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? "隐藏 API Key" : "显示 API Key"}
          className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 grid w-9 place-items-center"
        >
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    </div>
  );
}

/** "3 对话 · 1 语音识别" — what this provider actually brings to the table. */
function summarizeModels(models: ModelInfo[]): string {
  if (models.length === 0) return "未获取模型";
  const counts = new Map<ModelKind, number>();
  for (const model of models) {
    const kind = effectiveModelKind(model);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${KIND_LABELS[kind]}`)
    .join(" · ");
}

const DEFAULT_BASE_URL: Record<ProviderType, string> = {
  openai: "",
  mimo: "https://api.xiaomimimo.com/v1",
};

interface DraftState {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  wireApi: WireApi;
  builtIn: boolean;
  apiKey: string;
  models: ModelInfo[];
  hasKey: boolean;
  isNew: boolean;
}

function blankDraft(): DraftState {
  return {
    id: crypto.randomUUID(),
    name: "",
    type: "openai",
    baseUrl: "",
    wireApi: "auto",
    builtIn: false,
    apiKey: "",
    models: [],
    hasKey: false,
    isNew: true,
  };
}

function toDraft(p: ProviderView): DraftState {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    wireApi: p.wireApi,
    builtIn: p.builtIn,
    apiKey: "",
    models: p.models,
    hasKey: p.hasKey,
    isNew: false,
  };
}

export function ProviderManager() {
  const queryClient = useQueryClient();
  const providersQuery = useQuery({ queryKey: ["providers"], queryFn: listProviders });
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderView | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
  };

  const providers = providersQuery.data ?? [];
  const builtInProvider = providers.find((provider) => provider.builtIn);
  const customProviders = providers.filter((provider) => !provider.builtIn);
  const gatewayAccountQuery = useQuery({
    queryKey: ["gateway-account", builtInProvider?.id],
    queryFn: () => gatewayAccount(builtInProvider!.id),
    enabled: Boolean(builtInProvider),
    retry: false,
  });
  const gatewayLoggedIn = Boolean(gatewayAccountQuery.data?.loggedIn);
  const gatewayLoginMutation = useMutation({
    mutationFn: async () => {
      if (!builtInProvider) throw new Error("未找到 Tietiezhi Gateway");
      const account = await gatewayLogin(builtInProvider.id);
      await fetchProviderModels({
        id: builtInProvider.id,
        baseUrl: builtInProvider.baseUrl,
        kind: builtInProvider.type,
      });
      return account;
    },
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({
        queryKey: ["gateway-account", builtInProvider?.id],
      });
      message.success("中转站登录成功");
    },
    onError: (error) => notifyGatewayError(error, "中转站登录失败"),
  });
  const gatewayLogoutMutation = useMutation({
    mutationFn: async () => {
      if (!builtInProvider) return;
      await gatewayLogout(builtInProvider.id);
    },
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({
        queryKey: ["gateway-account", builtInProvider?.id],
      });
    },
    onError: (error) => notifyGatewayError(error, "退出登录失败"),
  });
  const refreshBuiltIn = useMutation({
    mutationFn: async () => {
      if (!builtInProvider) throw new Error("未找到 Tietiezhi Gateway");
      return fetchProviderModels({
        id: builtInProvider.id,
        baseUrl: builtInProvider.baseUrl,
        kind: builtInProvider.type,
      });
    },
    onSuccess: () => {
      invalidate();
      message.success("模型列表已刷新");
    },
    onError: (error) => notifyGatewayError(error, "刷新模型列表失败"),
  });

  const refreshBuiltInModels = () => {
    if (!gatewayLoggedIn) {
      message.warning(
        "请先登录中转站",
        "登录后即可刷新模型并使用当前账号额度。",
      );
      return;
    }
    refreshBuiltIn.mutate();
  };

  const editProvider = async (provider: ProviderView) => {
    const key = provider.builtIn ? null : await providerKey(provider.id).catch(() => null);
    setDraft({ ...toDraft(provider), apiKey: key ?? "" });
  };

  return (
    <SettingsSection>
      <div className="flex flex-col gap-5">
        {builtInProvider && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-4 rounded-xl border px-4 py-3.5">
              <img
                src="/gateway/tietiezhi-gateway.png"
                alt="Tietiezhi Gateway"
                draggable={false}
                className="size-12 shrink-0 select-none rounded-full object-contain"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="truncate text-sm font-semibold">Tietiezhi Gateway</span>
                <span className="text-muted-foreground text-xs">
                  {gatewayAccountQuery.data?.loggedIn
                    ? gatewayAccountQuery.data.account?.email
                    : gatewayAccountQuery.data?.supported === false
                      ? "当前中转站未提供账号登录"
                      : "登录后刷新模型并使用当前账号额度"}
                </span>
              </div>
              {gatewayAccountQuery.data?.loggedIn ? (
                <>
                  <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium">
                    <UserRound className="size-4" />
                    {gatewayAccountQuery.data.account?.nickname ||
                      gatewayAccountQuery.data.account?.email}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={gatewayLogoutMutation.isPending}
                    onClick={() => gatewayLogoutMutation.mutate()}
                  >
                    {gatewayLogoutMutation.isPending && (
                      <Loader2 className="animate-spin" />
                    )}
                    退出
                  </Button>
                </>
              ) : gatewayAccountQuery.data?.supported !== false ? (
                <Button
                  size="sm"
                  disabled={
                    gatewayLoginMutation.isPending ||
                    gatewayAccountQuery.isLoading
                  }
                  onClick={() => gatewayLoginMutation.mutate()}
                >
                  {gatewayLoginMutation.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <LogIn />
                  )}
                  登录中转站
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={refreshBuiltIn.isPending || gatewayAccountQuery.isLoading}
                onClick={refreshBuiltInModels}
              >
                <RefreshCw className={refreshBuiltIn.isPending ? "animate-spin" : undefined} />
                刷新模型列表
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="管理内置渠道模型"
                onClick={() => void editProvider(builtInProvider)}
              >
                <Settings2 />
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3 px-0.5">
            <div className="flex flex-col gap-0.5">
              <h3 className="text-sm font-medium">自定义供应商</h3>
            </div>
            <Button variant="outline" size="sm" onClick={() => setDraft(blankDraft())}>
              <Plus /> 添加供应商
            </Button>
          </div>

          {customProviders.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed px-4 py-5 text-center text-xs">
              暂无自定义供应商，需要时可在右上角添加
            </div>
          ) : (
            customProviders.map((provider) => (
              <div
                key={provider.id}
                className="hover:bg-accent/40 flex items-center gap-3 rounded-lg border px-3.5 py-3 transition-colors"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{provider.name}</span>
                    <Badge variant="secondary" className="shrink-0">
                      {TYPE_LABELS[provider.type]}
                    </Badge>
                    {provider.hasKey && (
                      <Badge
                        variant="outline"
                        className="shrink-0 text-emerald-600 dark:text-emerald-400"
                      >
                        已存 Key
                      </Badge>
                    )}
                  </div>
                  <span className="text-muted-foreground truncate text-xs">
                    {provider.baseUrl} · {summarizeModels(provider.models)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="编辑"
                  onClick={() => void editProvider(provider)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="删除"
                  onClick={() => setPendingDelete(provider)}
                >
                  <Trash2 />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      <ProviderFormDialog draft={draft} setDraft={setDraft} onSaved={invalidate} />

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除供应商「{pendingDelete?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              将同时删除其 API Key。引用了该供应商的选择会被清空。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (pendingDelete) {
                  await deleteProvider(pendingDelete.id).catch(() => {});
                  invalidate();
                }
                setPendingDelete(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function ProviderFormDialog({
  draft,
  setDraft,
  onSaved,
}: {
  draft: DraftState | null;
  setDraft: (d: DraftState | null) => void;
  onSaved: () => void;
}) {
  const [expandedModelId, setExpandedModelId] = useState("");
  const fetchModels = useMutation({
    mutationFn: () =>
      fetchProviderModels({
        id: draft!.id,
        baseUrl: draft!.baseUrl.trim(),
        kind: draft!.type,
        apiKey: draft!.apiKey.trim() || undefined,
      }),
    onSuccess: (models) => {
      if (!draft) return;
      const merged = models.map((model) => {
        const current = draft.models.find((candidate) => candidate.id === model.id);
        return current?.overrides ? { ...model, overrides: current.overrides } : model;
      });
      setDraft({ ...draft, models: merged });
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const d = draft!;
      const provider: Provider = {
        id: d.id,
        name: d.name.trim(),
        type: d.type,
        baseUrl: d.baseUrl.trim(),
        wireApi: d.wireApi,
        builtIn: d.builtIn,
        models: d.models,
      };
      await upsertProvider(provider, d.apiKey.trim() || undefined);
    },
    onSuccess: () => {
      onSaved();
      setDraft(null);
    },
  });

  const patch = (p: Partial<DraftState>) => draft && setDraft({ ...draft, ...p });

  return (
    <Dialog
      open={draft != null}
      onOpenChange={(open) => {
        if (!open) {
          setDraft(null);
          setExpandedModelId("");
          fetchModels.reset();
          save.reset();
        }
      }}
    >
      <DialogContent className="max-h-[min(48rem,calc(100vh-2rem))] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft?.isNew ? "添加供应商" : "编辑供应商"}</DialogTitle>
        </DialogHeader>

        {draft && (
          <div className="flex flex-col gap-4 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="p-name">名称</Label>
                <Input
                  id="p-name"
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="例如 小米 MiMo"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="p-type">厂商类型</Label>
                <Select
                  value={draft.type}
                  onValueChange={(v) => {
                    const type = v as ProviderType;
                    const baseUrl =
                      !draft.baseUrl.trim() || draft.baseUrl === DEFAULT_BASE_URL[draft.type]
                        ? DEFAULT_BASE_URL[type]
                        : draft.baseUrl;
                    patch({ type, baseUrl });
                  }}
                >
                  <SelectTrigger id="p-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">{TYPE_LABELS.openai}</SelectItem>
                    <SelectItem value="mimo">{TYPE_LABELS.mimo}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="p-base">baseURL</Label>
              <Input
                id="p-base"
                value={draft.baseUrl}
                onChange={(e) => patch({ baseUrl: e.target.value })}
                placeholder="https://api.example.com（带不带 /v1 均可）"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="p-wire-api">Agent 协议</Label>
              <Select
                value={draft.wireApi}
                onValueChange={(value) => patch({ wireApi: value as WireApi })}
                disabled={draft.builtIn}
              >
                <SelectTrigger id="p-wire-api">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{WIRE_API_LABELS.auto}</SelectItem>
                  <SelectItem value="responses">{WIRE_API_LABELS.responses}</SelectItem>
                  <SelectItem value="chatCompletions">
                    {WIRE_API_LABELS.chatCompletions}
                  </SelectItem>
                  <SelectItem value="anthropicMessages">
                    {WIRE_API_LABELS.anthropicMessages}
                  </SelectItem>
                  <SelectItem value="geminiGenerateContent">
                    {WIRE_API_LABELS.geminiGenerateContent}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {draft.builtIn
                  ? "官方 Gateway 按模型目录自动选择协议，可在每个模型下覆盖。"
                  : "Agent Runtime 支持 Responses、Chat Completions、Anthropic Messages 与 Gemini GenerateContent。"}
              </p>
            </div>

            {!draft.builtIn && (
              <ApiKeyField
                value={draft.apiKey}
                hasKey={draft.hasKey}
                onChange={(apiKey) => patch({ apiKey })}
              />
            )}

            {draft.models.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label>模型（{summarizeModels(draft.models)}）</Label>
                </div>
                <div className="max-h-80 overflow-y-auto rounded-md border">
                  {draft.models.map((m, i) => (
                    <div
                      key={m.id}
                      className="border-b last:border-b-0"
                    >
                      <div className="flex items-center gap-2 px-2.5 py-1.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</span>
                        <div className="text-muted-foreground flex shrink-0 items-center gap-1">
                          {modelInputModalities(m).includes("image") && (
                            <ImageIcon aria-label="支持图片输入" className="size-3.5" />
                          )}
                          {modelHasCapability(m, "reasoning") && (
                            <BrainCircuit aria-label="支持思考" className="size-3.5" />
                          )}
                          {modelHasCapability(m, "tool-call") && (
                            <Wrench aria-label="支持工具和 MCP" className="size-3.5" />
                          )}
                        </div>
                        <Select
                          value={effectiveModelKind(m)}
                          onValueChange={(v) => {
                            const models = [...draft.models];
                            models[i] = setKindOverride(m, v as ModelKind);
                            patch({ models });
                          }}
                        >
                          <SelectTrigger size="sm" className="w-28 shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(KIND_LABELS) as ModelKind[]).map((k) => (
                              <SelectItem key={k} value={k}>
                                {KIND_LABELS[k]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`编辑 ${m.id} 的能力`}
                          aria-expanded={expandedModelId === m.id}
                          onClick={() =>
                            setExpandedModelId((current) => current === m.id ? "" : m.id)
                          }
                        >
                          <Settings2 />
                        </Button>
                      </div>
                      {expandedModelId === m.id && (
                        <ModelCapabilityEditor
                          model={m}
                          onChange={(model) => {
                            const models = [...draft.models];
                            models[i] = model;
                            patch({ models });
                          }}
                        />
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  能力来自渠道元数据和 Tietiezhi 模型表；判断不准确时可以手动覆盖。
                </p>
              </div>
            )}

            {fetchModels.isError && (
              <Alert variant="destructive">
                <AlertTitle>获取模型失败</AlertTitle>
                <AlertDescription>{errorMessage(fetchModels.error)}</AlertDescription>
              </Alert>
            )}
            {save.isError && (
              <Alert variant="destructive">
                <AlertTitle>保存失败</AlertTitle>
                <AlertDescription>{errorMessage(save.error)}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="outline"
            onClick={() => fetchModels.mutate()}
            disabled={fetchModels.isPending || !draft?.baseUrl.trim()}
          >
            {fetchModels.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
            获取模型
            {fetchModels.isSuccess && <CheckCircle2 className="text-emerald-500" />}
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !draft?.name.trim() || !draft?.baseUrl.trim()}
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
