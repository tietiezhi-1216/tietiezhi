import { useEffect, useState } from "react";
import { FolderInput, Loader2, Pencil, Plus, Save, Trash2, X } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSection } from "@/features/settings/settings-section";
import type { SkillInput, SkillSummary } from "@shared/contracts";

interface SkillDraft extends SkillInput {
  existing: boolean;
}

export function SkillsSection() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [draft, setDraft] = useState<SkillDraft>();
  const [pendingDelete, setPendingDelete] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    setSkills(await window.tietiezhi.skills.list());
  };

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);

  const edit = async (name: string) => {
    setBusy(true);
    setError("");
    try {
      const detail = await window.tietiezhi.skills.read(name);
      setDraft({
        name: detail.name,
        description: detail.description,
        body: detail.body,
        existing: true,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await window.tietiezhi.skills.save(draft);
      await refresh();
      setDraft(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const importSkill = async () => {
    setBusy(true);
    setError("");
    try {
      await window.tietiezhi.skills.import();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (name: string, enabled: boolean) => {
    setSkills((current) =>
      current.map((skill) => (skill.name === name ? { ...skill, enabled } : skill)),
    );
    try {
      await window.tietiezhi.skills.setEnabled(name, enabled);
    } catch (cause) {
      await refresh();
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await window.tietiezhi.skills.remove(pendingDelete);
      await refresh();
      setPendingDelete(undefined);
    } finally {
      setBusy(false);
    }
  };

  if (draft) {
    return (
      <SettingsSection>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="skill-name">名称</Label>
            <Input
              id="skill-name"
              value={draft.name}
              disabled={draft.existing || busy}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="code-review"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-description">描述</Label>
            <Input
              id="skill-description"
              value={draft.description}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder="审查代码质量并给出修改建议"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="skill-body">技能说明（Markdown）</Label>
          <Textarea
            id="skill-body"
            value={draft.body}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            spellCheck={false}
            className="min-h-80 resize-y font-mono text-xs leading-6"
          />
        </div>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() => void save()}
            disabled={busy || !draft.name.trim() || !draft.description.trim()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Save />}
            保存
          </Button>
          <Button type="button" variant="outline" onClick={() => setDraft(undefined)}>
            <X /> 取消
          </Button>
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection>
      <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() =>
            setDraft({ name: "", description: "", body: "", existing: false })
          }
        >
          <Plus /> 新建技能
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void importSkill()}
          disabled={busy}
        >
          {busy ? <Loader2 className="animate-spin" /> : <FolderInput />}
          从文件夹导入
        </Button>
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">
        技能是带说明的 Markdown 文档：模型先看到名称和描述，任务相关时才加载全文。
      </p>
      {error && <p className="text-destructive text-xs">{error}</p>}
      {skills.length === 0 ? (
        <div className="text-muted-foreground py-4 text-sm">
          还没有技能。
        </div>
      ) : (
        <div className="flex flex-col divide-y rounded-lg border">
          {skills.map((skill) => (
            <div key={skill.name} className="flex items-center gap-3 px-3 py-2.5">
              
              <span className="min-w-0 flex-1">
                <strong className="block truncate font-mono text-sm font-medium">{skill.name}</strong>
                <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                  {skill.description || "暂无描述"}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`编辑 ${skill.name}`}
                onClick={() => void edit(skill.name)}
              >
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-destructive hover:text-destructive"
                aria-label={`删除 ${skill.name}`}
                onClick={() => setPendingDelete(skill.name)}
              >
                <Trash2 />
              </Button>
              <Switch
                checked={skill.enabled}
                onCheckedChange={(enabled) => void toggle(skill.name, enabled)}
                aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.name}`}
              />
            </div>
          ))}
        </div>
      )}
      </div>
      <AlertDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => !open && setPendingDelete(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除技能“{pendingDelete}”？</AlertDialogTitle>
            <AlertDialogDescription>
              技能文件夹会被永久删除，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
