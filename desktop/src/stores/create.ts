import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChatAttachment, CreateVideoGenerationEvent } from "@/lib/api";
import {
  cancelCreateGeneration,
  deleteCreateAssetFile,
  errorMessage,
  exportCreateAsset,
  generateCreateImage,
  generateCreateVideo,
} from "@/lib/api";
import { notifyActionableGatewayError } from "@/lib/gateway-feedback";

export type CreateView = "inspiration" | "generations" | "assets";
export type CreateMode = "image" | "video";
export type CreateAspectRatio =
  | "1:1"
  | "4:3"
  | "3:4"
  | "16:9"
  | "9:16"
  | "21:9";
export type CreateQuality = "standard" | "high";
export type CreateTaskStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface CreateReference {
  id: string;
  name: string;
  mimeType: string;
  path: string;
  dataUrl?: string;
}

export interface CreateDraft {
  mode: CreateMode;
  prompt: string;
  modelProviderId: string;
  model: string;
  aspectRatio: CreateAspectRatio;
  quality: CreateQuality;
  resultCount: number;
  durationSeconds: number;
  references: CreateReference[];
}

export interface CreateTask {
  id: string;
  requestId: number;
  mode: CreateMode;
  prompt: string;
  modelProviderId: string;
  model: string;
  aspectRatio: CreateAspectRatio;
  quality: CreateQuality;
  resultCount: number;
  durationSeconds: number;
  referencePaths: string[];
  referenceNames: string[];
  status: CreateTaskStatus;
  progress: number;
  createdAt: number;
  updatedAt: number;
  error: string;
  assetIds: string[];
}

export interface CreateAsset {
  id: string;
  taskId: string;
  title: string;
  mode: CreateMode;
  prompt: string;
  createdAt: number;
  favorite: boolean;
  filePath?: string;
  mimeType?: string;
  previewDataUrl?: string;
  modelProviderId?: string;
  model?: string;
  aspectRatio: CreateAspectRatio;
  durationSeconds?: number;
}

export type CreateDraftPatch = Partial<
  Omit<CreateDraft, "mode" | "references">
>;

interface GenerateOverrides {
  mode: CreateMode;
  prompt: string;
  modelProviderId: string;
  model: string;
  aspectRatio: CreateAspectRatio;
  quality: CreateQuality;
  resultCount: number;
  durationSeconds: number;
  referencePaths: string[];
  referenceNames: string[];
}

interface CreateState {
  view: CreateView;
  mode: CreateMode;
  drafts: Record<CreateMode, CreateDraft>;
  tasks: CreateTask[];
  assets: CreateAsset[];
  composerError: string;
  libraryError: string;
  setView: (view: CreateView) => void;
  setMode: (mode: CreateMode) => void;
  updateDraft: (mode: CreateMode, patch: CreateDraftPatch) => void;
  addReferences: (mode: CreateMode, attachments: ChatAttachment[]) => void;
  removeReference: (mode: CreateMode, id: string) => void;
  clearReferences: (mode: CreateMode) => void;
  usePrompt: (mode: CreateMode, prompt: string) => void;
  generate: () => Promise<void>;
  retryTask: (id: string) => Promise<void>;
  cancelTask: (id: string) => Promise<void>;
  reuseTask: (id: string) => void;
  reuseAsset: (id: string) => void;
  toggleAssetFavorite: (id: string) => void;
  removeAsset: (id: string) => Promise<void>;
  exportAsset: (id: string) => Promise<void>;
  clearLibraryError: () => void;
}

const DEFAULT_DRAFTS: Record<CreateMode, CreateDraft> = {
  image: {
    mode: "image",
    prompt: "",
    modelProviderId: "",
    model: "",
    aspectRatio: "1:1",
    quality: "high",
    resultCount: 4,
    durationSeconds: 5,
    references: [],
  },
  video: {
    mode: "video",
    prompt: "",
    modelProviderId: "",
    model: "",
    aspectRatio: "16:9",
    quality: "standard",
    resultCount: 1,
    durationSeconds: 5,
    references: [],
  },
};

let nextRequestId = 1;

function uid(): string {
  return crypto.randomUUID();
}

function cloneDefaultDraft(mode: CreateMode): CreateDraft {
  return { ...DEFAULT_DRAFTS[mode], references: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMode(value: unknown): value is CreateMode {
  return value === "image" || value === "video";
}

function isAspectRatio(value: unknown): value is CreateAspectRatio {
  return (
    value === "1:1" ||
    value === "4:3" ||
    value === "3:4" ||
    value === "16:9" ||
    value === "9:16" ||
    value === "21:9"
  );
}

function isCreateAsset(value: unknown): value is CreateAsset {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.prompt === "string" &&
    isMode(value.mode)
  );
}

function isCreateTask(value: unknown): value is CreateTask {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.prompt === "string" &&
    isMode(value.mode) &&
    Array.isArray(value.assetIds)
  );
}

function referenceFromAttachment(attachment: ChatAttachment): CreateReference | null {
  if (attachment.kind !== "image" || !attachment.path) return null;
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    path: attachment.path,
    dataUrl: attachment.dataUrl,
  };
}

function overridesFromDraft(draft: CreateDraft): GenerateOverrides {
  return {
    mode: draft.mode,
    prompt: draft.prompt.trim(),
    modelProviderId: draft.modelProviderId,
    model: draft.model,
    aspectRatio: draft.aspectRatio,
    quality: draft.quality,
    resultCount: draft.mode === "image" ? draft.resultCount : 1,
    durationSeconds: draft.durationSeconds,
    referencePaths: draft.references.map((reference) => reference.path),
    referenceNames: draft.references.map((reference) => reference.name),
  };
}

function overridesFromTask(task: CreateTask): GenerateOverrides {
  return {
    mode: task.mode,
    prompt: task.prompt,
    modelProviderId: task.modelProviderId,
    model: task.model,
    aspectRatio: task.aspectRatio,
    quality: task.quality,
    resultCount: task.resultCount,
    durationSeconds: task.durationSeconds,
    referencePaths: task.referencePaths,
    referenceNames: task.referenceNames,
  };
}

function titleFromPrompt(prompt: string, mode: CreateMode, index: number): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  const base = normalized.length > 26 ? `${normalized.slice(0, 26)}…` : normalized;
  return `${base || (mode === "image" ? "图片创作" : "视频创作")}${index > 0 ? ` · ${index + 1}` : ""}`;
}

function taskErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  return message || "生成失败，请稍后重试";
}

function reportGenerationError(error: unknown): string {
  const detail = taskErrorMessage(error);
  notifyActionableGatewayError(detail);
  return detail;
}

function normalizeDraft(value: unknown, mode: CreateMode): CreateDraft {
  const fallback = cloneDefaultDraft(mode);
  if (!isRecord(value)) return fallback;
  return {
    ...fallback,
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    modelProviderId:
      typeof value.modelProviderId === "string" ? value.modelProviderId : "",
    model: typeof value.model === "string" ? value.model : "",
    aspectRatio: isAspectRatio(value.aspectRatio)
      ? value.aspectRatio
      : fallback.aspectRatio,
    quality: value.quality === "standard" ? "standard" : "high",
    resultCount:
      typeof value.resultCount === "number"
        ? Math.min(4, Math.max(1, Math.round(value.resultCount)))
        : fallback.resultCount,
    durationSeconds:
      typeof value.durationSeconds === "number"
        ? Math.max(1, Math.round(value.durationSeconds))
        : fallback.durationSeconds,
    references: [],
  };
}

export const useCreateStore = create<CreateState>()(
  persist(
    (set, get) => {
      const runGeneration = async (input: GenerateOverrides) => {
        if (!input.prompt) {
          set({ composerError: "先描述你想生成的画面或镜头。" });
          return;
        }

        const requestId = nextRequestId++;
        const taskId = uid();
        const timestamp = Date.now();
        const task: CreateTask = {
          id: taskId,
          requestId,
          mode: input.mode,
          prompt: input.prompt,
          modelProviderId: input.modelProviderId,
          model: input.model,
          aspectRatio: input.aspectRatio,
          quality: input.quality,
          resultCount: input.resultCount,
          durationSeconds: input.durationSeconds,
          referencePaths: input.referencePaths,
          referenceNames: input.referenceNames,
          status: "queued",
          progress: 2,
          createdAt: timestamp,
          updatedAt: timestamp,
          error: "",
          assetIds: [],
        };
        set((state) => ({
          view: "generations",
          composerError: "",
          tasks: [task, ...state.tasks].slice(0, 100),
        }));

        const updateTask = (patch: Partial<CreateTask>) => {
          set((state) => ({
            tasks: state.tasks.map((candidate) =>
              candidate.id === taskId
                ? candidate.status === "cancelled" && patch.status !== "cancelled"
                  ? candidate
                  : { ...candidate, ...patch, updatedAt: Date.now() }
                : candidate,
            ),
          }));
        };

        try {
          if (input.mode === "image") {
            updateTask({ status: "running", progress: 18 });
            const results = await generateCreateImage({
              providerId: input.modelProviderId,
              model: input.model,
              prompt: input.prompt,
              aspectRatio: input.aspectRatio,
              quality: input.quality,
              resultCount: input.resultCount,
              referencePaths: input.referencePaths,
            });
            if (results.length === 0) throw new Error("图片模型没有返回生成结果");
            const createdAt = Date.now();
            const assets = results.map((result, index): CreateAsset => ({
              id: uid(),
              taskId,
              title: titleFromPrompt(input.prompt, "image", index),
              mode: "image",
              prompt: result.revisedPrompt?.trim() || input.prompt,
              createdAt: createdAt + index,
              favorite: false,
              filePath: result.filePath || undefined,
              mimeType: result.mimeType,
              previewDataUrl: result.previewDataUrl,
              modelProviderId: result.providerId,
              model: result.model,
              aspectRatio: input.aspectRatio,
            }));
            set((state) => ({
              assets: [...assets].reverse().concat(state.assets),
              tasks: state.tasks.map((candidate) =>
                candidate.id === taskId
                  ? {
                      ...candidate,
                      modelProviderId: results[0]?.providerId ?? candidate.modelProviderId,
                      model: results[0]?.model ?? candidate.model,
                      status: "done",
                      progress: 100,
                      updatedAt: createdAt,
                      assetIds: assets.map((asset) => asset.id),
                    }
                  : candidate,
              ),
            }));
            return;
          }

          updateTask({ status: "running", progress: 4 });
          await generateCreateVideo({
            requestId,
            providerId: input.modelProviderId,
            model: input.model,
            prompt: input.prompt,
            aspectRatio: input.aspectRatio,
            quality: input.quality,
            durationSeconds: input.durationSeconds,
            referencePath: input.referencePaths[0],
            onEvent: (event: CreateVideoGenerationEvent) => {
              if (event.type === "started") {
                updateTask({
                  status: "running",
                  progress: 5,
                  modelProviderId: event.providerId,
                  model: event.model,
                });
                return;
              }
              if (event.type === "progress") {
                updateTask({
                  status: "running",
                  progress: Math.min(99, Math.max(5, event.progress)),
                });
                return;
              }
              if (event.type === "cancelled") {
                updateTask({ status: "cancelled", progress: 0 });
                return;
              }
              if (event.type === "error") {
                updateTask({
                  status: "error",
                  progress: 0,
                  error: reportGenerationError(event.message),
                });
                return;
              }

              const createdAt = Date.now();
              const asset: CreateAsset = {
                id: uid(),
                taskId,
                title: titleFromPrompt(input.prompt, "video", 0),
                mode: "video",
                prompt: input.prompt,
                createdAt,
                favorite: false,
                filePath: event.result.filePath,
                mimeType: event.result.mimeType,
                modelProviderId: event.result.providerId,
                model: event.result.model,
                aspectRatio: input.aspectRatio,
                durationSeconds: event.result.durationSeconds,
              };
              set((state) => ({
                assets: state.tasks.some(
                  (candidate) =>
                    candidate.id === taskId && candidate.status === "cancelled",
                )
                  ? state.assets
                  : [asset, ...state.assets],
                tasks: state.tasks.map((candidate) =>
                  candidate.id === taskId
                    ? candidate.status === "cancelled"
                      ? candidate
                      : {
                        ...candidate,
                        status: "done",
                        progress: 100,
                        updatedAt: createdAt,
                        modelProviderId: event.result.providerId,
                        model: event.result.model,
                        assetIds: [asset.id],
                      }
                    : candidate,
                ),
              }));
            },
          });
        } catch (error) {
          updateTask({
            status: "error",
            progress: 0,
            error: reportGenerationError(error),
          });
        }
      };

      return {
        view: "inspiration",
        mode: "image",
        drafts: {
          image: cloneDefaultDraft("image"),
          video: cloneDefaultDraft("video"),
        },
        tasks: [],
        assets: [],
        composerError: "",
        libraryError: "",
        setView: (view) => set({ view }),
        setMode: (mode) => set({ mode, composerError: "" }),
        updateDraft: (mode, patch) =>
          set((state) => ({
            drafts: {
              ...state.drafts,
              [mode]: { ...state.drafts[mode], ...patch },
            },
            composerError: "",
          })),
        addReferences: (mode, attachments) => {
          const references = attachments
            .map(referenceFromAttachment)
            .filter((reference): reference is CreateReference => reference !== null);
          if (references.length === 0) return;
          set((state) => {
            const limit = mode === "image" ? 4 : 1;
            const current = state.drafts[mode].references;
            const next = [...current];
            for (const reference of references) {
              if (next.some((candidate) => candidate.path === reference.path)) continue;
              next.push(reference);
            }
            return {
              drafts: {
                ...state.drafts,
                [mode]: { ...state.drafts[mode], references: next.slice(0, limit) },
              },
              composerError: "",
            };
          });
        },
        removeReference: (mode, id) =>
          set((state) => ({
            drafts: {
              ...state.drafts,
              [mode]: {
                ...state.drafts[mode],
                references: state.drafts[mode].references.filter(
                  (reference) => reference.id !== id,
                ),
              },
            },
          })),
        clearReferences: (mode) =>
          set((state) => ({
            drafts: {
              ...state.drafts,
              [mode]: { ...state.drafts[mode], references: [] },
            },
          })),
        usePrompt: (mode, prompt) =>
          set((state) => ({
            view: "inspiration",
            mode,
            drafts: {
              ...state.drafts,
              [mode]: { ...state.drafts[mode], prompt },
            },
            composerError: "",
          })),
        generate: async () => {
          const state = get();
          await runGeneration(overridesFromDraft(state.drafts[state.mode]));
        },
        retryTask: async (id) => {
          const task = get().tasks.find((candidate) => candidate.id === id);
          if (!task || task.status === "queued" || task.status === "running") return;
          await runGeneration(overridesFromTask(task));
        },
        cancelTask: async (id) => {
          const task = get().tasks.find((candidate) => candidate.id === id);
          if (
            !task ||
            task.mode !== "video" ||
            (task.status !== "queued" && task.status !== "running")
          ) {
            return;
          }
          set((state) => ({
            tasks: state.tasks.map((candidate) =>
              candidate.id === id
                ? { ...candidate, status: "cancelled", progress: 0, updatedAt: Date.now() }
                : candidate,
            ),
          }));
          await cancelCreateGeneration(task.requestId);
        },
        reuseTask: (id) => {
          const task = get().tasks.find((candidate) => candidate.id === id);
          if (!task) return;
          set((state) => ({
            view: "inspiration",
            mode: task.mode,
            drafts: {
              ...state.drafts,
              [task.mode]: {
                ...state.drafts[task.mode],
                prompt: task.prompt,
                modelProviderId: task.modelProviderId,
                model: task.model,
                aspectRatio: task.aspectRatio,
                quality: task.quality,
                resultCount: task.resultCount,
                durationSeconds: task.durationSeconds,
                references: [],
              },
            },
          }));
        },
        reuseAsset: (id) => {
          const asset = get().assets.find((candidate) => candidate.id === id);
          if (!asset) return;
          set((state) => ({
            view: "inspiration",
            mode: asset.mode,
            drafts: {
              ...state.drafts,
              [asset.mode]: {
                ...state.drafts[asset.mode],
                prompt: asset.prompt,
                modelProviderId: asset.modelProviderId ?? "",
                model: asset.model ?? "",
                aspectRatio: asset.aspectRatio,
                durationSeconds:
                  asset.durationSeconds ?? state.drafts[asset.mode].durationSeconds,
                references: [],
              },
            },
          }));
        },
        toggleAssetFavorite: (id) =>
          set((state) => ({
            assets: state.assets.map((asset) =>
              asset.id === id ? { ...asset, favorite: !asset.favorite } : asset,
            ),
          })),
        removeAsset: async (id) => {
          const asset = get().assets.find((candidate) => candidate.id === id);
          if (!asset) return;
          try {
            if (asset.filePath) await deleteCreateAssetFile(asset.filePath);
            set((state) => ({
              assets: state.assets.filter((candidate) => candidate.id !== id),
              tasks: state.tasks.map((task) => ({
                ...task,
                assetIds: task.assetIds.filter((assetId) => assetId !== id),
              })),
              libraryError: "",
            }));
          } catch (error) {
            set({ libraryError: taskErrorMessage(error) });
          }
        },
        exportAsset: async (id) => {
          const asset = get().assets.find((candidate) => candidate.id === id);
          if (!asset?.filePath) {
            set({ libraryError: "当前作品没有可导出的本地文件。" });
            return;
          }
          try {
            await exportCreateAsset(asset.filePath);
            set({ libraryError: "" });
          } catch (error) {
            set({ libraryError: taskErrorMessage(error) });
          }
        },
        clearLibraryError: () => set({ libraryError: "" }),
      };
    },
    {
      name: "tietiezhi-create",
      version: 4,
      partialize: (state) => ({
        view: state.view,
        mode: state.mode,
        drafts: {
          image: { ...state.drafts.image, references: [] as CreateReference[] },
          video: { ...state.drafts.video, references: [] as CreateReference[] },
        },
        tasks: state.tasks.filter(
          (task) => task.status !== "queued" && task.status !== "running",
        ),
        assets: state.assets,
      }),
      migrate: (persisted) => {
        const previous = isRecord(persisted) ? persisted : {};
        const mode = isMode(previous.mode) ? previous.mode : "image";
        const previousDrafts = isRecord(previous.drafts) ? previous.drafts : {};
        const tasks = Array.isArray(previous.tasks)
          ? previous.tasks.filter(isCreateTask).map((task) => ({
              ...task,
              status:
                task.status === "queued" || task.status === "running"
                  ? ("error" as const)
                  : task.status,
              error:
                task.status === "queued" || task.status === "running"
                  ? "应用已重启，请重新生成。"
                  : task.error,
              progress:
                task.status === "queued" || task.status === "running"
                  ? 0
                  : task.progress,
            }))
          : [];
        const assets = Array.isArray(previous.assets)
          ? previous.assets.flatMap((value): CreateAsset[] => {
              if (isCreateAsset(value)) return [value];
              if (!isRecord(value)) return [];
              const legacyMode = value.modality;
              if (!isMode(legacyMode)) return [];
              if (typeof value.id !== "string" || typeof value.title !== "string") {
                return [];
              }
              const hasSource =
                typeof value.filePath === "string" ||
                typeof value.previewDataUrl === "string";
              if (!hasSource) return [];
              return [{
                id: value.id,
                taskId: "",
                title: value.title,
                mode: legacyMode,
                prompt: typeof value.prompt === "string" ? value.prompt : "",
                createdAt:
                  typeof value.createdAt === "number" ? value.createdAt : Date.now(),
                favorite: value.favorite === true,
                filePath:
                  typeof value.filePath === "string" ? value.filePath : undefined,
                mimeType:
                  typeof value.mimeType === "string" ? value.mimeType : undefined,
                previewDataUrl:
                  typeof value.previewDataUrl === "string"
                    ? value.previewDataUrl
                    : undefined,
                modelProviderId:
                  typeof value.modelProviderId === "string"
                    ? value.modelProviderId
                    : undefined,
                model: typeof value.model === "string" ? value.model : undefined,
                aspectRatio: "4:3",
              }];
            })
          : [];
        const view: CreateView =
          previous.view === "assets" || previous.view === "library"
            ? "assets"
            : previous.view === "generations"
              ? "generations"
              : "inspiration";
        return {
          view,
          mode,
          drafts: {
            image: normalizeDraft(previousDrafts.image, "image"),
            video: normalizeDraft(previousDrafts.video, "video"),
          },
          tasks,
          assets,
        };
      },
    },
  ),
);
