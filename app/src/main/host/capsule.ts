/**
 * The floating dictation capsule window — the Electron port of
 * `commands/capsule.rs`.
 *
 * Borderless, transparent, always on top, and pinned to the bottom-center of
 * the primary display's work area. It **never takes focus**: dictation inserts
 * into whatever app the user is typing in, so stealing focus would move the
 * caret away from the field we are about to write to. Hence `showInactive()`
 * rather than `show()` everywhere below.
 *
 * Unlike the Tauri build — which built the window hidden during setup — the
 * window here is created on first `show_capsule`. The host's bootstrap is not
 * ours to extend, and lazy creation has the same observable behaviour: the
 * window is transparent with no content until React mounts, so showing it
 * before the first paint reveals nothing.
 */

import { join } from "node:path";

import { app, BrowserWindow, screen, type Display, type Rectangle } from "electron";

import { createBridge, registerCommands } from "../bridge/index.js";
import { loadRenderer } from "../window.js";

/** Same geometry as the Rust original; the renderer's CSS assumes this width. */
const WIDTH = 400;
const COMPACT_HEIGHT = 120;
const MAX_HEIGHT = 800;

// electron-vite emits the preload as ESM (.mjs), which is also why the window
// needs `sandbox: false`. Mirrors the path `window.ts` builds for the main
// window: both files bundle into out/main, so the relative hop is identical.
const PRELOAD = join(import.meta.dirname, "../preload/index.mjs");

let capsule: BrowserWindow | null = null;
let hooksInstalled = false;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function primaryWorkArea(): Rectangle {
  let display: Display | undefined;
  try {
    display = screen.getPrimaryDisplay();
  } catch (error) {
    throw new Error(`读取显示器信息失败：${String(error)}`);
  }
  if (!display) throw new Error("未找到主显示器");
  // Electron reports display geometry in DIP, the same logical space window
  // bounds use, so no scale-factor conversion is needed here (the Rust version
  // divided by the scale factor because Tauri hands out physical pixels).
  return display.workArea;
}

/** Bottom-center bounds for a capsule of the requested height. */
function bottomCenter(height: number): Rectangle {
  const area = primaryWorkArea();
  // The work area already excludes the macOS menu bar and Dock. Clamping the
  // height to it keeps an expanded capsule from sliding under the menu bar,
  // where its close affordance would be unreachable.
  const bounded = Math.min(Math.round(height), Math.max(COMPACT_HEIGHT, Math.round(area.height)));
  return {
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: Math.round(area.y + area.height - bounded),
    width: WIDTH,
    height: bounded,
  };
}

function clampHeight(height: number): number {
  if (!Number.isFinite(height)) return COMPACT_HEIGHT;
  return Math.min(MAX_HEIGHT, Math.max(COMPACT_HEIGHT, height));
}

/**
 * `resizable: false` makes the platform reject programmatic resizes on some
 * window managers, so the flag is lifted for the duration of the move. Bounds
 * are applied in a single call: two steps would show the capsule jump.
 */
function applyBounds(window: BrowserWindow, bounds: Rectangle): void {
  window.setResizable(true);
  window.setBounds(bounds);
  window.setResizable(false);
}

// ---------------------------------------------------------------------------
// Window lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates the capsule window if it does not exist. Kept hidden — the caller
 * decides when to reveal it.
 */
export function ensureCapsuleWindow(): BrowserWindow {
  if (capsule && !capsule.isDestroyed()) return capsule;

  const bounds = bottomCenter(COMPACT_HEIGHT);
  let window: BrowserWindow;
  try {
    window = new BrowserWindow({
      title: "语音听写",
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      show: false,
      frame: false,
      transparent: true,
      // Transparency alone leaves a white base color on Windows.
      backgroundColor: "#00000000",
      // The pill draws its own capsule-shaped shadow; the native one would
      // trace the rectangular frame around it.
      hasShadow: false,
      alwaysOnTop: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
  } catch (error) {
    throw new Error(`创建胶囊窗口失败：${String(error)}`);
  }

  // Dictation happens over whatever the user is working in, including a
  // fullscreen app, so the capsule follows them across spaces. A no-op on
  // platforms without the concept.
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Nothing must survive the window: a stale handle would make `show_capsule`
  // throw instead of rebuilding.
  window.on("closed", () => {
    if (capsule === window) capsule = null;
  });

  capsule = window;
  installLifecycleHooks();

  // Must precede `loadRenderer`: the capsule's first `invoke()` fires during
  // mount, and without the bridge attached every one of them is rejected.
  createBridge(window);
  loadRenderer(window, { entry: "capsule" });

  return window;
}

/** The live capsule window, or `null` when it has never been shown / was closed. */
export function getCapsuleWindow(): BrowserWindow | null {
  return capsule && !capsule.isDestroyed() ? capsule : null;
}

/** Destroys the capsule. Safe to call repeatedly; a later show recreates it. */
export function disposeCapsule(): void {
  const window = capsule;
  capsule = null;
  if (window && !window.isDestroyed()) window.destroy();
}

function installLifecycleHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  // A `closed` handler on the window is not enough: quitting tears windows
  // down without it in every case, and a surviving transparent window would
  // keep the process visible on screen while the cores shut down.
  app.on("before-quit", () => disposeCapsule());

  // Outside macOS the app quits on `window-all-closed`, which never fires while
  // the capsule exists — even hidden. Releasing it once the last real window is
  // gone keeps the process from lingering with no reachable UI. macOS is
  // excluded on purpose: there the app legitimately outlives its windows, and
  // dictation must keep working after the main window was closed.
  if (process.platform !== "darwin") watchForLastWindow();
}

function watchForLastWindow(): void {
  const disposeIfLast = (): void => {
    // Deferred so the check cannot observe the window that is closing right
    // now, whichever order Electron removes it from the list in.
    setImmediate(() => {
      const others = BrowserWindow.getAllWindows().filter(
        (window) => window !== capsule && !window.isDestroyed(),
      );
      if (others.length === 0) disposeCapsule();
    });
  };
  const watch = (window: BrowserWindow): void => {
    if (window === capsule) return;
    window.once("closed", disposeIfLast);
  };
  // The main window already exists by the time the capsule is first shown, so
  // both the current and the future windows have to be picked up.
  for (const window of BrowserWindow.getAllWindows()) watch(window);
  app.on("browser-window-created", (_event, window) => watch(window));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Shows the capsule for a dictation session, re-anchored to the bottom edge.
 * Deliberately does not focus it.
 */
function showCapsule(): null {
  const window = ensureCapsuleWindow();
  // Re-read the current height: the renderer may have expanded the window for a
  // result card before the last hide, and that height must be preserved.
  const height = clampHeight(window.getBounds().height);
  applyBounds(window, bottomCenter(height));
  window.showInactive();
  return null;
}

function hideCapsule(): null {
  const window = getCapsuleWindow();
  if (window) window.hide();
  return null;
}

/**
 * Resizes the capsule while keeping it glued to the bottom edge. Used when the
 * result card expands or collapses above the pill.
 */
function capsuleSetHeight(height: number): null {
  const window = getCapsuleWindow();
  if (!window) throw new Error("胶囊窗口不存在");
  applyBounds(window, bottomCenter(clampHeight(height)));
  return null;
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`参数 ${key} 必须是数字`);
  }
  return value;
}

export function registerCapsuleCommands(): void {
  registerCommands({
    show_capsule: () => showCapsule(),
    hide_capsule: () => hideCapsule(),
    capsule_set_height: (args) => capsuleSetHeight(numberArg(args, "height")),
  });
}
