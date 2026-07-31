import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { app, BrowserWindow, ipcMain, net, protocol } from "electron";

import {
  IPC,
  type ImageGenerationRequest,
  type ProviderAccountInput,
  type SendMessageInput,
} from "@shared/contracts";

import { ConversationService } from "./application/conversation-service.js";
import { ApprovalManager } from "./application/approval-manager.js";
import { EngineManager } from "./application/engine-manager.js";
import { MediaService } from "./application/media-service.js";
import { ProviderService } from "./application/provider-service.js";
import { GatewayService } from "./application/gateway-service.js";
import { WorkspaceService } from "./application/workspace-service.js";
import { AISDKEngine } from "./engines/ai-sdk-engine.js";
import { setProviderFetch } from "./engines/provider-factory.js";
import { CredentialStore } from "./infrastructure/credential-store.js";
import { AppDatabase } from "./infrastructure/database.js";
import { createMainWindow, loadRenderer } from "./window.js";

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
  return {
    id: optionalString(input, "id"),
    providerType,
    displayName: string(input, "displayName"),
    baseURL: optionalString(input, "baseURL"),
    apiKey: optionalString(input, "apiKey"),
    enabled: typeof input["enabled"] === "boolean" ? input["enabled"] : undefined,
    models,
  };
}

function sendInput(value: unknown): SendMessageInput {
  const input = record(value);
  return {
    conversationId: optionalString(input, "conversationId"),
    text: string(input, "text"),
    providerAccountId: string(input, "providerAccountId"),
    model: string(input, "model"),
    engineId: optionalString(input, "engineId"),
    systemPrompt: optionalString(input, "systemPrompt"),
    workspace: optionalString(input, "workspace"),
  };
}

function imageInput(value: unknown): ImageGenerationRequest {
  const input = record(value);
  const aspectRatio = optionalString(input, "aspectRatio");
  if (aspectRatio !== undefined && !/^\d+:\d+$/.test(aspectRatio)) {
    throw new Error("图片比例格式无效");
  }
  const count = input["count"];
  return {
    providerAccountId: string(input, "providerAccountId"),
    model: string(input, "model"),
    prompt: string(input, "prompt"),
    aspectRatio: aspectRatio as `${number}:${number}` | undefined,
    count: typeof count === "number" && Number.isFinite(count) ? count : undefined,
  };
}

function readRequest(value: unknown): { method: string; input: unknown } {
  const request = record(value);
  if (typeof request["method"] !== "string") throw new Error("IPC 方法无效");
  return { method: request["method"], input: request["input"] };
}

let engines: EngineManager | null = null;
let approvals: ApprovalManager | null = null;

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
  approvals = new ApprovalManager();
  engines = new EngineManager();
  await engines.registerReady(new AISDKEngine(approvals));
  const conversations = new ConversationService(database, providers, engines, workspaces);
  const media = new MediaService(database, providers);

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
      const bytes = await readFile(requestedPath);
      const extension = basename(requestedPath).split(".").at(-1)?.toLowerCase();
      const type =
        extension === "jpg" || extension === "jpeg"
          ? "image/jpeg"
          : extension === "webp"
            ? "image/webp"
            : "image/png";
      return new Response(bytes, { headers: { "content-type": type } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });

  ipcMain.handle(IPC.invoke, async (_event, payload: unknown) => {
    const request = readRequest(payload);
    switch (request.method) {
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
      case "approvals.resolve":
        return approvals?.resolve(
          string(request.input, "approvalId"),
          record(request.input)["approved"] === true,
        );
      case "media.list":
        return media.list();
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
      default:
        throw new Error(`未知 IPC 方法：${request.method}`);
    }
  });

  if (process.env["TIETIEZHI_HEADLESS"] === "1") {
    console.log(
      "[host] ready: engines providers gateway conversations workspace approvals media",
    );
    app.quit();
    return;
  }

  const window = createMainWindow();
  loadRenderer(window);
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
  void engines?.dispose();
});
