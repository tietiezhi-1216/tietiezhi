/**
 * Commands that are deliberately **not** ported, because porting them would
 * duplicate what the ACP bridge is meant to replace.
 *
 * They are registered anyway so the renderer gets a sentence a user can act on
 * instead of the registry's `unknown command "x" — no handler is registered`,
 * which reads like a crash.
 *
 * - `codex_v2_*` is the App Server V2 JSON-RPC bridge (89 methods) the Workspace
 *   still speaks. Reimplementing that protocol in TypeScript would rebuild the
 *   very runtime this migration removes; the Workspace moves to ACP instead.
 * - `tietiezhi_stream` is the first-party assistant's chat loop, complete with
 *   skills, MCP and device tools. That loop belongs in the first-party core,
 *   reached over ACP — a second agent loop in the main process is the
 *   duplication we are trying to delete.
 *
 * Each entry names the work that will replace it, so this file doubles as the
 * remaining-work list.
 */

import { registerCommands } from "../bridge/index.js";

/** Thrown as a plain string, matching how the bridge surfaces errors. */
function pending(feature: string): never {
  throw new Error(
    `${feature}正在迁移到 ACP 协议，当前版本暂不可用。可在「核心」分区切换到已支持的核心继续工作。`,
  );
}

export function registerPendingAcpCommands(): void {
  registerCommands({
    codex_v2_request: () => pending("工作区（Workspace）"),
    codex_v2_notify: () => pending("工作区（Workspace）"),
    codex_v2_server_response: () => pending("工作区（Workspace）"),
    tietiezhi_stream: () => pending("铁铁汁助手对话"),
  });
}
