import { useEffect, useState } from "react";
import { KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import type { ProviderAccount, ProviderType } from "@shared/contracts";

export function ProviderDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [providers, setProviders] = useState<ProviderAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string>("new");
  const selected = providers.find((provider) => provider.id === selectedId);
  const [providerType, setProviderType] = useState<ProviderType>("openai-compatible");
  const [displayName, setDisplayName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    setProviders(await window.tietiezhi.providers.list());
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  useEffect(() => {
    if (selected === undefined) {
      setProviderType("openai-compatible");
      setDisplayName("");
      setBaseURL("");
      setModels("");
    } else {
      setProviderType(selected.providerType);
      setDisplayName(selected.displayName);
      setBaseURL(selected.baseURL);
      setModels(selected.models.join(", "));
    }
    setApiKey("");
    setError("");
  }, [selectedId, selected]);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await window.tietiezhi.providers.save({
        id: selected?.id,
        providerType,
        displayName,
        baseURL,
        apiKey: apiKey || undefined,
        enabled: true,
        models: models.split(/[,，\n]/).map((model) => model.trim()),
      });
      await refresh();
      setSelectedId(saved.id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (selected === undefined) return;
    setBusy(true);
    try {
      await window.tietiezhi.providers.remove(selected.id);
      setSelectedId("new");
      await refresh();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const refreshModels = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const refreshed = await window.tietiezhi.providers.refreshModels(selected.id);
      setModels(refreshed.models.join(", "));
      await refresh();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>模型供应商</DialogTitle>
          <DialogDescription>
            API Key 使用系统安全存储加密，SQLite 只保存凭据引用。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 py-2 sm:grid-cols-[13rem_minmax(0,1fr)]">
          <div className="space-y-2 border-r pr-4">
            <Button
              type="button"
              variant={selectedId === "new" ? "secondary" : "ghost"}
              className="w-full justify-start"
              onClick={() => setSelectedId("new")}
            >
              <Plus /> 新供应商
            </Button>
            {providers.map((provider) => (
              <Button
                key={provider.id}
                type="button"
                variant={selectedId === provider.id ? "secondary" : "ghost"}
                className="w-full justify-start truncate"
                onClick={() => setSelectedId(provider.id)}
              >
                <KeyRound />
                <span className="truncate">{provider.displayName}</span>
                {provider.builtIn && <Badge variant="secondary">内置</Badge>}
              </Button>
            ))}
          </div>
          <div className="space-y-4">
            <Field label="类型">
              <Select
                value={providerType}
                onValueChange={(value) => setProviderType(value as ProviderType)}
                disabled={selected?.builtIn}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="google">Google</SelectItem>
                  <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="名称">
              <Input value={displayName} disabled={selected?.builtIn} onChange={(event) => setDisplayName(event.target.value)} />
            </Field>
            <Field label="Base URL">
              <Input
                value={baseURL}
                onChange={(event) => setBaseURL(event.target.value)}
                placeholder="https://example.com/v1"
                disabled={selected?.builtIn}
              />
            </Field>
            {selected?.builtIn ? (
              <div className="bg-muted/40 rounded-lg border p-3 text-xs">
                内置中转站凭据由账号登录自动管理，不需要手工填写 API Key。
              </div>
            ) : (
              <Field label={selected ? "API Key（留空则保持原值）" : "API Key"}>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="off"
                />
              </Field>
            )}
            <Field label="模型">
              <div className="flex gap-2">
                <Input
                  value={models}
                  onChange={(event) => setModels(event.target.value)}
                  placeholder="gpt-5, gpt-image-1"
                  disabled={selected?.builtIn}
                />
                {selected && (
                  <Button type="button" variant="outline" onClick={() => void refreshModels()} disabled={busy}>
                    <RefreshCw className={busy ? "animate-spin" : ""} /> 获取
                  </Button>
                )}
              </div>
            </Field>
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <div>
            {selected && !selected.builtIn && (
              <Button type="button" variant="destructive" onClick={remove} disabled={busy}>
                <Trash2 /> 删除
              </Button>
            )}
          </div>
          {!selected?.builtIn && (
            <Button type="button" onClick={save} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              保存
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
