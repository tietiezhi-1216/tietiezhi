import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import {
  Archive,
  Info,
  Keyboard,
  Lightbulb,
  Mic,
  MessageSquareQuote,
  Monitor,
  Moon,
  Palette,
  Plug,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
  Sparkles,
  Sun,
  Tags,
  WalletCards,
} from "lucide-react";
import { AppIcon } from "@/components/app-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { loadSettings, saveSettings } from "@/lib/api";
import { useTheme } from "@/components/theme-provider";
import type { Theme } from "@/components/theme-provider";
import { DictationModelSection } from "@/features/settings/dictation-card";
import { ArchivedTasksSection } from "@/features/settings/archived-tasks-section";
import { DictationHotkeySection } from "@/features/settings/dictation-hotkey";
import { DictationPromptSection } from "@/features/settings/dictation-prompt";
import { McpSection } from "@/features/settings/mcp-section";
import { QuotaCenter } from "@/features/settings/quota-center";
import { PermissionSection } from "@/features/settings/permission-section";
import { ProviderManager } from "@/features/settings/provider-manager";
import { SkillsSection } from "@/features/settings/skills-section";
import { SystemPromptSection } from "@/features/settings/system-prompt-section";
import { SuggestionsSection } from "@/features/settings/suggestions-section";
import { TitleModelSection } from "@/features/settings/title-model-section";
import { SettingsSection } from "@/features/settings/settings-section";
import { UpdateCard } from "@/features/settings/update-card";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";
import type { SettingsCategory } from "@/stores/ui";

interface CategoryDef {
  key: SettingsCategory;
  label: string;
  icon: typeof Server;
}

interface CategoryGroup {
  label: string;
  items: CategoryDef[];
}

const GROUPS: CategoryGroup[] = [
  {
    label: "账号",
    items: [{ key: "quota", label: "额度中心", icon: WalletCards }],
  },
  {
    label: "模型",
    items: [
      { key: "providers", label: "供应商", icon: Server },
      { key: "titleModel", label: "标题生成", icon: Tags },
    ],
  },
  {
    label: "智能体",
    items: [
      { key: "systemPrompt", label: "系统提示词", icon: ScrollText },
      { key: "skills", label: "技能", icon: Sparkles },
      { key: "mcp", label: "MCP 服务器", icon: Plug },
      { key: "permissions", label: "权限", icon: ShieldCheck },
      { key: "suggestions", label: "任务建议", icon: Lightbulb },
    ],
  },
  {
    label: "语音听写",
    items: [
      { key: "dictationModel", label: "模型", icon: Mic },
      { key: "dictationHotkey", label: "快捷键", icon: Keyboard },
      { key: "dictationPrompt", label: "提示词", icon: MessageSquareQuote },
    ],
  },
  {
    label: "通用",
    items: [
      { key: "archives", label: "已归档任务", icon: Archive },
      { key: "appearance", label: "外观", icon: Palette },
      { key: "update", label: "软件更新", icon: RefreshCw },
      { key: "about", label: "关于", icon: Info },
    ],
  },
];

function categoryLabel(category: SettingsCategory): string {
  for (const group of GROUPS) {
    const item = group.items.find((c) => c.key === category);
    // Prefix generic item labels with their group (e.g. 语音听写 · 模型).
    if (item) return group.label === "语音听写" ? `${group.label} · ${item.label}` : item.label;
  }
  return "设置";
}

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const category = useUiStore((s) => s.settingsCategory);
  const setCategory = useUiStore((s) => s.setSettingsCategory);
  const closeSettings = useUiStore((s) => s.closeSettings);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeSettings()}>
      <DialogContent
        showCloseButton
        className="flex h-[760px] max-h-[90vh] gap-0 overflow-hidden p-0 sm:max-w-5xl"
      >
        <nav className="bg-muted/30 flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r p-3">
          <DialogTitle className="px-2 pt-1 text-sm font-semibold">设置</DialogTitle>
          {GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-1">
              <span className="text-muted-foreground px-2 pb-0.5 text-[11px] font-medium">
                {group.label}
              </span>
              {group.items.map((c) => (
                <button
                  key={c.key}
                  onClick={() => setCategory(c.key)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                    category === c.key
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <c.icon className="size-4 shrink-0" />
                  <span>{c.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center border-b px-7">
            <h2 className="text-base font-semibold">{categoryLabel(category)}</h2>
          </header>
          <div className="flex-1 overflow-y-auto px-7 py-6">
            {category === "providers" && <ProviderManager />}
            {category === "quota" && <QuotaCenter />}
            {category === "titleModel" && <TitleModelSection />}
            {category === "systemPrompt" && <SystemPromptSection />}
            {category === "skills" && <SkillsSection />}
            {category === "mcp" && <McpSection />}
            {category === "permissions" && <PermissionSection />}
            {category === "suggestions" && <SuggestionsSection />}
            {category === "dictationModel" && <DictationModelSection />}
            {category === "dictationHotkey" && <DictationHotkeySection />}
            {category === "dictationPrompt" && <DictationPromptSection />}
            {category === "archives" && <ArchivedTasksSection />}
            {category === "appearance" && <AppearanceSection />}
            {category === "update" && <UpdateCard />}
            {category === "about" && <AboutSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface ThemeOption {
  value: Theme;
  label: string;
  icon: typeof Sun;
}

const THEME_OPTIONS: ThemeOption[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const settings = settingsQuery.data;

  const saveStats = useMutation({
    mutationFn: async (showMessageStats: boolean) => {
      if (!settings) return;
      await saveSettings({ ...settings, showMessageStats });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const saveReasoning = useMutation({
    mutationFn: async (showReasoning: boolean) => {
      if (!settings) return;
      await saveSettings({ ...settings, showReasoning });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <SettingsSection>
      <div className="flex flex-col gap-2">
        <Label>主题</Label>
        <div className="flex gap-2">
          {THEME_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={theme === opt.value ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme(opt.value)}
            >
              <opt.icon /> {opt.label}
            </Button>
          ))}
        </div>
      </div>
      <Separator />
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="show-message-stats">在消息下方显示统计信息</Label>
          <p className="text-muted-foreground text-xs leading-relaxed">
            开启后直接展示模型、Token、生成速度和耗时；关闭时只显示时间，点每条回复的「详情」按钮仍可查看完整信息（含输入/输出、缓存命中等）。
          </p>
        </div>
        <Switch
          id="show-message-stats"
          className="mt-0.5 shrink-0"
          checked={settings?.showMessageStats ?? false}
          disabled={!settings}
          onCheckedChange={(checked) => saveStats.mutate(checked)}
        />
      </div>
      <Separator />
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="show-reasoning">显示模型思考过程</Label>
          <p className="text-muted-foreground text-xs leading-relaxed">
            开启后，会在支持思考的模型回复上方折叠展示其思考过程；关闭则完全隐藏。仅对会返回思考内容的模型生效。
          </p>
        </div>
        <Switch
          id="show-reasoning"
          className="mt-0.5 shrink-0"
          checked={settings?.showReasoning ?? false}
          disabled={!settings}
          onCheckedChange={(checked) => saveReasoning.mutate(checked)}
        />
      </div>
    </SettingsSection>
  );
}

function AboutSection() {
  const versionQuery = useQuery({
    queryKey: ["appVersion"],
    queryFn: getVersion,
    retry: false,
    staleTime: Infinity,
  });

  return (
    <SettingsSection>
      <div className="flex items-center gap-4">
        <AppIcon size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-semibold">铁铁汁 Tietiezhi</span>
          <span className="text-muted-foreground text-sm">
            连接各家模型的智能体终端 · v{versionQuery.data ?? "—"}
          </span>
          <Separator className="my-1" />
          <span className="text-muted-foreground text-xs">
            com.tietiezhi.tietiezhi · © 2026 Tietiezhi · 闭源软件，保留所有权利
          </span>
        </div>
      </div>
    </SettingsSection>
  );
}
