import { generateText, ToolLoopAgent, type ModelMessage } from "ai";

import type {
  ApprovalDecision,
  AppError,
  EngineDescriptor,
  EngineDetectionResult,
  EngineEvent,
  FinishReason,
  ProviderAccount,
  UsageInfo,
} from "@shared/contracts";

import { APPROVAL_TIMEOUT_MS, ApprovalManager } from "../application/approval-manager.js";
import type { AIEngine, EngineRunOptions, EngineTitleOptions } from "./engine.js";
import { languageModel, languageModelProviderName } from "./provider-factory.js";
import { createWorkspaceTools, type WorkspaceToolEvent } from "./workspace-tools.js";
import { AI_SDK_PERMISSION_PROFILES, requiresToolApproval } from "./permission-policy.js";

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

const STREAM_MAX_RETRIES = 5;
const WORKSPACE_APPROVAL_TOOLS = new Set(["writeFile", "replaceText", "runCommand"]);

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };
type ModelProviderOptions = Record<string, Record<string, JSONValue>>;

export function modelSupportsTools(provider: ProviderAccount, model: string): boolean {
  const metadata = provider.modelMetadata[model];
  return metadata?.overrides?.toolCall ?? metadata?.toolCall ?? true;
}

export function modelProviderOptions(
  provider: ProviderAccount,
  model: string,
): ModelProviderOptions | undefined {
  const metadata = provider.modelMetadata[model];
  const effort =
    metadata?.overrides?.defaultReasoningEffort ?? metadata?.defaultReasoningEffort;
  const providerName = languageModelProviderName(provider, model);
  if (providerName === "openai") {
    return { openai: { store: false, ...(effort ? { reasoningEffort: effort } : {}) } };
  }
  if (providerName === "anthropic") {
    const supported = ["low", "medium", "high", "xhigh", "max"];
    return effort && supported.includes(effort)
      ? { anthropic: { effort } }
      : undefined;
  }
  if (providerName === "google") {
    const supported = ["minimal", "low", "medium", "high"];
    return effort && supported.includes(effort)
      ? { google: { thinkingConfig: { thinkingLevel: effort } } }
      : undefined;
  }
  if (!effort) return undefined;
  if (providerName === "deepseek") {
    return ["low", "medium", "high", "xhigh", "max"].includes(effort)
      ? { deepseek: { reasoningEffort: effort } }
      : undefined;
  }
  if (providerName === "moonshotai") {
    return effort === "max" ? { moonshotai: { reasoningEffort: effort } } : undefined;
  }
  if (providerName === "alibaba") {
    return { alibaba: { enableThinking: true } };
  }
  if (providerName === "xai") {
    return ["low", "medium", "high"].includes(effort)
      ? { xai: { reasoningEffort: effort } }
      : undefined;
  }
  if (providerName === "mistral") {
    return effort === "high" ? { mistral: { reasoningEffort: effort } } : undefined;
  }
  if (providerName === "groq") {
    return ["low", "medium", "high"].includes(effort)
      ? { groq: { reasoningEffort: effort } }
      : undefined;
  }
  if (providerName === "zhipu") {
    return { zhipu: { reasoningEffort: effort } };
  }
  if (providerName === "openrouter") {
    return { openrouter: { reasoning: { effort } } };
  }
  return providerName === "compatible"
    ? { compatible: { reasoningEffort: effort } }
    : undefined;
}

function approvalDescription(toolName: string, input: unknown): string {
  const value = record(input) ?? {};
  if (toolName === "runCommand") {
    return `执行命令：${typeof value["command"] === "string" ? value["command"] : "?"}`;
  }
  const path = typeof value["path"] === "string" ? value["path"] : "?";
  return toolName === "writeFile" ? `写入 ${path}` : `修改 ${path}`;
}

function permissionInstruction(profile: EngineRunOptions["permissionProfileId"]): string {
  if (profile === "full-access") {
    return "当前任务已由用户授予完全访问；可以直接使用工作区工具，但不得尝试越过 Workspace。";
  }
  if (profile === "agent-managed") {
    return "当前任务使用智能审批；普通工作区修改可直接执行，危险 Shell 会由系统请求用户批准。";
  }
  return "修改文件或执行命令前必须等待用户审批。";
}

function retryDelay(attempt: number): number {
  const exponential = Math.min(8_000, 500 * 2 ** (attempt - 1));
  return Math.round(exponential * (0.9 + Math.random() * 0.2));
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function textOf(message: EngineRunOptions["messages"][number]): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function toModelMessages(messages: EngineRunOptions["messages"]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === "user" || message.role === "system") {
      const content = textOf(message);
      if (message.role === "system") return content === "" ? [] : [{ role: "system", content }];
      const images = message.parts.flatMap((part) =>
        part.type === "attachment" && part.dataUrl && part.mimeType?.startsWith("image/")
          ? [{ type: "image" as const, image: part.dataUrl, mediaType: part.mimeType }]
          : [],
      );
      if (images.length === 0) return content === "" ? [] : [{ role: "user", content }];
      return [{
        role: "user",
        content: [
          ...(content === "" ? [] : [{ type: "text" as const, text: content }]),
          ...images,
        ],
      }];
    }
    if (message.role !== "assistant") return [];
    const assistantContent: Array<
      | { type: "text"; text: string }
      | { type: "reasoning"; text: string }
      | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
    > = [];
    const toolContent: Array<{
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: { type: "text"; value: string };
    }> = [];
    const completedToolCallIds = new Set(
      message.parts.flatMap((part) => part.type === "tool-result" ? [part.toolCallId] : []),
    );
    const toolCallIds = new Set(
      message.parts.flatMap((part) => part.type === "tool-call" ? [part.toolCallId] : []),
    );
    for (const part of message.parts) {
      if (part.type === "text" && part.text !== "") {
        assistantContent.push({ type: "text", text: part.text });
      } else if (part.type === "reasoning" && part.text !== "") {
        assistantContent.push({ type: "reasoning", text: part.text });
      } else if (part.type === "tool-call") {
        if (!completedToolCallIds.has(part.toolCallId)) continue;
        assistantContent.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
      } else if (part.type === "tool-result") {
        if (!toolCallIds.has(part.toolCallId)) continue;
        toolContent.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: { type: "text", value: formatToolHistory(part.output) },
        });
      }
    }
    return [
      ...(assistantContent.length > 0
        ? ([{ role: "assistant", content: assistantContent }] satisfies ModelMessage[])
        : []),
      ...(toolContent.length > 0
        ? ([{ role: "tool", content: toolContent }] satisfies ModelMessage[])
        : []),
    ];
  });
}

function formatToolHistory(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function usageOf(value: unknown): UsageInfo {
  const source =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const number = (key: string): number | null =>
    typeof source[key] === "number" ? source[key] : null;
  const inputDetails = record(source["inputTokenDetails"]);
  const outputDetails = record(source["outputTokenDetails"]);
  return {
    inputTokens: number("inputTokens"),
    outputTokens: number("outputTokens"),
    totalTokens: number("totalTokens"),
    cachedInputTokens:
      typeof inputDetails?.["cacheReadTokens"] === "number"
        ? inputDetails["cacheReadTokens"]
        : null,
    cacheWriteTokens:
      typeof inputDetails?.["cacheWriteTokens"] === "number"
        ? inputDetails["cacheWriteTokens"]
        : null,
    reasoningTokens:
      typeof outputDetails?.["reasoningTokens"] === "number"
        ? outputDetails["reasoningTokens"]
        : null,
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

function normalizedErrorMessage(error: unknown): string {
  return (
    specificErrorMessage(error) ??
    (error instanceof Error ? error.message : String(error))
  );
}

function isRetryableStreamMessage(message: string): boolean {
  return /ERR_CONNECTION|ECONN|connection.{0,20}(closed|reset|aborted)|socket|network|fetch|stream.{0,20}(closed|reset|aborted|terminated)|SSE|terminated|timed?\s*out|UND_ERR/i.test(
    message,
  );
}

export function normalizeEngineError(error: unknown): AppError {
  const message = normalizedErrorMessage(error);
  return {
    code: "AGENT_ERROR",
    message,
    retryable: /429|5\d\d/i.test(message) || isRetryableStreamMessage(message),
  };
}

export function isRetryableStreamError(error: unknown): boolean {
  return isRetryableStreamMessage(normalizedErrorMessage(error));
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
      omitted: event.omitted,
      bytes: event.bytes,
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
        permissions: {
          defaultProfileId: "ask",
          profiles: AI_SDK_PERMISSION_PROFILES,
        },
      },
    };
  }

  async detect(): Promise<EngineDetectionResult> {
    return { installed: true, authenticated: true, compatible: true };
  }

  async generateTitle(options: EngineTitleOptions): Promise<string | undefined> {
    const result = await generateText({
      model: languageModel(options.provider, options.apiKey, options.model),
      system:
        "根据用户的第一条消息生成一个简短、明确的中文对话标题。只输出标题，不要引号、句号、Markdown 或解释；最多 18 个汉字。",
      prompt: options.prompt,
      maxOutputTokens: 32,
      abortSignal: options.abortSignal,
      providerOptions:
        options.provider.providerType === "openai"
          ? { openai: { store: false } }
          : undefined,
    });
    const title = result.text
      .trim()
      .split(/\r?\n/, 1)[0]
      ?.replace(/^["'“”‘’#*\s]+|["'“”‘’#*\s。]+$/g, "")
      .trim();
    return title ? title.slice(0, 36) : undefined;
  }

  async *run(options: EngineRunOptions): AsyncIterable<EngineEvent> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.abortSignal.reason);
    options.abortSignal.addEventListener("abort", abort, { once: true });
    this.#runs.set(options.runId, controller);
    const queue = new EventQueue();
    let usage: UsageInfo | undefined;

    yield { ...base(options), type: "run.started", messageId: options.messageId };

    try {
      const tools = createWorkspaceTools(
        {
          workspace: options.workspace,
          signal: controller.signal,
          emit: (event) => {
            const mapped = toolEvent(options, event);
            if (mapped) queue.push(mapped);
          },
        },
        options.skills,
      );
      const instructions = [
        "你是 Tietiezhi Workspace Agent。",
        `所有操作仅允许在 Workspace 目录中进行：${options.workspace}`,
        `先检查现有文件，再进行修改。${permissionInstruction(options.permissionProfileId)}`,
        options.skills.length > 0
          ? "当前存在已启用技能。先用 listSkills 查看描述，任务匹配时再用 readSkill 加载完整说明。"
          : "",
        "完成后简洁说明修改内容、验证结果和未解决问题。",
        options.systemPrompt?.trim() ?? "",
      ]
        .filter(Boolean)
        .join("\n");
      void (async () => {
        const messages = toModelMessages(options.messages);
        const allowedForRun = new Set<string>();
        try {
          for (let retryAttempt = 0; ; retryAttempt += 1) {
            let fullText = "";
            let reason: FinishReason = "stop";
            let toolActivity = false;
            if (retryAttempt > 0) {
              queue.push({
                ...base(options),
                type: "run.retry.started",
                messageId: options.messageId,
                attempt: retryAttempt,
              });
            }
            try {
              const agent = new ToolLoopAgent({
                model: languageModel(options.provider, options.apiKey, options.model),
                instructions,
                tools: modelSupportsTools(options.provider, options.model) ? tools : {},
                toolApproval: ({ toolCall }) => {
                  if (!WORKSPACE_APPROVAL_TOOLS.has(toolCall.toolName)) return undefined;
                  if (
                    !requiresToolApproval(
                      options.permissionProfileId,
                      toolCall.toolName,
                      toolCall.input,
                    )
                  ) {
                    this.approvals.recordAutomatic(
                      {
                        id: `auto:${options.runId}:${toolCall.toolCallId}`,
                        runId: options.runId,
                        conversationId: options.conversationId,
                        messageId: options.messageId,
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName,
                        description: approvalDescription(toolCall.toolName, toolCall.input),
                        input: toolCall.input,
                        risk: toolCall.toolName === "runCommand" ? "high" : "medium",
                      },
                      `由“${options.permissionProfileId}”权限策略自动允许`,
                    );
                    return "approved";
                  }
                  if (allowedForRun.has(toolCall.toolName)) {
                    this.approvals.recordAutomatic(
                      {
                        id: `auto:${options.runId}:${toolCall.toolCallId}`,
                        runId: options.runId,
                        conversationId: options.conversationId,
                        messageId: options.messageId,
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName,
                        description: approvalDescription(toolCall.toolName, toolCall.input),
                        input: toolCall.input,
                        risk: toolCall.toolName === "runCommand" ? "high" : "medium",
                      },
                      "由本轮同类工具授权自动允许",
                    );
                    return "approved";
                  }
                  return "user-approval";
                },
                maxRetries: 4,
                providerOptions: modelProviderOptions(options.provider, options.model),
              });
              const result = await agent.stream({
                messages,
                abortSignal: controller.signal,
              });
              let approval:
                | {
                    approvalId: string;
                    toolCallId: string;
                    toolName: string;
                    input: unknown;
                    decision: Promise<ApprovalDecision>;
                    expiresAt: number;
                  }
                | undefined;
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
                  toolActivity = true;
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
                } else if (part.type === "tool-approval-request" && !part.isAutomatic) {
                  const description = approvalDescription(part.toolCall.toolName, part.toolCall.input);
                  const risk = part.toolCall.toolName === "runCommand" ? "high" : "medium";
                  const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;
                  const decision = this.approvals.request(
                    {
                      id: part.approvalId,
                      runId: options.runId,
                      conversationId: options.conversationId,
                      messageId: options.messageId,
                      toolCallId: part.toolCall.toolCallId,
                      toolName: part.toolCall.toolName,
                      description,
                      input: part.toolCall.input,
                      risk,
                    },
                    controller.signal,
                  );
                  approval = {
                    approvalId: part.approvalId,
                    toolCallId: part.toolCall.toolCallId,
                    toolName: part.toolCall.toolName,
                    input: part.toolCall.input,
                    decision,
                    expiresAt,
                  };
                  queue.push({
                    ...base(options),
                    type: "tool.approval_required",
                    messageId: options.messageId,
                    approvalId: part.approvalId,
                    toolCallId: part.toolCall.toolCallId,
                    toolName: part.toolCall.toolName,
                    description,
                    input: part.toolCall.input,
                    risk,
                    expiresAt,
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
              messages.push(...(await result.responseMessages));
              if (approval !== undefined) {
                const decision = await approval.decision;
                if (decision === "allow-for-run") allowedForRun.add(approval.toolName);
                const approved = decision !== "deny";
                messages.push({
                  role: "tool",
                  content: [
                    {
                      type: "tool-approval-response",
                      approvalId: approval.approvalId,
                      approved,
                      reason: approved ? undefined : "用户拒绝了此操作",
                    },
                  ],
                });
                queue.push({
                  ...base(options),
                  type: "tool.approval_resolved",
                  messageId: options.messageId,
                  approvalId: approval.approvalId,
                  toolCallId: approval.toolCallId,
                  toolName: approval.toolName,
                  decision,
                  ...(approved ? {} : { reason: "用户拒绝了此操作" }),
                });
                retryAttempt = -1;
                continue;
              }
              queue.push({
                ...base(options),
                type: "run.completed",
                messageId: options.messageId,
                finishReason: controller.signal.aborted ? "cancelled" : reason,
              });
              break;
            } catch (error) {
              if (controller.signal.aborted) {
                queue.push({
                  ...base(options),
                  type: "run.completed",
                  messageId: options.messageId,
                  finishReason: "cancelled",
                });
                break;
              }
              if (
                !toolActivity &&
                retryAttempt < STREAM_MAX_RETRIES &&
                isRetryableStreamError(error)
              ) {
                const attempt = retryAttempt + 1;
                const delayMs = retryDelay(attempt);
                queue.push({
                  ...base(options),
                  type: "run.retrying",
                  messageId: options.messageId,
                  attempt,
                  maxRetries: STREAM_MAX_RETRIES,
                  delayMs,
                  reason: normalizeEngineError(error).message,
                });
                await waitForRetry(delayMs, controller.signal);
                continue;
              }
              queue.push({
                ...base(options),
                type: "run.failed",
                messageId: options.messageId,
                error: normalizeEngineError(error),
              });
              break;
            }
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
