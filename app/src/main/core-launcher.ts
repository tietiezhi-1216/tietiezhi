import type { Readable, Writable } from "node:stream";

import type { AcpAgentProcess } from "./acp/index.js";
import { AcpSessionManager } from "./acp/index.js";
import { coreInstaller } from "./cores/installer.js";
import { getCoreProcessManager } from "./cores/process.js";
import { getCoreConfigPaths, requireCore } from "./cores/registry.js";
import { listServers } from "./config/store.js";
import { projectMcp } from "./config/projection.js";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerDefinition } from "@shared/contracts";
import { resolveSecretReferences } from "./host/tietiezhi.js";

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
/**
 * Expands `${secret:name}` placeholders against the encrypted vault.
 *
 * The canonical store deliberately keeps the placeholder so the secret is not
 * duplicated in cleartext there. Expansion happens here, at the last moment
 * before the core's own config file is written — the CLIs read plain files and
 * have no notion of our vault.
 */
async function resolveServerSecrets(
  servers: McpServerDefinition[],
): Promise<{ resolved: McpServerDefinition[]; unresolved: Array<{ id: string; reason: string }> }> {
  const resolved: McpServerDefinition[] = [];
  const unresolved: Array<{ id: string; reason: string }> = [];

  for (const server of servers) {
    try {
      if (server.transport.type === "stdio") {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(server.transport.env ?? {})) {
          env[key] = await resolveSecretReferences(value);
        }
        resolved.push({ ...server, transport: { ...server.transport, env } });
      } else {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(server.transport.headers ?? {})) {
          headers[key] = await resolveSecretReferences(value);
        }
        resolved.push({
          ...server,
          transport: {
            ...server.transport,
            url: await resolveSecretReferences(server.transport.url),
            headers,
          },
        });
      }
    } catch (error) {
      // Writing an unexpanded `${secret:...}` would hand the core a literal
      // placeholder and fail at request time with a confusing upstream error.
      // Dropping the server and reporting why is the honest outcome.
      unresolved.push({ id: server.id, reason: String(error) });
    }
  }
  return { resolved, unresolved };
}

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
  const { resolved, unresolved } = await resolveServerSecrets(listServers());
  const target = join(paths.settingsDir, fileName);
  await projectMcp(resolved, format, target, { coreId });
  // The projected file now holds expanded secrets; keep it owner-only.
  await chmod(target, 0o600).catch(() => {});
  if (unresolved.length > 0) {
    throw new Error(
      `以下 MCP 服务器的密钥引用无法解析，已从 ${descriptor.name} 的配置中略过：` +
        unresolved.map((entry) => `${entry.id}（${entry.reason}）`).join("；"),
    );
  }
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
