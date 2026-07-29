/**
 * Owns the OS processes behind the cores. ACP speaks JSON-RPC over the child's
 * stdin/stdout, so the manager only hands the streams out — framing and the
 * protocol handshake belong to the ACP layer, which calls `markReady` once
 * `initialize` succeeds.
 */

import {
  spawn,
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
  type StdioPipe,
} from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { app } from "electron";
import type { CoreDescriptor, CoreRunState } from "@shared/contracts";
import { coreInstallDir } from "./paths";
import { getCore, getCoreConfigPaths } from "./registry";

const DEFAULT_MAX_RESTARTS = 3;
const RESTART_BASE_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 15_000;
/** A process that lived this long is considered healthy; its restart budget resets. */
const STABLE_UPTIME_MS = 60_000;
const STDERR_RING_LINES = 500;
const STOP_GRACE_MS = 3_000;

type CoreChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** What the ACP layer needs to talk to a running core. */
export interface CoreProcessHandle {
  coreId: string;
  pid: number;
  startedAt: number;
  stdin: Writable;
  stdout: Readable;
  /**
   * Bumped on every (re)start. An ACP connection created for generation N must
   * drop itself when the manager has moved on to N+1.
   */
  generation: number;
}

export type RunStateListener = (coreId: string, state: CoreRunState) => void;
export type CoreExitListener = (
  coreId: string,
  info: { code: number | null; signal: NodeJS.Signals | null; generation: number; willRestart: boolean },
) => void;

export interface CoreProcessManagerOptions {
  /** Restart attempts after an unexpected exit before giving up. */
  maxRestarts?: number;
  /** Working directory for cores; per-session cwd is an ACP concern, not this one. */
  defaultCwd?: string;
}

export interface StartOptions {
  cwd?: string;
  /** Extra environment merged on top of the descriptor's. */
  env?: Record<string, string>;
  /** Set false for a one-shot probe that should not be resurrected. */
  autoRestart?: boolean;
}

interface CoreRecord {
  descriptor: CoreDescriptor;
  state: CoreRunState;
  child?: CoreChild;
  handle?: CoreProcessHandle;
  stderr: string[];
  stderrPartial: string;
  restarts: number;
  generation: number;
  startedAt: number;
  autoRestart: boolean;
  /** Set while `stop()` is tearing the process down, to suppress the restart path. */
  intentionalStop: boolean;
  restartTimer?: NodeJS.Timeout;
  startOptions: StartOptions;
}

function pathKeyOf(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path";
}

export class CoreProcessManager {
  readonly #records = new Map<string, CoreRecord>();
  readonly #stateListeners = new Set<RunStateListener>();
  readonly #exitListeners = new Set<CoreExitListener>();
  readonly #maxRestarts: number;
  readonly #defaultCwd: string;
  #exitHooksInstalled = false;
  #shuttingDown = false;

  constructor(options: CoreProcessManagerOptions = {}) {
    this.#maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.#defaultCwd = options.defaultCwd ?? homedir();
    this.#installExitHooks();
  }

  onStateChange(listener: RunStateListener): () => void {
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  onExit(listener: CoreExitListener): () => void {
    this.#exitListeners.add(listener);
    return () => {
      this.#exitListeners.delete(listener);
    };
  }

  getState(coreId: string): CoreRunState {
    return this.#records.get(coreId)?.state ?? { status: "stopped" };
  }

  getHandle(coreId: string): CoreProcessHandle | undefined {
    return this.#records.get(coreId)?.handle;
  }

  /** Recent stderr lines, oldest first. The single most useful diagnostic for a core that will not start. */
  getStderr(coreId: string): string[] {
    return [...(this.#records.get(coreId)?.stderr ?? [])];
  }

  /** Ids of cores that currently have a live child process. */
  runningCoreIds(): string[] {
    return [...this.#records.entries()].filter(([, r]) => r.child !== undefined).map(([id]) => id);
  }

  /**
   * Starts a core, or returns the existing handle if it is already up.
   * Throws when the core is unknown or its executable is missing.
   */
  start(coreId: string, options: StartOptions = {}): CoreProcessHandle {
    const existing = this.#records.get(coreId);
    if (existing?.handle !== undefined && existing.child !== undefined) return existing.handle;

    const descriptor = getCore(coreId);
    if (descriptor === undefined) throw new Error(`unknown core: ${coreId}`);

    const record: CoreRecord =
      existing ??
      ({
        descriptor,
        state: { status: "stopped" },
        stderr: [],
        stderrPartial: "",
        restarts: 0,
        generation: 0,
        startedAt: 0,
        autoRestart: options.autoRestart ?? true,
        intentionalStop: false,
        startOptions: options,
      } satisfies CoreRecord);
    record.descriptor = descriptor;
    record.startOptions = options;
    record.autoRestart = options.autoRestart ?? true;
    record.intentionalStop = false;
    // An explicit start is a user decision, so it refills the restart budget a
    // previous crash loop may have exhausted.
    record.restarts = 0;
    this.#records.set(coreId, record);

    if (record.restartTimer !== undefined) {
      clearTimeout(record.restartTimer);
      record.restartTimer = undefined;
    }

    return this.#spawnCore(record);
  }

  #spawnCore(record: CoreRecord): CoreProcessHandle {
    const { descriptor } = record;
    const coreId = descriptor.id;

    if (descriptor.command.length === 0) {
      throw new Error(`core ${coreId} has no command configured`);
    }
    // Electron-as-node cores put the JS entry in args[0]; check that instead of
    // process.execPath, which always exists.
    const entry = descriptor.command === process.execPath ? descriptor.args[0] : descriptor.command;
    if (entry !== undefined && !existsSync(entry)) {
      const message = `core ${coreId} is not installed (missing ${entry})`;
      this.#setState(record, { status: "crashed", code: null, message });
      throw new Error(message);
    }

    const env: NodeJS.ProcessEnv = { ...process.env, ...descriptor.env, ...record.startOptions.env };
    const binDir = join(coreInstallDir(coreId), "node_modules", ".bin");
    const key = pathKeyOf(env);
    env[key] = [binDir, env[key] ?? ""].filter((part) => part.length > 0).join(delimiter);

    // Create the isolated config dir up front: several CLIs refuse to start
    // when the directory their config variable points at does not exist.
    const configPaths = getCoreConfigPaths(coreId);
    if (configPaths !== undefined) {
      try {
        mkdirSync(configPaths.settingsDir, { recursive: true });
      } catch {
        // Non-fatal: the core may create it itself.
      }
    }

    const spawnOptions: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe> = {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: record.startOptions.cwd ?? this.#defaultCwd,
      env,
      windowsHide: true,
      // Own process group on POSIX so a core that spawns its own tools can be
      // killed wholesale instead of leaving grandchildren behind.
      detached: process.platform !== "win32",
    };

    const child = spawn(descriptor.command, descriptor.args, spawnOptions);
    const generation = record.generation + 1;

    record.child = child;
    record.generation = generation;
    record.startedAt = Date.now();
    record.stderrPartial = "";
    this.#setState(record, { status: "starting" });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#absorbStderr(record, chunk);
    });

    child.on("error", (error) => {
      this.#handleExit(record, generation, null, null, error.message);
    });

    child.on("exit", (code, signal) => {
      this.#handleExit(record, generation, code, signal);
    });

    const pid = child.pid;
    if (pid === undefined) {
      // spawn() failed synchronously; the 'error' event carries the reason.
      throw new Error(`core ${coreId} failed to spawn`);
    }

    const handle: CoreProcessHandle = {
      coreId,
      pid,
      startedAt: record.startedAt,
      stdin: child.stdin,
      stdout: child.stdout,
      generation,
    };
    record.handle = handle;
    return handle;
  }

  /** Called by the ACP layer after a successful `initialize`. */
  markReady(coreId: string, protocolVersion: number): void {
    const record = this.#records.get(coreId);
    if (record === undefined) return;
    const pid = record.handle?.pid;
    if (pid === undefined) return;
    this.#setState(record, { status: "ready", pid, protocolVersion });
  }

  #absorbStderr(record: CoreRecord, chunk: string): void {
    const combined = record.stderrPartial + chunk;
    const parts = combined.split("\n");
    record.stderrPartial = parts.pop() ?? "";
    for (const line of parts) {
      record.stderr.push(line);
    }
    if (record.stderr.length > STDERR_RING_LINES) {
      record.stderr.splice(0, record.stderr.length - STDERR_RING_LINES);
    }
  }

  #handleExit(
    record: CoreRecord,
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
    errorMessage?: string,
  ): void {
    // A late event from a process we already replaced must not clobber state.
    if (generation !== record.generation) return;
    if (record.child === undefined) return;

    if (record.stderrPartial.length > 0) {
      record.stderr.push(record.stderrPartial);
      record.stderrPartial = "";
    }
    record.child = undefined;
    record.handle = undefined;

    const uptime = Date.now() - record.startedAt;
    if (uptime >= STABLE_UPTIME_MS) record.restarts = 0;

    if (record.intentionalStop || this.#shuttingDown) {
      record.intentionalStop = false;
      this.#setState(record, { status: "stopped" });
      this.#notifyExit(record.descriptor.id, code, signal, generation, false);
      return;
    }

    const canRestart = record.autoRestart && record.restarts < this.#maxRestarts;
    const detail = errorMessage ?? record.stderr.slice(-8).join("\n");
    const message = canRestart
      ? `core ${record.descriptor.id} exited (code=${String(code)}, signal=${String(signal)}), restarting ${record.restarts + 1}/${this.#maxRestarts}\n${detail}`
      : `core ${record.descriptor.id} exited (code=${String(code)}, signal=${String(signal)}) and will not be restarted\n${detail}`;

    this.#setState(record, { status: "crashed", code, message });
    this.#notifyExit(record.descriptor.id, code, signal, generation, canRestart);

    if (!canRestart) return;

    record.restarts += 1;
    const delay = Math.min(RESTART_BASE_DELAY_MS * 2 ** (record.restarts - 1), RESTART_MAX_DELAY_MS);
    record.restartTimer = setTimeout(() => {
      record.restartTimer = undefined;
      if (this.#shuttingDown || record.child !== undefined) return;
      try {
        this.#spawnCore(record);
      } catch (error) {
        this.#setState(record, {
          status: "crashed",
          code: null,
          message: `restart of ${record.descriptor.id} failed: ${String(error)}`,
        });
      }
    }, delay);
    record.restartTimer.unref();
  }

  #notifyExit(
    coreId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    generation: number,
    willRestart: boolean,
  ): void {
    for (const listener of this.#exitListeners) {
      try {
        listener(coreId, { code, signal, generation, willRestart });
      } catch {
        // A bad subscriber must not break lifecycle handling.
      }
    }
  }

  #setState(record: CoreRecord, state: CoreRunState): void {
    record.state = state;
    for (const listener of this.#stateListeners) {
      try {
        listener(record.descriptor.id, state);
      } catch {
        // Same reasoning as above.
      }
    }
  }

  /** SIGTERM, then SIGKILL after a grace period. Resolves once the child is gone. */
  async stop(coreId: string): Promise<void> {
    const record = this.#records.get(coreId);
    if (record === undefined) return;

    if (record.restartTimer !== undefined) {
      clearTimeout(record.restartTimer);
      record.restartTimer = undefined;
    }
    record.autoRestart = false;

    const child = record.child;
    if (child === undefined) {
      this.#setState(record, { status: "stopped" });
      return;
    }

    record.intentionalStop = true;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(killTimer);
        resolve();
      };
      child.once("exit", done);
      // Closing stdin lets a well-behaved ACP agent shut down on EOF.
      try {
        child.stdin.end();
      } catch {
        // Stream may already be destroyed.
      }
      this.#signalTree(child, "SIGTERM");
      const killTimer = setTimeout(() => {
        this.#signalTree(child, "SIGKILL");
        // The exit handler still resolves; this is only the escalation.
      }, STOP_GRACE_MS);
      killTimer.unref();
    });
  }

  /** Stops every core. Called on app quit. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#records.keys()].map((id) => this.stop(id)));
  }

  #signalTree(child: CoreChild, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
      } catch {
        // Fall through to the direct kill below.
      }
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
      return;
    }
    try {
      // Negative pid targets the group created by detached: true.
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  #installExitHooks(): void {
    if (this.#exitHooksInstalled) return;
    this.#exitHooksInstalled = true;

    const beginShutdown = (): void => {
      this.#shuttingDown = true;
      void this.stopAll();
    };

    app.on("before-quit", beginShutdown);
    app.on("will-quit", beginShutdown);

    // Last line of defence: Node's 'exit' handler must be synchronous, so send
    // SIGKILL directly rather than going through the graceful path.
    process.on("exit", () => {
      this.#shuttingDown = true;
      for (const record of this.#records.values()) {
        const child = record.child;
        if (child === undefined) continue;
        this.#signalTree(child, "SIGKILL");
      }
    });
  }
}

let singleton: CoreProcessManager | undefined;

/**
 * Process-wide manager shared by the ACP layer and the IPC layer. Constructed
 * lazily because the constructor registers Electron quit hooks, which should
 * not happen as a side effect of importing this module.
 */
export function getCoreProcessManager(): CoreProcessManager {
  singleton ??= new CoreProcessManager();
  return singleton;
}
