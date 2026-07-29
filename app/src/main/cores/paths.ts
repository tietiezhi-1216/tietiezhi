/**
 * Every path a core touches lives under directories the app owns. Cores are
 * never allowed to fall back to the user's own dotfiles (`~/.claude`,
 * `~/.codex`, `~/.gemini`) — those belong to the user's terminal sessions and
 * our config projection must not overwrite them.
 */

import { app } from "electron";
import { join } from "node:path";

/**
 * Env overrides exist so the installer and registry can be exercised outside a
 * running Electron app (scripts, tests) where `app.getPath` is unavailable.
 */
function userDataDir(): string {
  const override = process.env.TIETIEZHI_DATA_DIR;
  if (override !== undefined && override.length > 0) return override;
  return app.getPath("userData");
}

/** Parent of every core's install prefix. */
export function coresRoot(): string {
  const override = process.env.TIETIEZHI_CORES_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(userDataDir(), "cores");
}

/** npm prefix for one core: packages land in `<dir>/node_modules`. */
export function coreInstallDir(coreId: string): string {
  return join(coresRoot(), coreId);
}

/** Parent of every core's isolated config directory. */
export function coreConfigRoot(): string {
  const override = process.env.TIETIEZHI_CORE_CONFIG_ROOT;
  if (override !== undefined && override.length > 0) return override;
  return join(userDataDir(), "core-config");
}

/** The directory we hand to a core through its config-dir environment variable. */
export function coreConfigDir(coreId: string): string {
  return join(coreConfigRoot(), coreId);
}

/** Appends `.exe` on Windows so descriptors can stay platform-neutral. */
export function executableName(base: string): string {
  return process.platform === "win32" ? `${base}.exe` : base;
}
