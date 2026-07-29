/**
 * Multi-core, multi-session bookkeeping on top of {@link connectAcpAgent}.
 *
 * One ACP connection per core, many sessions per connection. Every event the
 * manager emits carries the `sessionId` it belongs to, so concurrent turns
 * across cores stay separable by the renderer without any per-turn channel.
 */

import { EventEmitter } from "node:events";

import type {
  ContentBlock,
  Implementation,
  McpServer,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import type {
  AcpSessionHandle,
  CoreCapabilities,
  CorePermissionRequest,
  CoreRunState,
  CoreStreamEvent,
} from "@shared/contracts";

import {
  connectAcpAgent,
  type AcpAgentProcess,
  type AcpConnectionHandle,
  type PermissionDecision,
} from "./connection.js";

export interface AcpSessionManagerEvents {
  /** One normalized event from any session of any core. */
  stream: [CoreStreamEvent];
  /** An approval the renderer must answer via {@link AcpSessionManager.resolvePermission}. */
  permission: [CorePermissionRequest];
  /** `[coreId, state]` whenever a core's process lifecycle changes. */
  "run-state": [string, CoreRunState];
  /** Non-fatal protocol/stderr noise, for the log pane. */
  diagnostic: [string, unknown];
}

export interface AcpSessionManagerOptions {
  /**
   * Starts the core's process with piped stdio. Supplied by the core launcher
   * so this module stays independent of install/resolve logic.
   */
  spawnCore(coreId: string): Promise<AcpAgentProcess>;
  /** Identifies the host to every core during `initialize`. */
  clientInfo?: Implementation;
  /** MCP servers to attach when opening a session. */
  mcpServers?(coreId: string, cwd: string): McpServer[] | Promise<McpServer[]>;
}

interface SessionEntry {
  handle: AcpSessionHandle;
  /** Non-null while a `session/prompt` is in flight; ACP allows one at a time. */
  turn: Promise<PromptResponse> | null;
}

interface PendingPermission {
  coreId: string;
  sessionId: string;
  resolve(decision: PermissionDecision): void;
}

function textPrompt(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

export class AcpSessionManager extends EventEmitter<AcpSessionManagerEvents> {
  private readonly options: AcpSessionManagerOptions;
  private readonly connections = new Map<string, AcpConnectionHandle>();
  /** Deduplicates concurrent `ensureCore` calls for the same core. */
  private readonly connecting = new Map<string, Promise<AcpConnectionHandle>>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  constructor(options: AcpSessionManagerOptions) {
    super();
    this.options = options;
  }

  /** Connects the core if needed and returns its live connection. */
  async ensureCore(coreId: string): Promise<AcpConnectionHandle> {
    const existing = this.connections.get(coreId);
    if (existing && !existing.isClosed()) return existing;

    const inFlight = this.connecting.get(coreId);
    if (inFlight) return inFlight;

    const attempt = this.openConnection(coreId).finally(() => {
      this.connecting.delete(coreId);
    });
    this.connecting.set(coreId, attempt);
    return attempt;
  }

  private async openConnection(coreId: string): Promise<AcpConnectionHandle> {
    const child = await this.options.spawnCore(coreId);
    const connection = await connectAcpAgent({
      coreId,
      child,
      ...(this.options.clientInfo ? { clientInfo: this.options.clientInfo } : {}),
      onStreamEvents: (events) => {
        for (const event of events) this.emit("stream", event);
      },
      onPermissionRequest: (request) => this.queuePermission(request),
      onRunState: (state) => {
        this.emit("run-state", coreId, state);
        if (state.status === "crashed" || state.status === "stopped") {
          this.handleCoreDown(coreId, state);
        }
      },
      onDiagnostic: (message, detail) => this.emit("diagnostic", message, detail),
    });

    this.connections.set(coreId, connection);
    return connection;
  }

  /** Live connection for a core, if one is currently up. */
  getCore(coreId: string): AcpConnectionHandle | undefined {
    const connection = this.connections.get(coreId);
    return connection && !connection.isClosed() ? connection : undefined;
  }

  capabilities(coreId: string): CoreCapabilities | undefined {
    return this.getCore(coreId)?.capabilities;
  }

  async newSession(coreId: string, cwd: string): Promise<AcpSessionHandle> {
    const connection = await this.ensureCore(coreId);
    const mcpServers = (await this.options.mcpServers?.(coreId, cwd)) ?? [];

    const response = await connection.agent.newSession({ cwd, mcpServers });
    const sessionId = response.sessionId;

    const collision = this.sessions.get(sessionId);
    if (collision) {
      throw new Error(
        `Core "${coreId}" returned session id "${sessionId}", which core "${collision.handle.coreId}" already uses.`,
      );
    }

    const handle: AcpSessionHandle = { sessionId, coreId, cwd, createdAt: Date.now() };
    this.sessions.set(sessionId, { handle, turn: null });
    return handle;
  }

  listSessions(): AcpSessionHandle[] {
    return [...this.sessions.values()].map((entry) => entry.handle);
  }

  getSession(sessionId: string): AcpSessionHandle | undefined {
    return this.sessions.get(sessionId)?.handle;
  }

  /**
   * Runs one prompt turn. Stream events reach listeners as they arrive; the
   * returned promise settles when the core reports a stop reason.
   */
  async prompt(sessionId: string, content: string | ContentBlock[]): Promise<PromptResponse> {
    const entry = this.requireSession(sessionId);
    if (entry.turn) {
      throw new Error(`Session "${sessionId}" already has a turn in flight.`);
    }

    const connection = this.getCore(entry.handle.coreId);
    if (!connection) {
      throw new Error(`Core "${entry.handle.coreId}" is not running.`);
    }

    const blocks = typeof content === "string" ? textPrompt(content) : content;
    this.assertPromptSupported(connection, blocks);

    const turn = connection.agent.prompt({ sessionId, prompt: blocks });
    entry.turn = turn;

    try {
      const response = await turn;
      this.emit("stream", { kind: "turn-ended", sessionId, stopReason: response.stopReason });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("stream", { kind: "error", sessionId, message });
      throw error;
    } finally {
      // The entry may already be gone if the core died mid-turn.
      const current = this.sessions.get(sessionId);
      if (current === entry) entry.turn = null;
    }
  }

  /** True while a `session/prompt` is in flight for this session. */
  isTurnActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.turn != null;
  }

  /**
   * Cancels the current turn. Per ACP the client must also answer any open
   * permission request with `cancelled`, otherwise the core waits forever.
   */
  async cancel(sessionId: string): Promise<void> {
    const entry = this.requireSession(sessionId);
    const connection = this.getCore(entry.handle.coreId);
    if (!connection) return;

    await connection.agent.cancel({ sessionId });
    connection.cancelPendingPermissions(sessionId);
    this.settlePermissions(
      (pending) => pending.sessionId === sessionId,
      { outcome: "cancelled" },
    );
  }

  /** Cancels any turn and forgets the session locally. */
  async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    const connection = this.getCore(entry.handle.coreId);
    if (connection) {
      if (entry.turn) {
        await connection.agent.cancel({ sessionId }).catch(() => {});
        connection.cancelPendingPermissions(sessionId);
      }
      // `session/close` is optional; only call it where the core advertises it.
      if (connection.agentCapabilities?.sessionCapabilities?.close) {
        await connection.agent.closeSession({ sessionId }).catch((error: unknown) => {
          this.emit("diagnostic", `session/close failed for "${sessionId}"`, error);
        });
      }
    }

    this.settlePermissions((p) => p.sessionId === sessionId, { outcome: "cancelled" });
    this.sessions.delete(sessionId);
  }

  /** Answers a permission request previously emitted as `permission`. */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  /** Permission requests still awaiting an answer, oldest first. */
  pendingPermissionIds(): string[] {
    return [...this.pendingPermissions.keys()];
  }

  async shutdownCore(coreId: string): Promise<void> {
    const connection = this.connections.get(coreId);
    this.connections.delete(coreId);
    if (connection) await connection.close();
    this.dropSessionsOf(coreId);
  }

  async dispose(): Promise<void> {
    const coreIds = [...this.connections.keys()];
    await Promise.all(coreIds.map((coreId) => this.shutdownCore(coreId)));
    this.settlePermissions(() => true, { outcome: "cancelled" });
    this.sessions.clear();
    this.removeAllListeners();
  }

  private requireSession(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Unknown session "${sessionId}".`);
    return entry;
  }

  private queuePermission(request: CorePermissionRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.pendingPermissions.set(request.requestId, {
        coreId: request.coreId,
        sessionId: request.sessionId,
        resolve,
      });
      this.emit("permission", request);
    });
  }

  private settlePermissions(
    match: (pending: PendingPermission) => boolean,
    decision: PermissionDecision,
  ): void {
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      if (!match(pending)) continue;
      this.pendingPermissions.delete(requestId);
      pending.resolve(decision);
    }
  }

  private handleCoreDown(coreId: string, state: CoreRunState): void {
    this.settlePermissions((pending) => pending.coreId === coreId, { outcome: "cancelled" });

    const message =
      state.status === "crashed" ? state.message : `Core "${coreId}" was stopped.`;
    for (const entry of this.sessions.values()) {
      if (entry.handle.coreId !== coreId) continue;
      this.emit("stream", { kind: "error", sessionId: entry.handle.sessionId, message });
    }
    this.dropSessionsOf(coreId);

    const connection = this.connections.get(coreId);
    if (connection?.isClosed()) this.connections.delete(coreId);
  }

  /** Sessions live inside the core process, so they die with it. */
  private dropSessionsOf(coreId: string): void {
    for (const [sessionId, entry] of [...this.sessions]) {
      if (entry.handle.coreId === coreId) this.sessions.delete(sessionId);
    }
  }

  private assertPromptSupported(
    connection: AcpConnectionHandle,
    blocks: readonly ContentBlock[],
  ): void {
    const caps = connection.capabilities;
    for (const block of blocks) {
      if (block.type === "image" && !caps.promptImage) {
        throw new Error(`Core "${connection.coreId}" does not accept image prompt content.`);
      }
      if (block.type === "audio" && !caps.promptAudio) {
        throw new Error(`Core "${connection.coreId}" does not accept audio prompt content.`);
      }
      if (block.type === "resource" && !caps.promptEmbeddedContext) {
        throw new Error(
          `Core "${connection.coreId}" does not accept embedded resources; send a resource_link instead.`,
        );
      }
    }
  }
}
