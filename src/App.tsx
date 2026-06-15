import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Satellite,
  Mic,
  Volume2,
  Eye,
  Image as ImageIcon,
  Clapperboard,
  AudioLines,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const satellites = [
  { icon: Mic, name: "Voice In", status: "Next up", desc: "System-wide ASR" },
  { icon: Volume2, name: "Voice Out", status: "Planned", desc: "TTS read-back" },
  { icon: Eye, name: "Vision", status: "Planned", desc: "Image understanding" },
  { icon: ImageIcon, name: "Image Gen", status: "Planned", desc: "Generate images" },
  { icon: Clapperboard, name: "Video", status: "Planned", desc: "Understand & generate" },
  { icon: AudioLines, name: "Audio", status: "Planned", desc: "Listen & reason" },
];

function App() {
  const [name, setName] = useState("");
  const [greetMsg, setGreetMsg] = useState("");
  const [options, setOptions] = useState({
    localFirst: true,
    llmPostProcess: false,
    pushToTalk: true,
  });

  async function greet() {
    setGreetMsg(await invoke("greet", { name }));
  }

  function toggle(key: keyof typeof options) {
    setOptions((o) => ({ ...o, [key]: !o[key] }));
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
        {/* Hero */}
        <header className="flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-3">
            <Satellite className="size-8 text-primary" />
            <h1 className="text-4xl font-bold tracking-tight">Orbit</h1>
          </div>
          <p className="text-muted-foreground max-w-md text-balance">
            An open, multimodal, decentralized agent platform — where every model
            is a satellite.
          </p>
        </header>

        {/* Rust ⇄ React bridge demo */}
        <Card>
          <CardHeader>
            <CardTitle>Rust ⇄ React bridge</CardTitle>
            <CardDescription>
              A live Tauri command — the frontend calls into the Rust core.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                greet();
              }}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder="Enter your name…"
              />
              <Button type="submit">Greet</Button>
            </form>
            {greetMsg && (
              <p className="text-muted-foreground mt-3 text-sm">{greetMsg}</p>
            )}
          </CardContent>
        </Card>

        {/* The constellation */}
        <section className="flex flex-col gap-3">
          <h2 className="text-muted-foreground text-sm font-medium uppercase tracking-wide">
            The constellation
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {satellites.map((s) => {
              const Icon = s.icon;
              return (
                <Card key={s.name} className="gap-2 py-4">
                  <CardContent className="flex flex-col gap-1">
                    <Icon className="size-5 text-primary" />
                    <div className="font-medium">{s.name}</div>
                    <div className="text-muted-foreground text-xs">{s.desc}</div>
                    <div className="text-muted-foreground/70 text-[11px]">
                      {s.status}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>

        {/* Everything is an Option */}
        <Card>
          <CardHeader>
            <CardTitle>Everything is an Option</CardTitle>
            <CardDescription>
              Every idea becomes a toggle. Defaults stay sane; you stay in control.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <OptionRow
              label="Local-first models"
              hint="Prefer on-device backends before reaching for the cloud"
              checked={options.localFirst}
              onToggle={() => toggle("localFirst")}
            />
            <OptionRow
              label="LLM post-processing"
              hint="Clean up transcripts with an LLM (off = raw & fast)"
              checked={options.llmPostProcess}
              onToggle={() => toggle("llmPostProcess")}
            />
            <OptionRow
              label="Push-to-talk"
              hint="Hold the hotkey to dictate, release to insert"
              checked={options.pushToTalk}
              onToggle={() => toggle("pushToTalk")}
            />
          </CardContent>
        </Card>

        <footer className="text-muted-foreground/60 text-center text-xs">
          Built with Tauri · Rust · React · shadcn/ui
        </footer>
      </div>
    </main>
  );
}

function OptionRow({
  label,
  hint,
  checked,
  onToggle,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </div>
      <Switch checked={checked} onCheckedChange={onToggle} />
    </div>
  );
}

export default App;
