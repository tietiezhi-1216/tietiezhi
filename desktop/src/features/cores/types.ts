/**
 * Renderer-local mirror of the host contracts (`app/src/shared/contracts.ts`).
 *
 * The renderer must not reach into the Electron main-process source tree, so
 * the wire types are re-declared here. Keep them structurally identical to the
 * host copy — they describe the same IPC payloads.
 */

// ---------------------------------------------------------------------------
// Cores
// ---------------------------------------------------------------------------

export type CoreSource = "builtin" | "npm" | "binary" | "path";

/** Native config dialect a core understands. */
export type McpConfigFormat = "claude-json" | "codex-toml" | "gemini-json" | "none";

export interface CoreDescriptor {
  id: string;
  name: string;
  summary: string;
  source: CoreSource;
  packageName?: string;
  version?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  configFormat?: McpConfigFormat;
  firstParty: boolean;
}

export type CoreInstallState =
  | { status: "not-installed" }
  | { status: "installing"; progress?: number }
  | { status: "installed"; version: string; installedAt: number }
  | { status: "failed"; message: string };

export type CoreRunState =
  | { status: "stopped" }
  | { status: "starting" }
  | { status: "ready"; pid: number; protocolVersion: number }
  | { status: "crashed"; code: number | null; message: string };

export interface CoreCapabilities {
  loadSession: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  raw: unknown;
}

/** One row of `core_list`. */
export interface CoreListRow {
  descriptor: CoreDescriptor;
  install: CoreInstallState;
  run: CoreRunState;
  capabilities: CoreCapabilities | null;
}

// ---------------------------------------------------------------------------
// ACP sessions
// ---------------------------------------------------------------------------

export interface AcpSessionHandle {
  sessionId: string;
  coreId: string;
  cwd: string;
  createdAt: number;
}

export type CoreStreamEvent =
  | { kind: "message-delta"; sessionId: string; text: string }
  | { kind: "thought-delta"; sessionId: string; text: string }
  | {
      kind: "tool-call";
      sessionId: string;
      callId: string;
      title: string;
      status: string;
      raw: unknown;
    }
  | { kind: "tool-call-update"; sessionId: string; callId: string; status: string; raw: unknown }
  | { kind: "plan"; sessionId: string; raw: unknown }
  | { kind: "turn-ended"; sessionId: string; stopReason: string }
  | { kind: "error"; sessionId: string; message: string };

export interface CorePermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface CorePermissionRequest {
  requestId: string;
  sessionId: string;
  coreId: string;
  title: string;
  options: CorePermissionOption[];
  raw: unknown;
}

/** Reply of `core_start`. */
export interface CoreStartResult {
  coreId: string;
  protocolVersion: number;
  capabilities: CoreCapabilities;
}

/** Reply of `core_session_prompt`. */
export interface CorePromptResult {
  stopReason: string;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export type McpTransport =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface McpServerDefinition {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
}

/** Payload of the `mcp://projected` event. */
export interface McpProjectionReport {
  failed: Array<{ coreId: string; reason: string }>;
  /** Cores that were already running when the projection changed. */
  restartRequired: string[];
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface CoreRunStateEvent {
  coreId: string;
  state: CoreRunState;
}

export interface CoreInstallStateEvent {
  coreId: string;
  state: CoreInstallState;
}

export const CORE_EVENTS = {
  stream: "core://stream",
  permission: "core://permission",
  runState: "core://run-state",
  installState: "core://install-state",
  mcpProjected: "mcp://projected",
} as const;
