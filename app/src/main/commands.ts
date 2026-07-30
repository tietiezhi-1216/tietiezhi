import type { BrowserWindow } from "electron";

import type { AcpSessionManager } from "./acp/index.js";
import { broadcastEvent, registerCommands } from "./bridge/index.js";
import { onMcpServersChanged } from "./host/mcp-sync.js";
import { getMcpStore, listServers, parseServerDefinition, removeServer, setEnabled, upsertServer } from "./config/store.js";
import { coreInstaller } from "./cores/installer.js";
import { getCoreProcessManager } from "./cores/process.js";
import { listCores, requireCore } from "./cores/registry.js";
import type { CorePermissionRequest, CoreRunState, CoreStreamEvent } from "@shared/contracts";

/** Events the renderer subscribes to with `listen()`. */
export const EVENTS = {
  coreStream: "core://stream",
  corePermission: "core://permission",
  coreRunState: "core://run-state",
  coreInstallState: "core://install-state",
} as const;

/**
 * Maps the renderer's semantic decision onto one of the options the core
 * offered.
 *
 * ACP lets each core name its own options, but it tags them with a `kind`
 * (`allow_once` / `allow_always` / `reject_once` / `reject_always`), so the
 * mapping goes through the kind and only falls back to the option id. Returning
 * null means "cancel", which is a valid ACP outcome — not an error.
 */
function matchPermissionOption(
  options: Array<{ optionId: string; name: string; kind: string }>,
  decision: string,
): string | null {
  const byKind = (...kinds: string[]): string | null =>
    options.find((option) => kinds.includes(option.kind))?.optionId ?? null;

  switch (decision) {
    case "accept":
      return byKind("allow_once", "allow_always");
    case "acceptForSession":
      // Prefer a persistent allow, but a one-shot allow is closer to the user's
      // intent than refusing outright.
      return byKind("allow_always", "allow_once");
    case "decline":
      return byKind("reject_once", "reject_always");
    case "cancel":
      return null;
    default:
      throw new Error("无效的授权决定");
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`参数 ${key} 必须是非空字符串`);
  }
  return value;
}

/**
 * Registers everything the renderer can invoke. Names are namespaced with
 * `core_` / `mcp_` so they cannot collide with the Tauri plugin commands the
 * bridge already owns.
 */
export function registerHostCommands(manager: AcpSessionManager): void {
  const processes = getCoreProcessManager();

  registerCommands({
    // --- cores -----------------------------------------------------------
    core_list: async () => {
      const cores = listCores();
      const rows = await Promise.all(
        cores.map(async (descriptor) => ({
          descriptor,
          install:
            descriptor.source === "npm"
              ? await coreInstaller.checkInstalled(descriptor)
              : { status: "installed" as const, version: descriptor.version ?? "bundled", installedAt: 0 },
          run: processes.getState(descriptor.id),
          capabilities: manager.capabilities(descriptor.id) ?? null,
        })),
      );
      return rows;
    },

    core_install: async (args) => {
      const descriptor = requireCore(requireString(args, "coreId"));
      return coreInstaller.install(descriptor);
    },

    core_uninstall: async (args) => {
      await coreInstaller.uninstall(requireString(args, "coreId"));
      return null;
    },

    core_start: async (args) => {
      const coreId = requireString(args, "coreId");
      const connection = await manager.ensureCore(coreId);
      return {
        coreId,
        protocolVersion: connection.protocolVersion,
        capabilities: connection.capabilities,
      };
    },

    core_stop: async (args) => {
      const coreId = requireString(args, "coreId");
      await manager.shutdownCore(coreId);
      // The ACP handle's `kill` only asks the process manager to stop; awaiting
      // it here is what guarantees the child is gone (including the SIGKILL
      // escalation) before the renderer is told the core stopped.
      await processes.stop(coreId);
      return null;
    },

    core_stderr: (args) => processes.getStderr(requireString(args, "coreId")),

    // --- sessions --------------------------------------------------------
    core_session_new: async (args) =>
      manager.newSession(requireString(args, "coreId"), requireString(args, "cwd")),

    core_session_list: () => manager.listSessions(),

    core_session_prompt: async (args) =>
      manager.prompt(requireString(args, "sessionId"), requireString(args, "text")),

    core_session_cancel: async (args) => {
      await manager.cancel(requireString(args, "sessionId"));
      return null;
    },

    core_session_close: async (args) => {
      await manager.closeSession(requireString(args, "sessionId"));
      return null;
    },

    core_turn_active: (args) => manager.isTurnActive(requireString(args, "sessionId")),

    // --- model / mode switching -----------------------------------------
    core_session_config: (args) => manager.sessionConfig(requireString(args, "sessionId")),

    /** Switching the core's `category: "model"` option is the model switch. */
    core_session_set_config: async (args) => {
      const value = args["value"];
      if (typeof value !== "string" && typeof value !== "boolean") {
        throw new Error("配置项的值必须是字符串或布尔值");
      }
      return manager.setConfigOption(
        requireString(args, "sessionId"),
        requireString(args, "optionId"),
        value,
      );
    },

    core_session_set_mode: async (args) =>
      manager.setMode(requireString(args, "sessionId"), requireString(args, "modeId")),

    core_permission_resolve: (args) => {
      const requestId = requireString(args, "requestId");
      const optionId = typeof args["optionId"] === "string" ? args["optionId"] : null;
      return manager.resolvePermission(
        requestId,
        optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
      );
    },

    /**
     * The renderer's existing approval UI answers with a semantic decision
     * rather than a core-specific option id, so map it onto whichever option
     * the core actually offered. Without this the approval dialog has no
     * handler and every permission request stalls.
     */
    permission_respond: (args) => {
      const id = requireString(args, "id");
      const decision = requireString(args, "decision");
      const pending = manager.pendingPermission(id);
      if (!pending) throw new Error("授权请求已失效");
      const optionId = matchPermissionOption(pending.options, decision);
      manager.resolvePermission(
        id,
        optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId },
      );
      return null;
    },

    // --- MCP -------------------------------------------------------------
    mcp_list: () => listServers(),

    mcp_issues: () => getMcpStore().loadIssues,

    mcp_upsert: async (args) => {
      const definition = parseServerDefinition(args["server"]);
      if (!definition) throw new Error("MCP 服务器定义不合法");
      const saved = upsertServer(definition);
      await reprojectAll();
      return saved;
    },

    mcp_remove: async (args) => {
      const removed = removeServer(requireString(args, "id"));
      if (removed) await reprojectAll();
      return removed;
    },

    mcp_set_enabled: async (args) => {
      const changed = setEnabled(requireString(args, "id"), args["enabled"] === true);
      if (changed) await reprojectAll();
      return changed;
    },
  });
}

/** Single implementation lives in host/mcp-sync so both entry points agree. */
const reprojectAll = onMcpServersChanged;

/** Bridges manager and installer events onto the renderer's `listen()`. */
export function forwardHostEvents(manager: AcpSessionManager, _window: BrowserWindow): () => void {
  // EventEmitter#on returns the emitter, so unsubscribe needs the handlers.
  const onStream = (event: CoreStreamEvent) => broadcastEvent(EVENTS.coreStream, event);
  const onPermission = (request: CorePermissionRequest) =>
    broadcastEvent(EVENTS.corePermission, request);
  const onRunState = (coreId: string, state: CoreRunState) =>
    broadcastEvent(EVENTS.coreRunState, { coreId, state });

  manager.on("stream", onStream);
  manager.on("permission", onPermission);
  manager.on("run-state", onRunState);
  const offInstall = coreInstaller.onStateChange((coreId, state) =>
    broadcastEvent(EVENTS.coreInstallState, { coreId, state }),
  );

  return () => {
    manager.off("stream", onStream);
    manager.off("permission", onPermission);
    manager.off("run-state", onRunState);
    offInstall();
  };
}
