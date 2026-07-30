/**
 * Event and channel delivery towards the renderer.
 *
 * Two distinct Tauri mechanisms share one callback table in the preload:
 *
 * - `listen(event, handler)` registers a callback id under an event name and
 *   receives `{ event, id, payload }` objects.
 * - `new Channel(onmessage)` registers a callback id that is then passed to a
 *   command as `"__CHANNEL__:<id>"`; it receives `{ index, message }` objects
 *   and expects the index to increase by one per message, ending with
 *   `{ index, end: true }`.
 */

import { webContents as allWebContents, type BrowserWindow, type WebContents } from "electron";

import { IPC } from "@shared/contracts";

/** Marker Tauri's `Channel` serializes itself to when passed as a command argument. */
export const CHANNEL_MARKER = "__CHANNEL__:";

/** A renderer target: either a window or its web contents. */
export type RendererTarget = BrowserWindow | WebContents;

interface Subscription {
  id: number;
  event: string;
  callbackId: number;
  webContentsId: number;
}

const subscriptions = new Map<number, Subscription>();
/** Per-channel message counter; `Channel` drops out-of-order messages. */
const channelIndexes = new Map<string, number>();
let nextEventId = 1;

function resolveWebContents(target: RendererTarget): WebContents {
  return "webContents" in target ? target.webContents : target;
}

function send(target: WebContents, channel: string, payload: unknown): boolean {
  if (target.isDestroyed()) return false;
  target.send(channel, payload);
  return true;
}

/** Register a `plugin:event|listen` subscription; returns the Tauri event id. */
export function addEventListener(event: string, callbackId: number, sender: WebContents): number {
  const id = nextEventId++;
  subscriptions.set(id, { id, event, callbackId, webContentsId: sender.id });
  return id;
}

/** Drop one subscription. The event name is checked to match Tauri's semantics. */
export function removeEventListener(event: string, eventId: number): boolean {
  const subscription = subscriptions.get(eventId);
  if (!subscription || subscription.event !== event) return false;
  return subscriptions.delete(eventId);
}

/**
 * Forget everything owned by a renderer. Callback ids are handed out by the
 * preload and restart at 1 for every document, so stale subscriptions would
 * deliver to unrelated callbacks after a reload.
 */
export function clearRendererState(webContentsId: number): void {
  for (const [id, subscription] of subscriptions) {
    if (subscription.webContentsId === webContentsId) subscriptions.delete(id);
  }
  const prefix = `${webContentsId}:`;
  for (const key of channelIndexes.keys()) {
    if (key.startsWith(prefix)) channelIndexes.delete(key);
  }
}

/** Subscriptions currently registered, for diagnostics. */
export function describeEventListeners(): Array<{ event: string; eventId: number; webContentsId: number }> {
  return [...subscriptions.values()].map((subscription) => ({
    event: subscription.event,
    eventId: subscription.id,
    webContentsId: subscription.webContentsId,
  }));
}

function deliver(subscription: Subscription, target: WebContents, payload: unknown): void {
  send(target, IPC.event, {
    callbackId: subscription.callbackId,
    message: { event: subscription.event, id: subscription.id, payload },
  });
}

/** Emit a Tauri event to the listeners registered by one window. */
export function emitEvent(target: RendererTarget, event: string, payload: unknown): void {
  const contents = resolveWebContents(target);
  for (const subscription of subscriptions.values()) {
    if (subscription.event !== event) continue;
    if (subscription.webContentsId !== contents.id) continue;
    deliver(subscription, contents, payload);
  }
}

/** Emit a Tauri event to every window that listens for it. */
/**
 * Observes every broadcast, in addition to the renderers.
 *
 * The event stream is how all live UI data arrives, and nothing else can see it
 * from outside a renderer — which left it untested end to end. The integration
 * probe installs an observer so it can assert on what the UI would actually
 * receive, not just on what a command returned.
 */
type EventObserver = (event: string, payload: unknown) => void;

let observer: EventObserver | null = null;

export function setEventObserver(next: EventObserver | null): void {
  observer = next;
}

export function broadcastEvent(event: string, payload: unknown): void {
  observer?.(event, payload);
  for (const subscription of subscriptions.values()) {
    if (subscription.event !== event) continue;
    const contents = allWebContents.fromId(subscription.webContentsId);
    if (!contents) {
      subscriptions.delete(subscription.id);
      continue;
    }
    deliver(subscription, contents, payload);
  }
}

/**
 * Read a channel handle out of a command argument. Handlers receive the
 * serialized form (`"__CHANNEL__:7"`), exactly like a Rust command receives a
 * `Channel<T>`.
 */
export function parseChannelId(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string" || !value.startsWith(CHANNEL_MARKER)) return null;
  const id = Number.parseInt(value.slice(CHANNEL_MARKER.length), 10);
  return Number.isInteger(id) ? id : null;
}

function indexKey(webContentsId: number, channelId: number): string {
  return `${webContentsId}:${channelId}`;
}

function takeIndex(key: string): number {
  const index = channelIndexes.get(key) ?? 0;
  channelIndexes.set(key, index + 1);
  return index;
}

/**
 * Push one message into a renderer `Channel`. Accepts the raw argument the
 * command received (`"__CHANNEL__:7"`) as well as a plain id.
 */
export function emitChannel(target: RendererTarget, channelId: number | string, payload: unknown): boolean {
  const id = parseChannelId(channelId);
  if (id === null) return false;
  const contents = resolveWebContents(target);
  const key = indexKey(contents.id, id);
  const index = takeIndex(key);
  return send(contents, IPC.channel, {
    callbackId: id,
    message: { index, message: payload },
  });
}

/**
 * Close a renderer `Channel`. The end marker carries the number of messages
 * sent so the receiver can flush anything still queued out of order before it
 * releases the callback.
 */
export function closeChannel(target: RendererTarget, channelId: number | string): boolean {
  const id = parseChannelId(channelId);
  if (id === null) return false;
  const contents = resolveWebContents(target);
  const key = indexKey(contents.id, id);
  const index = channelIndexes.get(key) ?? 0;
  channelIndexes.delete(key);
  return send(contents, IPC.channel, {
    callbackId: id,
    message: { index, end: true },
  });
}
