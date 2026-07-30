import { contextBridge, ipcRenderer } from "electron";

import { IPC, type DesktopAPI, type EngineEvent } from "@shared/contracts";

function invoke<T>(method: string, input?: unknown): Promise<T> {
  return ipcRenderer.invoke(IPC.invoke, { method, input }) as Promise<T>;
}

const api: DesktopAPI = {
  engines: {
    list: () => invoke("engines.list"),
  },
  providers: {
    list: () => invoke("providers.list"),
    save: (input) => invoke("providers.save", input),
    remove: (id) => invoke("providers.remove", { id }),
    refreshModels: (id) => invoke("providers.refreshModels", { id }),
  },
  gateway: {
    account: () => invoke("gateway.account"),
    login: () => invoke("gateway.login"),
    logout: () => invoke("gateway.logout"),
  },
  conversations: {
    list: () => invoke("conversations.list"),
    load: (id) => invoke("conversations.load", { id }),
    send: (input) => invoke("conversations.send", input),
    cancel: (runId) => invoke("conversations.cancel", { runId }),
    remove: (id) => invoke("conversations.remove", { id }),
    rename: (id, title) => invoke("conversations.rename", { id, title }),
  },
  workspace: {
    createTemporary: () => invoke("workspace.createTemporary"),
    choose: () => invoke("workspace.choose"),
    listFiles: (conversationId) => invoke("workspace.listFiles", { conversationId }),
    readFile: (conversationId, path) =>
      invoke("workspace.readFile", { conversationId, path }),
  },
  approvals: {
    resolve: (approvalId, approved) =>
      invoke("approvals.resolve", { approvalId, approved }),
  },
  media: {
    list: () => invoke("media.list"),
    generateImage: (input) => invoke("media.generateImage", input),
    cancel: (id) => invoke("media.cancel", { id }),
    retry: (id) => invoke("media.retry", { id }),
    remove: (id) => invoke("media.remove", { id }),
    saveArtifact: (path) => invoke("media.saveArtifact", { path }),
    assetURL: (path) => `tietiezhi-media://asset/?path=${encodeURIComponent(path)}`,
  },
  onEngineEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, payload: EngineEvent) => listener(payload);
    ipcRenderer.on(IPC.engineEvent, handler);
    return () => ipcRenderer.removeListener(IPC.engineEvent, handler);
  },
};

contextBridge.exposeInMainWorld("tietiezhi", api);
