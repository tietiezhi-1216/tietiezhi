import { join } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import { IPC, type AppendMessageInput, type CreateConversationInput } from "@shared/contracts";

import { ConversationService } from "./application/conversation-service.js";
import { GatewayAuthService } from "./application/gateway-auth-service.js";
import { WorkspaceService } from "./application/workspace-service.js";
import { AppDatabase } from "./infrastructure/database.js";
import { applyWindowMode, createMainWindow, loadRenderer } from "./window.js";

const customDataDirectory = process.env["TIETIEZHI_DATA_DIR"]?.trim();
if (customDataDirectory) app.setPath("userData", customDataDirectory);

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

let database: AppDatabase | undefined;

async function bootstrap(): Promise<void> {
  const userData = app.getPath("userData");
  database = new AppDatabase(join(userData, "tietiezhi.sqlite3"));
  const workspaces = new WorkspaceService(database, join(userData, "workspaces"), {
    async chooseDirectory() {
      const result = await dialog.showOpenDialog({
        title: "选择项目文件夹",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    reveal: (path) => shell.openPath(path),
  });
  const conversations = new ConversationService(database);
  const auth = new GatewayAuthService(userData, (url) => shell.openExternal(url));

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
      default:
        throw new Error(`未知 IPC 方法：${request.method}`);
    }
  });

  if (process.env["TIETIEZHI_HEADLESS"] === "1") {
    console.log("[host] ready: workspaces conversations messages");
    app.quit();
    return;
  }

  const window = createMainWindow();
  loadRenderer(window);
}

void app.whenReady().then(bootstrap).catch((error: unknown) => {
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
  database?.close();
});
