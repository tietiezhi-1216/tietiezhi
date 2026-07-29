import { invoke } from "@tauri-apps/api/core";
import type {
  AcpSessionHandle,
  CoreInstallState,
  CoreListRow,
  CorePromptResult,
  CoreStartResult,
  McpServerDefinition,
} from "./types";

/**
 * Thin wrappers over the host commands registered in the Electron main
 * process (`registerHostCommands`). Every command takes an object payload.
 */

export function coreList(): Promise<CoreListRow[]> {
  return invoke<CoreListRow[]>("core_list");
}

export function coreInstall(coreId: string): Promise<CoreInstallState> {
  return invoke<CoreInstallState>("core_install", { coreId });
}

export function coreUninstall(coreId: string): Promise<null> {
  return invoke<null>("core_uninstall", { coreId });
}

export function coreStart(coreId: string): Promise<CoreStartResult> {
  return invoke<CoreStartResult>("core_start", { coreId });
}

export function coreStop(coreId: string): Promise<null> {
  return invoke<null>("core_stop", { coreId });
}

export function coreStderr(coreId: string): Promise<string[]> {
  return invoke<string[]>("core_stderr", { coreId });
}

export function coreSessionNew(coreId: string, cwd: string): Promise<AcpSessionHandle> {
  return invoke<AcpSessionHandle>("core_session_new", { coreId, cwd });
}

export function coreSessionPrompt(sessionId: string, text: string): Promise<CorePromptResult> {
  return invoke<CorePromptResult>("core_session_prompt", { sessionId, text });
}

export function coreSessionCancel(sessionId: string): Promise<null> {
  return invoke<null>("core_session_cancel", { sessionId });
}

/** Omitting `optionId` tells the host the user dismissed the request. */
export function corePermissionResolve(requestId: string, optionId?: string): Promise<boolean> {
  return invoke<boolean>("core_permission_resolve", { requestId, optionId });
}

export function mcpList(): Promise<McpServerDefinition[]> {
  return invoke<McpServerDefinition[]>("mcp_list");
}

export function mcpUpsert(server: McpServerDefinition): Promise<McpServerDefinition> {
  return invoke<McpServerDefinition>("mcp_upsert", { server });
}

export function mcpRemove(id: string): Promise<boolean> {
  return invoke<boolean>("mcp_remove", { id });
}

export function mcpSetEnabled(id: string, enabled: boolean): Promise<boolean> {
  return invoke<boolean>("mcp_set_enabled", { id, enabled });
}

/**
 * Optional convenience: the host may expose the workspace folder picker. It is
 * not part of the cores command set, so callers must tolerate a rejection and
 * fall back to typing a path.
 */
export function pickDirectory(): Promise<string | null> {
  return invoke<string | null>("pick_workspace_dir");
}

export const CORES_QUERY_KEY = ["cores", "list"] as const;
export const MCP_QUERY_KEY = ["cores", "mcp"] as const;
