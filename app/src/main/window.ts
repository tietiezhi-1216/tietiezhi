import { join } from "node:path";

import { BrowserWindow, nativeTheme, shell } from "electron";

const HERE = import.meta.dirname;
// electron-vite emits the preload as ESM (.mjs); an ESM preload also requires
// `sandbox: false` on the window.
const PRELOAD = join(HERE, "../preload/index.mjs");

/** electron-vite exposes the dev server URL here; absent in a packaged build. */
const DEV_SERVER_URL = process.env["ELECTRON_RENDERER_URL"];

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "铁铁汁",
    autoHideMenuBar: true,
    backgroundColor: process.platform === "darwin"
      ? "#00000000"
      : nativeTheme.shouldUseDarkColors
        ? "#101114"
        : "#ffffff",
    vibrancy: process.platform === "darwin" ? "sidebar" : undefined,
    visualEffectState: process.platform === "darwin" ? "active" : undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 16, y: 17 } : undefined,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  window.setMenuBarVisibility(false);

  // Avoid the white flash while the renderer boots.
  window.once("ready-to-show", () => window.show());

  // External links belong in the user's browser, never in an app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

export function loadRenderer(window: BrowserWindow): void {
  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(join(HERE, "../renderer/index.html"));
  }
}
