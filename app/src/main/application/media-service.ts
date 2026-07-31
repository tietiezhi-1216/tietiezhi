import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { app, dialog, nativeImage } from "electron";
import {
  experimental_generateVideo as generateVideo,
  generateImage,
} from "ai";

import type {
  AppError,
  ImageGenerationRequest,
  LocalMediaAsset,
  MediaArtifact,
  MediaEvent,
  MediaJob,
  MediaJobReference,
  MediaReferenceInput,
  MediaType,
  VideoGenerationRequest,
} from "@shared/contracts";
import {
  aspectRatioForResolution,
  mediaModelCapabilities,
} from "@shared/media-model-capabilities";

import {
  imageModel,
  imageProviderKind,
  videoModel,
} from "../engines/provider-factory.js";
import { AppDatabase } from "../infrastructure/database.js";
import { ProviderService } from "./provider-service.js";

function extension(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "video/webm") return ".webm";
  if (mimeType === "video/quicktime") return ".mov";
  if (mimeType.startsWith("video/")) return ".mp4";
  return ".png";
}

function mediaTypeForPath(path: string): MediaType | undefined {
  const suffix = extname(path).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(suffix)) return "image";
  if ([".mp4", ".webm", ".mov"].includes(suffix)) return "video";
  return undefined;
}

function mimeTypeForPath(path: string, type: MediaType): string {
  const suffix = extname(path).toLowerCase();
  if (suffix === ".jpg" || suffix === ".jpeg") return "image/jpeg";
  if (suffix === ".webp") return "image/webp";
  if (suffix === ".gif") return "image/gif";
  if (suffix === ".webm") return "video/webm";
  if (suffix === ".mov") return "video/quicktime";
  return type === "video" ? "video/mp4" : "image/png";
}

function openAIImageSize(
  aspectRatio: ImageGenerationRequest["aspectRatio"],
): `${number}x${number}` | undefined {
  if (aspectRatio === undefined) return undefined;
  if (aspectRatio === "1:1") return "1024x1024";
  if (aspectRatio === "3:2" || aspectRatio === "4:3" || aspectRatio === "16:9") {
    return "1536x1024";
  }
  if (aspectRatio === "2:3" || aspectRatio === "3:4" || aspectRatio === "9:16") {
    return "1024x1536";
  }
  throw new Error("当前图片模型不支持所选比例");
}

export class MediaService {
  readonly #controllers = new Map<string, AbortController>();
  readonly #tasks = new Map<string, Promise<void>>();
  #sink: (event: MediaEvent) => void = () => {};

  constructor(
    private readonly database: AppDatabase,
    private readonly providers: ProviderService,
  ) {}

  setEventSink(sink: (event: MediaEvent) => void): void {
    this.#sink = sink;
  }

  list(): MediaJob[] {
    return this.database.listMediaJobs();
  }

  listAssets(): LocalMediaAsset[] {
    return this.database.listMediaAssets();
  }

  async importAssets(): Promise<LocalMediaAsset[]> {
    const result = await dialog.showOpenDialog({
      title: "导入本地素材",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "图片与视频",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov"],
        },
      ],
    });
    if (result.canceled) return [];
    const imported: LocalMediaAsset[] = [];
    for (const sourcePath of result.filePaths) {
      const type = mediaTypeForPath(sourcePath);
      if (type === undefined) continue;
      const id = randomUUID();
      const directory = join(app.getPath("userData"), "media", "library", id);
      const filePath = join(directory, `original${extname(sourcePath).toLowerCase()}`);
      await mkdir(directory, { recursive: true });
      await copyFile(sourcePath, filePath);
      const image = type === "image" ? nativeImage.createFromPath(filePath) : undefined;
      const size = image?.isEmpty() === false ? image.getSize() : undefined;
      if (type === "image") {
        await MediaService.#writeThumbnail(await readFile(filePath), filePath);
      }
      const asset: LocalMediaAsset = {
        id,
        name: basename(sourcePath),
        type,
        source: "imported",
        filePath,
        mimeType: mimeTypeForPath(sourcePath, type),
        width: size?.width,
        height: size?.height,
        createdAt: Date.now(),
      };
      this.database.saveMediaAsset(asset);
      imported.push(asset);
    }
    return imported;
  }

  async removeAsset(id: string): Promise<void> {
    const asset = this.database.listMediaAssets().find((candidate) => candidate.id === id);
    if (asset === undefined) return;
    try {
      this.database.removeMediaAsset(id);
    } catch {
      throw new Error("该素材已被生成记录引用，暂时不能删除");
    }
    if (asset.source === "imported") {
      await rm(dirname(asset.filePath), { recursive: true, force: true });
    }
  }

  #references(
    input: MediaReferenceInput[] | undefined,
    model: string,
    mode: MediaType,
  ): MediaJobReference[] {
    const capabilities = mediaModelCapabilities(model, mode);
    const requested = input ?? [];
    if (requested.length > capabilities.maxReferences) {
      throw new Error(`当前模型最多支持 ${capabilities.maxReferences} 个参考素材`);
    }
    const assets = new Map(this.database.listMediaAssets().map((asset) => [asset.id, asset]));
    return requested.map((reference, order) => {
      const asset = assets.get(reference.assetId);
      if (asset === undefined) throw new Error("引用的素材不存在");
      if (!capabilities.acceptedReferenceTypes.includes(asset.type)) {
        throw new Error(`当前模型不支持${asset.type === "video" ? "视频" : "图片"}参考素材`);
      }
      if (!capabilities.referenceRoles.includes(reference.role)) {
        throw new Error("当前模型不支持所选素材角色");
      }
      return { ...reference, order, asset };
    });
  }

  async generateImage(input: ImageGenerationRequest): Promise<MediaJob> {
    const prompt = input.prompt.trim();
    if (prompt === "") throw new Error("图片描述不能为空");
    const provider = this.providers.require(input.providerAccountId);
    if (!provider.models.includes(input.model)) throw new Error("所选模型不属于当前供应商");
    const capabilities = mediaModelCapabilities(input.model, "image");
    const resolution = input.resolution ?? capabilities.defaultResolution;
    const aspectRatio =
      aspectRatioForResolution(resolution) ??
      input.aspectRatio ??
      capabilities.defaultAspectRatio;
    const quality = input.quality ?? capabilities.defaultQuality;
    const count = Math.max(1, Math.min(4, input.count ?? capabilities.defaultCount));
    const references = this.#references(input.references, input.model, "image");
    if (
      resolution !== undefined &&
      !capabilities.resolutions.some((option) => option.value === resolution)
    ) {
      throw new Error("当前图片模型不支持所选分辨率");
    }
    if (
      aspectRatio !== undefined &&
      capabilities.aspectRatios.length > 0 &&
      !capabilities.aspectRatios.some((option) => option.value === aspectRatio)
    ) {
      throw new Error("当前图片模型不支持所选比例");
    }
    if (
      quality !== undefined &&
      !capabilities.qualities.some((option) => option.value === quality)
    ) {
      throw new Error("当前图片模型不支持所选质量");
    }
    if (!capabilities.counts.some((option) => option.value === count)) {
      throw new Error("当前图片模型不支持所选生成数量");
    }
    const now = Date.now();
    const job: MediaJob = {
      id: randomUUID(),
      type: "image",
      providerId: provider.id,
      modelId: input.model,
      prompt,
      aspectRatio,
      resolution,
      quality,
      count,
      status: "running",
      createdAt: now,
      updatedAt: now,
      artifacts: [],
      references,
    };
    this.database.saveMediaJob(job);
    this.#publish(job);
    this.#start(job);
    return job;
  }

  async generateVideo(input: VideoGenerationRequest): Promise<MediaJob> {
    const prompt = input.prompt.trim();
    if (prompt === "") throw new Error("视频描述不能为空");
    const provider = this.providers.require(input.providerAccountId);
    if (!provider.models.includes(input.model)) throw new Error("所选模型不属于当前供应商");
    const capabilities = mediaModelCapabilities(input.model, "video");
    const resolution = input.resolution ?? capabilities.defaultResolution;
    let aspectRatio = input.aspectRatio ?? capabilities.defaultAspectRatio;
    let duration = Math.round(input.duration ?? capabilities.defaultDuration ?? 8);
    const count = Math.max(1, Math.min(4, input.count ?? capabilities.defaultCount));
    const references = this.#references(input.references, input.model, "video");
    if (
      resolution === "1920x1080" ||
      resolution === "3840x2160"
    ) {
      duration = 8;
    }
    if (input.model.toLowerCase().includes("veo-3.0") && resolution === "1920x1080") {
      aspectRatio = "16:9";
    }
    if (
      resolution !== undefined &&
      !capabilities.resolutions.some((option) => option.value === resolution)
    ) {
      throw new Error("当前视频模型不支持所选分辨率");
    }
    if (
      aspectRatio !== undefined &&
      !capabilities.aspectRatios.some((option) => option.value === aspectRatio)
    ) {
      throw new Error("当前视频模型不支持所选比例");
    }
    if (!capabilities.durations.some((option) => option.value === duration)) {
      throw new Error("当前视频模型不支持所选时长");
    }
    if (!capabilities.counts.some((option) => option.value === count)) {
      throw new Error("当前视频模型不支持所选生成数量");
    }
    const now = Date.now();
    const job: MediaJob = {
      id: randomUUID(),
      type: "video",
      providerId: provider.id,
      modelId: input.model,
      prompt,
      aspectRatio,
      resolution,
      duration,
      count,
      status: "running",
      createdAt: now,
      updatedAt: now,
      artifacts: [],
      references,
    };
    this.database.saveMediaJob(job);
    this.#publish(job);
    this.#start(job);
    return job;
  }

  #start(job: MediaJob): void {
    const task = this.#execute(job);
    this.#tasks.set(job.id, task);
    void task.finally(() => this.#tasks.delete(job.id));
  }

  async #execute(job: MediaJob): Promise<void> {
    const provider = this.providers.require(job.providerId);
    const controller = new AbortController();
    this.#controllers.set(job.id, controller);

    try {
      const apiKey = await this.providers.key(provider);
      const artifacts =
        job.type === "video"
          ? await this.#generateVideoArtifacts(job, apiKey, controller.signal)
          : await this.#generateImageArtifacts(job, apiKey, controller.signal);
      job.status = "completed";
      job.updatedAt = Date.now();
      job.artifacts = artifacts;
      this.database.saveMediaJob(job);
      this.#publish(job);
    } catch (error) {
      const mediaLabel = job.type === "video" ? "视频" : "图片";
      const failure: AppError = {
        code:
          controller.signal.aborted
            ? "CANCELLED"
            : job.type === "video"
              ? "VIDEO_GENERATION_FAILED"
              : "IMAGE_GENERATION_FAILED",
        message: controller.signal.aborted
          ? `${mediaLabel}生成已取消`
          : error instanceof Error
            ? error.message
            : String(error),
        retryable: !controller.signal.aborted,
      };
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.updatedAt = Date.now();
      job.error = failure;
      this.database.saveMediaJob(job);
      this.#publish(job);
    } finally {
      this.#controllers.delete(job.id);
    }
  }

  async #generateImageArtifacts(
    job: MediaJob,
    apiKey: string,
    abortSignal: AbortSignal,
  ): Promise<MediaArtifact[]> {
    const provider = this.providers.require(job.providerId);
    const kind = imageProviderKind(provider, job.modelId);
    const pixelResolution =
      job.resolution !== undefined && /^\d+x\d+$/.test(job.resolution)
        ? (job.resolution as `${number}x${number}`)
        : undefined;
    const googleImageSize =
      job.resolution !== undefined && /^(?:512|[124]K)$/.test(job.resolution)
        ? (job.resolution as "512" | "1K" | "2K" | "4K")
        : undefined;
    const dimensions =
      kind === "google"
        ? job.aspectRatio === undefined
          ? {}
          : { aspectRatio: job.aspectRatio }
        : { size: pixelResolution ?? openAIImageSize(job.aspectRatio) };
    const referenceImages = await Promise.all(
      job.references.map((reference) => readFile(reference.asset.filePath)),
    );
    const request = {
      model: imageModel(provider, apiKey, job.modelId),
      prompt:
        referenceImages.length === 0
          ? job.prompt
          : { text: job.prompt, images: referenceImages },
      n: job.count,
      ...dimensions,
      abortSignal,
    };
    const result =
      kind === "google" && googleImageSize !== undefined
        ? await generateImage({
            ...request,
            providerOptions: {
              google: {
                imageConfig: {
                  ...(job.aspectRatio === undefined
                    ? {}
                    : { aspectRatio: job.aspectRatio }),
                  imageSize: googleImageSize,
                },
              },
            },
          })
        : kind === "openai" && job.quality !== undefined
          ? await generateImage({
              ...request,
              providerOptions: { openai: { quality: job.quality } },
            })
          : await generateImage(request);
    return this.#writeArtifacts(job, result.images);
  }

  async #generateVideoArtifacts(
    job: MediaJob,
    apiKey: string,
    abortSignal: AbortSignal,
  ): Promise<MediaArtifact[]> {
    const provider = this.providers.require(job.providerId);
    if (job.resolution !== undefined && !/^\d+x\d+$/.test(job.resolution)) {
      throw new Error("视频模型需要像素分辨率");
    }
    const references = await Promise.all(
      job.references.map(async (reference) => ({
        ...reference,
        data: await readFile(reference.asset.filePath),
      })),
    );
    const frameImages = references
      .filter(
        (reference) =>
          reference.role === "first-frame" || reference.role === "last-frame",
      )
      .map((reference) => ({
        image: reference.data,
        frameType:
          reference.role === "first-frame"
            ? ("first_frame" as const)
            : ("last_frame" as const),
      }));
    const inputReferences = references
      .filter((reference) => reference.role === "reference")
      .map((reference) => ({
        data: reference.data,
        mediaType: reference.asset.mimeType,
      }));
    const result = await generateVideo({
      model: videoModel(provider, apiKey, job.modelId),
      prompt: job.prompt,
      n: job.count,
      aspectRatio: job.aspectRatio,
      resolution: job.resolution as `${number}x${number}` | undefined,
      duration: job.duration,
      frameImages: frameImages.length === 0 ? undefined : frameImages,
      inputReferences: inputReferences.length === 0 ? undefined : inputReferences,
      abortSignal,
    });
    return this.#writeArtifacts(job, result.videos);
  }

  async #writeArtifacts(
    job: MediaJob,
    files: readonly {
      uint8Array: Uint8Array;
      mediaType: string;
    }[],
  ): Promise<MediaArtifact[]> {
    const artifacts: MediaArtifact[] = [];
    for (const file of files) {
      const id = randomUUID();
      const directory = join(app.getPath("userData"), "media", "library", id);
      await mkdir(directory, { recursive: true });
      const filePath = join(directory, `${id}${extension(file.mediaType)}`);
      await writeFile(filePath, file.uint8Array);
      let width: number | undefined;
      let height: number | undefined;
      if (job.type === "image") {
        await MediaService.#writeThumbnail(file.uint8Array, filePath);
        const image = nativeImage.createFromBuffer(Buffer.from(file.uint8Array));
        if (!image.isEmpty()) {
          const size = image.getSize();
          width = size.width;
          height = size.height;
        }
      }
      this.database.saveMediaAsset({
        id,
        name: `${job.type === "video" ? "生成视频" : "生成图片"}-${id.slice(0, 8)}${extension(file.mediaType)}`,
        type: job.type,
        source: "generated",
        filePath,
        mimeType: file.mediaType,
        width,
        height,
        createdAt: Date.now(),
        originJobId: job.id,
      });
      artifacts.push({
        id,
        jobId: job.id,
        type: job.type,
        filePath,
        mimeType: file.mediaType,
        createdAt: Date.now(),
      });
    }
    return artifacts;
  }

  async cancel(id: string): Promise<void> {
    this.#controllers.get(id)?.abort();
  }

  async retry(id: string): Promise<MediaJob> {
    const original = this.database.listMediaJobs().find((job) => job.id === id);
    if (original === undefined) throw new Error("媒体任务不存在");
    if (original.type === "video") {
      return this.generateVideo({
        providerAccountId: original.providerId,
        model: original.modelId,
        prompt: original.prompt,
        aspectRatio: original.aspectRatio,
        resolution: original.resolution,
        duration: original.duration,
        count: original.count,
        references: original.references.map(({ assetId, role }) => ({ assetId, role })),
      });
    }
    return this.generateImage({
      providerAccountId: original.providerId,
      model: original.modelId,
      prompt: original.prompt,
      aspectRatio: original.aspectRatio,
      resolution: original.resolution,
      quality: original.quality,
      count: original.count,
      references: original.references.map(({ assetId, role }) => ({ assetId, role })),
    });
  }

  async remove(id: string): Promise<void> {
    await this.cancel(id);
    await this.#tasks.get(id);
    const job = this.database.listMediaJobs().find((candidate) => candidate.id === id);
    this.database.removeMediaJob(id);
    if (job) await rm(join(app.getPath("userData"), "media", job.id), { recursive: true, force: true });
    this.#sink({ schemaVersion: 1, type: "media.job.removed", jobId: id });
  }

  async saveArtifact(path: string): Promise<boolean> {
    if (!MediaService.isManagedArtifact(path)) throw new Error("只能导出应用生成的媒体文件");
    const suffix = extname(path).replace(/^\./, "") || "png";
    const video = ["mp4", "webm", "mov"].includes(suffix.toLowerCase());
    const result = await dialog.showSaveDialog({
      title: video ? "保存视频" : "保存图片",
      defaultPath: basename(path),
      filters: [{ name: video ? "视频" : "图片", extensions: [suffix] }],
    });
    if (result.canceled || !result.filePath) return false;
    await copyFile(path, result.filePath);
    return true;
  }

  static isManagedArtifact(path: string): boolean {
    const mediaRoot = resolve(app.getPath("userData"), "media");
    const candidate = resolve(path);
    const relation = relative(mediaRoot, candidate);
    return (
      relation !== "" &&
      relation !== ".." &&
      !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !relation.startsWith("/") &&
      !relation.startsWith("\\") &&
      extname(candidate) !== ""
    );
  }

  static async thumbnail(path: string): Promise<string> {
    if (!MediaService.isManagedArtifact(path)) throw new Error("只能读取应用生成的图片");
    const thumbnailPath = join(dirname(path), `.thumbnail-${basename(path)}.png`);
    try {
      await readFile(thumbnailPath);
      return thumbnailPath;
    } catch {
      const source = await readFile(path);
      return (await MediaService.#writeThumbnail(source, path)) ? thumbnailPath : path;
    }
  }

  static async #writeThumbnail(source: Uint8Array, path: string): Promise<boolean> {
    const image = nativeImage.createFromBuffer(Buffer.from(source));
    if (image.isEmpty()) return false;
    const size = image.getSize();
    const resized =
      Math.max(size.width, size.height) <= 640
        ? image
        : size.width >= size.height
          ? image.resize({ width: 640, quality: "good" })
          : image.resize({ height: 640, quality: "good" });
    await writeFile(
      join(dirname(path), `.thumbnail-${basename(path)}.png`),
      resized.toPNG(),
    );
    return true;
  }

  #publish(job: MediaJob): void {
    this.#sink({
      schemaVersion: 1,
      type: "media.job.updated",
      job: structuredClone(job),
    });
  }
}
