import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { app, dialog, nativeImage } from "electron";
import { generateImage } from "ai";

import type {
  AppError,
  ImageGenerationRequest,
  MediaArtifact,
  MediaEvent,
  MediaJob,
} from "@shared/contracts";

import { imageModel, imageProviderKind } from "../engines/provider-factory.js";
import { AppDatabase } from "../infrastructure/database.js";
import { ProviderService } from "./provider-service.js";

function extension(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
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

  async generateImage(input: ImageGenerationRequest): Promise<MediaJob> {
    const prompt = input.prompt.trim();
    if (prompt === "") throw new Error("图片描述不能为空");
    const provider = this.providers.require(input.providerAccountId);
    if (!provider.models.includes(input.model)) throw new Error("所选模型不属于当前供应商");
    const now = Date.now();
    const job: MediaJob = {
      id: randomUUID(),
      type: "image",
      providerId: provider.id,
      modelId: input.model,
      prompt,
      aspectRatio: input.aspectRatio,
      count: Math.max(1, Math.min(4, input.count ?? 1)),
      status: "running",
      createdAt: now,
      updatedAt: now,
      artifacts: [],
    };
    this.database.saveMediaJob(job);
    this.#publish(job);
    const task = this.#execute(job);
    this.#tasks.set(job.id, task);
    void task.finally(() => this.#tasks.delete(job.id));
    return job;
  }

  async #execute(job: MediaJob): Promise<void> {
    const provider = this.providers.require(job.providerId);
    const controller = new AbortController();
    this.#controllers.set(job.id, controller);

    try {
      const apiKey = await this.providers.key(provider);
      const kind = imageProviderKind(provider, job.modelId);
      const dimensions =
        kind === "google"
          ? job.aspectRatio === undefined
            ? {}
            : { aspectRatio: job.aspectRatio }
          : { size: openAIImageSize(job.aspectRatio) };
      const result = await generateImage({
        model: imageModel(provider, apiKey, job.modelId),
        prompt: job.prompt,
        n: job.count,
        ...dimensions,
        abortSignal: controller.signal,
      });
      const directory = join(app.getPath("userData"), "media", job.id);
      await mkdir(directory, { recursive: true });
      const artifacts: MediaArtifact[] = [];
      for (const image of result.images) {
        const id = randomUUID();
        const filePath = join(directory, `${id}${extension(image.mediaType)}`);
        await writeFile(filePath, image.uint8Array);
        await MediaService.#writeThumbnail(image.uint8Array, filePath);
        artifacts.push({
          id,
          jobId: job.id,
          type: "image",
          filePath,
          mimeType: image.mediaType,
          createdAt: Date.now(),
        });
      }
      job.status = "completed";
      job.updatedAt = Date.now();
      job.artifacts = artifacts;
      this.database.saveMediaJob(job);
      this.#publish(job);
    } catch (error) {
      const failure: AppError = {
        code: controller.signal.aborted ? "CANCELLED" : "IMAGE_GENERATION_FAILED",
        message: controller.signal.aborted
          ? "图片生成已取消"
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

  async cancel(id: string): Promise<void> {
    this.#controllers.get(id)?.abort();
  }

  async retry(id: string): Promise<MediaJob> {
    const original = this.database.listMediaJobs().find((job) => job.id === id);
    if (original === undefined) throw new Error("图片任务不存在");
    return this.generateImage({
      providerAccountId: original.providerId,
      model: original.modelId,
      prompt: original.prompt,
      aspectRatio: original.aspectRatio,
      count: original.count,
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
    if (!MediaService.isManagedArtifact(path)) throw new Error("只能导出应用生成的图片");
    const result = await dialog.showSaveDialog({
      title: "保存图片",
      defaultPath: basename(path),
      filters: [{ name: "图片", extensions: [extname(path).replace(/^\./, "") || "png"] }],
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
