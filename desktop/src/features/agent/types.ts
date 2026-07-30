/**
 * Renderer-side mirror of the agent core's contracts.
 *
 * Deliberately duplicated rather than imported from the main process: the two
 * are separate build graphs, and a shared file would make the renderer depend on
 * Node-only modules. Keeping it as a hand-written mirror also means a change to
 * the core's shape shows up here as a type error instead of a runtime surprise.
 */

export type ProviderKind = "anthropic" | "openai" | "google";

export type Role = "user" | "assistant";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; providerData?: Record<string, unknown> }
  | { type: "tool-call"; callId: string; toolName: string; input: unknown }
  | {
      type: "tool-result";
      callId: string;
      toolName: string;
      output: unknown;
      isError?: boolean;
    };

export interface Message {
  role: Role;
  content: ContentPart[];
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: ProviderKind | null;
  model: string | null;
  usage: Usage | null;
}

export interface AgentSession {
  meta: SessionMeta;
  messages: Message[];
}

export type TurnEndReason = "stop" | "max-steps" | "cancelled" | "denied" | "error";

export interface TurnOutcome {
  reason: TurnEndReason;
  usage: Usage | null;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  input: unknown;
  summary: string;
}

export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-start"; callId: string; toolName: string }
  | { type: "tool-call"; callId: string; toolName: string; input: unknown }
  | {
      type: "tool-result";
      callId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    }
  | { type: "approval-required"; request: ApprovalRequest }
  | { type: "message-done"; message: Message }
  | { type: "turn-done"; reason: TurnEndReason; usage: Usage | null }
  | { type: "error"; message: string };

export interface ApprovalEnvelope {
  sessionId: string;
  request: ApprovalRequest;
}

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------

/**
 * What the transcript shows. Streaming text and reasoning are separate bubbles
 * that grow in place; a tool call and its result are one entry so the UI can
 * show the outcome next to what was asked.
 */
export type TranscriptEntry =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; streaming: boolean }
  | { id: string; kind: "reasoning"; text: string; streaming: boolean }
  | {
      id: string;
      kind: "tool";
      callId: string;
      toolName: string;
      input: unknown;
      status: "pending" | "awaiting-approval" | "done" | "error";
      output: unknown;
    }
  | { id: string; kind: "notice"; text: string; tone: "info" | "error" };

export interface TranscriptState {
  meta: SessionMeta;
  entries: TranscriptEntry[];
  busy: boolean;
  /** Populated while a tool waits on the user. */
  approval: ApprovalRequest | null;
}
