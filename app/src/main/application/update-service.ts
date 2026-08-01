import { app } from "electron";
import electronUpdater, {
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater";

import type { UpdateEvent, UpdateState } from "@shared/contracts";

type UpdateEventSink = (event: UpdateEvent) => void;
const { autoUpdater } = electronUpdater;

function releaseNotes(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const notes = value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const note = Reflect.get(entry, "note");
    return typeof note === "string" ? [note] : [];
  });
  return notes.length > 0 ? notes.join("\n\n") : undefined;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Cannot find latest") && message.includes(".yml")) {
    return "最新发布版本缺少更新元数据，请稍后重试";
  }
  if (
    message.includes("ERR_INTERNET_DISCONNECTED") ||
    message.includes("ERR_NAME_NOT_RESOLVED") ||
    message.includes("ERR_CONNECTION") ||
    message.includes("HttpError")
  ) {
    return "无法连接更新服务，请检查网络后重试";
  }
  if (message.toLowerCase().includes("signature")) {
    return "更新包签名验证失败，已停止安装";
  }
  return message.split("\n")[0]?.slice(0, 300) || "更新失败";
}

export class UpdateService {
  #sink: UpdateEventSink = () => {};
  #state: UpdateState;
  #automaticCheckTimer?: NodeJS.Timeout;

  constructor() {
    const supportedPlatform = process.platform === "darwin" || process.platform === "win32";
    const supported = app.isPackaged && supportedPlatform;
    this.#state = {
      currentVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      supported,
      status: supported ? "idle" : "disabled",
      error: supported
        ? undefined
        : app.isPackaged
          ? "当前平台暂不支持应用内更新"
          : "开发模式下不检查应用更新",
    };
    if (!supported) return;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = true;
    // Date-based release versions (YYYY.M.D-tHHmmss) carry a SemVer prerelease
    // segment, so the updater must accept prerelease versions to see them.
    autoUpdater.allowPrerelease = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.disableDifferentialDownload = false;
    autoUpdater.logger = {
      info: (message?: unknown) => console.info("[updater]", String(message ?? "")),
      warn: (message?: unknown) => console.warn("[updater]", String(message ?? "")),
      error: (message?: unknown) => console.error("[updater]", errorMessage(message)),
      debug: (message: string) => console.debug("[updater]", message),
    };

    autoUpdater.on("checking-for-update", () => {
      this.#replace({ status: "checking", error: undefined });
    });
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.#replace({
        status: "available",
        availableVersion: info.version,
        releaseName: info.releaseName ?? undefined,
        releaseDate: info.releaseDate,
        releaseNotes: releaseNotes(info.releaseNotes),
        checkedAt: Date.now(),
        error: undefined,
      });
    });
    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      this.#replace({
        status: "not-available",
        availableVersion: info.version,
        checkedAt: Date.now(),
        error: undefined,
      });
    });
    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      this.#replace({
        status: "downloading",
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
        error: undefined,
      });
    });
    autoUpdater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
      this.#replace({
        status: "downloaded",
        availableVersion: info.version,
        releaseName: info.releaseName ?? undefined,
        releaseDate: info.releaseDate,
        releaseNotes: releaseNotes(info.releaseNotes),
        percent: 100,
        transferred: undefined,
        total: undefined,
        bytesPerSecond: undefined,
        error: undefined,
      });
    });
    autoUpdater.on("error", (error: Error) => {
      this.#replace({
        status: "error",
        error: errorMessage(error),
        percent: undefined,
        transferred: undefined,
        total: undefined,
        bytesPerSecond: undefined,
      });
    });
  }

  setEventSink(sink: UpdateEventSink): void {
    this.#sink = sink;
  }

  state(): UpdateState {
    return structuredClone(this.#state);
  }

  startAutomaticChecks(): void {
    if (!this.#state.supported || this.#automaticCheckTimer !== undefined) return;
    this.#automaticCheckTimer = setTimeout(() => {
      this.#automaticCheckTimer = undefined;
      void this.check();
    }, 10_000);
  }

  async check(): Promise<UpdateState> {
    if (!this.#state.supported) return this.state();
    if (this.#state.status === "checking" || this.#state.status === "downloading") {
      return this.state();
    }
    try {
      this.#replace({ status: "checking", error: undefined });
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.#replace({ status: "error", error: errorMessage(error) });
    }
    return this.state();
  }

  async download(): Promise<UpdateState> {
    if (!this.#state.supported || this.#state.status !== "available") return this.state();
    try {
      this.#replace({
        status: "downloading",
        percent: 0,
        transferred: 0,
        total: undefined,
        bytesPerSecond: 0,
        error: undefined,
      });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.#replace({ status: "error", error: errorMessage(error) });
    }
    return this.state();
  }

  install(): void {
    if (this.#state.status !== "downloaded") {
      throw new Error("更新尚未下载完成");
    }
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  }

  dispose(): void {
    if (this.#automaticCheckTimer !== undefined) clearTimeout(this.#automaticCheckTimer);
    this.#automaticCheckTimer = undefined;
  }

  #replace(patch: Partial<UpdateState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#sink({
      schemaVersion: 1,
      type: "app.update.state",
      state: this.state(),
    });
  }
}
