/**
 * ACP client-side connection over a core's stdio.
 *
 * We are the *client* half of ACP: the core process is the agent. The host
 * deliberately advertises neither `fs` nor `terminal` capabilities — external
 * cores (Claude Code, Codex, Gemini CLI, ...) already own a filesystem and a
 * terminal inside their own runtime, and proxying those through us would only
 * add a lossy second implementation. `session/request_permission` is the one
 * client request we do serve, so approvals render in one unified UI no matter
 * which core asked.
 */

import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  AuthMethod,
  Client,
  ClientCapabilities,
  Implementation,
  InitializeResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import type {
  CoreCapabilities,
  CorePermissionRequest,
  CoreRunState,
  CoreStreamEvent,
} from "@shared/contracts";

import { normalizeSessionUpdate, type UnhandledSessionUpdate } from "./normalize.js";

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;

/** How much of a core's stderr we keep for crash diagnostics. */
const STDERR_TAIL_BYTES = 8192;

/** The user's answer to a `CorePermissionRequest`. */
export type PermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/**
 * The subset of `ChildProcess` this module needs. Declared structurally so the
 * core launcher can hand us a real `ChildProcess` without this module
 * depending on how the process was started.
 */
export interface AcpAgentProcess {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface ConnectAcpAgentOptions {
  /** Identifier of the core this process implements, echoed into events. */
  coreId: string;
  /** Already-spawned core process with piped stdin/stdout. */
  child: AcpAgentProcess;
  /** Identifies the host to the core during `initialize`. */
  clientInfo?: Implementation;
  /** Normalized stream events for one `session/update` notification. */
  onStreamEvents(events: CoreStreamEvent[]): void;
  /**
   * Renders an approval prompt and resolves once the user answers. Rejecting
   * is treated as a cancellation so a UI failure cannot wedge the core.
   */
  onPermissionRequest(request: CorePermissionRequest): Promise<PermissionDecision>;
  /** Lifecycle transitions: `ready` after initialize, `crashed` on failure. */
  onRunState?(state: CoreRunState): void;
  /** Update variants we do not model, plus raw stderr lines. */
  onDiagnostic?(message: string, detail?: unknown): void;
}

export interface AcpConnectionHandle {
  readonly coreId: string;
  /** Typed ACP agent proxy: `newSession`, `prompt`, `cancel`, ... */
  readonly agent: ClientSideConnection;
  readonly capabilities: CoreCapabilities;
  /** Raw agent capabilities, for features `CoreCapabilities` does not model. */
  readonly agentCapabilities: AgentCapabilities | undefined;
  readonly protocolVersion: number;
  readonly authMethods: readonly AuthMethod[];
  readonly agentInfo: Implementation | undefined;
  readonly pid: number | undefined;
  /** Resolves once the process is gone and no further traffic is possible. */
  readonly closed: Promise<void>;
  isClosed(): boolean;
  /**
   * Answers still-open permission requests with `cancelled`. Pass a sessionId
   * to limit it to one session, as required after `session/cancel`.
   */
  cancelPendingPermissions(sessionId?: string): void;
  /** Terminates the core process and settles `closed`. */
  close(): Promise<void>;
}

function capabilityNotDeclared(method: string, capability: string): RequestError {
  return new RequestError(
    METHOD_NOT_FOUND,
    `Tietiezhi does not declare the "${capability}" client capability, so ${method} is unavailable. ` +
      `Cores run against their own filesystem and terminal.`,
  );
}

/** Capabilities the host advertises. `fs` and `terminal` are explicitly off. */
function hostCapabilities(): ClientCapabilities {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  };
}

function parseCapabilities(agentCapabilities: AgentCapabilities | undefined): CoreCapabilities {
  const prompt = agentCapabilities?.promptCapabilities;
  return {
    loadSession: agentCapabilities?.loadSession === true,
    promptImage: prompt?.image === true,
    promptAudio: prompt?.audio === true,
    promptEmbeddedContext: prompt?.embeddedContext === true,
    raw: agentCapabilities ?? null,
  };
}

function permissionTitle(params: RequestPermissionRequest): string {
  const call = params.toolCall;
  return call.title ?? call.name ?? call.toolCallId;
}

/** Keeps the tail of a core's stderr so a crash can report a real cause. */
class StderrTail {
  private buffer = "";

  attach(stderr: Readable | null, onLine?: (line: string) => void): void {
    if (!stderr) return;
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.buffer = (this.buffer + text).slice(-STDERR_TAIL_BYTES);
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length > 0) onLine(line);
        }
      }
    });
    // A core dying mid-write can surface EPIPE here; it is not fatal on its own.
    stderr.on("error", () => {});
  }

  text(): string {
    return this.buffer.trim();
  }
}

const textEncoder = new TextEncoder();

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return textEncoder.encode(chunk);
  return textEncoder.encode(String(chunk));
}

/**
 * Node's `Readable.toWeb` / `Writable.toWeb` return `node:stream/web` types
 * that are not assignable to the DOM stream types the ACP SDK is declared
 * against, so the bridge is done by hand. Backpressure is preserved by
 * pausing the source once the queue is full.
 */
function toWebReadable(source: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let finished = false;
      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        if (error) controller.error(error);
        else controller.close();
      };
      source.on("data", (chunk: unknown) => {
        controller.enqueue(toBytes(chunk));
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      });
      source.once("end", () => finish());
      source.once("close", () => finish());
      source.once("error", (error: Error) => finish(error));
    },
    pull() {
      source.resume();
    },
    cancel() {
      source.destroy();
    },
  });
}

function toWebWritable(sink: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        sink.write(chunk, (error) => (error ? reject(error) : resolve()));
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        sink.end(() => resolve());
      });
    },
    abort() {
      sink.destroy();
    },
  });
}

interface PendingPermission {
  sessionId: string;
  resolve(decision: PermissionDecision): void;
}

/**
 * Spawns nothing: takes an already-running core process, performs the ACP
 * `initialize` handshake over its stdio and returns a live handle.
 */
export async function connectAcpAgent(
  options: ConnectAcpAgentOptions,
): Promise<AcpConnectionHandle> {
  const { coreId, child } = options;
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (!stdin || !stdout) {
    throw new Error(
      `Core "${coreId}" was spawned without piped stdio; ACP needs both stdin and stdout.`,
    );
  }

  options.onRunState?.({ status: "starting" });

  const stderrTail = new StderrTail();
  stderrTail.attach(child.stderr, (line) => options.onDiagnostic?.(`[${coreId}] ${line}`));

  const pendingPermissions = new Map<string, PendingPermission>();

  let closed = false;
  let closeReason: CoreRunState | undefined;
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const cancelPendingPermissions = (sessionId?: string): void => {
    for (const [requestId, entry] of [...pendingPermissions]) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      pendingPermissions.delete(requestId);
      entry.resolve({ outcome: "cancelled" });
    }
  };

  /** Idempotent: exit, stdout EOF and an explicit close() all funnel here. */
  const markClosed = (state: CoreRunState): void => {
    if (closed) return;
    closed = true;
    closeReason = state;
    cancelPendingPermissions();
    options.onRunState?.(state);
    resolveClosed();
  };

  child.on("error", (error: Error) => {
    markClosed({ status: "crashed", code: null, message: error.message });
  });

  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    const tail = stderrTail.text();
    const how = signal !== null ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    markClosed({
      status: "crashed",
      code,
      message: tail.length > 0 ? `Core "${coreId}" exited (${how}): ${tail}` : `Core "${coreId}" exited (${how}).`,
    });
  });

  const handleUnhandledUpdate = (info: UnhandledSessionUpdate): void => {
    options.onDiagnostic?.(
      `[${coreId}] unhandled session/update variant "${info.sessionUpdate}"`,
      info.update,
    );
  };

  const client: Client = {
    async requestPermission(
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      if (closed) return { outcome: { outcome: "cancelled" } };

      const requestId = randomUUID();
      const request: CorePermissionRequest = {
        requestId,
        sessionId: params.sessionId,
        coreId,
        title: permissionTitle(params),
        options: params.options.map((option) => ({
          optionId: option.optionId,
          name: option.name,
          kind: option.kind,
        })),
        raw: params,
      };

      // Racing against the pending map lets close()/session-cancel settle a
      // prompt the user never answered, instead of leaving the core blocked.
      const preempted = new Promise<PermissionDecision>((resolve) => {
        pendingPermissions.set(requestId, { sessionId: params.sessionId, resolve });
      });

      let decision: PermissionDecision;
      try {
        decision = await Promise.race([options.onPermissionRequest(request), preempted]);
      } catch (error) {
        options.onDiagnostic?.(
          `[${coreId}] permission UI failed, answering cancelled`,
          error instanceof Error ? error.message : error,
        );
        decision = { outcome: "cancelled" };
      } finally {
        pendingPermissions.delete(requestId);
      }

      if (decision.outcome === "selected") {
        return { outcome: { outcome: "selected", optionId: decision.optionId } };
      }
      return { outcome: { outcome: "cancelled" } };
    },

    sessionUpdate(params: SessionNotification): void {
      const events = normalizeSessionUpdate(params, handleUnhandledUpdate);
      if (events.length > 0) options.onStreamEvents(events);
    },

    // The methods below exist only to return a precise protocol error if a
    // core calls them anyway; we never advertise the capabilities that gate them.
    readTextFile(_params: ReadTextFileRequest): ReadTextFileResponse {
      throw capabilityNotDeclared("fs/read_text_file", "fs.readTextFile");
    },
    writeTextFile(_params: WriteTextFileRequest): WriteTextFileResponse {
      throw capabilityNotDeclared("fs/write_text_file", "fs.writeTextFile");
    },
    createTerminal(_params: CreateTerminalRequest): CreateTerminalResponse {
      throw capabilityNotDeclared("terminal/create", "terminal");
    },
    terminalOutput(_params: TerminalOutputRequest): TerminalOutputResponse {
      throw capabilityNotDeclared("terminal/output", "terminal");
    },
    releaseTerminal(_params: ReleaseTerminalRequest): ReleaseTerminalResponse {
      throw capabilityNotDeclared("terminal/release", "terminal");
    },
    waitForTerminalExit(
      _params: WaitForTerminalExitRequest,
    ): WaitForTerminalExitResponse {
      throw capabilityNotDeclared("terminal/wait_for_exit", "terminal");
    },
    killTerminal(_params: KillTerminalRequest): KillTerminalResponse {
      throw capabilityNotDeclared("terminal/kill", "terminal");
    },
  };

  const stream = ndJsonStream(toWebWritable(stdin), toWebReadable(stdout));
  const connection = new ClientSideConnection(() => client, stream);

  // stdout EOF closes the connection even while the process lingers; treat it
  // as a crash so the UI stops waiting on a core that can no longer answer.
  void connection.closed.then(() => {
    markClosed({
      status: "crashed",
      code: null,
      message:
        stderrTail.text().length > 0
          ? `Core "${coreId}" closed its ACP stream: ${stderrTail.text()}`
          : `Core "${coreId}" closed its ACP stream.`,
    });
  });

  let initialized: InitializeResponse;
  try {
    initialized = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: hostCapabilities(),
      ...(options.clientInfo ? { clientInfo: options.clientInfo } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = stderrTail.text();
    markClosed({
      status: "crashed",
      code: null,
      message: detail.length > 0 ? `${message}\n${detail}` : message,
    });
    child.kill();
    throw new Error(`ACP initialize failed for core "${coreId}": ${message}`);
  }

  if (closed) {
    throw new Error(
      closeReason?.status === "crashed"
        ? closeReason.message
        : `Core "${coreId}" closed during initialize.`,
    );
  }

  const capabilities = parseCapabilities(initialized.agentCapabilities);
  const pid = child.pid;
  options.onRunState?.({
    status: "ready",
    pid: pid ?? -1,
    protocolVersion: initialized.protocolVersion,
  });

  return {
    coreId,
    agent: connection,
    capabilities,
    agentCapabilities: initialized.agentCapabilities,
    protocolVersion: initialized.protocolVersion,
    authMethods: initialized.authMethods ?? [],
    agentInfo: initialized.agentInfo ?? undefined,
    pid,
    closed: closedPromise,
    isClosed: () => closed,
    cancelPendingPermissions,
    async close(): Promise<void> {
      if (!closed) {
        // Signal rather than closing stdin: a core wedged mid-turn will not
        // notice EOF, and `markClosed` must run even if it never exits.
        child.kill();
        markClosed({ status: "stopped" });
      }
      await closedPromise;
    },
  };
}
