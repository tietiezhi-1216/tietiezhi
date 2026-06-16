import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Boxes,
  FileText,
  Keyboard,
  Plus,
  Satellite,
  Server,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import type {
  Model,
  ModelType,
  Provider,
  Settings,
  Transport,
} from "@/lib/types";

const OPENAI_BASE = "https://api.openai.com/v1";

const TABS = [
  { id: "providers", label: "服务商", icon: Server },
  { id: "models", label: "模型", icon: Boxes },
  { id: "dictation", label: "听写", icon: Keyboard },
  { id: "templates", label: "模板", icon: FileText },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface SectionProps {
  settings: Settings;
  update: (s: Settings) => void;
}

const uid = () => crypto.randomUUID();

// macOS 虚拟键码 → 友好名称（用于快捷键显示）。
const KEYCODE_LABELS: Record<string, string> = {
  "54": "右 ⌘",
  "55": "左 ⌘",
  "59": "左 ⌃",
  "62": "右 ⌃",
  "56": "左 ⇧",
  "60": "右 ⇧",
  "58": "左 ⌥",
  "61": "右 ⌥",
  "63": "Fn",
  "49": "空格",
  "36": "回车",
  "53": "Esc",
  "48": "Tab",
  "51": "删除",
  "57": "大写锁定",
};
const hotkeyLabel = (code: string) =>
  !code ? "—" : (KEYCODE_LABELS[code] ?? `键码 ${code}`);

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<TabId>("providers");

  useEffect(() => {
    api.getSettings().then(setSettings).catch(console.error);
  }, []);

  const update = useCallback((next: Settings) => {
    setSettings(next);
    api.saveSettings(next).catch(console.error);
  }, []);

  if (!settings) {
    return (
      <div className="text-muted-foreground grid min-h-screen place-items-center bg-background">
        加载中…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar tab={tab} setTab={setTab} />
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl p-8">
          {tab === "providers" && (
            <ProvidersSection settings={settings} update={update} />
          )}
          {tab === "models" && (
            <ModelsSection settings={settings} update={update} />
          )}
          {tab === "dictation" && (
            <DictationSection settings={settings} update={update} />
          )}
          {tab === "templates" && (
            <TemplatesSection settings={settings} update={update} />
          )}
        </div>
      </main>
    </div>
  );
}

function Sidebar({
  tab,
  setTab,
}: {
  tab: TabId;
  setTab: (t: TabId) => void;
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col gap-1 border-r p-4">
      <div className="mb-4 flex items-center gap-2 px-2">
        <Satellite className="size-5 text-primary" />
        <span className="text-lg font-bold">Orbit</span>
      </div>
      {TABS.map((t) => {
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              tab === t.id
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-secondary/60",
            )}
          >
            <Icon className="size-4" />
            {t.label}
          </button>
        );
      })}
      <div className="flex-1" />
      <p className="text-muted-foreground/60 px-2 text-xs">语音听写</p>
    </aside>
  );
}

// ---- 通用布局 -------------------------------------------------------------

function Section({
  title,
  desc,
  action,
  children,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold">{title}</h2>
          {desc && <p className="text-muted-foreground text-sm">{desc}</p>}
        </div>
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
      {children}
    </p>
  );
}

function Labeled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </label>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-[3px]"
    >
      {children}
    </select>
  );
}

// ---- 服务商 ---------------------------------------------------------------

function ProvidersSection({ settings, update }: SectionProps) {
  const add = () =>
    update({
      ...settings,
      providers: [
        ...settings.providers,
        {
          id: uid(),
          name: "OpenAI",
          kind: "openai",
          base_url: OPENAI_BASE,
          api_key: "",
        },
      ],
    });
  const edit = (id: string, patch: Partial<Provider>) =>
    update({
      ...settings,
      providers: settings.providers.map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      ),
    });
  const remove = (id: string) =>
    update({
      ...settings,
      providers: settings.providers.filter((p) => p.id !== id),
    });

  return (
    <Section
      title="服务商"
      desc="模型厂商与接口地址。内置 OpenAI；改一下 Base URL 即可接入任何兼容 OpenAI 的端点。"
      action={
        <Button size="sm" onClick={add}>
          <Plus className="size-4" />
          添加服务商
        </Button>
      }
    >
      {settings.providers.length === 0 && (
        <Empty>还没有服务商，先添加一个。</Empty>
      )}
      {settings.providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          onEdit={(patch) => edit(p.id, patch)}
          onRemove={() => remove(p.id)}
        />
      ))}
    </Section>
  );
}

function ProviderCard({
  provider,
  onEdit,
  onRemove,
}: {
  provider: Provider;
  onEdit: (p: Partial<Provider>) => void;
  onRemove: () => void;
}) {
  const [test, setTest] = useState("");
  const runTest = async () => {
    setTest("testing");
    try {
      setTest(await api.testProvider(provider));
    } catch (e) {
      setTest(String(e));
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        <div className="flex items-center gap-2">
          <Input
            value={provider.name}
            onChange={(e) => onEdit({ name: e.target.value })}
            className="max-w-[220px] font-medium"
          />
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={runTest}>
            测试
          </Button>
          <Button variant="ghost" size="icon" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>
        <Labeled label="接口地址 (Base URL)">
          <Input
            value={provider.base_url}
            onChange={(e) => onEdit({ base_url: e.target.value })}
          />
        </Labeled>
        <Labeled label="API Key" hint="仅保存在本地的 Orbit 配置文件中。">
          <Input
            type="password"
            value={provider.api_key}
            onChange={(e) => onEdit({ api_key: e.target.value })}
            placeholder="sk-…"
          />
        </Labeled>
        {test && (
          <p className="text-muted-foreground text-xs">
            {test === "testing" ? "测试中…" : test}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---- 模型 -----------------------------------------------------------------

function ModelsSection({ settings, update }: SectionProps) {
  const addModel = (type: ModelType) =>
    update({
      ...settings,
      models: [
        ...settings.models,
        {
          id: uid(),
          provider_id: settings.providers[0]?.id ?? "",
          name: type === "asr" ? "语音识别" : "润色模型",
          model: type === "asr" ? "gpt-4o-transcribe" : "gpt-4o-mini",
          type,
          transport: "http",
          language: null,
        },
      ],
    });
  const edit = (id: string, patch: Partial<Model>) =>
    update({
      ...settings,
      models: settings.models.map((m) =>
        m.id === id ? { ...m, ...patch } : m,
      ),
    });
  const remove = (id: string) =>
    update({
      ...settings,
      models: settings.models.filter((m) => m.id !== id),
    });

  const asr = settings.models.filter((m) => m.type === "asr");
  const llm = settings.models.filter((m) => m.type === "llm");

  return (
    <Section
      title="模型"
      desc="配置语音识别（ASR）与大模型（LLM），再选择听写要用哪一个。"
    >
      {settings.providers.length === 0 && (
        <Empty>请先在「服务商」里添加一个，再到这里创建模型。</Empty>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Labeled label="当前语音识别 (ASR) 模型">
          <Select
            value={settings.asr_model_id ?? ""}
            onChange={(v) => update({ ...settings, asr_model_id: v || null })}
          >
            <option value="">— 无 —</option>
            {asr.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Labeled>
        <Labeled label="当前大模型 (LLM)">
          <Select
            value={settings.llm_model_id ?? ""}
            onChange={(v) => update({ ...settings, llm_model_id: v || null })}
          >
            <option value="">— 无 —</option>
            {llm.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Labeled>
      </div>

      <div className="flex items-center gap-2">
        <h3 className="text-muted-foreground text-sm font-medium">
          已配置的模型
        </h3>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => addModel("asr")}>
          <Plus className="size-4" />
          加 ASR
        </Button>
        <Button size="sm" variant="outline" onClick={() => addModel("llm")}>
          <Plus className="size-4" />
          加 LLM
        </Button>
      </div>

      {settings.models.length === 0 && <Empty>还没有配置任何模型。</Empty>}
      {[...asr, ...llm].map((m) => (
        <ModelCard
          key={m.id}
          model={m}
          providers={settings.providers}
          onEdit={(patch) => edit(m.id, patch)}
          onRemove={() => remove(m.id)}
        />
      ))}
    </Section>
  );
}

function ModelCard({
  model,
  providers,
  onEdit,
  onRemove,
}: {
  model: Model;
  providers: Provider[];
  onEdit: (p: Partial<Model>) => void;
  onRemove: () => void;
}) {
  return (
    <Card>
      <CardContent className="grid gap-3 pt-6 sm:grid-cols-2">
        <Labeled label="名称">
          <Input
            value={model.name}
            onChange={(e) => onEdit({ name: e.target.value })}
          />
        </Labeled>
        <Labeled label="模型 ID">
          <Input
            value={model.model}
            onChange={(e) => onEdit({ model: e.target.value })}
          />
        </Labeled>
        <Labeled label="服务商">
          <Select
            value={model.provider_id}
            onChange={(v) => onEdit({ provider_id: v })}
          >
            {providers.length === 0 && <option value="">— 无 —</option>}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Labeled>
        <Labeled label="类型">
          <Select
            value={model.type}
            onChange={(v) => onEdit({ type: v as ModelType })}
          >
            <option value="asr">语音识别 (ASR)</option>
            <option value="llm">大模型 (LLM)</option>
          </Select>
        </Labeled>
        {model.type === "asr" && (
          <Labeled label="传输方式">
            <Select
              value={model.transport}
              onChange={(v) => onEdit({ transport: v as Transport })}
            >
              <option value="http">HTTP（停止后上传）</option>
              <option value="realtime_ws">实时 WebSocket</option>
            </Select>
          </Labeled>
        )}
        {model.type === "asr" && (
          <Labeled label="语言" hint="可选，如 zh / en">
            <Input
              value={model.language ?? ""}
              onChange={(e) => onEdit({ language: e.target.value || null })}
            />
          </Labeled>
        )}
        <div className="flex justify-end sm:col-span-2">
          <Button variant="ghost" size="sm" onClick={onRemove}>
            <Trash2 className="size-4" />
            删除
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- 听写 -----------------------------------------------------------------

function DictationSection({ settings, update }: SectionProps) {
  const [capturing, setCapturing] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    api.listAudioInputs().then(setDevices).catch(() => {});
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    listen<string>("hotkey://captured", (e) => {
      update({ ...settingsRef.current, hotkey: e.payload });
      setCapturing(false);
    }).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [update]);

  const record = async () => {
    setCapturing(true);
    await api.startHotkeyCapture();
  };
  const cancelCapture = async () => {
    setCapturing(false);
    await api.cancelHotkeyCapture();
  };

  return (
    <Section
      title="听写"
      desc="按一下快捷键开始录音，再按一下（或点 ✓）进行识别。✗ 取消。"
    >
      <Card>
        <CardHeader>
          <CardTitle>快捷键</CardTitle>
          <CardDescription>
            可以是单独一个键（如右 ⌘），也可以录制任意按键。按一下开始，再按一下识别。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <code className="rounded-md bg-secondary px-3 py-1.5 text-sm">
            {hotkeyLabel(settings.hotkey)}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={record}
            disabled={capturing}
          >
            <Keyboard className="size-4" />
            {capturing ? "请按下任意键…" : "录制快捷键"}
          </Button>
          {capturing && (
            <Button variant="ghost" size="sm" onClick={cancelCapture}>
              取消
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Row
            label="自动输入结果"
            hint="把最终文本输入到当前聚焦的应用（需要辅助功能权限）。"
          >
            <Switch
              checked={settings.auto_insert}
              onCheckedChange={(v) => update({ ...settings, auto_insert: v })}
            />
          </Row>
          <Row
            label="用大模型润色"
            hint="在输入前，先让当前大模型把识别文本润色一遍。"
          >
            <Switch
              checked={settings.llm_polish_enabled}
              onCheckedChange={(v) =>
                update({ ...settings, llm_polish_enabled: v })
              }
            />
          </Row>
          <Labeled
            label="模板占位符"
            hint="提示词模板里 {{…}} 内使用的名称。"
          >
            <Input
              value={settings.insert_position}
              onChange={(e) =>
                update({ ...settings, insert_position: e.target.value })
              }
              className="max-w-[220px]"
            />
          </Labeled>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>麦克风</CardTitle>
          <CardDescription>Orbit 从系统默认输入设备录音。</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="text-muted-foreground space-y-1 text-sm">
            {devices.length ? (
              devices.map((d, i) => <li key={i}>• {d}</li>)
            ) : (
              <li>未检测到输入设备。</li>
            )}
          </ul>
        </CardContent>
      </Card>
    </Section>
  );
}

// ---- 提示词模板 -----------------------------------------------------------

function TemplatesSection({ settings, update }: SectionProps) {
  const placeholder = `{{${settings.insert_position}}}`;
  const add = () =>
    update({
      ...settings,
      templates: [
        ...settings.templates,
        { id: uid(), name: "新模板", template: placeholder },
      ],
    });
  const edit = (id: string, patch: Partial<{ name: string; template: string }>) =>
    update({
      ...settings,
      templates: settings.templates.map((t) =>
        t.id === id ? { ...t, ...patch } : t,
      ),
    });
  const remove = (id: string) =>
    update({
      ...settings,
      templates: settings.templates.filter((t) => t.id !== id),
    });

  return (
    <Section
      title="提示词模板"
      desc={`润色步骤用的可复用提示词。把 ${placeholder} 放在你希望插入识别文本的位置。`}
      action={
        <Button size="sm" onClick={add}>
          <Plus className="size-4" />
          添加模板
        </Button>
      }
    >
      <Labeled label="当前模板">
        <Select
          value={settings.active_template_id ?? ""}
          onChange={(v) => update({ ...settings, active_template_id: v || null })}
        >
          <option value="">— 无 —</option>
          {settings.templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Labeled>

      {settings.templates.map((t) => (
        <Card key={t.id}>
          <CardContent className="flex flex-col gap-3 pt-6">
            <div className="flex items-center gap-2">
              <Input
                value={t.name}
                onChange={(e) => edit(t.id, { name: e.target.value })}
                className="max-w-[260px] font-medium"
              />
              <div className="flex-1" />
              <Button variant="ghost" size="icon" onClick={() => remove(t.id)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
            <Textarea
              value={t.template}
              onChange={(e) => edit(t.id, { template: e.target.value })}
              className="min-h-28 font-mono text-xs"
            />
          </CardContent>
        </Card>
      ))}
    </Section>
  );
}
