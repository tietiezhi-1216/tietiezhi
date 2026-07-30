import { ToolLoopAgent, type ModelMessage } from "ai";

import type {
  AppError,
  EngineDescriptor,
  EngineDetectionResult,
  EngineEvent,
  FinishReason,
  UsageInfo,
} from "@shared/contracts";

import { ApprovalManager } from "../application/approval-manager.js";
import type { AIEngine, EngineRunOptions } from "./engine.js";
import { languageModel } from "./provider-factory.js";
import { createWorkspaceTools, type WorkspaceToolEvent } from "./workspace-tools.js";

class EventQueue {
  readonly #items: EngineEvent[] = [];
  readonly #waiters: Array<(item: IteratorResult<EngineEvent>) => void> = [];
  #closed = false;

  push(item: EngineEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: item });
    else this.#items.push(item);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  next(): Promise<IteratorResult<EngineEvent>> {
    const item = this.#items.shift();
    if (item) return Promise.resolve({ done: false, value: item });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

function textOf(message: EngineRunOptions["messages"][number]): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toMessages(messages: EngineRunOptions["messages"]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") {
      return [];
    }
    const content = textOf(message);
    return content === "" ? [] : [{ role: message.role, content }];
  });
}

function usageOf(value: unknown): UsageInfo {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const number = (key: string): number | null =>
    typeof record[key] === "number" ? record[key] : null;
  return {
    inputTokens: number("inputTokens"),
    outputTokens: number("outputTokens"),
    totalTokens: number("totalTokens"),
  };
}

function finishReason(value: string): FinishReason {
  if (value === "length") return "length";
  if (value === "tool-calls") return "tool";
  if (value === "error") return "error";
  return "stop";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function responseError(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const body = record(JSON.parse(value) as unknown);
    const nested = record(body?.["error"]);
    return typeof nested?.["message"] === "string" ? nested["message"] : undefined;
  } catch {
    return undefined;
  }
}

function specificErrorMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  const source = record(value);
  if (!source) return undefined;
  const bodyMessage = responseError(source["responseBody"]);
  if (bodyMessage) return bodyMessage;
  for (const key of ["lastError", "cause", "error"]) {
    const nested = specificErrorMessage(source[key], depth + 1);
    if (nested) return nested;
  }
  if (Array.isArray(source["errors"])) {
    for (const candidate of [...source["errors"]].reverse()) {
      const nested = specificErrorMessage(candidate, depth + 1);
      if (nested) return nested;
    }
  }
  const message = source["message"];
  return typeof message === "string" && message !== "" ? message : undefined;
}

export function normalizeEngineError(error: unknown): AppError {
  const message =
    specificErrorMessage(error) ??
    (error instanceof Error ? error.message : String(error));
  return {
    code: "AGENT_ERROR",
    message,
    retryable: /429|5\d\d|timeout|network|fetch/i.test(message),
  };
}

function base(
  options: EngineRunOptions,
): Pick<EngineEvent, "schemaVersion" | "runId" | "conversationId" | "createdAt"> {
  return {
    schemaVersion: 1,
    runId: options.runId,
    conversationId: options.conversationId,
    createdAt: Date.now(),
  };
}

function toolEvent(options: EngineRunOptions, event: WorkspaceToolEvent): EngineEvent | null {
  if (event.type === "approval" && event.approvalId && event.description && event.risk) {
    return {
      ...base(options),
      type: "tool.approval_required",
      messageId: options.messageId,
      approvalId: event.approvalId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      description: event.description,
      input: event.input,
      risk: event.risk,
    };
  }
  if (
    event.type === "diff" &&
    event.path !== undefined &&
    event.before !== undefined &&
    event.after !== undefined
  ) {
    return {
      ...base(options),
      type: "artifact.diff",
      messageId: options.messageId,
      toolCallId: event.toolCallId,
      path: event.path,
      before: event.before,
      after: event.after,
    };
  }
  return null;
}

export class AISDKEngine implements AIEngine {
  readonly #runs = new Map<string, AbortController>();

  constructor(private readonly approvals: ApprovalManager) {}

  async descriptor(): Promise<EngineDescriptor> {
    return {
      id: "ai-sdk",
      name: "AI SDK Agent",
      kind: "native",
      capabilities: {
        chat: true,
        tools: true,
        reasoning: true,
        attachments: false,
        images: true,
        video: false,
        sessionResume: true,
        workspaceAccess: true,
      },
    };
  }

  async detect(): Promise<EngineDetectionResult> {
    return { installed: true, authenticated: true, compatible: true };
  }

  async *run(options: EngineRunOptions): AsyncIterable<EngineEvent> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.abortSignal.reason);
    options.abortSignal.addEventListener("abort", abort, { once: true });
    this.#runs.set(options.runId, controller);
    const queue = new EventQueue();
    let fullText = "";
    let usage: UsageInfo | undefined;
    let reason: FinishReason = "stop";

    yield { ...base(options), type: "run.started", messageId: options.messageId };

    try {
      const tools = createWorkspaceTools({
        workspace: options.workspace,
        signal: controller.signal,
        approvals: this.approvals,
        emit: (event) => {
          const mapped = toolEvent(options, event);
          if (mapped) queue.push(mapped);
        },
      });
      const instructions = [
        "你是 Tietiezhi Workspace Agent。",
        `所有操作仅允许在 Workspace 目录中进行：${options.workspace}`,
        "先检查现有文件，再进行修改。修改文件或执行命令前必须等待用户审批。",
        "完成后简洁说明修改内容、验证结果和未解决问题。",
        options.systemPrompt?.trim() ?? "",
      ]
        .filter(Boolean)
        .join("\n");
      const agent = new ToolLoopAgent({
        model: languageModel(options.provider, options.apiKey, options.model),
        instructions,
        tools,
        providerOptions:
          options.provider.providerType === "openai"
            ? { openai: { store: false } }
            : undefined,
      });
      const result = await agent.stream({
        messages: toMessages(options.messages),
        abortSignal: controller.signal,
      });

      void (async () => {
        try {
          for await (const part of result.fullStream) {
            if (part.type === "text-delta") {
              fullText += part.text;
              queue.push({
                ...base(options),
                type: "text.delta",
                messageId: options.messageId,
                delta: part.text,
              });
            } else if (part.type === "reasoning-delta") {
              queue.push({
                ...base(options),
                type: "reasoning.delta",
                messageId: options.messageId,
                delta: part.text,
              });
            } else if (part.type === "tool-call") {
              queue.push({
                ...base(options),
                type: "tool.call",
                messageId: options.messageId,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              });
            } else if (part.type === "tool-result") {
              queue.push({
                ...base(options),
                type: "tool.result",
                messageId: options.messageId,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: part.output,
                isError: false,
              });
            } else if (part.type === "tool-error") {
              queue.push({
                ...base(options),
                type: "tool.result",
                messageId: options.messageId,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: normalizeEngineError(part.error),
                isError: true,
              });
            } else if (part.type === "finish") {
              usage = usageOf(part.totalUsage);
              reason = finishReason(part.finishReason);
              queue.push({
                ...base(options),
                type: "usage",
                messageId: options.messageId,
                usage,
              });
            } else if (part.type === "error") {
              throw part.error;
            }
          }
          if (fullText) {
            queue.push({
              ...base(options),
              type: "text.end",
              messageId: options.messageId,
              text: fullText,
            });
          }
          queue.push({
            ...base(options),
            type: "run.completed",
            messageId: options.messageId,
            finishReason: controller.signal.aborted ? "cancelled" : reason,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            queue.push({
              ...base(options),
              type: "run.completed",
              messageId: options.messageId,
              finishReason: "cancelled",
            });
          } else {
            queue.push({
              ...base(options),
              type: "run.failed",
              messageId: options.messageId,
              error: normalizeEngineError(error),
            });
          }
        } finally {
          queue.close();
        }
      })();

      for (;;) {
        const item = await queue.next();
        if (item.done) break;
        yield item.value;
      }
    } catch (error) {
      yield {
        ...base(options),
        type: controller.signal.aborted ? "run.completed" : "run.failed",
        messageId: options.messageId,
        ...(controller.signal.aborted
          ? { finishReason: "cancelled" as const }
          : { error: normalizeEngineError(error) }),
      } as EngineEvent;
    } finally {
      options.abortSignal.removeEventListener("abort", abort);
      this.#runs.delete(options.runId);
      void usage;
    }
  }

  async cancel(runId: string): Promise<void> {
    this.#runs.get(runId)?.abort();
  }

  async dispose(): Promise<void> {
    for (const controller of this.#runs.values()) controller.abort();
    this.#runs.clear();
  }
}
