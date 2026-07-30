/**
 * Tauri compatibility bridge, main-process half.
 *
 * The preload turns `window.__TAURI_INTERNALS__.invoke()` into a single
 * `IPC.invoke` request; this module dispatches it to a registered
 * {@link CommandHandler} and pushes events and channel messages back.
 *
 * See `README.md` in this directory for the wire contract.
 */

import { ipcMain, type BrowserWindow, type WebContents } from "electron";

import { IPC } from "@shared/contracts";

import { registerBuiltinCommands } from "./builtin";
import { clearRendererState } from "./events";
import { dispatchCommand } from "./registry";

export type {
  CommandDescription,
  InvocationContext,
  RegisterOptions,
} from "./registry";
export {
  currentInvocation,
  describeRegisteredCommands,
  // Exported for the integration probe, which drives real handlers without a
  // renderer; the IPC path uses it internally.
  dispatchCommand,
  hasCommand,
  registerCommand,
  registerCommands,
  requireInvocation,
  unregisterCommand,
} from "./registry";

export type { RendererTarget } from "./events";
export {
  CHANNEL_MARKER,
  broadcastEvent,
  closeChannel,
  describeEventListeners,
  emitChannel,
  emitEvent,
  parseChannelId,
} from "./events";

// Re-exported so the main process can register the protocol that serves the
// URLs `convertFileSrc()` hands to the webview.
export {
  ASSET_HOST,
  ASSET_PROTOCOL,
  ASSET_URL_PREFIX,
  assetUrlToPath,
} from "../../preload/asset-protocol";

/** Reply envelope. Errors travel as data so the renderer sees Tauri's shape. */
type InvokeResult = { ok: true; value: unknown } | { ok: false; error: string };

export interface Bridge {
  readonly window: BrowserWindow;
  /** Detach this window: drop its subscriptions and, for the last window, the IPC handler. */
  dispose(): void;
}

/** `ipcMain.handle` allows a single handler per channel, so mount it once. */
let mountedBridges = 0;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function readRequest(payload: unknown): { cmd: string; args: Record<string, unknown> } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const cmd = record["cmd"];
  if (typeof cmd !== "string" || cmd.length === 0) return null;
  const args = record["args"];
  const isRecord = typeof args === "object" && args !== null && !Array.isArray(args);
  return { cmd, args: isRecord ? (args as Record<string, unknown>) : {} };
}

async function handleInvoke(sender: WebContents, payload: unknown): Promise<InvokeResult> {
  const request = readRequest(payload);
  if (!request) {
    return { ok: false, error: "bridge: malformed invoke request" };
  }
  try {
    const value = await dispatchCommand(request.cmd, request.args, sender);
    // `undefined` is not structured-cloneable in every Electron version and
    // Tauri commands returning `()` resolve to null, so normalize it.
    return { ok: true, value: value === undefined ? null : value };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

function mountHandler(): void {
  if (mountedBridges === 0) {
    ipcMain.handle(IPC.invoke, async (event, payload: unknown) => handleInvoke(event.sender, payload));
  }
  mountedBridges += 1;
}

function unmountHandler(): void {
  mountedBridges = Math.max(0, mountedBridges - 1);
  if (mountedBridges === 0) ipcMain.removeHandler(IPC.invoke);
}

/**
 * Wire a window to the bridge. Safe to call for every window the app opens;
 * the command registry is shared, the listener tables are per renderer.
 */
export function createBridge(window: BrowserWindow): Bridge {
  registerBuiltinCommands();
  mountHandler();

  const contents = window.webContents;
  // Captured because reading `.id` off destroyed web contents throws.
  const contentsId = contents.id;
  let disposed = false;

  // A reload starts a fresh preload with callback ids counting from 1 again,
  // so subscriptions from the previous document must not survive it.
  const onStartLoading = (): void => clearRendererState(contentsId);
  contents.on("did-start-loading", onStartLoading);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (!contents.isDestroyed()) contents.removeListener("did-start-loading", onStartLoading);
    clearRendererState(contentsId);
    unmountHandler();
  };

  contents.once("destroyed", dispose);

  return { window, dispose };
}
