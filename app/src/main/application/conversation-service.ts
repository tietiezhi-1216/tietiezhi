import { randomUUID } from "node:crypto";

import type {
  AppError,
  AppMessage,
  Conversation,
  ConversationDetail,
  EngineEvent,
  SendMessageInput,
  UsageInfo,
} from "@shared/contracts";

import { AppDatabase } from "../infrastructure/database.js";
import { EngineManager } from "./engine-manager.js";
import { PreferencesService } from "./preferences-service.js";
import { ProviderService } from "./provider-service.js";
import { SkillService } from "./skill-service.js";
import { WorkspaceService } from "./workspace-service.js";

type EventSink = (event: EngineEvent) => void;

function appendText(message: AppMessage, delta: string): void {
  const part = message.parts.at(-1);
  if (part?.type === "text") {
    part.text += delta;
    return;
  }
  const created = { type: "text" as const, text: "" };
  message.parts.push(created);
  created.text = delta;
}

function appendReasoning(message: AppMessage, delta: string): void {
  const part = message.parts.at(-1);
  if (part?.type === "reasoning") {
    part.text += delta;
    return;
  }
  const created = { type: "reasoning" as const, text: "" };
  message.parts.push(created);
  created.text = delta;
}

function completeText(message: AppMessage, text: string): void {
  const streamedText = message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (streamedText === "" && text !== "") appendText(message, text);
}

function resetStreamAttempt(message: AppMessage): void {
  message.parts = message.parts.filter(
    (part) => part.type !== "text" && part.type !== "reasoning",
  );
  message.firstTokenAt = undefined;
  message.completedAt = undefined;
  message.usage = undefined;
}

export class ConversationService {
  readonly #controllers = new Map<
    string,
    { controller: AbortController; conversationId: string }
  >();
  readonly #tasks = new Map<string, Promise<void>>();
  #sink: EventSink = () => {};

  constructor(
    private readonly database: AppDatabase,
    private readonly providers: ProviderService,
    private readonly engines: EngineManager,
    private readonly workspaces: WorkspaceService,
    private readonly preferences: PreferencesService,
    private readonly skills: SkillService,
  ) {}

  setEventSink(sink: EventSink): void {
    this.#sink = sink;
  }

  list(): Conversation[] {
    return this.database.listConversations();
  }

  load(id: string): ConversationDetail {
    const detail = this.database.detail(id);
    if (detail === null) throw new Error("对话不存在");
    return detail;
  }

  async remove(id: string): Promise<void> {
    const activeRuns = [...this.#controllers.entries()]
      .filter(([, run]) => run.conversationId === id)
      .map(([runId]) => runId);
    await Promise.all(activeRuns.map((runId) => this.cancel(runId)));
    await Promise.all(
      activeRuns.map((runId) => this.#tasks.get(runId)?.catch(() => undefined)),
    );
    const conversation = this.database.conversation(id);
    this.database.removeConversation(id);
    if (
      conversation?.workspace &&
      !this.database
        .listConversations()
        .some((candidate) => candidate.workspace === conversation.workspace)
    ) {
      await this.workspaces.removeTemporary(conversation.workspace);
    }
  }

  rename(id: string, title: string): void {
    const conversation = this.database.conversation(id);
    if (conversation === null) throw new Error("对话不存在");
    const normalized = title.trim();
    if (!normalized) throw new Error("任务名称不能为空");
    conversation.title = normalized.slice(0, 120);
    conversation.updatedAt = Date.now();
    this.database.saveConversation(conversation);
  }

  async send(input: SendMessageInput): Promise<{ conversationId: string; runId: string }> {
    const prompt = input.text.trim();
    if (prompt === "") throw new Error("消息不能为空");
    const provider = this.providers.require(input.providerAccountId);
    if (!provider.models.includes(input.model)) throw new Error("所选模型不属于当前供应商");
    const engineId = input.engineId ?? "ai-sdk";
    const now = Date.now();
    const conversationId = input.conversationId ?? randomUUID();
    const existing = this.database.conversation(conversationId);
    const workspace =
      input.workspace !== undefined
        ? existing?.workspace === input.workspace
          ? await this.workspaces.restore(input.workspace)
          : await this.workspaces.ensure(input.workspace)
        : existing?.workspace
          ? await this.workspaces.restore(existing.workspace)
          : await this.workspaces.createTemporary();
    const conversation: Conversation = existing ?? {
      id: conversationId,
      title: input.model,
      createdAt: now,
      updatedAt: now,
      activeEngineId: engineId,
      activeModelId: input.model,
      providerAccountId: provider.id,
      workspace: workspace.path,
      taskMode: input.taskMode ?? "code",
    };
    conversation.updatedAt = now;
    conversation.activeEngineId = engineId;
    conversation.activeModelId = input.model;
    conversation.providerAccountId = provider.id;
    conversation.workspace = workspace.path;
    conversation.taskMode = input.taskMode ?? conversation.taskMode;
    this.database.saveConversation(conversation);

    const prior = this.database.messages(conversationId);
    const userMessage: AppMessage = {
      id: randomUUID(),
      conversationId,
      parentMessageId: prior.at(-1)?.id,
      role: "user",
      createdAt: now,
      status: "completed",
      parts: [{ type: "text", text: prompt }],
      engineId,
      modelId: input.model,
      providerAccountId: provider.id,
    };
    const runId = randomUUID();
    const assistantMessage: AppMessage = {
      id: randomUUID(),
      conversationId,
      parentMessageId: userMessage.id,
      role: "assistant",
      createdAt: now + 1,
      status: "pending",
      parts: [{ type: "text", text: "" }],
      engineId,
      modelId: input.model,
      providerAccountId: provider.id,
      runId,
    };
    this.database.saveMessage(userMessage);
    this.database.saveMessage(assistantMessage);
    this.database.startRun({
      id: runId,
      conversationId,
      messageId: assistantMessage.id,
      engineId,
      modelId: input.model,
      startedAt: now,
    });

    const controller = new AbortController();
    const preferences = await this.preferences.get();
    const enabledSkills = await this.skills.enabled();
    const modePrompt =
      conversation.taskMode === "work"
        ? "当前为 Work 工作方式。优先研究、整理资料并在 Workspace 中产出清晰的文档、表格、报告或其他可交付成果。"
        : "当前为 Code 工作方式。优先分析仓库、修改代码，并使用测试或构建验证变更。";
    const systemPrompt = [preferences.systemPrompt, modePrompt, input.systemPrompt]
      .map((value) => value?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n");
    this.#controllers.set(runId, { controller, conversationId });
    const task = this.#execute({
      engineId,
      runId,
      providerId: provider.id,
      model: input.model,
      systemPrompt,
      skills: enabledSkills,
      assistantMessage,
      messages: [...prior, userMessage],
      controller,
      workspace: workspace.path,
      titlePrompt: existing === null ? prompt : undefined,
    });
    this.#tasks.set(runId, task);
    void task.then(
      () => this.#tasks.delete(runId),
      () => this.#tasks.delete(runId),
    );
    return { conversationId, runId };
  }

  async #execute(input: {
    engineId: string;
    runId: string;
    providerId: string;
    model: string;
    systemPrompt?: string;
    skills: Awaited<ReturnType<SkillService["enabled"]>>;
    assistantMessage: AppMessage;
    messages: AppMessage[];
    controller: AbortController;
    workspace: string;
    titlePrompt?: string;
  }): Promise<void> {
    const provider = this.providers.require(input.providerId);
    const engine = this.engines.require(input.engineId);
    let usage: UsageInfo | undefined;
    let persistTimer: NodeJS.Timeout | undefined;
    let dirty = false;
    const persist = (immediate = false): void => {
      dirty = true;
      if (!immediate) {
        persistTimer ??= setTimeout(() => {
          persistTimer = undefined;
          if (!dirty) return;
          dirty = false;
          this.database.saveMessage(input.assistantMessage);
        }, 80);
        return;
      }
      if (persistTimer !== undefined) clearTimeout(persistTimer);
      persistTimer = undefined;
      dirty = false;
      this.database.saveMessage(input.assistantMessage);
    };
    try {
      const apiKey = await this.providers.key(provider);
      if (input.titlePrompt !== undefined) {
        try {
          const generatedTitle = await engine.generateTitle({
            provider,
            apiKey,
            model: input.model,
            prompt: input.titlePrompt,
            abortSignal: input.controller.signal,
          });
          if (generatedTitle) {
            const conversation = this.database.conversation(
              input.assistantMessage.conversationId,
            );
            if (conversation?.title === input.model) {
              conversation.title = generatedTitle;
              conversation.updatedAt = Date.now();
              this.database.saveConversation(conversation);
            }
          }
        } catch {
          // Keep the active model name when title generation is unavailable.
        }
      }
      for await (const event of engine.run({
        runId: input.runId,
        conversationId: input.assistantMessage.conversationId,
        messageId: input.assistantMessage.id,
        provider,
        apiKey,
        model: input.model,
        systemPrompt: input.systemPrompt,
        skills: input.skills,
        workspace: input.workspace,
        messages: input.messages,
        abortSignal: input.controller.signal,
      })) {
        if (
          event.type === "run.started" ||
          event.type === "run.retrying" ||
          event.type === "text.start"
        ) {
          input.assistantMessage.status = "streaming";
        } else if (event.type === "run.retry.started") {
          resetStreamAttempt(input.assistantMessage);
          usage = undefined;
        } else if (event.type === "text.delta") {
          input.assistantMessage.firstTokenAt ??= event.createdAt;
          appendText(input.assistantMessage, event.delta);
        } else if (event.type === "text.end") {
          completeText(input.assistantMessage, event.text);
        } else if (event.type === "reasoning.delta") {
          appendReasoning(input.assistantMessage, event.delta);
        } else if (event.type === "tool.call") {
          const existingCall = input.assistantMessage.parts.find(
            (part) => part.type === "tool-call" && part.toolCallId === event.toolCallId,
          );
          if (existingCall?.type === "tool-call") {
            existingCall.status = "running";
          } else {
            input.assistantMessage.parts.push({
              type: "tool-call",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
              status: "running",
            });
          }
        } else if (event.type === "tool.approval_required") {
          input.assistantMessage.status = "waiting_approval";
          const call = input.assistantMessage.parts.find(
            (part) => part.type === "tool-call" && part.toolCallId === event.toolCallId,
          );
          if (call?.type === "tool-call") call.status = "approval";
        } else if (event.type === "tool.approval_resolved") {
          input.assistantMessage.status = "streaming";
          const call = input.assistantMessage.parts.find(
            (part) => part.type === "tool-call" && part.toolCallId === event.toolCallId,
          );
          if (call?.type === "tool-call") {
            call.status = event.decision === "deny" ? "denied" : "running";
          }
        } else if (event.type === "tool.result") {
          const call = input.assistantMessage.parts.find(
            (part) => part.type === "tool-call" && part.toolCallId === event.toolCallId,
          );
          if (call?.type === "tool-call") call.status = event.isError ? "failed" : "completed";
          input.assistantMessage.parts.push({
            type: "tool-result",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            output: event.output,
            isError: event.isError,
          });
        } else if (event.type === "artifact.diff") {
          input.assistantMessage.parts.push({
            type: "diff",
            toolCallId: event.toolCallId,
            path: event.path,
            before: event.before,
            after: event.after,
          });
        } else if (event.type === "usage") {
          usage = event.usage;
          input.assistantMessage.usage = usage;
        } else if (event.type === "run.completed") {
          input.assistantMessage.status =
            event.finishReason === "cancelled" ? "cancelled" : "completed";
          input.assistantMessage.completedAt = event.createdAt;
          this.database.finishRun(
            input.runId,
            event.finishReason === "cancelled" ? "cancelled" : "completed",
            event.finishReason,
            usage,
          );
        } else if (event.type === "run.failed") {
          input.assistantMessage.status = "failed";
          input.assistantMessage.completedAt = event.createdAt;
          input.assistantMessage.parts.push({
            type: "error",
            code: event.error.code,
            message: event.error.message,
          });
          this.database.finishRun(input.runId, "failed", "error", usage, event.error);
        }
        persist(
          event.type === "tool.approval_required" ||
            event.type === "tool.approval_resolved" ||
            event.type === "tool.result" ||
            event.type === "artifact.diff" ||
            event.type === "run.retry.started" ||
            event.type === "text.end" ||
            event.type === "run.completed" ||
            event.type === "run.failed",
        );
        this.#sink(event);
      }
    } catch (error) {
      const failure: AppError = {
        code: "RUN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
      input.assistantMessage.status = "failed";
      input.assistantMessage.completedAt = Date.now();
      input.assistantMessage.parts.push({
        type: "error",
        code: failure.code,
        message: failure.message,
      });
      this.database.saveMessage(input.assistantMessage);
      this.database.finishRun(input.runId, "failed", "error", usage, failure);
      this.#sink({
        schemaVersion: 1,
        type: "run.failed",
        runId: input.runId,
        conversationId: input.assistantMessage.conversationId,
        messageId: input.assistantMessage.id,
        createdAt: Date.now(),
        error: failure,
      });
    } finally {
      if (persistTimer !== undefined) clearTimeout(persistTimer);
      if (dirty) this.database.saveMessage(input.assistantMessage);
      this.#controllers.delete(input.runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    this.#controllers.get(runId)?.controller.abort();
    await Promise.all(
      (await this.engines.list()).map((descriptor) =>
        this.engines.require(descriptor.id).cancel(runId),
      ),
    );
  }
}
