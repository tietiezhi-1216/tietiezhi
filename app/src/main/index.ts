import { extname } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, net, protocol } from "electron";

import {
  IPC,
  type ApprovalDecision,
  type AgentPreferences,
  type ImageGenerationRequest,
  type ProviderAccountInput,
  type ProviderModelProbeInput,
  type SendMessageInput,
  type SkillInput,
  type VideoGenerationRequest,
} from "@shared/contracts";

import { ConversationService } from "./application/conversation-service.js";
import { ApprovalManager } from "./application/approval-manager.js";
import { EngineManager } from "./application/engine-manager.js";
import { MediaService } from "./application/media-service.js";
import { PreferencesService } from "./application/preferences-service.js";
import { ProviderService } from "./application/provider-service.js";
import { SkillService } from "./application/skill-service.js";
import { GatewayService } from "./application/gateway-service.js";
import { UpdateService } from "./application/update-service.js";
import { WorkspaceService } from "./application/workspace-service.js";
import { AISDKEngine } from "./engines/ai-sdk-engine.js";
import { setProviderFetch } from "./engines/provider-factory.js";
import { WORKSPACE_TOOL_DESCRIPTORS } from "./engines/workspace-tools.js";
import { CredentialStore } from "./infrastructure/credential-store.js";
import { AppDatabase } from "./infrastructure/database.js";
import { applyWindowMode, createMainWindow, loadRenderer } from "./window.js";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "tietiezhi-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const customDataDirectory = process.env["TIETIEZHI_DATA_DIR"]?.trim();
if (customDataDirectory) app.setPath("userData", customDataDirectory);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("请求参数格式不正确");
  return value;
}

function string(value: unknown, key: string): string {
  const result = record(value)[key];
  if (typeof result !== "string" || result === "") throw new Error(`参数 ${key} 无效`);
  return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  return typeof result === "string" && result !== "" ? result : undefined;
}

function providerInput(value: unknown): ProviderAccountInput {
  const input = record(value);
  const providerType = input["providerType"];
  if (
    providerType !== "openai" &&
    providerType !== "anthropic" &&
    providerType !== "google" &&
    providerType !== "openai-compatible"
  ) {
    throw new Error("供应商类型无效");
  }
  const models = input["models"];
  if (!Array.isArray(models) || models.some((model) => typeof model !== "string")) {
    throw new Error("模型列表格式无效");
  }
  const modelMetadata = input["modelMetadata"];
  return {
    id: optionalString(input, "id"),
    providerType,
    displayName: string(input, "displayName"),
    baseURL: optionalString(input, "baseURL"),
    apiKey: optionalString(input, "apiKey"),
    enabled: typeof input["enabled"] === "boolean" ? input["enabled"] : undefined,
    models,
    modelMetadata:
      typeof modelMetadata === "object" && modelMetadata !== null
        ? (modelMetadata as ProviderAccountInput["modelMetadata"])
        : undefined,
  };
}

function providerProbeInput(value: unknown): ProviderModelProbeInput {
  const input = record(value);
  const providerType = input["providerType"];
  if (
    providerType !== "openai" &&
    providerType !== "anthropic" &&
    providerType !== "google" &&
    providerType !== "openai-compatible"
  ) {
    throw new Error("供应商类型无效");
  }
  return {
    id: optionalString(input, "id"),
    providerType,
    baseURL: optionalString(input, "baseURL"),
    apiKey: optionalString(input, "apiKey"),
  };
}

function sendInput(value: unknown): SendMessageInput {
  const input = record(value);
  const taskMode = optionalString(input, "taskMode");
  return {
    conversationId: optionalString(input, "conversationId"),
    text: string(input, "text"),
    providerAccountId: string(input, "providerAccountId"),
    model: string(input, "model"),
    engineId: optionalString(input, "engineId"),
    systemPrompt: optionalString(input, "systemPrompt"),
    workspace: optionalString(input, "workspace"),
    taskMode: taskMode === "work" ? "work" : "code",
  };
}

function approvalDecision(value: unknown): ApprovalDecision {
  if (value === "allow-once" || value === "allow-for-run" || value === "deny") return value;
  throw new Error("审批决定无效");
}

function imageInput(value: unknown): ImageGenerationRequest {
  const input = record(value);
  const aspectRatio = optionalString(input, "aspectRatio");
  if (aspectRatio !== undefined && !/^\d+:\d+$/.test(aspectRatio)) {
    throw new Error("图片比例格式无效");
  }
  const resolution = optionalString(input, "resolution");
  if (
    resolution !== undefined &&
    !/^(?:\d+x\d+|512|[124]K)$/.test(resolution)
  ) {
    throw new Error("图片分辨率格式无效");
  }
  const quality = optionalString(input, "quality");
  if (
    quality !== undefined &&
    !["auto", "low", "medium", "high"].includes(quality)
  ) {
    throw new Error("图片质量参数无效");
  }
  const count = input["count"];
  return {
    providerAccountId: string(input, "providerAccountId"),
    model: string(input, "model"),
    prompt: string(input, "prompt"),
    aspectRatio: aspectRatio as `${number}:${number}` | undefined,
    resolution: resolution as ImageGenerationRequest["resolution"],
    quality: quality as ImageGenerationRequest["quality"],
    count: typeof count === "number" && Number.isFinite(count) ? count : undefined,
    references: mediaReferences(input["references"]),
  };
}

function videoInput(value: unknown): VideoGenerationRequest {
  const input = record(value);
  const aspectRatio = optionalString(input, "aspectRatio");
  if (aspectRatio !== undefined && !/^\d+:\d+$/.test(aspectRatio)) {
    throw new Error("视频比例格式无效");
  }
  const resolution = optionalString(input, "resolution");
  if (resolution !== undefined && !/^\d+x\d+$/.test(resolution)) {
    throw new Error("视频分辨率格式无效");
  }
  const duration = input["duration"];
  const count = input["count"];
  return {
    providerAccountId: string(input, "providerAccountId"),
    model: string(input, "model"),
    prompt: string(input, "prompt"),
    aspectRatio: aspectRatio as `${number}:${number}` | undefined,
    resolution: resolution as `${number}x${number}` | undefined,
    duration:
      typeof duration === "number" && Number.isFinite(duration)
        ? duration
        : undefined,
    count: typeof count === "number" && Number.isFinite(count) ? count : undefined,
    references: mediaReferences(input["references"]),
  };
}

function mediaReferences(
  value: unknown,
): NonNullable<ImageGenerationRequest["references"]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("参考素材格式无效");
  return value.map((candidate) => {
    const reference = record(candidate);
    const role = string(reference, "role");
    if (!["reference", "first-frame", "last-frame"].includes(role)) {
      throw new Error("参考素材角色无效");
    }
    return {
      assetId: string(reference, "assetId"),
      role: role as "reference" | "first-frame" | "last-frame",
    };
  });
}

function skillInput(value: unknown): SkillInput {
  const input = record(value);
  return {
    name: string(input, "name"),
    description: typeof input["description"] === "string" ? input["description"] : "",
    body: typeof input["body"] === "string" ? input["body"] : "",
  };
}

function preferencesInput(value: unknown): AgentPreferences {
  const input = record(value);
  return {
    systemPrompt: typeof input["systemPrompt"] === "string" ? input["systemPrompt"] : "",
  };
}

function readRequest(value: unknown): { method: string; input: unknown } {
  const request = record(value);
  if (typeof request["method"] !== "string") throw new Error("IPC 方法无效");
  return { method: request["method"], input: request["input"] };
}

let engines: EngineManager | null = null;
let approvals: ApprovalManager | null = null;
let updates: UpdateService | null = null;

async function bootstrap(): Promise<void> {
  setProviderFetch(net.fetch as unknown as typeof globalThis.fetch);
  const database = new AppDatabase();
  const credentials = new CredentialStore();
  const providers = new ProviderService(
    database,
    credentials,
    net.fetch as unknown as typeof globalThis.fetch,
  );
  const gateway = new GatewayService(
    providers,
    credentials,
    net.fetch as unknown as typeof globalThis.fetch,
  );
  const workspaces = new WorkspaceService();
  const preferences = new PreferencesService();
  const skills = new SkillService();
  approvals = new ApprovalManager(database);
  engines = new EngineManager();
  await engines.registerReady(new AISDKEngine(approvals));
  const conversations = new ConversationService(
    database,
    providers,
    engines,
    workspaces,
    preferences,
    skills,
  );
  const media = new MediaService(database, providers);
  const updateService = new UpdateService();
  updates = updateService;

  conversations.setEventSink((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC.engineEvent, event);
    }
  });
  media.setEventSink((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC.mediaEvent, event);
    }
  });
  updateService.setEventSink((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC.updateEvent, event);
    }
  });

  protocol.handle("tietiezhi-media", async (request) => {
    const filePath = new URL(request.url).searchParams.get("path") ?? "";
    if (!MediaService.isManagedArtifact(filePath)) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      const url = new URL(request.url);
      const requestedPath =
        url.searchParams.get("variant") === "thumbnail"
          ? await MediaService.thumbnail(filePath)
          : filePath;
      const response = await net.fetch(pathToFileURL(requestedPath).toString(), {
        headers: request.headers,
      });
      const extension = extname(requestedPath).slice(1).toLowerCase();
      const type =
        extension === "jpg" || extension === "jpeg"
          ? "image/jpeg"
          : extension === "webp"
            ? "image/webp"
            : extension === "mp4"
              ? "video/mp4"
              : extension === "webm"
                ? "video/webm"
                : extension === "mov"
                  ? "video/quicktime"
                  : "image/png";
      const headers = new Headers(response.headers);
      headers.set("content-type", type);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });

  ipcMain.handle(IPC.invoke, async (event, payload: unknown) => {
    const request = readRequest(payload);
    switch (request.method) {
      case "window.setMode": {
        const mode = string(request.input, "mode");
        if (mode !== "setup" && mode !== "normal") {
          throw new Error(`未知窗口模式：${mode}`);
        }
        const sender = BrowserWindow.fromWebContents(event.sender);
        if (sender) applyWindowMode(sender, mode);
        return;
      }
      case "engines.list":
        return engines?.list() ?? [];
      case "providers.list":
        return providers.list();
      case "providers.save":
        return providers.save(providerInput(request.input));
      case "providers.remove":
        return providers.remove(string(request.input, "id"));
      case "providers.refreshModels":
        return providers.refreshModels(string(request.input, "id"));
      case "providers.fetchModels":
        return providers.fetchModels(providerProbeInput(request.input));
      case "gateway.account":
        return gateway.account();
      case "gateway.login":
        return gateway.login();
      case "gateway.logout":
        return gateway.logout();
      case "conversations.list":
        return conversations.list();
      case "conversations.load":
        return conversations.load(string(request.input, "id"));
      case "conversations.send":
        return conversations.send(sendInput(request.input));
      case "conversations.cancel":
        return conversations.cancel(string(request.input, "runId"));
      case "conversations.remove":
        return conversations.remove(string(request.input, "id"));
      case "conversations.rename":
        return conversations.rename(
          string(request.input, "id"),
          string(request.input, "title"),
        );
      case "workspace.createTemporary":
        return workspaces.createTemporary();
      case "workspace.choose":
        return workspaces.choose();
      case "workspace.reveal":
        return workspaces.reveal(string(request.input, "path"));
      case "workspace.listFiles": {
        const conversation = database.conversation(string(request.input, "conversationId"));
        if (!conversation?.workspace) throw new Error("会话尚未绑定 Workspace");
        return workspaces.listFiles(conversation.workspace);
      }
      case "workspace.readFile": {
        const conversation = database.conversation(string(request.input, "conversationId"));
        if (!conversation?.workspace) throw new Error("会话尚未绑定 Workspace");
        return workspaces.readTextFile(
          conversation.workspace,
          string(request.input, "path"),
        );
      }
      case "tools.list":
        return WORKSPACE_TOOL_DESCRIPTORS;
      case "skills.list":
        return skills.list();
      case "skills.read":
        return skills.read(string(request.input, "name"));
      case "skills.save":
        return skills.save(skillInput(request.input));
      case "skills.remove":
        return skills.remove(string(request.input, "name"));
      case "skills.setEnabled":
        return skills.setEnabled(
          string(request.input, "name"),
          record(request.input)["enabled"] === true,
        );
      case "skills.import":
        return skills.import();
      case "preferences.get":
        return preferences.get();
      case "preferences.save":
        return preferences.save(preferencesInput(request.input));
      case "approvals.resolve":
        return approvals?.resolve(
          string(request.input, "approvalId"),
          approvalDecision(record(request.input)["decision"]),
        );
      case "approvals.list":
        return approvals?.list(optionalString(record(request.input), "conversationId"));
      case "media.list":
        return media.list();
      case "media.listAssets":
        return media.listAssets();
      case "media.importAssets":
        return media.importAssets();
      case "media.removeAsset":
        return media.removeAsset(string(request.input, "id"));
      case "media.generateImage":
        return media.generateImage(imageInput(request.input));
      case "media.cancel":
        return media.cancel(string(request.input, "id"));
      case "media.retry":
        return media.retry(string(request.input, "id"));
      case "media.remove":
        return media.remove(string(request.input, "id"));
      case "media.saveArtifact":
        return media.saveArtifact(string(request.input, "path"));
      case "updates.state":
        return updateService.state();
      case "updates.check":
        return updateService.check();
      case "updates.download":
        return updateService.download();
      case "updates.install":
        return updateService.install();
      default:
        throw new Error(`未知 IPC 方法：${request.method}`);
    }
  });

  if (process.env["TIETIEZHI_HEADLESS"] === "1") {
    console.log(
      "[host] ready: engines providers gateway conversations workspace tools skills approvals media updates",
    );
    app.quit();
    return;
  }

  const window = createMainWindow();
  loadRenderer(window);
  updateService.startAutomaticChecks();
}

void app
  .whenReady()
  .then(bootstrap)
  .catch((error: unknown) => {
    console.error("[host] startup failed:", error);
    app.exit(1);
  });

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length > 0) return;
  const window = createMainWindow();
  loadRenderer(window);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  approvals?.dispose();
  updates?.dispose();
  void engines?.dispose();
});
