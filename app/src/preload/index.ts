import { contextBridge, ipcRenderer } from "electron";

import { IPC, type DesktopAPI } from "@shared/contracts";

function invoke<T>(method: string, input?: unknown): Promise<T> {
  return ipcRenderer.invoke(IPC.invoke, { method, input }) as Promise<T>;
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
};

contextBridge.exposeInMainWorld("tietiezhi", api);
