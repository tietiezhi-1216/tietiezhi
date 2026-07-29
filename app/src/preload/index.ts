/**
 * Tauri compatibility shim.
 *
 * The renderer is the unmodified `desktop/` frontend, which talks to the
 * backend exclusively through `@tauri-apps/api`. Every entry point of that
 * package bottoms out in two globals, so reproducing them here is enough to
 * run the whole frontend on Electron without touching a line of it:
 *
 * - `__TAURI_INTERNALS__` — `invoke`, `transformCallback`, `unregisterCallback`,
 *   `convertFileSrc`, `metadata`.
 * - `__TAURI_EVENT_PLUGIN_INTERNALS__` — `unregisterListener`, called by
 *   `event.js` before it invokes `plugin:event|unlisten`.
 *
 * Callbacks cannot cross the Electron IPC boundary, so they live in a table
 * here and the main process addresses them by id — the same indirection Tauri
 * uses when it `eval()`s a callback id from Rust.
 */

import { contextBridge, ipcRenderer } from "electron";

import { IPC } from "@shared/contracts";
import type { TauriInternals } from "@shared/contracts";

import { convertFileSrc } from "./asset-protocol";
import { toIpcArgs } from "./serialize";

type Callback = (payload: unknown) => void;

interface CallbackEntry {
  fn: Callback;
  once: boolean;
}

const callbacks = new Map<number, CallbackEntry>();
/** `plugin:event|listen` eventId -> callback id, so `unregisterListener` works. */
const eventListeners = new Map<string, number>();
let nextCallbackId = 1;

function listenerKey(event: string, eventId: number): string {
  return `${event} ${eventId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function transformCallback(callback: Callback, once = false): number {
  const id = nextCallbackId++;
  callbacks.set(id, { fn: callback, once });
  return id;
}

function unregisterCallback(id: number): void {
  callbacks.delete(id);
}

function dispatch(callbackId: number, message: unknown): void {
  const entry = callbacks.get(callbackId);
  if (!entry) return;
  if (entry.once) callbacks.delete(callbackId);
  try {
    entry.fn(message);
  } catch (error) {
    // The callback lives in the renderer; a throw there must not tear down the
    // IPC listener that serves every other subscriber.
    console.error("[tauri-bridge] callback threw", error);
  }
}

/** Tauri rejects with the raw error value, which the frontend reads as a string. */
function toErrorString(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error["message"] === "string") return error["message"];
  return String(error);
}

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  let payload: Record<string, unknown>;
  try {
    payload = toIpcArgs(args, (id) => callbacks.has(id));
  } catch (error) {
    throw `${cmd}: ${toErrorString(error)}`;
  }

  let result: unknown;
  try {
    result = await ipcRenderer.invoke(IPC.invoke, { cmd, args: payload });
  } catch (error) {
    // Transport-level failure: bridge not mounted, or an uncloneable result.
    throw `${cmd}: ${toErrorString(error)}`;
  }

  if (!isRecord(result)) throw `${cmd}: malformed bridge response`;
  if (result["ok"] !== true) throw toErrorString(result["error"]);

  const value = result["value"];
  rememberEventListener(cmd, payload, value);
  return value;
}

/**
 * `listen()` resolves to an eventId that `unlisten()` later hands back to
 * `unregisterListener`. Only the pairing observed here can map that eventId to
 * the callback which must be dropped.
 */
function rememberEventListener(cmd: string, args: Record<string, unknown>, value: unknown): void {
  if (cmd !== "plugin:event|listen") return;
  const handler = args["handler"];
  const event = args["event"];
  if (typeof handler !== "number" || typeof event !== "string" || typeof value !== "number") return;
  eventListeners.set(listenerKey(event, value), handler);
}

function unregisterListener(event: string, eventId: number): void {
  const key = listenerKey(event, eventId);
  const callbackId = eventListeners.get(key);
  if (callbackId === undefined) return;
  eventListeners.delete(key);
  callbacks.delete(callbackId);
}

/** Both `IPC.event` and `IPC.channel` carry `{ callbackId, message }`. */
function readDelivery(value: unknown): { callbackId: number; message: unknown } | null {
  if (!isRecord(value)) return null;
  const callbackId = value["callbackId"];
  if (typeof callbackId !== "number") return null;
  return { callbackId, message: value["message"] };
}

for (const channel of [IPC.event, IPC.channel]) {
  ipcRenderer.on(channel, (_event, payload: unknown) => {
    const delivery = readDelivery(payload);
    if (!delivery) return;
    dispatch(delivery.callbackId, delivery.message);
  });
}

const internals: TauriInternals = {
  transformCallback,
  unregisterCallback,
  invoke,
  convertFileSrc,
  // Tauri fills this with window/webview labels. The frontend only reads it
  // through APIs we do not implement, so an empty record is enough.
  metadata: {},
};

contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", internals);
contextBridge.exposeInMainWorld("__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener });
// `core.isTauri()` reads this; keeping it truthy makes the frontend take the
// native path instead of any browser fallback.
contextBridge.exposeInMainWorld("isTauri", true);
