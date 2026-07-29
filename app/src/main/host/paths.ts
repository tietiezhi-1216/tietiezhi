import { cp, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { app } from "electron";

/**
 * Data directory of the shipping Tauri build.
 *
 * Treated as **read-only**. The Electron host is new code; writing into the
 * directory the production app is actively using could corrupt real user data,
 * so the first run copies what it needs and everything after that stays in the
 * host's own directory.
 */
export function legacyDataDir(): string {
  const identifier = "com.tietiezhi.tietiezhi";
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", identifier);
    case "win32":
      return join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), identifier);
    default:
      return join(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), identifier);
  }
}

/** The host's own data directory. Everything written lives here. */
export function dataDir(): string {
  return app.getPath("userData");
}

export function dataPath(...segments: string[]): string {
  return join(dataDir(), ...segments);
}

/** Entries copied from the Tauri build on first run. */
const IMPORTED = [
  "settings.json",
  "projects.json",
  "tietiezhi.json",
  "conversations",
  "tasks",
  "skills",
  "automations",
  "tietiezhi",
  "suggestions",
  "agent-runtime",
];

const IMPORT_MARKER = ".legacy-imported";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the Tauri build's data once, so the host starts with the user's real
 * providers, tasks and skills instead of an empty profile. Never overwrites an
 * entry the host already has, and never writes back to the source.
 */
export async function importLegacyDataOnce(): Promise<{ imported: string[]; skipped: string[] }> {
  const marker = dataPath(IMPORT_MARKER);
  if (await exists(marker)) return { imported: [], skipped: ["already-imported"] };

  const source = legacyDataDir();
  if (!(await exists(source))) {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(marker, new Date().toISOString(), "utf8");
    return { imported: [], skipped: ["no-legacy-data"] };
  }

  const imported: string[] = [];
  const skipped: string[] = [];
  for (const entry of IMPORTED) {
    const from = join(source, entry);
    const to = dataPath(entry);
    if (!(await exists(from))) {
      skipped.push(`${entry}: 源不存在`);
      continue;
    }
    if (await exists(to)) {
      skipped.push(`${entry}: 目标已存在，保留宿主数据`);
      continue;
    }
    try {
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to, { recursive: true, errorOnExist: true, force: false });
      imported.push(entry);
    } catch (error) {
      skipped.push(`${entry}: ${String(error)}`);
    }
  }

  await writeFile(marker, new Date().toISOString(), "utf8");
  return { imported, skipped };
}

let tempCounter = 0;

/**
 * Atomic JSON write: a torn settings.json costs the user every provider they
 * configured, so the rename has to be the only visible mutation.
 *
 * The temp name must be unique per call, not per process. Two writers of the
 * same file inside one process (settings.json is written by both the settings
 * module and the skills toggle) would otherwise share a temp path: the second
 * `writeFile` truncates what the first is still filling, and the first
 * `rename` publishes that half-written buffer.
 *
 * `rename` makes the swap atomic but says nothing about durability, so the
 * data is fsynced before it becomes visible — otherwise a power loss can land
 * the metadata change ahead of the contents and produce the very torn file
 * this function exists to prevent.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${++tempCounter}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, "w");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    // Leaving temp files behind would accumulate silently in the data dir.
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Reads JSON, returning `fallback` when the file is missing or unparsable. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}
