/**
 * The only module allowed to import `ai` / `@ai-sdk/*`.
 *
 * Everything above this file speaks the types in `types.ts`. Swapping the LLM
 * library means rewriting this file and nothing else — the Rust core's mistake
 * was letting the wire format become the internal one, which made the
 * transport unswappable.
 *
 * One step per call. The multi-step tool loop lives in `loop.ts` so approval,
 * cancellation and persistence stay ours; `stopWhen` is pinned to a single step
 * for the same reason (its default is already `isStepCount(1)`, but relying on
 * a default that changed between majors is how upgrades break).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { isStepCount, jsonSchema, streamText, tool, type ModelMessage, type ToolSet } from "ai";

import type {
  AgentEvent,
  ContentPart,
  Message,
  ProviderKind,
  ReasoningOptions,
  Tool,
  TurnEndReason,
  Usage,
} from "./types.js";

/**
 * Silences the library's `console.warn` prefix ("AI SDK Warning (…)"), which is
 * branding in the host's own log output. Warnings still reach us through the
 * stream's error part, so nothing is lost.
 */
(globalThis as unknown as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

/** Identifies this host to providers instead of the library's default. */
const USER_AGENT = "Tietiezhi/0.1";

/**
 * The transport every provider call goes through.
 *
 * Injectable because Node's own `fetch` ignores proxy configuration entirely —
 * no `HTTP_PROXY`, no system proxy — so on a network that needs one every
 * request dies with `ECONNRESET` and no HTTP status to explain it. In the app
 * this is replaced with Electron's `net.fetch`, which uses Chromium's stack and
 * honours both the system proxy and a PAC script; that also covers the case
 * where the app is launched from Finder and inherits no shell environment.
 *
 * Kept as a setter rather than a constructor argument so tests and the probe run
 * against plain `fetch` without dragging Electron in.
 */
let transport: typeof globalThis.fetch = globalThis.fetch;

export function setAgentFetch(implementation: typeof globalThis.fetch): void {
  transport = implementation;
}

/**
 * The library appends its own version to `user-agent` and ignores a provider
 * `headers` override, so replacing it has to happen at the fetch layer.
 */
const brandedFetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("user-agent", USER_AGENT);
  return transport(input, { ...init, headers });
};

interface ProviderTarget {
  provider: ProviderKind;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

/**
 * Ensures a base url carries the version segment the provider appends paths to.
 *
 * Verified against the installed SDKs, whose defaults are
 * `https://api.openai.com/v1`, `https://api.anthropic.com/v1` and
 * `https://generativelanguage.googleapis.com/v1beta`. Passing a bare host makes
 * the SDK request `/messages` instead of `/v1/messages` — a live probe against
 * this project's own gateway caught exactly that as a 404.
 *
 * Users write gateway urls both ways, so a missing segment is added and a
 * present one is left alone.
 */
export function versionedBaseUrl(baseUrl: string, provider: ProviderKind): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  // A url already carrying either version segment is taken as intentional:
  // rewriting it silently would hide a misconfiguration rather than surface it.
  if (/\/v1(beta)?$/.test(trimmed)) return trimmed;
  return `${trimmed}/${provider === "google" ? "v1beta" : "v1"}`;
}

function languageModel(target: ProviderTarget) {
  const shared = {
    apiKey: target.apiKey,
    fetch: brandedFetch,
    ...(target.baseUrl === undefined
      ? {}
      : { baseURL: versionedBaseUrl(target.baseUrl, target.provider) }),
  };
  switch (target.provider) {
    case "anthropic":
      return createAnthropic(shared)(target.model);
    case "openai":
      return createOpenAI(shared)(target.model);
    case "google":
      return createGoogleGenerativeAI(shared)(target.model);
  }
};

// ---------------------------------------------------------------------------
// Outbound: our messages -> library messages
// ---------------------------------------------------------------------------

/**
 * Rebuilds the library's message shape from ours.
 *
 * `providerData` is replayed as `providerOptions`, which is what carries a
 * thinking block's signature back to the provider. Anthropic rejects a replayed
 * thinking block whose signature is missing or altered, so this must be a
 * verbatim pass-through.
 */
function toModelMessages(messages: Message[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const text = message.content
        .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
      // Tool results are a separate `tool` message, not user content.
      const results = message.content.filter(
        (part): part is Extract<ContentPart, { type: "tool-result" }> =>
          part.type === "tool-result",
      );
      if (text !== "") out.push({ role: "user", content: text });
      if (results.length > 0) {
        out.push({
          role: "tool",
          content: results.map((part) => ({
            type: "tool-result" as const,
            toolCallId: part.callId,
            toolName: part.toolName,
            output:
              part.isError === true
                ? { type: "error-text" as const, value: String(part.output) }
                : { type: "text" as const, value: String(part.output) },
          })),
        });
      }
      continue;
    }

    const content: Array<
      | { type: "text"; text: string }
      | { type: "reasoning"; text: string; providerOptions?: Record<string, unknown> }
      | {
          type: "tool-call";
          toolCallId: string;
          toolName: string;
          input: unknown;
          providerOptions?: Record<string, unknown>;
        }
    > = [];

    for (const part of message.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "reasoning") {
        content.push({
          type: "reasoning",
          text: part.text,
          ...(part.providerData === undefined ? {} : { providerOptions: part.providerData }),
        });
      } else if (part.type === "tool-call") {
        content.push({
          type: "tool-call",
          toolCallId: part.callId,
          toolName: part.toolName,
          input: part.input,
          ...(part.providerData === undefined ? {} : { providerOptions: part.providerData }),
        });
      }
    }

    if (content.length > 0) {
      out.push({ role: "assistant", content } as ModelMessage);
    }
  }

  return out;
}

/**
 * Declares tools without an `execute`, which is what makes the library hand the
 * calls back instead of running them. Execution stays behind our approval gate.
 */
function toToolSet(tools: Tool[]): ToolSet {
  const set: ToolSet = {};
  for (const definition of tools) {
    set[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema),
    });
  }
  return set;
}

/**
 * JSON-safe value. The library's provider options are typed as strict JSON, so
 * `unknown` is not assignable — this mirrors that constraint locally instead of
 * importing the library's type into our surface.
 */
type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

/** Maps neutral reasoning settings onto each provider's own knob. */
function reasoningOptions(
  provider: ProviderKind,
  reasoning: ReasoningOptions | undefined,
): Record<string, { [key: string]: JsonValue }> | undefined {
  if (reasoning === undefined || reasoning.effort === undefined) return undefined;
  const effort = reasoning.effort;

  if (provider === "anthropic") {
    if (effort === "off") return { anthropic: { thinking: { type: "disabled" } } };
    const budget = reasoning.budgetTokens ?? { low: 2048, medium: 4096, high: 8192 }[effort];
    return { anthropic: { thinking: { type: "enabled", budgetTokens: budget } } };
  }
  if (provider === "openai") {
    if (effort === "off") return undefined;
    return { openai: { reasoningEffort: effort } };
  }
  // Google takes a token budget; -1 lets the model decide.
  if (effort === "off") return { google: { thinkingConfig: { thinkingBudget: 0 } } };
  const budget = reasoning.budgetTokens ?? { low: 2048, medium: 4096, high: 8192 }[effort];
  return { google: { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } } };
}

// ---------------------------------------------------------------------------
// Inbound: library stream -> our events
// ---------------------------------------------------------------------------

export interface StepResult {
  /** The assistant message produced by this step, ready to persist. */
  message: Message;
  /** Tool calls the model wants run. Empty means the turn can finish. */
  toolCalls: Array<{ callId: string; toolName: string; input: unknown }>;
  reason: TurnEndReason;
  usage: Usage | null;
}

export interface StepRequest {
  target: ProviderTarget;
  instructions: string;
  messages: Message[];
  tools: Tool[];
  reasoning?: ReasoningOptions;
  signal: AbortSignal;
}

function toUsage(value: unknown): Usage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const num = (key: string): number | null =>
    typeof record[key] === "number" ? (record[key] as number) : null;
  return {
    inputTokens: num("inputTokens"),
    outputTokens: num("outputTokens"),
    totalTokens: num("totalTokens"),
    reasoningTokens: num("reasoningTokens"),
    cachedInputTokens: num("cachedInputTokens"),
  };
}

function mapFinishReason(reason: string | undefined): TurnEndReason {
  switch (reason) {
    case "tool-calls":
    case "stop":
      return "stop";
    case "length":
      return "max-steps";
    case "error":
      return "error";
    default:
      return "stop";
  }
}

/**
 * Runs one assistant step, emitting our events as they arrive.
 *
 * Reasoning deltas are accumulated per block id: a block's signature only
 * arrives with its final delta, so the text and the signature have to be joined
 * before the message is assembled.
 */
export async function streamStep(
  request: StepRequest,
  emit: (event: AgentEvent) => void,
): Promise<StepResult> {
  const options: Parameters<typeof streamText>[0] = {
    model: languageModel(request.target),
    messages: toModelMessages(request.messages),
    tools: toToolSet(request.tools),
    // One step per call — the loop is ours. Pinned rather than inherited: the
    // library's default already is `isStepCount(1)`, but defaults have moved
    // between majors and a silent change here would run tools unapproved.
    stopWhen: isStepCount(1),
    abortSignal: request.signal,
  };
  if (request.instructions.trim() !== "") options.instructions = request.instructions;
  const providerOptions = reasoningOptions(request.target.provider, request.reasoning);
  if (providerOptions !== undefined) options.providerOptions = providerOptions;

  const result = streamText(options);

  const content: ContentPart[] = [];
  const toolCalls: StepResult["toolCalls"] = [];
  let text = "";
  const reasoningBlocks = new Map<string, { text: string; providerData?: Record<string, unknown> }>();
  let reason: TurnEndReason = "stop";
  let usage: Usage | null = null;

  try {
    for await (const part of result.stream) {
      switch (part.type) {
        case "text-delta": {
          text += part.text;
          emit({ type: "text-delta", text: part.text });
          break;
        }

        case "reasoning-delta": {
          const block = reasoningBlocks.get(part.id) ?? { text: "" };
          block.text += part.text;
          // The provider blob arrives on the last delta of the block.
          if (part.providerMetadata !== undefined) {
            block.providerData = part.providerMetadata as Record<string, unknown>;
          }
          reasoningBlocks.set(part.id, block);
          emit({ type: "reasoning-delta", text: part.text });
          break;
        }

        case "tool-input-start": {
          emit({ type: "tool-call-start", callId: part.id, toolName: part.toolName });
          break;
        }

        case "tool-call": {
          const call = {
            callId: part.toolCallId,
            toolName: part.toolName,
            input: part.input as unknown,
          };
          toolCalls.push(call);
          content.push({
            type: "tool-call",
            ...call,
            ...(part.providerMetadata === undefined
              ? {}
              : { providerData: part.providerMetadata as Record<string, unknown> }),
          });
          emit({ type: "tool-call", ...call });
          break;
        }

        case "abort": {
          reason = "cancelled";
          break;
        }

        case "error": {
          reason = "error";
          emit({ type: "error", message: describeError(part.error) });
          break;
        }

        case "finish": {
          reason = reason === "cancelled" ? reason : mapFinishReason(part.finishReason);
          usage = toUsage(part.totalUsage);
          break;
        }

        default:
          // Parts we do not model (sources, files, raw) are not errors.
          break;
      }
    }
  } catch (error) {
    // A network failure surfaces as a thrown error rather than a stream part.
    if (request.signal.aborted) {
      reason = "cancelled";
    } else {
      reason = "error";
      emit({ type: "error", message: describeError(error) });
    }
  }

  // Reasoning precedes visible text in the assembled message, matching the
  // order providers require when it is replayed.
  const assembled: ContentPart[] = [
    ...[...reasoningBlocks.values()].map((block) => ({
      type: "reasoning" as const,
      text: block.text,
      ...(block.providerData === undefined ? {} : { providerData: block.providerData }),
    })),
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...content.filter((part) => part.type === "tool-call"),
  ];

  const message: Message = { role: "assistant", content: assembled };
  if (assembled.length > 0) emit({ type: "message-done", message });

  return { message, toolCalls, reason, usage };
}

/**
 * Extracts the message a user can act on.
 *
 * The library wraps a failed call in a retry error whose message is only
 * "Failed after 3 attempts", and hangs the real cause on nested `errors` with the
 * provider's answer in `responseBody`. A gateway that says
 * `上游请求受限（upstream status 429）` is telling the user exactly what is wrong;
 * reporting the wrapper instead throws that away and makes a quota problem look
 * like a broken client.
 */
export function describeError(error: unknown): string {
  const detail = providerMessage(error);
  if (detail !== null) return detail;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Digs the provider's own message out of an SDK error, if there is one. */
function providerMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;

  const body = record["responseBody"];
  if (typeof body === "string" && body !== "") {
    const status = typeof record["statusCode"] === "number" ? `HTTP ${record["statusCode"]}: ` : "";
    try {
      const parsed: unknown = JSON.parse(body);
      const message = readNestedMessage(parsed);
      if (message !== null) return status + message;
    } catch {
      // Not JSON: the raw body is still more useful than the wrapper's message.
    }
    return status + body.slice(0, 500);
  }

  // Retry wrappers keep the attempts in `errors`; the last one is the real cause.
  const nested = record["errors"];
  if (Array.isArray(nested) && nested.length > 0) {
    return providerMessage(nested[nested.length - 1]);
  }
  const cause = record["cause"];
  return cause === undefined ? null : providerMessage(cause);
}

/** Reads `{error:{message}}`, `{message}` or `{error:"…"}` shapes. */
function readNestedMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const error = record["error"];
  if (typeof error === "string" && error !== "") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string" && message !== "") return message;
  }
  const message = record["message"];
  return typeof message === "string" && message !== "" ? message : null;
}
