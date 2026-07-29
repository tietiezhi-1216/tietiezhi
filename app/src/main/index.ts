import { readFile } from "node:fs/promises";

import { app, BrowserWindow, protocol } from "electron";

import { ASSET_PROTOCOL, assetUrlToPath, createBridge } from "./bridge/index.js";
import { forwardHostEvents, registerHostCommands } from "./commands.js";
import { createSessionManager, markCoreReady } from "./core-launcher.js";
import { createMainWindow, loadRenderer } from "./window.js";
import type { AcpSessionManager } from "./acp/index.js";

// Must run before `whenReady`, or the renderer cannot fetch asset URLs.
protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let sessions: AcpSessionManager | null = null;

function registerAssetProtocol(): void {
  protocol.handle(ASSET_PROTOCOL, async (request) => {
    const path = assetUrlToPath(request.url);
    if (!path) return new Response("bad asset url", { status: 400 });
    try {
      return new Response(await readFile(path));
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

/**
 * `markReady` needs the protocol version, which only the ACP handshake knows.
 * Wrapping `ensureCore` keeps that coupling in one place instead of leaking
 * process-manager state into the ACP layer.
 */
function trackReadiness(manager: AcpSessionManager): AcpSessionManager {
  const original = manager.ensureCore.bind(manager);
  manager.ensureCore = async (coreId: string) => {
    const connection = await original(coreId);
    markCoreReady(coreId, connection.protocolVersion);
    return connection;
  };
  return manager;
}

async function bootstrap(): Promise<void> {
  registerAssetProtocol();

  sessions = trackReadiness(createSessionManager());
  registerHostCommands(sessions);

  const window = createMainWindow();
  // The bridge must exist before the renderer's first `invoke()`.
  createBridge(window);
  forwardHostEvents(sessions, window);
  loadRenderer(window);
}

void app.whenReady().then(bootstrap);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length > 0 || !sessions) return;
  const window = createMainWindow();
  createBridge(window);
  forwardHostEvents(sessions, window);
  loadRenderer(window);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Cores are child processes; leaving them behind would orphan them.
  void sessions?.dispose();
});
