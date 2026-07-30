import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import { app, BrowserWindow, dialog, protocol } from "electron";

import {
  ASSET_PROTOCOL,
  assetUrlToPath,
  createBridge,
  describeRegisteredCommands,
} from "./bridge/index.js";
import { forwardHostEvents, registerHostCommands } from "./commands.js";
import { createSessionManager, markCoreReady } from "./core-launcher.js";
import { getCoreProcessManager } from "./cores/process.js";
import {
  dataDir,
  disposeTerminals,
  importLegacyDataOnce,
  registerHostModules,
} from "./host/index.js";
import { createMainWindow, loadRenderer, rendererRoot } from "./window.js";
import { handleRendererScheme, registerRendererScheme } from "./renderer-protocol.js";
import type { AcpSessionManager } from "./acp/index.js";

// Must run before `whenReady`, or the renderer cannot fetch asset URLs.
protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
registerRendererScheme();

let sessions: AcpSessionManager | null = null;

/**
 * Directories the renderer may read through `tietiezhi-asset://`.
 *
 * The Tauri build restricted its asset protocol to `$APPDATA/create-assets`.
 * Without an equivalent allowlist any string that reaches an `<img src>` —
 * a model reply, an MCP tool result, a filename in a repo — could read back
 * arbitrary files, `secrets.enc.json` included.
 */
function assetRoots(): string[] {
  return [join(dataDir(), "create-assets"), join(dataDir(), "tietiezhi")];
}

function isInsideAllowedRoot(target: string): boolean {
  return assetRoots().some((root) => target === root || target.startsWith(root + sep));
}

function registerAssetProtocol(): void {
  protocol.handle(ASSET_PROTOCOL, async (request) => {
    const path = assetUrlToPath(request.url);
    if (!path) return new Response("bad asset url", { status: 400 });
    // Resolve symlinks before checking: a link inside create-assets must not
    // become a window onto the rest of the disk.
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch {
      return new Response("not found", { status: 404 });
    }
    if (!isInsideAllowedRoot(resolved)) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      return new Response(await readFile(resolved));
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
  if (!process.env["ELECTRON_RENDERER_URL"]) handleRendererScheme(rendererRoot());

  // Must finish before any command can read a store, or a first read would
  // cache an empty profile and the import would then be skipped forever.
  try {
    const result = await importLegacyDataOnce();
    console.log(
      `[host] legacy import: imported=[${result.imported.join(", ")}] skipped=[${result.skipped.join(" | ")}]`,
    );
  } catch (error) {
    // A failed import must not stop the app: the host simply starts empty.
    console.error("[host] legacy import failed:", error);
  }

  registerHostModules();

  sessions = trackReadiness(createSessionManager());
  registerHostCommands(sessions);

  const window = createMainWindow();
  // The bridge must exist before the renderer's first `invoke()`.
  createBridge(window);
  // Subscribed once for the process, not per window: `broadcastEvent` already
  // reaches every window, so re-subscribing on `activate` would deliver each
  // stream delta twice and duplicate the assistant's reply.
  forwardHostEvents(sessions, window);

  // The port is incremental: knowing exactly which commands exist is the only
  // way to tell a missing module from a broken one while it is in progress.
  if (process.env["TIETIEZHI_DEBUG_COMMANDS"]) {
    const names = describeRegisteredCommands().map((entry) => entry.name);
    console.log(`[host] registered ${names.length} command(s): ${names.join(" ")}`);
  }

  loadRenderer(window);
}

void app.whenReady().then(async () => {
  try {
    await bootstrap();
  } catch (error) {
    // Without this the rejection is unhandled: on macOS the process stays
    // alive with no window and no message, and the user can only force-quit.
    console.error("[host] bootstrap failed:", error);
    dialog.showErrorBox("铁铁汁启动失败", String(error));
    app.exit(1);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length > 0 || !sessions) return;
  const window = createMainWindow();
  createBridge(window);
  // No `forwardHostEvents` here — the subscription made during bootstrap is
  // process-wide and already broadcasts to this new window.
  loadRenderer(window);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let shuttingDown = false;

/**
 * Cores are child processes, and at least one shipped agent ignores SIGTERM,
 * so quitting has to actually wait for the escalation to SIGKILL. `before-quit`
 * cannot await, so the quit is deferred once and re-issued when teardown is
 * genuinely done.
 */
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  void (async () => {
    try {
      await sessions?.dispose();
      await getCoreProcessManager().stopAll();
      // A pty child outlives its parent unless killed explicitly.
      disposeTerminals();
    } catch (error) {
      console.error("[host] shutdown failed:", error);
    } finally {
      app.quit();
    }
  })();
});
