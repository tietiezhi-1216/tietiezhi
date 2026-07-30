/**
 * The agent core's own message and event model.
 *
 * This file deliberately imports nothing. It is the isolation boundary around
 * the LLM library: only `provider.ts` may import `ai` / `@ai-sdk/*`, and it
 * translates to and from these types.
 *
 * The reason is a mistake this project already paid for once. The Rust core used
 * the OpenAI Responses `item` JSON as its internal canonical format, so that
 * shape leaked into six crates and the app layer; swapping the transport meant
 * rewriting the core. Keeping a shape we own means swapping libraries is one
 * file, not a rewrite.
 *
 * Opaque provider data (Anthropic's thinking `signature`, Gemini's
 * `thoughtSignature`, OpenAI's encrypted reasoning) is carried verbatim in
 * `providerData` and must survive persistence untouched — dropping it is what
 * made Anthropic reject multi-turn conversations in the old implementation.
 */

/** Who produced a message. */
export type Role = "user" | "assistant";

/** A block of content inside a message. */
export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "reasoning";
      text: string;
      /**
       * Provider-owned blob for this reasoning block, keyed by provider id.
       * Persist and replay verbatim; never synthesize or edit it.
       */
      providerData?: Record<string, unknown>;
    }
  | {
      type: "tool-call";
      callId: string;
      toolName: string;
      input: unknown;
      providerData?: Record<string, unknown>;
    }
  | {
      type: "tool-result";
      callId: string;
      toolName: string;
      /** Whatever the tool returned; shape is the tool's own contract. */
      output: unknown;
      /** True when the tool failed and `output` describes the failure. */
      isError?: boolean;
    };

export interface Message {
  role: Role;
  content: ContentPart[];
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * What the UI consumes. Deltas are incremental; `message-done` carries the
 * assembled message so a consumer can rebuild state without running its own
 * accumulator — the old core's "reasoning delta arrived before its item" bug
 * came from making every consumer maintain that state machine itself.
 */
export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  /** A tool call is being assembled; input may still be incomplete. */
  | { type: "tool-call-start"; callId: string; toolName: string }
  | { type: "tool-call"; callId: string; toolName: string; input: unknown }
  | {
      type: "tool-result";
      callId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    }
  /** An approval gate blocked a tool; the turn pauses until answered. */
  | { type: "approval-required"; request: ApprovalRequest }
  /** One assistant message finished. Carries the full message. */
  | { type: "message-done"; message: Message }
  /** The whole turn finished. */
  | { type: "turn-done"; reason: TurnEndReason; usage: Usage | null }
  | { type: "error"; message: string };

export type TurnEndReason =
  | "stop"
  | "max-steps"
  | "cancelled"
  | "denied"
  | "error";

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Reasoning tokens when the provider reports them separately. */
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** JSON Schema describing a tool's input. Kept as data, not a library type. */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * True when running the tool changes something outside the process (writes a
   * file, runs a command). Those go through the approval gate; reads do not.
   */
  mutating: boolean;
}

export interface ToolContext {
  /** Absolute path the session is rooted at. Tools must not escape it. */
  cwd: string;
  /** Aborts long-running work when the turn is cancelled. */
  signal: AbortSignal;
}

export interface ToolResult {
  /** Rendered for the model. Keep it small; truncate large payloads. */
  output: string;
  isError?: boolean;
  /** Structured detail for the UI (a diff, a file list) — not sent to the model. */
  detail?: unknown;
}

export type ToolHandler = (
  input: unknown,
  context: ToolContext,
) => Promise<ToolResult>;

export interface Tool extends ToolDefinition {
  run: ToolHandler;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  id: string;
  toolName: string;
  input: unknown;
  /** One line describing what will happen, for the prompt. */
  summary: string;
}

export type ApprovalDecision =
  | { outcome: "allow" }
  /** Allow this tool for the rest of the session without asking again. */
  | { outcome: "allow-always" }
  | { outcome: "deny"; reason?: string };

/** Resolves once the user answers. Rejecting is treated as a denial. */
export type ApprovalGate = (request: ApprovalRequest) => Promise<ApprovalDecision>;

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/** Which wire protocol a provider speaks. */
export type ProviderKind = "anthropic" | "openai" | "google";

export interface ModelRef {
  provider: ProviderKind;
  /** Provider's own model id, passed through unchanged. */
  model: string;
  /** Overrides the provider default; needed for gateways and self-hosting. */
  baseUrl?: string;
  apiKey: string;
}

export interface ReasoningOptions {
  /** Provider-neutral effort. Mapped per provider by `provider.ts`. */
  effort?: "off" | "low" | "medium" | "high";
  /** Explicit thinking token budget when the provider supports one. */
  budgetTokens?: number;
}

export interface TurnRequest {
  model: ModelRef;
  /** System instructions. Empty string means send none. */
  instructions: string;
  messages: Message[];
  tools: Tool[];
  reasoning?: ReasoningOptions;
  /**
   * Upper bound on assistant steps in one turn. The loop runs until the model
   * stops calling tools or this is hit — a runaway agent has to terminate.
   */
  maxSteps: number;
  cwd: string;
}
