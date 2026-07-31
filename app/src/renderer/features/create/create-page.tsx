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
    <main className="bg-background h-full min-h-0 overflow-hidden">
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center px-4 pb-12">
        <div
          aria-hidden="true"
          className="relative -mb-4 h-52 w-80 max-w-full motion-safe:animate-area-create-float"
        >
          <div className="absolute inset-x-16 bottom-7 h-5 rounded-full bg-black/20 blur-xl dark:bg-black/45" />
          <img
            src="./tietiezhi.png"
            alt=""
            decoding="async"
            draggable={false}
            className="relative mx-auto size-48 object-contain drop-shadow-[0_16px_28px_rgba(0,0,0,0.16)]"
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
