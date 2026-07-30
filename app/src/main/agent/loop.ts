/**
 * The agent turn loop.
 *
 * One turn is: ask the model, run the tools it asked for, ask again with the
 * results, repeat until it stops calling tools or `maxSteps` is reached.
 *
 * The loop is ours rather than the LLM library's for three reasons that all
 * matter more than the convenience: every mutating tool has to pass the approval
 * gate before it runs, cancellation has to actually stop in-flight work, and
 * each step has to be persisted as it completes so a crash does not lose the
 * conversation.
 */

import { randomUUID } from "node:crypto";

import { describeError, streamStep } from "./provider.js";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalGate,
  ContentPart,
  Message,
  Tool,
  ToolResult,
  TurnEndReason,
  TurnRequest,
  Usage,
} from "./types.js";

export interface TurnHooks {
  /** Every event, in order. The UI and the session store both read this. */
  emit: (event: AgentEvent) => void;
  /** Asks the user. Rejecting is a denial, never an allow. */
  approve: ApprovalGate;
  /** Called as each message completes so persistence never lags the stream. */
  persist?: (message: Message) => Promise<void> | void;
}

export interface TurnResult {
  reason: TurnEndReason;
  /** Messages produced this turn, in order, ready to append to history. */
  messages: Message[];
  usage: Usage | null;
}

/** One line describing what a tool is about to do, for the approval prompt. */
function summarize(tool: Tool, input: unknown): string {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const path = typeof record["path"] === "string" ? record["path"] : null;
  switch (tool.name) {
    case "write":
      return `写入文件 ${path ?? "?"}`;
    case "edit":
      return `修改文件 ${path ?? "?"}`;
    case "bash":
      return `执行命令：${typeof record["command"] === "string" ? record["command"] : "?"}`;
    default:
      return `${tool.name}（${Object.keys(record).join(", ")}）`;
  }
}

function sumUsage(total: Usage | null, step: Usage | null): Usage | null {
  if (step === null) return total;
  if (total === null) return step;
  const add = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: add(total.inputTokens, step.inputTokens),
    outputTokens: add(total.outputTokens, step.outputTokens),
    totalTokens: add(total.totalTokens, step.totalTokens),
    reasoningTokens: add(total.reasoningTokens, step.reasoningTokens),
    cachedInputTokens: add(total.cachedInputTokens, step.cachedInputTokens),
  };
}

/**
 * Runs one turn to completion.
 *
 * `signal` cancels: the current model stream stops, running tools are killed,
 * and whatever was produced so far is still returned so it can be persisted —
 * a cancelled turn that loses its transcript is worse than no cancel at all.
 */
export async function runTurn(
  request: TurnRequest,
  hooks: TurnHooks,
  signal: AbortSignal,
): Promise<TurnResult> {
  const produced: Message[] = [];
  const history: Message[] = [...request.messages];
  /** Tools the user allowed for the rest of this turn. */
  const alwaysAllowed = new Set<string>();
  let usage: Usage | null = null;

  const record = async (message: Message): Promise<void> => {
    produced.push(message);
    history.push(message);
    await hooks.persist?.(message);
  };

  for (let step = 0; step < request.maxSteps; step += 1) {
    if (signal.aborted) {
      hooks.emit({ type: "turn-done", reason: "cancelled", usage });
      return { reason: "cancelled", messages: produced, usage };
    }

    const result = await streamStep(
      {
        target: {
          provider: request.model.provider,
          model: request.model.model,
          apiKey: request.model.apiKey,
          ...(request.model.baseUrl === undefined ? {} : { baseUrl: request.model.baseUrl }),
        },
        instructions: request.instructions,
        messages: history,
        tools: request.tools,
        ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
        signal,
      },
      hooks.emit,
    );

    usage = sumUsage(usage, result.usage);
    if (result.message.content.length > 0) await record(result.message);

    if (result.reason === "error" || result.reason === "cancelled") {
      hooks.emit({ type: "turn-done", reason: result.reason, usage });
      return { reason: result.reason, messages: produced, usage };
    }

    // No tool calls means the model is done talking; the turn ends here.
    if (result.toolCalls.length === 0) {
      hooks.emit({ type: "turn-done", reason: "stop", usage });
      return { reason: "stop", messages: produced, usage };
    }

    const outcome = await runToolCalls(result.toolCalls, request, hooks, signal, alwaysAllowed);
    // Tool results go back as a user-role message; that is how every provider
    // expects them, and `provider.ts` splits them into a `tool` message.
    if (outcome.parts.length > 0) await record({ role: "user", content: outcome.parts });

    if (outcome.stop !== null) {
      hooks.emit({ type: "turn-done", reason: outcome.stop, usage });
      return { reason: outcome.stop, messages: produced, usage };
    }
  }

  // Hitting the cap is a real outcome, not a silent stop: the UI should offer
  // to continue rather than letting the user think the model finished.
  hooks.emit({ type: "turn-done", reason: "max-steps", usage });
  return { reason: "max-steps", messages: produced, usage };
}

interface ToolPhaseOutcome {
  parts: ContentPart[];
  /** Non-null when the turn must end (denial or cancellation). */
  stop: TurnEndReason | null;
}

async function runToolCalls(
  calls: Array<{ callId: string; toolName: string; input: unknown }>,
  request: TurnRequest,
  hooks: TurnHooks,
  signal: AbortSignal,
  alwaysAllowed: Set<string>,
): Promise<ToolPhaseOutcome> {
  const parts: ContentPart[] = [];

  for (const call of calls) {
    if (signal.aborted) return { parts, stop: "cancelled" };

    const tool = request.tools.find((entry) => entry.name === call.toolName);
    if (tool === undefined) {
      // Reported back to the model rather than thrown: it can recover by
      // calling something that exists.
      parts.push({
        type: "tool-result",
        callId: call.callId,
        toolName: call.toolName,
        output: `没有名为 ${call.toolName} 的工具`,
        isError: true,
      });
      continue;
    }

    if (tool.mutating && !alwaysAllowed.has(tool.name)) {
      const decision = await ask(hooks, tool, call.input);
      if (decision.outcome === "deny") {
        parts.push({
          type: "tool-result",
          callId: call.callId,
          toolName: call.toolName,
          output: decision.reason ?? "用户拒绝了这个操作",
          isError: true,
        });
        // The denial is fed back so the model sees why it stopped, but the turn
        // ends: continuing after a refusal tends to produce workarounds.
        return { parts, stop: "denied" };
      }
      if (decision.outcome === "allow-always") alwaysAllowed.add(tool.name);
    }

    const result: ToolResult = await tool
      .run(call.input, { cwd: request.cwd, signal })
      .catch((error: unknown): ToolResult => ({ output: describeError(error), isError: true }));

    // The part carries `output` only. `detail` holds whole-file text for the
    // diff view; putting it here would spend context on it every step and
    // append it to the session file forever.
    parts.push({
      type: "tool-result",
      callId: call.callId,
      toolName: call.toolName,
      output: result.output,
      ...(result.isError === true ? { isError: true } : {}),
    });
    hooks.emit({
      type: "tool-result",
      callId: call.callId,
      toolName: call.toolName,
      output: result.output,
      isError: result.isError === true,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    });
  }

  return { parts, stop: null };
}

/** A gate that throws is treated as a denial, never as an allow. */
async function ask(hooks: TurnHooks, tool: Tool, input: unknown): Promise<ApprovalDecision> {
  const request = {
    id: randomUUID(),
    toolName: tool.name,
    input,
    summary: summarize(tool, input),
  };
  hooks.emit({ type: "approval-required", request });
  try {
    return await hooks.approve(request);
  } catch (error) {
    return { outcome: "deny", reason: `审批失败：${describeError(error)}` };
  }
}
