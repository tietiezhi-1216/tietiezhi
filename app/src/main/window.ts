import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, nativeTheme, screen, shell } from "electron";

const HERE = import.meta.dirname;
// electron-vite emits the preload as ESM (.mjs); an ESM preload also requires
// `sandbox: false` on the window.
const PRELOAD = join(HERE, "../preload/index.mjs");

/** electron-vite exposes the dev server URL here; absent in a packaged build. */
const DEV_SERVER_URL = process.env["ELECTRON_RENDERER_URL"];

export type WindowMode = "setup" | "normal";

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowState {
  mode?: WindowMode;
  bounds?: WindowBounds;
}

const SETUP_SIZE = { width: 760, height: 560 };
const SETUP_MIN = { width: 640, height: 500 };
const NORMAL_SIZE = { width: 1320, height: 860 };
const NORMAL_MIN = { width: 900, height: 600 };

const windowModes = new WeakMap<BrowserWindow, WindowMode>();

function stateFile(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function readWindowState(): WindowState {
  try {
    const raw: unknown = JSON.parse(readFileSync(stateFile(), "utf8"));
    if (typeof raw !== "object" || raw === null) return {};
    const record = raw as Record<string, unknown>;
    const state: WindowState = {};
    if (record["mode"] === "setup" || record["mode"] === "normal") {
      state.mode = record["mode"];
    }
    const bounds = record["bounds"];
    if (typeof bounds === "object" && bounds !== null) {
      const candidate = bounds as Record<string, unknown>;
      const values = [candidate["x"], candidate["y"], candidate["width"], candidate["height"]];
      if (values.every((value) => typeof value === "number" && Number.isFinite(value))) {
        state.bounds = {
          x: candidate["x"] as number,
          y: candidate["y"] as number,
          width: Math.max(NORMAL_MIN.width, candidate["width"] as number),
          height: Math.max(NORMAL_MIN.height, candidate["height"] as number),
        };
      }
    }
    return state;
  } catch {
    return {};
  }
}

function writeWindowState(patch: WindowState): void {
  try {
    writeFileSync(stateFile(), JSON.stringify({ ...readWindowState(), ...patch }));
  } catch {
    // Losing window-state persistence is never worth surfacing an error.
  }
}

/** A remembered position is only reusable while it still overlaps a display. */
function boundsVisible(bounds: WindowBounds): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x + bounds.width > area.x + 40 &&
      bounds.x < area.x + area.width - 40 &&
      bounds.y >= area.y - 8 &&
      bounds.y < area.y + area.height - 40
    );
  });
}

function resizedBoundsAroundCenter(window: BrowserWindow, size: { width: number; height: number }): WindowBounds {
  const current = window.getBounds();
  const display = screen.getDisplayMatching(current);
  const area = display.workArea;
  const centerX = current.x + current.width / 2;
  const centerY = current.y + current.height / 2;
  return {
    x: Math.round(Math.min(Math.max(centerX - size.width / 2, area.x), area.x + area.width - size.width)),
    y: Math.round(Math.min(Math.max(centerY - size.height / 2, area.y), area.y + area.height - size.height)),
    width: size.width,
    height: size.height,
  };
}

/**
 * Switch between the compact onboarding window and the full workspace window.
 * The renderer reports the desired mode after bootstrap; repeated reports of
 * the current mode are no-ops so a normal boot never jolts the window.
 */
export function applyWindowMode(window: BrowserWindow, mode: WindowMode): void {
  if (windowModes.get(window) === mode) return;
  windowModes.set(window, mode);
  writeWindowState({ mode });
  if (mode === "setup") {
    window.setMinimumSize(SETUP_MIN.width, SETUP_MIN.height);
    window.setBounds(resizedBoundsAroundCenter(window, SETUP_SIZE), true);
    return;
  }
  window.setMinimumSize(NORMAL_MIN.width, NORMAL_MIN.height);
  const saved = readWindowState().bounds;
  if (saved && boundsVisible(saved)) {
    window.setBounds(saved, true);
  } else {
    window.setSize(NORMAL_SIZE.width, NORMAL_SIZE.height, true);
    window.center();
  }
}

export function createMainWindow(): BrowserWindow {
  const state = readWindowState();
  const mode: WindowMode = state.mode ?? "normal";
  const restored =
    mode === "normal" && state.bounds && boundsVisible(state.bounds)
      ? state.bounds
      : undefined;
  const size = mode === "setup" ? SETUP_SIZE : NORMAL_SIZE;
  const minimum = mode === "setup" ? SETUP_MIN : NORMAL_MIN;

  const window = new BrowserWindow({
    width: restored?.width ?? size.width,
    height: restored?.height ?? size.height,
    x: restored?.x,
    y: restored?.y,
    minWidth: minimum.width,
    minHeight: minimum.height,
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
  windowModes.set(window, mode);
  window.setMenuBarVisibility(false);

  // Only workspace-mode geometry is remembered; the setup window is fixed.
  let persistTimer: NodeJS.Timeout | undefined;
  const persistBounds = () => {
    if (windowModes.get(window) !== "normal" || window.isDestroyed()) return;
    if (window.isMaximized() || window.isFullScreen()) return;
    writeWindowState({ bounds: window.getBounds() });
  };
  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistBounds, 400);
  };
  window.on("moved", schedulePersist);
  window.on("resized", schedulePersist);
  window.once("close", () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistBounds();
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

export function loadRenderer(window: BrowserWindow): void {
  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(join(HERE, "../renderer/index.html"));
  }
}
