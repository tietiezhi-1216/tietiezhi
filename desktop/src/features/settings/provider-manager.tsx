import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  PlugZap,
  Save,
  Trash2,
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
  listProviders,
  providerKey,
  upsertProvider,
} from "@/lib/api";
import type { ModelInfo, ModelKind, Provider, ProviderType, ProviderView } from "@/lib/api";
import { SettingsSection } from "@/features/settings/settings-section";

const TYPE_LABELS: Record<ProviderType, string> = {
  openai: "OpenAI 兼容",
  mimo: "小米 MiMo",
};

const KIND_LABELS: Record<ModelKind, string> = {
  chat: "对话",
  asr: "语音识别",
  tts: "语音合成",
  image: "图像",
  video: "视频",
  embedding: "向量",
  other: "其它",
};

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
  for (const m of models) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
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

  const editProvider = async (provider: ProviderView) => {
    const key = await providerKey(provider.id).catch(() => null);
    setDraft({ ...toDraft(provider), apiKey: key ?? "" });
  };

  return (
    <SettingsSection>
      <div className="flex flex-col gap-5">
        {builtInProvider && (
          <div className="flex items-center gap-4 rounded-xl border px-4 py-3.5">
            <img
              src="/gateway/tietiezhi-gateway.png"
              alt="Tietiezhi Gateway"
              draggable={false}
              className="size-12 shrink-0 select-none rounded-full object-contain"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="truncate text-sm font-semibold">Tietiezhi Gateway</span>
              <span className="text-muted-foreground text-xs">
                {summarizeModels(builtInProvider.models)}
              </span>
            </div>
            <span className="shrink-0 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              免费
            </span>
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
  const fetchModels = useMutation({
    mutationFn: () =>
      fetchProviderModels({
        id: draft!.id,
        baseUrl: draft!.baseUrl.trim(),
        kind: draft!.type,
        apiKey: draft!.apiKey.trim() || undefined,
      }),
    onSuccess: (models) => draft && setDraft({ ...draft, models }),
  });

  const save = useMutation({
    mutationFn: async () => {
      const d = draft!;
      const provider: Provider = {
        id: d.id,
        name: d.name.trim(),
        type: d.type,
        baseUrl: d.baseUrl.trim(),
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
          fetchModels.reset();
          save.reset();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
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

            <ApiKeyField
              value={draft.apiKey}
              hasKey={draft.hasKey}
              onChange={(apiKey) => patch({ apiKey })}
            />

            {draft.models.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label>模型（{summarizeModels(draft.models)}）</Label>
                </div>
                {/* Type is inferred from the model name — the only signal
                    `/v1/models` gives — so it can be wrong; let the user fix it. */}
                <div className="max-h-56 overflow-y-auto rounded-md border">
                  {draft.models.map((m, i) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-b-0"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</span>
                      <Select
                        value={m.kind}
                        onValueChange={(v) => {
                          const models = [...draft.models];
                          models[i] = { ...m, kind: v as ModelKind };
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
                    </div>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  类型按模型名自动判断（接口不提供该信息），判断错了可以在这里改。
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
