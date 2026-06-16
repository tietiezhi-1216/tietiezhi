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
const VOLC_RESOURCE = "volc.bigasr.sauc.duration";

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

function Sidebar({ tab, setTab }: { tab: TabId; setTab: (t: TabId) => void }) {
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
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">{title}</h2>
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

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
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
  disabled,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-[3px] disabled:opacity-50"
    >
      {children}
    </select>
  );
}

// ---- 服务商 ---------------------------------------------------------------

function ProvidersSection({ settings, update }: SectionProps) {
  const addOpenAI = () =>
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
          app_id: "",
          resource_id: "",
        },
      ],
    });
  const addVolcano = () =>
    update({
      ...settings,
      providers: [
        ...settings.providers,
        {
          id: uid(),
          name: "火山引擎",
          kind: "volcano",
          base_url: "",
          api_key: "",
          app_id: "",
          resource_id: VOLC_RESOURCE,
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
      action={
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={addOpenAI}>
            <Plus className="size-4" />
            OpenAI
          </Button>
          <Button size="sm" onClick={addVolcano}>
            <Plus className="size-4" />
            火山引擎
          </Button>
        </div>
      }
    >
      {settings.providers.length === 0 && (
        <Empty>还没有服务商，添加一个开始。</Empty>
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
  const isVolcano = provider.kind === "volcano";
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
            className="max-w-[200px] font-medium"
          />
          <span className="bg-secondary text-muted-foreground rounded px-2 py-0.5 text-xs">
            {isVolcano ? "火山引擎" : "OpenAI"}
          </span>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={runTest}>
            测试
          </Button>
          <Button variant="ghost" size="icon" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>

        {isVolcano ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label="AppID">
              <Input
                value={provider.app_id}
                onChange={(e) => onEdit({ app_id: e.target.value })}
              />
            </Labeled>
            <Labeled label="Access Token">
              <Input
                type="password"
                value={provider.api_key}
                onChange={(e) => onEdit({ api_key: e.target.value })}
              />
            </Labeled>
            <Labeled label="Resource ID">
              <Input
                value={provider.resource_id}
                onChange={(e) => onEdit({ resource_id: e.target.value })}
              />
            </Labeled>
          </div>
        ) : (
          <>
            <Labeled label="Base URL">
              <Input
                value={provider.base_url}
                onChange={(e) => onEdit({ base_url: e.target.value })}
              />
            </Labeled>
            <Labeled label="API Key">
              <Input
                type="password"
                value={provider.api_key}
                onChange={(e) => onEdit({ api_key: e.target.value })}
                placeholder="sk-…"
              />
            </Labeled>
          </>
        )}
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
  const [modelTab, setModelTab] = useState<ModelType>("asr");

  const addModel = () => {
    const provider = settings.providers[0];
    const isVolc = provider?.kind === "volcano";
    update({
      ...settings,
      models: [
        ...settings.models,
        {
          id: uid(),
          provider_id: provider?.id ?? "",
          name: modelTab === "asr" ? "语音识别" : "大模型",
          model:
            modelTab === "asr"
              ? isVolc
                ? "bigmodel"
                : "gpt-4o-transcribe"
              : "gpt-4o-mini",
          type: modelTab,
          transport: modelTab === "asr" && isVolc ? "volcano_ws" : "http",
          language: null,
        },
      ],
    });
  };
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

  const list = settings.models.filter((m) => m.type === modelTab);
  const activeId =
    modelTab === "asr" ? settings.asr_model_id : settings.llm_model_id;
  const setActive = (v: string) =>
    update(
      modelTab === "asr"
        ? { ...settings, asr_model_id: v || null }
        : { ...settings, llm_model_id: v || null },
    );

  return (
    <Section
      title="模型"
      action={
        <Button size="sm" onClick={addModel} disabled={!settings.providers.length}>
          <Plus className="size-4" />
          添加{modelTab === "asr" ? "语音识别" : "大模型"}
        </Button>
      }
    >
      <div className="bg-secondary/50 flex w-fit gap-1 rounded-lg p-1">
        {(["asr", "llm"] as ModelType[]).map((t) => (
          <button
            key={t}
            onClick={() => setModelTab(t)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              modelTab === t
                ? "bg-background shadow-sm"
                : "text-muted-foreground",
            )}
          >
            {t === "asr" ? "语音识别" : "大模型"}
          </button>
        ))}
      </div>

      {settings.providers.length === 0 && <Empty>请先添加服务商。</Empty>}

      <Labeled label={modelTab === "asr" ? "当前语音识别模型" : "当前大模型"}>
        <Select value={activeId ?? ""} onChange={setActive}>
          <option value="">— 无 —</option>
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Labeled>

      {list.length === 0 && settings.providers.length > 0 && (
        <Empty>还没有模型，点右上角添加。</Empty>
      )}
      {list.map((m) => (
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
  const provider = providers.find((p) => p.id === model.provider_id);
  const isVolcano = provider?.kind === "volcano";
  const [fetched, setFetched] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const loadModels = async () => {
    if (!provider) return;
    setLoading(true);
    try {
      setFetched(await api.fetchModels(provider));
    } catch (e) {
      console.error(e);
      setFetched([]);
    }
    setLoading(false);
  };

  const options = fetched.length
    ? fetched.includes(model.model)
      ? fetched
      : [model.model, ...fetched]
    : model.model
      ? [model.model]
      : [];

  return (
    <Card>
      <CardContent className="grid gap-3 pt-6 sm:grid-cols-2">
        <Labeled label="名称">
          <Input
            value={model.name}
            onChange={(e) => onEdit({ name: e.target.value })}
          />
        </Labeled>
        <Labeled label="服务商">
          <Select
            value={model.provider_id}
            onChange={(v) => {
              const np = providers.find((p) => p.id === v);
              const transport: Transport =
                np?.kind === "volcano"
                  ? "volcano_ws"
                  : model.transport === "volcano_ws"
                    ? "http"
                    : model.transport;
              onEdit({ provider_id: v, transport });
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Labeled>
        <Labeled label="模型">
          <div className="flex gap-2">
            <Select value={model.model} onChange={(v) => onEdit({ model: v })}>
              {options.length === 0 && <option value="">— 获取列表 —</option>}
              {options.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={loadModels}
              disabled={loading || !provider}
            >
              {loading ? "获取中…" : "获取列表"}
            </Button>
          </div>
        </Labeled>
        {model.type === "asr" && (
          <Labeled label="传输方式">
            {isVolcano ? (
              <Input value="火山引擎流式" disabled />
            ) : (
              <Select
                value={model.transport}
                onChange={(v) => onEdit({ transport: v as Transport })}
              >
                <option value="http">HTTP（停止后上传）</option>
                <option value="realtime_ws">实时 WebSocket</option>
              </Select>
            )}
          </Labeled>
        )}
        {model.type === "asr" && (
          <Labeled label="语言">
            <Input
              value={model.language ?? ""}
              onChange={(e) => onEdit({ language: e.target.value || null })}
              placeholder="zh / en"
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
    <Section title="听写">
      <Card>
        <CardHeader>
          <CardTitle>快捷键</CardTitle>
          <CardDescription>
            按一下开始录音，再按一下识别。可用单个键（如右 ⌘）或录制任意键。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <code className="bg-secondary rounded-md px-3 py-1.5 text-sm">
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
          <Row label="用大模型润色" hint="在输入前，用当前大模型把识别文本润色一遍。">
            <Switch
              checked={settings.llm_polish_enabled}
              onCheckedChange={(v) =>
                update({ ...settings, llm_polish_enabled: v })
              }
            />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>麦克风</CardTitle>
          <CardDescription>从系统默认输入设备录音。</CardDescription>
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
  const edit = (
    id: string,
    patch: Partial<{ name: string; template: string }>,
  ) =>
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
          onChange={(v) =>
            update({ ...settings, active_template_id: v || null })
          }
        >
          <option value="">— 无 —</option>
          {settings.templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Labeled>
      <p className="text-muted-foreground text-xs">
        用 {placeholder} 标记识别文本插入的位置。
      </p>

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
