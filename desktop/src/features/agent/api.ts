import { invoke } from "@tauri-apps/api/core";

import type { AgentEvent, AgentSession, ProviderKind, SessionMeta, TurnOutcome } from "./types";

/**
 * Wrappers over the first-party agent core's host commands.
 *
 * The agent runs in the Electron main process, not as a child process — unlike
 * the ACP cores, it is ours, so there is no protocol boundary to cross.
 */

export function agentSessionNew(options: {
  cwd: string;
  provider?: ProviderKind;
  model?: string;
}): Promise<SessionMeta> {
  return invoke<SessionMeta>("agent_session_new", options);
}

export function agentSessionList(): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("agent_session_list");
}

export function agentSessionLoad(sessionId: string): Promise<AgentSession | null> {
  return invoke<AgentSession | null>("agent_session_load", { sessionId });
}

export function agentSessionDelete(sessionId: string): Promise<boolean> {
  return invoke<boolean>("agent_session_delete", { sessionId });
}

export function agentSessionUpdate(
  sessionId: string,
  patch: { title?: string; provider?: ProviderKind; model?: string },
): Promise<SessionMeta | null> {
  return invoke<SessionMeta | null>("agent_session_update", { sessionId, ...patch });
}

/**
 * Runs one turn. Resolves when the turn ends; progress arrives as events, so a
 * caller should not await this before showing anything.
 */
export function agentPrompt(options: {
  sessionId: string;
  text: string;
  provider?: ProviderKind;
  instructions?: string;
  maxSteps?: number;
}): Promise<TurnOutcome> {
  return invoke<TurnOutcome>("agent_prompt", options);
}

export function agentCancel(sessionId: string): Promise<boolean> {
  return invoke<boolean>("agent_cancel", { sessionId });
}

/** `decision` is a string shorthand or an object carrying a denial reason. */
export function agentApprove(
  sessionId: string,
  requestId: string,
  decision: "allow" | "allow-always" | { outcome: "deny"; reason?: string },
): Promise<boolean> {
  return invoke<boolean>("agent_approve", { sessionId, requestId, decision });
}

export function agentBusy(sessionId: string): Promise<boolean> {
  return invoke<boolean>("agent_busy", { sessionId });
}

export function agentTools(): Promise<
  Array<{ name: string; description: string; mutating: boolean }>
> {
  return invoke<Array<{ name: string; description: string; mutating: boolean }>>("agent_tools");
}

/** Event channel names, kept next to the API that produces them. */
export const AGENT_EVENTS = {
  stream: "agent://stream",
  approval: "agent://approval",
} as const;

export type StreamEnvelope = { sessionId: string; event: AgentEvent };
