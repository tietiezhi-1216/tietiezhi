import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, RotateCcw, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSection } from "@/features/settings/settings-section";
import { DEFAULT_SYSTEM_PROMPT } from "@shared/contracts";

export function SystemPromptSection() {
  const [draft, setDraft] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [busy, setBusy] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.tietiezhi.preferences.get().then((preferences) => {
      setDraft(preferences.systemPrompt);
      setSavedValue(preferences.systemPrompt);
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => setBusy(false));
  }, []);

  const save = async () => {
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const preferences = await window.tietiezhi.preferences.save({ systemPrompt: draft });
      setDraft(preferences.systemPrompt);
      setSavedValue(preferences.systemPrompt);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="system-prompt">默认系统提示词</Label>
          <Textarea
            id="system-prompt"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            disabled={busy}
            className="min-h-72 font-mono text-xs leading-relaxed"
          />
          <p className="text-muted-foreground text-xs leading-relaxed">
            对所有普通对话生效。Workspace 路径与已启用技能清单会自动附加在末尾。
          </p>
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <div className="flex items-center gap-2">
          <Button onClick={() => void save()} disabled={busy || draft === savedValue}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />}
            保存
          </Button>
          <Button
            variant="outline"
            onClick={() => setDraft(DEFAULT_SYSTEM_PROMPT)}
            disabled={busy || draft === DEFAULT_SYSTEM_PROMPT}
          >
            <RotateCcw /> 恢复默认
          </Button>
          {saved && draft === savedValue && (
            <Badge variant="secondary" className="text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 /> 已保存
            </Badge>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
