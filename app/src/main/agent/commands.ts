/**
 * Exposes the agent core to the renderer.
 *
 * One turn at a time per session (the model's own constraint), with the approval
 * gate bridged over IPC: the loop awaits a promise that the renderer resolves by
 * calling `agent_approve`. A window that closes mid-approval must not wedge the
 * turn, so pending gates are rejected when their session is disposed — and a
 * rejected gate is a denial, never an allow.
 */

import { app } from "electron";
import { join } from "node:path";

import { broadcastEvent, registerCommands } from "../bridge/index.js";
import { runTurn } from "./loop.js";
import { describeError } from "./provider.js";
import {
  appendMessage,
  createSession,
  deleteSession,
  deriveTitle,
  listSessions,
  loadSession,
  setSessionRoot,
  updateMeta,
} from "./store.js";
import { DEFAULT_TOOLS } from "./tools.js";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  Message,
  ProviderKind,
  Usage,
} from "./types.js";

/** Events the renderer subscribes to with `listen()`. */
export const AGENT_EVENTS = {
  stream: "agent://stream",
  approval: "agent://approval",
} as const;

interface RunningTurn {
  controller: AbortController;
  /** Gates awaiting `agent_approve`, keyed by request id. */
  pending: Map<string, (decision: ApprovalDecision) => void>;
}

const running = new Map<string, RunningTurn>();

/** Resolves the API key for a provider from the app's encrypted vault. */
export type KeyResolver = (provider: ProviderKind) => Promise<{
  apiKey: string;
  baseUrl?: string;
  model: string;
} | null>;

let resolveKey: KeyResolver | null = null;

/**
 * Injected by the integration layer: the agent core must not reach into the
 * settings module directly, or it stops being testable in isolation.
 */
export function setKeyResolver(resolver: KeyResolver): void {
  resolveKey = resolver;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`参数 ${key} 必须是非空字符串`);
  }
  return value;
}

function readProvider(value: unknown): ProviderKind {
  if (value === "anthropic" || value === "openai" || value === "google") return value;
  throw new Error("provider 必须是 anthropic / openai / google 之一");
}

function emit(sessionId: string, event: AgentEvent): void {
  broadcastEvent(AGENT_EVENTS.stream, { sessionId, event });
}

export function registerAgentCommands(): void {
  setSessionRoot(join(app.getPath("userData"), "agent-sessions"));

  registerCommands({
    agent_session_new: async (args) => {
      const cwd = requireString(args, "cwd");
      const provider = args["provider"] === undefined ? undefined : readProvider(args["provider"]);
      const model = typeof args["model"] === "string" ? args["model"] : undefined;
      return createSession({
        cwd,
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
      });
    },

    agent_session_list: () => listSessions(),

    agent_session_load: async (args) => loadSession(requireString(args, "sessionId")),

    agent_session_delete: async (args) => deleteSession(requireString(args, "sessionId")),

    agent_session_update: async (args) => {
      const sessionId = requireString(args, "sessionId");
      const patch: Parameters<typeof updateMeta>[1] = {};
      if (typeof args["title"] === "string") patch.title = args["title"];
      if (args["provider"] !== undefined) patch.provider = readProvider(args["provider"]);
      if (typeof args["model"] === "string") patch.model = args["model"];
      return updateMeta(sessionId, patch);
    },

    /**
     * Starts a turn and returns when it finishes. Progress arrives as events, so
     * the renderer does not block on this promise for UI updates.
     */
    agent_prompt: async (args) => {
      const sessionId = requireString(args, "sessionId");
      const text = requireString(args, "text");

      if (running.has(sessionId)) {
        throw new Error("这个会话正在进行中，请先等待或取消");
      }
      const session = await loadSession(sessionId);
      if (session === null) throw new Error("会话不存在");
      if (resolveKey === null) throw new Error("尚未配置模型供应商");

      const provider = session.meta.provider ?? readProvider(args["provider"]);
      const credentials = await resolveKey(provider);
      if (credentials === null) {
        throw new Error(`供应商 ${provider} 缺少 API Key，请到「设置」补充`);
      }

      const userMessage: Message = { role: "user", content: [{ type: "text", text }] };
      await appendMessage(sessionId, userMessage);

      const turn: RunningTurn = { controller: new AbortController(), pending: new Map() };
      running.set(sessionId, turn);

      // Name the session from its first prompt rather than spending a model call.
      if (session.messages.length === 0) {
        const title = deriveTitle([userMessage]);
        if (title !== null) await updateMeta(sessionId, { title });
      }

      try {
        const result = await runTurn(
          {
            model: {
              provider,
              model: session.meta.model ?? credentials.model,
              apiKey: credentials.apiKey,
              ...(credentials.baseUrl === undefined ? {} : { baseUrl: credentials.baseUrl }),
            },
            instructions: typeof args["instructions"] === "string" ? args["instructions"] : "",
            messages: [...session.messages, userMessage],
            tools: DEFAULT_TOOLS,
            maxSteps: typeof args["maxSteps"] === "number" ? args["maxSteps"] : 24,
            cwd: session.meta.cwd,
          },
          {
            emit: (event) => emit(sessionId, event),
            approve: (request) => waitForApproval(sessionId, turn, request),
            persist: (message) => appendMessage(sessionId, message),
          },
          turn.controller.signal,
        );

        await updateMeta(sessionId, { usage: mergeUsage(session.meta.usage, result.usage) });
        return { reason: result.reason, usage: result.usage };
      } finally {
        // Any gate still waiting would otherwise hold the turn forever.
        for (const resolve of turn.pending.values()) {
          resolve({ outcome: "deny", reason: "本轮已结束" });
        }
        running.delete(sessionId);
      }
    },

    agent_cancel: (args) => {
      const turn = running.get(requireString(args, "sessionId"));
      if (turn === undefined) return false;
      turn.controller.abort();
      return true;
    },

    agent_approve: (args) => {
      const sessionId = requireString(args, "sessionId");
      const requestId = requireString(args, "requestId");
      const turn = running.get(sessionId);
      const resolve = turn?.pending.get(requestId);
      if (resolve === undefined) return false;
      turn?.pending.delete(requestId);
      resolve(readDecision(args["decision"]));
      return true;
    },

    agent_busy: (args) => running.has(requireString(args, "sessionId")),

    agent_tools: () =>
      DEFAULT_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        mutating: tool.mutating,
      })),
  });
}

function readDecision(value: unknown): ApprovalDecision {
  if (value === "allow") return { outcome: "allow" };
  if (value === "allow-always") return { outcome: "allow-always" };
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record["outcome"] === "allow") return { outcome: "allow" };
    if (record["outcome"] === "allow-always") return { outcome: "allow-always" };
    if (record["outcome"] === "deny") {
      return {
        outcome: "deny",
        ...(typeof record["reason"] === "string" ? { reason: record["reason"] } : {}),
      };
    }
  }
  // Anything unrecognised is a denial: defaulting to allow would turn a UI bug
  // into an unapproved file write.
  return { outcome: "deny", reason: "未识别的审批结果" };
}

function waitForApproval(
  sessionId: string,
  turn: RunningTurn,
  request: ApprovalRequest,
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    turn.pending.set(request.id, resolve);
    broadcastEvent(AGENT_EVENTS.approval, { sessionId, request });
  });
}

function mergeUsage(previous: Usage | null, added: Usage | null): Usage | null {
  if (added === null) return previous;
  if (previous === null) return added;
  const add = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: add(previous.inputTokens, added.inputTokens),
    outputTokens: add(previous.outputTokens, added.outputTokens),
    totalTokens: add(previous.totalTokens, added.totalTokens),
    reasoningTokens: add(previous.reasoningTokens, added.reasoningTokens),
    cachedInputTokens: add(previous.cachedInputTokens, added.cachedInputTokens),
  };
}

/** Cancels every in-flight turn. Called on quit. */
export function disposeAgent(): void {
  for (const turn of running.values()) {
    turn.controller.abort();
    for (const resolve of turn.pending.values()) {
      resolve({ outcome: "deny", reason: "应用正在退出" });
    }
  }
  running.clear();
}

export { describeError };
