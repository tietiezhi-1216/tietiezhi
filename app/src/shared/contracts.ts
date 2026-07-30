/**
 * Shared contracts between the Electron main process, the preload bridge and
 * the renderer. Every module under `src/main/**` codes against these types, so
 * they are the coordination point for parallel work — extend them additively,
 * do not reshape existing members.
 */

// ---------------------------------------------------------------------------
// Cores
// ---------------------------------------------------------------------------

/**
 * How a core is obtained and launched.
 *
 * - `builtin`: the first-party Tietiezhi core, shipped inside the app bundle.
 * - `npm`: an ACP agent distributed as an npm package (claude-code-acp,
 *   codex-acp, ...), installed into the app's own managed prefix.
 * - `binary`: a platform executable downloaded from a release URL.
 * - `path`: an executable the user already has on their machine.
 */
export type CoreSource = "builtin" | "npm" | "binary" | "path";

/** Static description of a core the app knows how to run. */
export interface CoreDescriptor {
  /** Stable identifier, e.g. `tietiezhi`, `claude-code`, `codex`, `gemini`. */
  id: string;
  /** Display name shown in the core picker. */
  name: string;
  /** One-line description shown under the name. */
  summary: string;
  source: CoreSource;
  /** npm package name when `source === "npm"`. */
  packageName?: string;
  /** Version to pin. Cores are never installed from a floating range. */
  version?: string;
  /** Executable and arguments, resolved after install. */
  command: string;
  args: string[];
  /**
   * Extra environment for the child process. Used to point a CLI at the
   * app-managed config directory instead of the user's own dotfiles.
   */
  env?: Record<string, string>;
  /** Which config projections this core understands. */
  configFormat?: McpConfigFormat;
  /** True for the first-party core, which gets the full protocol surface. */
  firstParty: boolean;
}

/** Whether a core is installed and runnable right now. */
export type CoreInstallState =
  | { status: "not-installed" }
  | { status: "installing"; progress?: number }
  | { status: "installed"; version: string; installedAt: number }
  | { status: "failed"; message: string };

/** Lifecycle of a launched core process. */
export type CoreRunState =
  | { status: "stopped" }
  | { status: "starting" }
  | { status: "ready"; pid: number; protocolVersion: number }
  | { status: "crashed"; code: number | null; message: string };

/** What a running core told us it can do during ACP `initialize`. */
export interface CoreCapabilities {
  /** Agent can load a previously persisted session. */
  loadSession: boolean;
  /** Prompt content types the agent accepts. */
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  /** Raw capability object as returned, for features not modelled above. */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// ACP sessions
// ---------------------------------------------------------------------------

export interface AcpSessionHandle {
  sessionId: string;
  coreId: string;
  /** Absolute path the session was opened against. */
  cwd: string;
  createdAt: number;
}

/**
 * Normalized stream event the renderer consumes. ACP `session/update`
 * variants are flattened into this union so the UI does not need to know
 * which core produced them.
 */
export type CoreStreamEvent =
  | { kind: "message-delta"; sessionId: string; text: string }
  | { kind: "thought-delta"; sessionId: string; text: string }
  | { kind: "tool-call"; sessionId: string; callId: string; title: string; status: string; raw: unknown }
  | { kind: "tool-call-update"; sessionId: string; callId: string; status: string; raw: unknown }
  | { kind: "plan"; sessionId: string; raw: unknown }
  | { kind: "turn-ended"; sessionId: string; stopReason: string }
  // The core changed a knob on its own (or confirmed our change). Carries the
  // full option so the renderer can re-render without a round trip.
  | { kind: "config-changed"; sessionId: string; option: CoreConfigOption }
  | { kind: "mode-changed"; sessionId: string; currentModeId: string }
  | { kind: "error"; sessionId: string; message: string };

// ---------------------------------------------------------------------------
// Session configuration (model switching, modes)
// ---------------------------------------------------------------------------

/** One selectable value of a session config option. */
export interface CoreConfigChoice {
  value: string;
  name: string;
  description: string | null;
  /** Group label when the core grouped its options; null when ungrouped. */
  group: string | null;
}

/**
 * A knob the running core exposes for the session.
 *
 * `category` is ACP's own hint — `"model"` is the one that matters for the
 * product: it is how a core advertises which models it can switch between.
 * The list is always the core's own; a CLI only offers the providers it
 * integrates with, so this switches models *within* a core rather than moving
 * an arbitrary model into an arbitrary core.
 */
export interface CoreConfigOption {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  kind: "select" | "boolean";
  /** Selected value id for `select`, the toggle state for `boolean`. */
  currentValue: string | boolean;
  /** Empty for `boolean`. Groups are flattened, preserving the group label. */
  choices: CoreConfigChoice[];
}

/** One operating mode a core can be switched between. */
export interface CoreMode {
  id: string;
  name: string;
  description: string | null;
}

/** Everything switchable about a live session. */
export interface CoreSessionConfig {
  sessionId: string;
  coreId: string;
  options: CoreConfigOption[];
  currentModeId: string | null;
  modes: CoreMode[];
}

/**
 * Permission request surfaced from `session/request_permission`. The renderer
 * renders this with the app's own approval UI regardless of which core asked.
 */
export interface CorePermissionRequest {
  requestId: string;
  sessionId: string;
  coreId: string;
  /** Human-readable description of what the core wants to do. */
  title: string;
  /** Options the core offered, in the order it listed them. */
  options: Array<{ optionId: string; name: string; kind: string }>;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Config projection
// ---------------------------------------------------------------------------

/** Native config dialect of a core. */
export type McpConfigFormat = "claude-json" | "codex-toml" | "gemini-json" | "none";

/** Canonical MCP server definition, configured once in the app. */
export interface McpServerDefinition {
  id: string;
  name: string;
  enabled: boolean;
  transport:
    | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
    | { type: "http"; url: string; headers?: Record<string, string> };
}

/** Result of projecting the canonical config into one core's dialect. */
export interface ProjectionResult {
  coreId: string;
  format: McpConfigFormat;
  /** Absolute path written. Always inside the app-managed config dir. */
  path: string;
  /** Servers that could not be represented in this dialect. */
  skipped: Array<{ id: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Renderer bridge
// ---------------------------------------------------------------------------

/**
 * Channel names used between preload and main. The renderer never sees these
 * directly — it keeps calling `invoke()` from `@tauri-apps/api`, which the
 * preload satisfies by injecting `window.__TAURI_INTERNALS__`.
 */
export const IPC = {
  invoke: "tietiezhi:invoke",
  event: "tietiezhi:event",
  channel: "tietiezhi:channel",
} as const;

/**
 * Minimal shape the renderer's Tauri client expects on
 * `window.__TAURI_INTERNALS__`. Reproducing it lets the existing 32k-line
 * frontend run unmodified against Electron.
 */
export interface TauriInternals {
  transformCallback(callback: (payload: unknown) => void, once?: boolean): number;
  unregisterCallback(id: number): void;
  invoke(cmd: string, args?: Record<string, unknown>, options?: unknown): Promise<unknown>;
  metadata: Record<string, unknown>;
  /** Called unconditionally by `convertFileSrc`, so it must be present. */
  convertFileSrc(path: string, protocol?: string): string;
}

/**
 * Wire format a Tauri `Channel` expects, verified against
 * `@tauri-apps/api/core.js`.
 *
 * A Channel serializes into an invoke argument as the string
 * `__CHANNEL__:<callbackId>`. The backend then pushes frames to that callback
 * id. Frames carry an `index` because the client reorders them and buffers
 * anything that arrives early — sending frames without a monotonically
 * increasing index makes messages silently stall.
 */
export type ChannelFrame<T = unknown> =
  | { index: number; message: T }
  | { index: number; end: true };

/** Prefix a serialized Channel uses inside invoke arguments. */
export const CHANNEL_PREFIX = "__CHANNEL__:";

/** Extract a channel callback id from a serialized invoke argument. */
export function parseChannelId(value: unknown): number | null {
  if (typeof value !== "string" || !value.startsWith(CHANNEL_PREFIX)) return null;
  const id = Number.parseInt(value.slice(CHANNEL_PREFIX.length), 10);
  return Number.isInteger(id) ? id : null;
}

/** A handler registered in the main process for one `invoke()` command. */
export type CommandHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;
