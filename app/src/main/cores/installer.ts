/**
 * Installs npm-distributed cores into a prefix the app owns, so a core upgrade
 * never touches the user's global npm root and two hosts on the same machine
 * cannot fight over versions. Versions are always pinned exactly — a floating
 * range would let a core change protocol behaviour under a running app.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoreDescriptor, CoreInstallState } from "@shared/contracts";
import { coreInstallDir } from "./paths";
import { getCoreTemplate } from "./registry";

const RECEIPT_FILE = ".tietiezhi-install.json";
/**
 * Generous on purpose: claude-code-acp drags in `sharp`, whose prebuilt libvips
 * binary alone took ~9 minutes on a cold cache during testing from CN.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const STDERR_TAIL_CHARS = 4000;
const PROGRESS_THROTTLE_MS = 250;

export interface InstallOptions {
  /**
   * Alternative npm registry. Left unset by default: rewriting the registry
   * silently would break users behind a corporate proxy that only trusts
   * registry.npmjs.org. `TIETIEZHI_NPM_REGISTRY` is the user-facing knob.
   */
  registryUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type InstallStateListener = (coreId: string, state: CoreInstallState) => void;

interface InstallReceipt {
  packageName: string;
  version: string;
  installedAt: number;
}

function parseReceipt(raw: string): InstallReceipt | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const { packageName, version, installedAt } = record;
  if (typeof packageName !== "string" || typeof version !== "string") return undefined;
  if (typeof installedAt !== "number") return undefined;
  return { packageName, version, installedAt };
}

function readVersionField(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" ? version : undefined;
}

function packageDir(coreId: string, packageName: string): string {
  return join(coreInstallDir(coreId), "node_modules", ...packageName.split("/"));
}

/** cmd.exe needs the quoting done by hand; Node's default quoting breaks `/c`. */
function quoteForCmd(arg: string): string {
  const sanitized = arg.replace(/"/g, "");
  return /[\s&|<>^]/.test(sanitized) ? `"${sanitized}"` : sanitized;
}

export class CoreInstaller {
  readonly #listeners = new Set<InstallStateListener>();
  readonly #states = new Map<string, CoreInstallState>();
  readonly #inFlight = new Map<string, Promise<CoreInstallState>>();

  /** Subscribe to install state transitions. Returns an unsubscribe function. */
  onStateChange(listener: InstallStateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Last known state, without touching the disk. */
  getState(coreId: string): CoreInstallState {
    return this.#states.get(coreId) ?? { status: "not-installed" };
  }

  #emit(coreId: string, state: CoreInstallState): void {
    this.#states.set(coreId, state);
    for (const listener of this.#listeners) {
      try {
        listener(coreId, state);
      } catch {
        // A bad subscriber must not abort an install.
      }
    }
  }

  /**
   * Reads what is actually on disk. Reports the version found rather than the
   * pinned one, so a caller can detect drift and re-install.
   */
  async checkInstalled(descriptor: CoreDescriptor): Promise<CoreInstallState> {
    const state = await this.#probe(descriptor);
    this.#states.set(descriptor.id, state);
    return state;
  }

  /** Version recorded in the installed package's own manifest, or undefined if absent. */
  async #readInstalledVersion(coreId: string, packageName: string): Promise<string | undefined> {
    try {
      return readVersionField(await readFile(join(packageDir(coreId, packageName), "package.json"), "utf8"));
    } catch {
      return undefined;
    }
  }

  async #probe(descriptor: CoreDescriptor): Promise<CoreInstallState> {
    if (descriptor.source !== "npm") {
      // builtin / binary / path cores are "installed" iff their executable exists.
      if (descriptor.command.length === 0 || !existsSync(descriptor.command)) {
        return { status: "not-installed" };
      }
      let installedAt = Date.now();
      try {
        installedAt = (await stat(descriptor.command)).mtimeMs;
      } catch {
        // Keep the fallback; mtime is only used for display.
      }
      return { status: "installed", version: descriptor.version ?? "unknown", installedAt };
    }

    const packageName = descriptor.packageName;
    if (packageName === undefined) {
      return { status: "failed", message: `core ${descriptor.id} has source "npm" but no packageName` };
    }

    const version = await this.#readInstalledVersion(descriptor.id, packageName);
    if (version === undefined) return { status: "not-installed" };

    // The receipt is only written after npm exits 0, so it is the proof that
    // the *dependency tree* is complete. Without it the top-level package can
    // be on disk while its deps are missing — an interrupted or timed-out
    // install looks identical to a good one otherwise, and the core then dies
    // with ERR_MODULE_NOT_FOUND at spawn time.
    let receipt: InstallReceipt | undefined;
    try {
      receipt = parseReceipt(await readFile(join(coreInstallDir(descriptor.id), RECEIPT_FILE), "utf8"));
    } catch {
      receipt = undefined;
    }
    if (receipt === undefined || receipt.packageName !== packageName) {
      return {
        status: "failed",
        message: `${packageName} is present under ${coreInstallDir(descriptor.id)} but the install never completed; re-install the core`,
      };
    }
    return { status: "installed", version, installedAt: receipt.installedAt };
  }

  /**
   * Installs the pinned version. Concurrent calls for the same core share one
   * npm run — npm is not safe to run twice against the same prefix.
   */
  async install(descriptor: CoreDescriptor, options: InstallOptions = {}): Promise<CoreInstallState> {
    const pending = this.#inFlight.get(descriptor.id);
    if (pending !== undefined) return pending;

    const run = this.#runInstall(descriptor, options).finally(() => {
      this.#inFlight.delete(descriptor.id);
    });
    this.#inFlight.set(descriptor.id, run);
    return run;
  }

  async #runInstall(descriptor: CoreDescriptor, options: InstallOptions): Promise<CoreInstallState> {
    if (descriptor.source !== "npm") {
      const state = await this.#probe(descriptor);
      this.#emit(descriptor.id, state);
      return state;
    }

    const packageName = descriptor.packageName;
    const version = descriptor.version ?? getCoreTemplate(descriptor.id)?.version;
    if (packageName === undefined || version === undefined) {
      const failed: CoreInstallState = {
        status: "failed",
        message: `core ${descriptor.id} is missing packageName/version, refusing to install an unpinned core`,
      };
      this.#emit(descriptor.id, failed);
      return failed;
    }

    const prefix = coreInstallDir(descriptor.id);
    this.#emit(descriptor.id, { status: "installing", progress: 0.02 });

    try {
      await mkdir(prefix, { recursive: true });
      // Without a manifest in the prefix npm walks up and can adopt an
      // unrelated package.json as the install root.
      await writeFile(
        join(prefix, "package.json"),
        `${JSON.stringify({ name: `tietiezhi-core-${descriptor.id}`, version: "0.0.0", private: true }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      const failed: CoreInstallState = { status: "failed", message: `cannot prepare ${prefix}: ${String(error)}` };
      this.#emit(descriptor.id, failed);
      return failed;
    }

    const registryUrl = options.registryUrl ?? process.env.TIETIEZHI_NPM_REGISTRY;
    const args = [
      "install",
      `${packageName}@${version}`,
      "--prefix",
      prefix,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      "--loglevel=info",
    ];
    if (registryUrl !== undefined && registryUrl.length > 0) args.push(`--registry=${registryUrl}`);

    const result = await this.#spawnNpm(descriptor.id, args, prefix, options);
    if (!result.ok) {
      const failed: CoreInstallState = { status: "failed", message: result.message };
      this.#emit(descriptor.id, failed);
      return failed;
    }

    const installedVersion = await this.#readInstalledVersion(descriptor.id, packageName);
    if (installedVersion === undefined) {
      const failed: CoreInstallState = {
        status: "failed",
        message: `npm exited 0 but ${packageName} is not present under ${prefix}\n${result.stderrTail}`,
      };
      this.#emit(descriptor.id, failed);
      return failed;
    }

    // Written only on the success path: `checkInstalled` treats its absence as
    // an incomplete install.
    const receipt: InstallReceipt = { packageName, version: installedVersion, installedAt: Date.now() };
    try {
      await writeFile(join(prefix, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    } catch (error) {
      const failed: CoreInstallState = {
        status: "failed",
        message: `installed ${packageName}@${installedVersion} but could not write the install receipt: ${String(error)}`,
      };
      this.#emit(descriptor.id, failed);
      return failed;
    }

    const installed: CoreInstallState = {
      status: "installed",
      version: installedVersion,
      installedAt: receipt.installedAt,
    };
    this.#emit(descriptor.id, installed);
    return installed;
  }

  #spawnNpm(
    coreId: string,
    args: string[],
    cwd: string,
    options: InstallOptions,
  ): Promise<{ ok: true; stderrTail: string } | { ok: false; message: string; stderrTail: string }> {
    return new Promise((resolve) => {
      const env = { ...process.env };
      // Inherited from our own launcher, this would make npm's node shim
      // behave as Electron-as-node in unexpected ways.
      delete env.ELECTRON_RUN_AS_NODE;

      const child =
        process.platform === "win32"
          ? spawn(process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", `npm ${args.map(quoteForCmd).join(" ")}`], {
              cwd,
              env,
              windowsVerbatimArguments: true,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            })
          : spawn("npm", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      let lines = 0;
      let lastEmit = 0;
      let settled = false;

      const bumpProgress = (): void => {
        lines += 1;
        const now = Date.now();
        if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
        lastEmit = now;
        // npm has no machine-readable progress, so approach 0.9 asymptotically
        // with log output volume rather than inventing a fake percentage.
        const progress = 0.1 + 0.8 * (1 - Math.exp(-lines / 60));
        this.#emit(coreId, { status: "installing", progress: Math.round(progress * 100) / 100 });
      };

      const collect = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        stderr += text;
        if (stderr.length > STDERR_TAIL_CHARS * 4) stderr = stderr.slice(-STDERR_TAIL_CHARS * 4);
        for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") bumpProgress();
      };

      child.stderr.on("data", collect);
      child.stdout.on("data", collect);

      const tail = (): string => stderr.slice(-STDERR_TAIL_CHARS).trim();

      const finish = (value: { ok: true; stderrTail: string } | { ok: false; message: string; stderrTail: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };

      const kill = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
      };

      const onAbort = (): void => {
        kill();
        finish({ ok: false, message: "install cancelled", stderrTail: tail() });
      };

      const timer = setTimeout(() => {
        kill();
        finish({
          ok: false,
          message: `npm install timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms\n${tail()}`,
          stderrTail: tail(),
        });
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      if (options.signal?.aborted === true) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (error) => {
        finish({
          ok: false,
          message: `cannot run npm (${error.message}). npm must be on PATH to install cores.`,
          stderrTail: tail(),
        });
      });

      child.on("close", (code) => {
        if (code === 0) finish({ ok: true, stderrTail: tail() });
        else finish({ ok: false, message: `npm install exited with code ${String(code)}\n${tail()}`, stderrTail: tail() });
      });
    });
  }

  /** Removes the whole prefix. Safe to call when nothing is installed. */
  async uninstall(coreId: string): Promise<void> {
    const prefix = coreInstallDir(coreId);
    await rm(prefix, { recursive: true, force: true });
    this.#emit(coreId, { status: "not-installed" });
  }
}

/** Process-wide installer; the IPC layer and the core manager share one. */
export const coreInstaller = new CoreInstaller();
