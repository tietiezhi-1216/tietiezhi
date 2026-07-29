import type { Readable, Writable } from "node:stream";

import type { AcpAgentProcess } from "./acp/index.js";
import { AcpSessionManager } from "./acp/index.js";
import { coreInstaller } from "./cores/installer.js";
import { getCoreProcessManager } from "./cores/process.js";
import { getCoreConfigPaths, requireCore } from "./cores/registry.js";
import { listServers } from "./config/store.js";
import { projectMcp } from "./config/projection.js";
import { join } from "node:path";
import type { McpServerDefinition } from "@shared/contracts";

/**
 * Adapts a `CoreProcessHandle` to the shape the ACP layer expects. The process
 * manager owns lifecycle and restarts, so `kill` delegates to it rather than
 * signalling the child directly — signalling behind its back would trip the
 * restart logic.
 */
function toAgentProcess(
  coreId: string,
  handle: { pid: number; stdin: Writable; stdout: Readable; generation: number },
): AcpAgentProcess {
  const manager = getCoreProcessManager();
  return {
    pid: handle.pid,
    stdin: handle.stdin,
    stdout: handle.stdout,
    // The manager buffers stderr for diagnostics; exposing the raw stream here
    // would race its own reader. Crash reasons come from `getStderr`.
    stderr: null,
    kill() {
      void manager.stop(coreId);
      return true;
    },
    on(event: "exit" | "error", listener: (...args: never[]) => void) {
      if (event === "exit") {
        return manager.onExit((exited, info) => {
          // Ignore exits belonging to a newer generation: that connection is
          // already someone else's problem.
          if (exited !== coreId || info.generation !== handle.generation) return;
          (listener as unknown as (code: number | null, signal: NodeJS.Signals | null) => void)(
            info.code,
            info.signal,
          );
        });
      }
      return () => {};
    },
  };
}

/** MCP servers currently enabled, in the ACP `session/new` wire shape. */
function acpMcpServers(): Array<{
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}> {
  const servers: McpServerDefinition[] = listServers().filter((server) => server.enabled);
  return servers.flatMap((server) => {
    if (server.transport.type !== "stdio") return [];
    const env = Object.entries(server.transport.env ?? {}).map(([name, value]) => ({
      name,
      value,
    }));
    return [
      {
        name: server.id,
        command: server.transport.command,
        args: server.transport.args,
        env,
      },
    ];
  });
}

/**
 * Writes the canonical MCP config into the core's isolated config directory.
 * Every core reads its config at startup, so this must run before `start`.
 */
export async function projectCoreConfig(coreId: string): Promise<void> {
  const descriptor = requireCore(coreId);
  const format = descriptor.configFormat ?? "none";
  if (format === "none") return;
  const paths = getCoreConfigPaths(coreId);
  if (!paths) return;
  const fileName =
    format === "codex-toml"
      ? "config.toml"
      : format === "gemini-json"
        ? "settings.json"
        : ".claude.json";
  await projectMcp(listServers(), format, join(paths.settingsDir, fileName), { coreId });
}

/**
 * Builds the session manager. `spawnCore` is the seam between the process
 * manager (owns the child) and the ACP layer (owns the protocol).
 */
export function createSessionManager(): AcpSessionManager {
  const processes = getCoreProcessManager();

  return new AcpSessionManager({
    clientInfo: { name: "tietiezhi", version: "0.1.0" },
    mcpServers: () => acpMcpServers(),
    async spawnCore(coreId) {
      const descriptor = requireCore(coreId);

      if (descriptor.source === "npm") {
        const state = await coreInstaller.checkInstalled(descriptor);
        if (state.status !== "installed") {
          throw new Error(
            `核心 ${descriptor.name} 尚未安装（${state.status}），请先在设置里安装`,
          );
        }
      }

      await projectCoreConfig(coreId);
      const handle = processes.start(coreId);
      return toAgentProcess(coreId, handle);
    },
  });
}

/**
 * The ACP layer learns the protocol version during `initialize`; the process
 * manager cannot, so it stays in `starting` until told. Call after a
 * connection is established.
 */
export function markCoreReady(coreId: string, protocolVersion: number): void {
  getCoreProcessManager().markReady(coreId, protocolVersion);
}
