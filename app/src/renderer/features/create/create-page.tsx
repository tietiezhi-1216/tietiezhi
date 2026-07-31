import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { providerImageModels } from "@/lib/model-capabilities";
import type {
  ImageGenerationRequest,
  MediaJob,
  ProviderAccount,
} from "@shared/contracts";

import { CreateAssetPreview } from "./create-asset-preview";
import { CreateComposer } from "./create-composer";
import type { CreateController, ImageProvider } from "./create-types";

const CREATE_STARS = [
  "top-[7%] left-[8%] size-1 motion-safe:[animation-delay:-0.4s]",
  "top-[13%] left-[19%] size-0.5 motion-safe:[animation-delay:-2.8s]",
  "top-[9%] left-[34%] size-1 motion-safe:[animation-delay:-1.6s]",
  "top-[17%] left-[47%] size-0.5 motion-safe:[animation-delay:-3.7s]",
  "top-[8%] left-[63%] size-1 motion-safe:[animation-delay:-4.2s]",
  "top-[15%] left-[78%] size-0.5 motion-safe:[animation-delay:-1.1s]",
  "top-[6%] left-[91%] size-1 motion-safe:[animation-delay:-3.2s]",
  "top-[27%] left-[4%] size-0.5 motion-safe:[animation-delay:-4.7s]",
  "top-[32%] left-[14%] size-1 motion-safe:[animation-delay:-1.9s]",
  "top-[25%] left-[28%] size-0.5 motion-safe:[animation-delay:-0.8s]",
  "top-[35%] left-[41%] size-1 motion-safe:[animation-delay:-3.4s]",
  "top-[29%] left-[57%] size-0.5 motion-safe:[animation-delay:-2.3s]",
  "top-[37%] left-[72%] size-1 motion-safe:[animation-delay:-4.4s]",
  "top-[26%] left-[86%] size-0.5 motion-safe:[animation-delay:-1.4s]",
  "top-[44%] left-[95%] size-1 motion-safe:[animation-delay:-3.9s]",
  "top-[49%] left-[7%] size-1 motion-safe:[animation-delay:-2.1s]",
  "top-[55%] left-[22%] size-0.5 motion-safe:[animation-delay:-4.9s]",
  "top-[46%] left-[36%] size-1 motion-safe:[animation-delay:-1.2s]",
  "top-[57%] left-[52%] size-0.5 motion-safe:[animation-delay:-3.1s]",
  "top-[48%] left-[68%] size-1 motion-safe:[animation-delay:-0.3s]",
  "top-[59%] left-[82%] size-0.5 motion-safe:[animation-delay:-4.1s]",
  "top-[68%] left-[3%] size-0.5 motion-safe:[animation-delay:-3.6s]",
  "top-[73%] left-[17%] size-1 motion-safe:[animation-delay:-0.9s]",
  "top-[65%] left-[31%] size-0.5 motion-safe:[animation-delay:-4.6s]",
  "top-[78%] left-[44%] size-1 motion-safe:[animation-delay:-2.5s]",
  "top-[69%] left-[61%] size-0.5 motion-safe:[animation-delay:-1.7s]",
  "top-[76%] left-[75%] size-1 motion-safe:[animation-delay:-3.3s]",
  "top-[67%] left-[93%] size-0.5 motion-safe:[animation-delay:-0.6s]",
  "top-[88%] left-[10%] size-1 motion-safe:[animation-delay:-4.3s]",
  "top-[91%] left-[26%] size-0.5 motion-safe:[animation-delay:-2.7s]",
  "top-[86%] left-[55%] size-1 motion-safe:[animation-delay:-1.3s]",
  "top-[92%] left-[88%] size-0.5 motion-safe:[animation-delay:-3.8s]",
] as const;

export function CreatePage({ providerVersion }: { providerVersion: number }) {
  const [providers, setProviders] = useState<ProviderAccount[]>([]);
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [activeJobId, setActiveJobId] = useState<string>();
  const [resultOpen, setResultOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const presentedJobId = useRef<string | undefined>(undefined);

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
  const selectedProvider = imageProviders.find(
    (provider) => provider.id === providerId,
  );
  const activeJob = jobs.find((job) => job.id === activeJobId);
  const running =
    activeJob?.status === "queued" || activeJob?.status === "running";

  const upsertJob = useCallback((job: MediaJob) => {
    setJobs((current) => [
      job,
      ...current.filter((candidate) => candidate.id !== job.id),
    ]);
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      window.tietiezhi.providers.list(),
      window.tietiezhi.media.list(),
    ])
      .then(([nextProviders, nextJobs]) => {
        if (!active) return;
        setProviders(nextProviders);
        setJobs(nextJobs);
        setActiveJobId(
          nextJobs.find(
            (job) => job.status === "queued" || job.status === "running",
          )?.id,
        );
        setProviderId((current) => {
          if (nextProviders.some((provider) => provider.id === current)) {
            return current;
          }
          return (
            nextProviders.find(
              (provider) => providerImageModels(provider).length > 0,
            )?.id ?? ""
          );
        });
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [providerVersion]);

  useEffect(
    () =>
      window.tietiezhi.onMediaEvent((event) => {
        if (event.type === "media.job.updated") {
          upsertJob(event.job);
          return;
        }
        setJobs((current) =>
          current.filter((job) => job.id !== event.jobId),
        );
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
    if (!activeJob) return;
    if (activeJob.status === "failed") {
      setError(activeJob.error?.message ?? "图片生成失败");
      return;
    }
    if (
      activeJob.status === "completed" &&
      activeJob.artifacts.length > 0 &&
      presentedJobId.current !== activeJob.id
    ) {
      presentedJobId.current = activeJob.id;
      setResultOpen(true);
    }
  }, [activeJob]);

  const generate = useCallback(async () => {
    if (!prompt.trim() || !providerId || !model || busy || running) return;
    setBusy(true);
    setError("");
    try {
      const request: ImageGenerationRequest = {
        providerAccountId: providerId,
        model,
        prompt: prompt.trim(),
        aspectRatio: "1:1",
        count: 1,
      };
      const job = await window.tietiezhi.media.generateImage(request);
      upsertJob(job);
      setActiveJobId(job.id);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, model, prompt, providerId, running, upsertJob]);

  const cancel = useCallback(async () => {
    if (!activeJobId) return;
    setError("");
    try {
      await window.tietiezhi.media.cancel(activeJobId);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [activeJobId]);

  const saveArtifact = useCallback(async (path: string) => {
    setError("");
    try {
      await window.tietiezhi.media.saveArtifact(path);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const controller: CreateController = {
    providers: imageProviders,
    providerId,
    model,
    prompt,
    busy,
    running,
    error,
    setProvider: setProviderId,
    setModel,
    setPrompt,
    generate,
    cancel,
  };
  const resultArtifact = activeJob?.artifacts[0];

  return (
    <main className="dark relative isolate h-full min-h-0 overflow-hidden bg-[#060912] text-white">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-8 overflow-hidden motion-safe:animate-create-star-drift"
      >
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_20%,rgba(21,105,153,0.2),transparent_52%)]" />
        <div className="absolute top-[18%] left-[20%] size-80 rounded-full bg-cyan-500/5 blur-3xl motion-safe:animate-pulse" />
        <div className="absolute right-[12%] bottom-[5%] size-96 rounded-full bg-blue-600/6 blur-3xl motion-safe:animate-pulse motion-safe:[animation-delay:-1.8s]" />
        {CREATE_STARS.map((className) => (
          <span
            key={className}
            className={`absolute rounded-full bg-white/80 shadow-[0_0_7px_rgba(125,211,252,0.9)] motion-safe:animate-create-star-twinkle ${className}`}
          />
        ))}
      </div>

      <div className="relative z-10 mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center px-4 pb-12">
        <div
          aria-hidden="true"
          className="relative -mb-4 h-52 w-80 max-w-full motion-safe:animate-area-create-float"
        >
          <div className="absolute inset-x-12 bottom-4 h-8 rounded-full bg-cyan-300/10 blur-2xl motion-safe:animate-pulse" />
          <div className="absolute inset-x-16 bottom-7 h-5 rounded-full bg-black/50 blur-xl" />
          <img
            src="./mode-mascots/paper-plane/create.png"
            alt=""
            decoding="async"
            draggable={false}
            className="absolute inset-x-0 top-0 mx-auto size-48 object-contain drop-shadow-[0_18px_30px_rgba(0,0,0,0.3)]"
          />
          <img
            src="./mode-mascots/paper-plane/create-blink.png"
            alt=""
            decoding="async"
            draggable={false}
            className="absolute inset-x-0 top-0 mx-auto size-48 object-contain opacity-0 drop-shadow-[0_18px_30px_rgba(0,0,0,0.3)] motion-safe:animate-create-mascot-blink"
          />
        </div>
        <CreateComposer controller={controller} />
      </div>

      <Dialog open={resultOpen} onOpenChange={setResultOpen}>
        {activeJob && resultArtifact && (
          <DialogContent className="max-w-2xl overflow-hidden p-0 sm:max-w-2xl">
            <CreateAssetPreview
              artifact={resultArtifact}
              alt={activeJob.prompt}
              thumbnail={false}
              className="max-h-[68vh] min-h-80 bg-black object-contain"
            />
            <div className="p-5 pt-0">
              <DialogHeader className="text-left">
                <DialogTitle>图片已生成</DialogTitle>
                <DialogDescription className="line-clamp-2">
                  {activeJob.prompt}
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setResultOpen(false)}
                >
                  继续创作
                </Button>
                <Button
                  type="button"
                  onClick={() => void saveArtifact(resultArtifact.filePath)}
                >
                  <Download />
                  导出图片
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}
