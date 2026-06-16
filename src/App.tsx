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
  { id: "providers", label: "Providers", icon: Server },
  { id: "models", label: "Models", icon: Boxes },
  { id: "dictation", label: "Dictation", icon: Keyboard },
  { id: "templates", label: "Templates", icon: FileText },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface SectionProps {
  settings: Settings;
  update: (s: Settings) => void;
}

const uid = () => crypto.randomUUID();

// macOS virtual keycode → friendly label (for the hotkey display).
const KEYCODE_LABELS: Record<string, string> = {
  "54": "Right ⌘",
  "55": "Left ⌘",
  "59": "Left ⌃",
  "62": "Right ⌃",
  "56": "Left ⇧",
  "60": "Right ⇧",
  "58": "Left ⌥",
  "61": "Right ⌥",
  "63": "Fn",
  "49": "Space",
  "36": "Return",
  "53": "Esc",
  "48": "Tab",
  "51": "Delete",
  "57": "Caps Lock",
};
const hotkeyLabel = (code: string) =>
  !code ? "—" : (KEYCODE_LABELS[code] ?? `Key ${code}`);

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
        Loading…
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
      <p className="text-muted-foreground/60 px-2 text-xs">Voice dictation</p>
    </aside>
  );
}

// ---- Shared layout helpers -------------------------------------------------

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

// ---- Providers -------------------------------------------------------------

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
      title="Providers"
      desc="Model vendors and endpoints. OpenAI is built in; any OpenAI-compatible endpoint works by changing the base URL."
      action={
        <Button size="sm" onClick={add}>
          <Plus className="size-4" />
          Add provider
        </Button>
      }
    >
      {settings.providers.length === 0 && (
        <Empty>No providers yet. Add one to get started.</Empty>
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
            Test
          </Button>
          <Button variant="ghost" size="icon" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>
        <Labeled label="Base URL">
          <Input
            value={provider.base_url}
            onChange={(e) => onEdit({ base_url: e.target.value })}
          />
        </Labeled>
        <Labeled label="API key" hint="Stored locally in your Orbit config file.">
          <Input
            type="password"
            value={provider.api_key}
            onChange={(e) => onEdit({ api_key: e.target.value })}
            placeholder="sk-…"
          />
        </Labeled>
        {test && (
          <p className="text-muted-foreground text-xs">
            {test === "testing" ? "Testing…" : test}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Models ----------------------------------------------------------------

function ModelsSection({ settings, update }: SectionProps) {
  const addModel = (type: ModelType) =>
    update({
      ...settings,
      models: [
        ...settings.models,
        {
          id: uid(),
          provider_id: settings.providers[0]?.id ?? "",
          name: type === "asr" ? "Transcribe" : "Polish model",
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
      title="Models"
      desc="Configure speech (ASR) and language (LLM) models, then pick which ones dictation uses."
    >
      {settings.providers.length === 0 && (
        <Empty>Add a provider first, then create models here.</Empty>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Labeled label="Active ASR model">
          <Select
            value={settings.asr_model_id ?? ""}
            onChange={(v) => update({ ...settings, asr_model_id: v || null })}
          >
            <option value="">— none —</option>
            {asr.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Labeled>
        <Labeled label="Active LLM model">
          <Select
            value={settings.llm_model_id ?? ""}
            onChange={(v) => update({ ...settings, llm_model_id: v || null })}
          >
            <option value="">— none —</option>
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
          Configured models
        </h3>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => addModel("asr")}>
          <Plus className="size-4" />
          ASR
        </Button>
        <Button size="sm" variant="outline" onClick={() => addModel("llm")}>
          <Plus className="size-4" />
          LLM
        </Button>
      </div>

      {settings.models.length === 0 && <Empty>No models configured yet.</Empty>}
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
        <Labeled label="Name">
          <Input
            value={model.name}
            onChange={(e) => onEdit({ name: e.target.value })}
          />
        </Labeled>
        <Labeled label="Model id">
          <Input
            value={model.model}
            onChange={(e) => onEdit({ model: e.target.value })}
          />
        </Labeled>
        <Labeled label="Provider">
          <Select
            value={model.provider_id}
            onChange={(v) => onEdit({ provider_id: v })}
          >
            {providers.length === 0 && <option value="">— none —</option>}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Labeled>
        <Labeled label="Type">
          <Select
            value={model.type}
            onChange={(v) => onEdit({ type: v as ModelType })}
          >
            <option value="asr">ASR (speech)</option>
            <option value="llm">LLM (text)</option>
          </Select>
        </Labeled>
        {model.type === "asr" && (
          <Labeled label="Transport">
            <Select
              value={model.transport}
              onChange={(v) => onEdit({ transport: v as Transport })}
            >
              <option value="http">HTTP (upload after stop)</option>
              <option value="realtime_ws">Realtime WebSocket</option>
            </Select>
          </Labeled>
        )}
        {model.type === "asr" && (
          <Labeled label="Language" hint="optional, e.g. zh / en">
            <Input
              value={model.language ?? ""}
              onChange={(e) => onEdit({ language: e.target.value || null })}
            />
          </Labeled>
        )}
        <div className="flex justify-end sm:col-span-2">
          <Button variant="ghost" size="sm" onClick={onRemove}>
            <Trash2 className="size-4" />
            Remove
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- Dictation -------------------------------------------------------------

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
      title="Dictation"
      desc="Press your shortcut to start recording, press it again (or ✓) to transcribe. ✗ cancels."
    >
      <Card>
        <CardHeader>
          <CardTitle>Shortcut</CardTitle>
          <CardDescription>
            A single key like right ⌘, or any key you record. Press it once to
            start, again to transcribe.
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
            {capturing ? "Press any key…" : "Record shortcut"}
          </Button>
          {capturing && (
            <Button variant="ghost" size="sm" onClick={cancelCapture}>
              Cancel
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Row
            label="Auto-insert result"
            hint="Type the final text into the focused app (needs Accessibility permission)."
          >
            <Switch
              checked={settings.auto_insert}
              onCheckedChange={(v) => update({ ...settings, auto_insert: v })}
            />
          </Row>
          <Row
            label="Polish with LLM"
            hint="Send the transcript through the active LLM model before inserting."
          >
            <Switch
              checked={settings.llm_polish_enabled}
              onCheckedChange={(v) =>
                update({ ...settings, llm_polish_enabled: v })
              }
            />
          </Row>
          <Labeled
            label="Template placeholder"
            hint="Token name used inside {{…}} in prompt templates."
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
          <CardTitle>Microphone</CardTitle>
          <CardDescription>
            Orbit records from the system default input device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="text-muted-foreground space-y-1 text-sm">
            {devices.length ? (
              devices.map((d, i) => <li key={i}>• {d}</li>)
            ) : (
              <li>No input devices detected.</li>
            )}
          </ul>
        </CardContent>
      </Card>
    </Section>
  );
}

// ---- Templates -------------------------------------------------------------

function TemplatesSection({ settings, update }: SectionProps) {
  const placeholder = `{{${settings.insert_position}}}`;
  const add = () =>
    update({
      ...settings,
      templates: [
        ...settings.templates,
        { id: uid(), name: "New template", template: placeholder },
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
      title="Prompt templates"
      desc={`Reusable prompts for the polish step. Put ${placeholder} where the transcript should go.`}
      action={
        <Button size="sm" onClick={add}>
          <Plus className="size-4" />
          Add template
        </Button>
      }
    >
      <Labeled label="Active template">
        <Select
          value={settings.active_template_id ?? ""}
          onChange={(v) => update({ ...settings, active_template_id: v || null })}
        >
          <option value="">— none —</option>
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
