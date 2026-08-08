import { contextBridge, ipcRenderer } from "electron";

import { IPC, type AgentEvent, type DesktopAPI } from "@shared/contracts";

function invoke<T>(method: string, input?: unknown): Promise<T> {
  return ipcRenderer.invoke(IPC.invoke, { method, input }) as Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value) || typeof value["type"] !== "string") return false;
  const type = value["type"];
  if (type === "session_started") {
    return isNonEmptyString(value["conversationId"]) &&
      isNonEmptyString(value["sessionId"]) &&
      isNonEmptyString(value["modelId"]);
  }
  if (type === "assistant_text_delta") {
    return isNonEmptyString(value["conversationId"]) && typeof value["delta"] === "string";
  }
  if (type === "assistant_completed") {
    return isNonEmptyString(value["conversationId"]) && typeof value["text"] === "string";
  }
  if (type === "session_error") {
    return isNonEmptyString(value["conversationId"]) && isNonEmptyString(value["message"]);
  }
  return type === "session_stopped" && isNonEmptyString(value["conversationId"]);
}

const api: DesktopAPI = {
  app: {
    setWindowMode: (mode) => invoke("app.setWindowMode", { mode }),
  },
  auth: {
    status: () => invoke("auth.status"),
    openLogin: () => invoke("auth.openLogin"),
    cancelLogin: () => invoke("auth.cancelLogin"),
    loginWithAPIKey: (apiKey) => invoke("auth.loginWithAPIKey", { apiKey }),
    openRegistration: () => invoke("auth.openRegistration"),
    logout: () => invoke("auth.logout"),
    setAvatar: (avatar) => invoke("auth.setAvatar", { avatar }),
  },
  workspaces: {
    list: () => invoke("workspaces.list"),
    chooseProject: () => invoke("workspaces.chooseProject"),
    createTemporary: () => invoke("workspaces.createTemporary"),
    reveal: (id) => invoke("workspaces.reveal", { id }),
    listDirectory: (id, path) => invoke("workspaces.listDirectory", { id, path }),
    readTextFile: (id, path) => invoke("workspaces.readTextFile", { id, path }),
  },
  conversations: {
    list: (workspaceId) => invoke("conversations.list", { workspaceId }),
    create: (input) => invoke("conversations.create", input),
    load: (id) => invoke("conversations.load", { id }),
    appendMessage: (input) => invoke("conversations.appendMessage", input),
    rename: (id, title) => invoke("conversations.rename", { id, title }),
    remove: (id) => invoke("conversations.remove", { id }),
  },
  agentProfiles: {
    list: () => invoke("agentProfiles.list"),
    presets: () => invoke("agentProfiles.presets"),
    create: (input) => invoke("agentProfiles.create", input),
  },
  agentGroups: {
    list: () => invoke("agentGroups.list"),
    create: (input) => invoke("agentGroups.create", input),
    remove: (id) => invoke("agentGroups.remove", { id }),
  },
  agents: {
    start: (input) => invoke("agents.start", input),
    prompt: (input) => invoke("agents.prompt", input),
    abort: (conversationId) => invoke("agents.abort", { conversationId }),
    stop: (conversationId) => invoke("agents.stop", { conversationId }),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, value: unknown) => {
        if (isAgentEvent(value)) listener(value);
      };
      ipcRenderer.on(IPC.agentEvent, handleEvent);
      return () => ipcRenderer.removeListener(IPC.agentEvent, handleEvent);
    },
  },
};

contextBridge.exposeInMainWorld("tietiezhi", api);
