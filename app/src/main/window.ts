import { join } from "node:path";

import { BrowserWindow, shell } from "electron";

import { RENDERER_ORIGIN } from "./renderer-protocol.js";

/**
 * The renderer is the existing desktop frontend. It reaches the main process
 * only through `window.__TAURI_INTERNALS__`, which the preload injects, so
 * context isolation stays on and the renderer keeps no Node access.
 */
const HERE = import.meta.dirname;
// electron-vite emits the preload as ESM (.mjs); an ESM preload also requires
// `sandbox: false` on the window.
const PRELOAD = join(HERE, "../preload/index.mjs");

/** electron-vite exposes the dev server URL here; absent in a packaged build. */
const DEV_SERVER_URL = process.env["ELECTRON_RENDERER_URL"];

export interface WindowOptions {
  /** Which renderer entry to load. `capsule` is the small always-on-top panel. */
  entry?: "index" | "capsule";
}

/**
 * Creates the window without loading anything. The caller must attach the
 * invoke bridge before calling `loadRenderer`, otherwise the renderer's first
 * `invoke()` calls race the handler registration and get rejected.
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Avoid the white flash while the renderer boots.
  window.once("ready-to-show", () => window.show());

  // External links belong in the user's browser, never in an app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

export function loadRenderer(window: BrowserWindow, options: WindowOptions = {}): void {
  const entry = options.entry ?? "index";
  if (DEV_SERVER_URL) {
    void window.loadURL(`${DEV_SERVER_URL}/${entry}.html`);
  } else {
    void window.loadURL(`${RENDERER_ORIGIN}/${entry}.html`);
  }
}

/** Directory the built renderer is served from. */
export function rendererRoot(): string {
  return join(HERE, "../renderer");
}
