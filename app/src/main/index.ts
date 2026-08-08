import { resolve } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import { IPC, type AppendMessageInput, type CreateConversationInput } from "@shared/contracts";

import { ConversationService } from "./application/conversation-service.js";
import { AgentProfileService } from "./application/agent-profile-service.js";
import { AgentGroupService } from "./application/agent-group-service.js";
import { GatewayAuthService } from "./application/gateway-auth-service.js";
import { PiAgentService } from "./application/pi-agent-service.js";
import { WorkspaceService } from "./application/workspace-service.js";
import { AppDatabase } from "./infrastructure/database.js";
import { applyWindowMode, createMainWindow, loadRenderer } from "./window.js";

const customDataDirectory = process.env["TIETIEZHI_DATA_DIR"]?.trim();
if (customDataDirectory) app.setPath("userData", customDataDirectory);

let mainWindow: BrowserWindow | undefined;
let database: AppDatabase | undefined;
let authService: GatewayAuthService | undefined;
let piAgentService: PiAgentService | undefined;
let shutdownStarted = false;

function registerAppProtocol(): void {
  if (process.defaultApp) {
    return;
  }
  app.setAsDefaultProtocolClient("tietiezhi");
}

function focusMainWindow(): void {
  const window = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function openMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }
  mainWindow = createMainWindow();
  mainWindow.once("closed", () => {
    mainWindow = undefined;
  });
  loadRenderer(mainWindow);
  return mainWindow;
}

function handleAppProtocol(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "tietiezhi:") return;
  openMainWindow();
  if (parsed.hostname === "auth" && parsed.pathname === "/callback") {
    void authService?.completeBrowserLogin(url);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("请求参数格式不正确");
  }
  return value as Record<string, unknown>;
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

function createConversationInput(value: unknown): CreateConversationInput {
  const input = record(value);
  return {
    workspaceId: string(input, "workspaceId"),
    agentId: optionalString(input, "agentId"),
    groupId: optionalString(input, "groupId"),
    title: optionalString(input, "title"),
  };
}

function appendMessageInput(value: unknown): AppendMessageInput {
  const input = record(value);
  const role = input["role"];
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    throw new Error("消息角色无效");
  }
  const parts = input["parts"];
  if (!Array.isArray(parts)) throw new Error("消息内容格式无效");
  return {
    conversationId: string(input, "conversationId"),
    role,
    parts: parts as AppendMessageInput["parts"],
    parentMessageId: optionalString(input, "parentMessageId"),
  };
}

function readRequest(value: unknown): { method: string; input: unknown } {
  const request = record(value);
  if (typeof request["method"] !== "string") throw new Error("IPC 方法无效");
  return { method: request["method"], input: request["input"] };
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath("userData");
  database = new AppDatabase(resolve(userData, "tietiezhi.sqlite3"));
  const workspaces = new WorkspaceService(database, resolve(userData, "workspaces"), {
    async chooseDirectory() {
      const result = await dialog.showOpenDialog({
        title: "选择项目文件夹",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    reveal: (path) => shell.openPath(path),
  });
  const agentProfiles = new AgentProfileService(database, resolve(userData, "agents"));
  const agentGroups = new AgentGroupService(database, agentProfiles);
  const conversations = new ConversationService(database, agentProfiles, agentGroups);
  const auth = new GatewayAuthService(userData, (url) => shell.openExternal(url));
  authService = auth;
  piAgentService = new PiAgentService(
    auth,
    conversations,
    workspaces,
    agentProfiles,
    agentGroups,
    (agentEvent) => mainWindow?.webContents.send(IPC.agentEvent, agentEvent),
  );

  ipcMain.handle(IPC.invoke, async (event, payload: unknown) => {
    const request = readRequest(payload);
    switch (request.method) {
      case "app.setWindowMode": {
        const mode = string(request.input, "mode");
        if (mode !== "setup" && mode !== "normal") throw new Error("窗口模式无效");
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (owner) applyWindowMode(owner, mode);
        return;
      }
      case "auth.status":
        return auth.status();
      case "auth.openLogin":
        return auth.loginWithBrowser();
      case "auth.cancelLogin":
        auth.cancelLogin();
        return;
      case "auth.loginWithAPIKey":
        return auth.loginWithAPIKey(string(request.input, "apiKey"));
      case "auth.openRegistration":
        await shell.openExternal(auth.registrationURL());
        return;
      case "auth.logout":
        await piAgentService?.stopAll();
        await auth.logout();
        return;
      case "auth.setAvatar": {
        const input = record(request.input);
        const avatar = input["avatar"];
        if (avatar !== null && typeof avatar !== "string") throw new Error("头像地址无效");
        return auth.setAvatar(avatar);
      }
      case "workspaces.list":
        return workspaces.list();
      case "workspaces.chooseProject":
        return workspaces.chooseProject();
      case "workspaces.createTemporary":
        return workspaces.createTemporary();
      case "workspaces.reveal":
        return workspaces.reveal(string(request.input, "id"));
      case "workspaces.listDirectory": {
        const input = record(request.input);
        return workspaces.listDirectory(
          string(input, "id"),
          optionalString(input, "path"),
        );
      }
      case "workspaces.readTextFile": {
        const input = record(request.input);
        return workspaces.readTextFile(string(input, "id"), string(input, "path"));
      }
      case "conversations.list":
        return conversations.list(optionalString(record(request.input ?? {}), "workspaceId"));
      case "conversations.create":
        return conversations.create(createConversationInput(request.input));
      case "conversations.load":
        return conversations.load(string(request.input, "id"));
      case "conversations.appendMessage":
        return conversations.appendMessage(appendMessageInput(request.input));
      case "conversations.rename":
        return conversations.rename(
          string(request.input, "id"),
          string(request.input, "title"),
        );
      case "conversations.remove":
        return conversations.remove(string(request.input, "id"));
      case "agentProfiles.list":
        return agentProfiles.list();
      case "agentProfiles.presets":
        return agentProfiles.presets();
      case "agentProfiles.create": {
        const input = record(request.input);
        return agentProfiles.create({
          presetId: optionalString(input, "presetId"),
          name: string(input, "name"),
          role: string(input, "role"),
          description: optionalString(input, "description"),
          avatar: optionalString(input, "avatar"),
          modelId: optionalString(input, "modelId"),
          systemPrompt: optionalString(input, "systemPrompt"),
        });
      }
      case "agentGroups.list":
        return agentGroups.list();
      case "agentGroups.create": {
        const input = record(request.input);
        const agentIds = input["agentIds"];
        if (!Array.isArray(agentIds) || !agentIds.every((item): item is string => typeof item === "string")) {
          throw new Error("群聊成员格式无效");
        }
        return agentGroups.create({
          name: string(input, "name"),
          description: optionalString(input, "description"),
          agentIds,
        });
      }
      case "agentGroups.remove":
        return agentGroups.remove(string(request.input, "id"));
      case "agents.start": {
        const input = record(request.input);
        if (!piAgentService) throw new Error("Agent 服务尚未初始化");
        return piAgentService.start({
          conversationId: string(input, "conversationId"),
          workspaceId: string(input, "workspaceId"),
          agentId: optionalString(input, "agentId"),
          groupId: optionalString(input, "groupId"),
        });
      }
      case "agents.prompt": {
        const input = record(request.input);
        if (!piAgentService) throw new Error("Agent 服务尚未初始化");
        return piAgentService.prompt({
          conversationId: string(input, "conversationId"),
          text: string(input, "text"),
        });
      }
      case "agents.abort":
        if (!piAgentService) throw new Error("Agent 服务尚未初始化");
        return piAgentService.abort(string(request.input, "conversationId"));
      case "agents.stop":
        if (!piAgentService) throw new Error("Agent 服务尚未初始化");
        return piAgentService.stop(string(request.input, "conversationId"));
      default:
        throw new Error(`未知 IPC 方法：${request.method}`);
    }
  });

  if (process.env["TIETIEZHI_HEADLESS"] === "1") {
    console.log("[host] ready: workspaces conversations messages");
    app.quit();
    return;
  }

  openMainWindow();
}

registerAppProtocol();

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const protocolURL = argv.find((value) => value.startsWith("tietiezhi://"));
    if (protocolURL) handleAppProtocol(protocolURL);
    else focusMainWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleAppProtocol(url);
  });

  void app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error("[host] startup failed:", error);
    app.exit(1);
  });

  app.on("activate", () => {
    openMainWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownStarted || !piAgentService) {
    database?.close();
    return;
  }
  shutdownStarted = true;
  event.preventDefault();
  void piAgentService.stopAll()
    .catch((error: unknown) => {
      console.error("[host] agent shutdown failed:", error);
    })
    .finally(() => {
      database?.close();
      app.quit();
    });
});
