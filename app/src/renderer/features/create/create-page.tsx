import { useCallback, useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Images, Library, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { providerImageModels } from "@/lib/model-capabilities";
import type {
  ImageGenerationRequest,
  MediaJob,
  ProviderAccount,
} from "@shared/contracts";

import { CreateGenerations } from "./create-generations";
import { CreateHome } from "./create-home";
import { CreateLibrary } from "./create-library";
import type {
  CreateController,
  CreateView,
  ImageProvider,
  ImageRatio,
} from "./create-types";

const OPENAI_RATIOS = ["1:1", "3:2", "2:3"] as const satisfies readonly ImageRatio[];
const GOOGLE_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const satisfies readonly ImageRatio[];
const FAVORITES_KEY = "tietiezhi-create-favorites";

const NAVIGATION: Array<{
  id: CreateView;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "inspiration", label: "灵感", icon: Sparkles },
  { id: "generations", label: "生成", icon: Images },
  { id: "assets", label: "资产", icon: Library },
];

function ratiosFor(provider: ImageProvider | undefined, model: string): readonly ImageRatio[] {
  const wireAPIs = provider?.modelMetadata[model]?.wireAPIs ?? [];
  return provider?.providerType === "google" || wireAPIs.includes("gemini_generate_content")
    ? GOOGLE_RATIOS
    : OPENAI_RATIOS;
}

function loadFavorites(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function CreatePage({ providerVersion }: { providerVersion: number }) {
  const [view, setView] = useState<CreateView>("inspiration");
  const [providers, setProviders] = useState<ProviderAccount[]>([]);
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<ImageRatio>("1:1");
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);

  const imageProviders = useMemo(
    () =>
      providers
        .map((provider): ImageProvider => ({
          ...provider,
          imageModels: providerImageModels(provider),
        }))
        .filter((provider) => provider.imageModels.length > 0),
    [providers],
  );
  const selectedProvider = imageProviders.find((provider) => provider.id === providerId);
  const ratios = useMemo(() => ratiosFor(selectedProvider, model), [model, selectedProvider]);
  const running = jobs.some((job) => job.status === "queued" || job.status === "running");

  const upsertJob = useCallback((job: MediaJob) => {
    setJobs((current) => [job, ...current.filter((candidate) => candidate.id !== job.id)]);
  }, []);

  useEffect(() => {
    void Promise.all([
      window.tietiezhi.providers.list(),
      window.tietiezhi.media.list(),
    ])
      .then(([nextProviders, nextJobs]) => {
        setProviders(nextProviders);
        setJobs(nextJobs);
        setProviderId((current) => {
          if (nextProviders.some((provider) => provider.id === current)) return current;
          return nextProviders.find((provider) => providerImageModels(provider).length > 0)?.id ?? "";
        });
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [providerVersion]);

  useEffect(
    () =>
      window.tietiezhi.onMediaEvent((event) => {
        if (event.type === "media.job.updated") {
          upsertJob(event.job);
        } else {
          setJobs((current) => current.filter((job) => job.id !== event.jobId));
        }
      }),
    [upsertJob],
  );

  useEffect(() => {
    if (!selectedProvider) {
      setModel("");
      return;
    }
    if (!selectedProvider.imageModels.includes(model)) {
      setModel(selectedProvider.imageModels[0] ?? "");
    }
  }, [model, selectedProvider]);

  useEffect(() => {
    if (!ratios.includes(ratio)) setRatio(ratios[0] ?? "1:1");
  }, [ratio, ratios]);

  const generate = useCallback(async () => {
    if (!prompt.trim() || !providerId || !model || busy || running) return;
    setBusy(true);
    setError("");
    try {
      const request: ImageGenerationRequest = {
        providerAccountId: providerId,
        model,
        prompt,
        aspectRatio: ratio,
        count,
      };
      const job = await window.tietiezhi.media.generateImage(request);
      upsertJob(job);
      setView("generations");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, count, model, prompt, providerId, ratio, running, upsertJob]);

  const retry = useCallback(async (id: string) => {
    setError("");
    try {
      upsertJob(await window.tietiezhi.media.retry(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [upsertJob]);

  const cancel = useCallback(async (id: string) => {
    setError("");
    try {
      await window.tietiezhi.media.cancel(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setError("");
    try {
      await window.tietiezhi.media.remove(id);
      setJobs((current) => current.filter((job) => job.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const reuse = useCallback((job: MediaJob) => {
    setProviderId(job.providerId);
    setModel(job.modelId);
    setPrompt(job.prompt);
    setRatio(job.aspectRatio ?? "1:1");
    setCount(job.count);
    setView("inspiration");
    requestAnimationFrame(() => document.getElementById("create-prompt")?.focus());
  }, []);

  const saveArtifact = useCallback(async (path: string) => {
    setError("");
    try {
      await window.tietiezhi.media.saveArtifact(path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const toggleFavorite = useCallback((artifactId: string) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(artifactId)) next.delete(artifactId);
      else next.add(artifactId);
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const controller: CreateController = {
    providers: imageProviders,
    jobs,
    providerId,
    model,
    prompt,
    ratio,
    ratios,
    count,
    busy,
    running,
    error,
    favorites,
    setProvider: setProviderId,
    setModel,
    setPrompt,
    setRatio,
    setCount,
    generate,
    retry,
    cancel,
    remove,
    reuse,
    saveArtifact,
    toggleFavorite,
  };
  const activeTasks = jobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  ).length;
  const assetCount = jobs.reduce((total, job) => total + job.artifacts.length, 0);

  return (
    <main className="flex h-full min-h-0 bg-[#0d0e11]">
      <aside className="flex w-20 shrink-0 flex-col items-center border-r border-white/6 bg-[#0b0c0f] px-2 py-5 text-white">
        <div className="grid size-9 place-items-center rounded-xl bg-linear-to-br from-cyan-300 via-sky-400 to-blue-600 text-slate-950 shadow-lg shadow-cyan-500/10">
          <Sparkles className="size-4" />
        </div>
        <nav className="mt-14 flex w-full flex-col gap-2">
          {NAVIGATION.map((item) => {
            const Icon = item.icon;
            const badge = item.id === "generations" ? activeTasks : item.id === "assets" ? assetCount : 0;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setView(item.id)}
                aria-current={view === item.id ? "page" : undefined}
                className={cn(
                  "relative flex h-14 w-full flex-col items-center justify-center gap-1 rounded-xl text-[10px] text-white/40 transition-[background-color,color,transform] hover:bg-white/5 hover:text-white/75 active:scale-[0.98]",
                  view === item.id && "bg-white/8 text-white hover:bg-white/8 hover:text-white",
                )}
              >
                <Icon className="size-4" />
                <span>{item.label}</span>
                {badge > 0 && (
                  <span
                    className={cn(
                      "absolute top-1.5 right-2 min-w-4 rounded-full bg-white/10 px-1 text-center text-[8px] leading-4 text-white/60",
                      item.id === "generations" && "bg-cyan-300 text-slate-950",
                    )}
                  >
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto h-8 w-px bg-linear-to-b from-transparent via-white/10 to-transparent" />
      </aside>
      <div className="min-w-0 flex-1">
        {view === "assets" ? (
          <CreateLibrary controller={controller} onCreate={() => setView("inspiration")} />
        ) : view === "generations" ? (
          <CreateGenerations controller={controller} />
        ) : (
          <CreateHome controller={controller} />
        )}
      </div>
    </main>
  );
}
