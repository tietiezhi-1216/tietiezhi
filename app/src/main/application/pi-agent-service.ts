import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { AgentEvent, AgentPromptInput, AgentSessionInfo, AgentStartInput } from "@shared/contracts";
import type { GatewayModel } from "@shared/gateway-protocol";

import { ConversationService } from "./conversation-service.js";
import { AgentGroupService } from "./agent-group-service.js";
import { AgentProfileService } from "./agent-profile-service.js";
import { GatewayAuthService, type GatewayAgentConfig } from "./gateway-auth-service.js";
import { WorkspaceService } from "./workspace-service.js";

const PROVIDER_ID = "tietiezhi-gateway";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const PREFERRED_MODEL_IDS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.4",
  "claude-sonnet-4-6",
  "gemini-3.6-flash",
] as const;

interface ManagedSession {
  info: AgentSessionInfo;
  session: AgentSession;
  unsubscribe: () => void;
  assistantText: string;
}

type AgentEventSink = (event: AgentEvent) => void;

export class PiAgentService {
  private readonly sessions = new Map<string, ManagedSession>();
  private modelRuntimePromise: Promise<ModelRuntime> | undefined;

  constructor(
    private readonly auth: GatewayAuthService,
    private readonly conversations: ConversationService,
    private readonly workspaces: WorkspaceService,
    private readonly agentProfiles: AgentProfileService,
    private readonly agentGroups: AgentGroupService,
    private readonly emit: AgentEventSink,
  ) {}

  async start(input: AgentStartInput): Promise<AgentSessionInfo> {
    const detail = this.conversations.load(input.conversationId);
    if (detail.conversation.workspaceId !== input.workspaceId) {
      throw new Error("对话与 Workspace 不匹配");
    }
    const agentId = input.agentId ?? detail.conversation.agentId;
    if (detail.conversation.agentId && agentId && detail.conversation.agentId !== agentId) {
      throw new Error("对话与智能体不匹配");
    }
    const agent = agentId ? this.agentProfiles.require(agentId) : undefined;
    const groupId = input.groupId ?? detail.conversation.groupId;
    if (detail.conversation.groupId && groupId && detail.conversation.groupId !== groupId) {
      throw new Error("对话与群聊不匹配");
    }
    const group = groupId ? this.agentGroups.require(groupId) : undefined;
    const existing = this.sessions.get(input.conversationId);
    if (existing) {
      return existing.info;
    }

    const workspace = this.workspaces.require(input.workspaceId);
    const gateway = await this.auth.agentConfig();
    const runtime = await this.getModelRuntime();
    const modelId = registerGatewayModels(
      runtime,
      gateway,
      (input, init) => authFetch(this.auth, input, init),
      agent?.modelId,
    );
    const model = runtime.getModel(PROVIDER_ID, modelId);
    if (!model) throw new Error("网关模型初始化失败");

    const { session } = await createAgentSession({
      cwd: workspace.path,
      model,
      modelRuntime: runtime,
      noTools: "all",
      sessionManager: SessionManager.inMemory(workspace.path),
    });
    if (agent) {
      const groupContext = group
        ? `\n你正在群聊「${group.name}」中担任主协调智能体。群聊成员包括：${group.agentIds.map((id) => this.agentProfiles.require(id).name).join("、")}。需要时请明确说明建议交给哪位成员复核。`
        : "";
      session.agent.state.systemPrompt = `${this.agentProfiles.systemPrompt(agent.id)}${groupContext}`;
    }
    restoreConversationHistory(session, detail.messages, model.id);
    const info: AgentSessionInfo = {
      conversationId: input.conversationId,
      agentId,
      sessionId: session.sessionId,
      modelId: model.id,
    };
    const managed: ManagedSession = {
      info,
      session,
      unsubscribe: () => undefined,
      assistantText: "",
    };
    managed.unsubscribe = session.subscribe((event) => {
      this.handleSessionEvent(managed, event);
    });
    this.sessions.set(input.conversationId, managed);
    this.emit({ type: "session_started", ...info });
    return info;
  }

  async prompt(input: AgentPromptInput): Promise<void> {
    const managed = this.requireSession(input.conversationId);
    const text = input.text.trim();
    if (!text) throw new Error("提示词不能为空");
    managed.assistantText = "";
    try {
      await managed.session.prompt(text);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.emit({ type: "session_error", conversationId: input.conversationId, message });
      throw cause;
    }
  }

  async abort(conversationId: string): Promise<void> {
    const managed = this.requireSession(conversationId);
    await managed.session.abort();
  }

  async stop(conversationId: string): Promise<void> {
    const managed = this.sessions.get(conversationId);
    if (!managed) return;
    this.sessions.delete(conversationId);
    managed.unsubscribe();
    await managed.session.abort().catch(() => undefined);
    managed.session.dispose();
    this.emit({ type: "session_stopped", conversationId });
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((conversationId) => this.stop(conversationId)));
  }

  private requireSession(conversationId: string): ManagedSession {
    const managed = this.sessions.get(conversationId);
    if (!managed) throw new Error("Agent 会话尚未启动");
    return managed;
  }

  private async getModelRuntime(): Promise<ModelRuntime> {
    this.modelRuntimePromise ??= ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    });
    return this.modelRuntimePromise;
  }

  private handleSessionEvent(managed: ManagedSession, event: AgentSessionEvent): void {
    if (event.type === "message_start" && event.message.role === "assistant") {
      managed.assistantText = "";
      return;
    }
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        managed.assistantText += event.assistantMessageEvent.delta;
        this.emit({
          type: "assistant_text_delta",
          conversationId: managed.info.conversationId,
          delta: event.assistantMessageEvent.delta,
        });
      } else if (event.assistantMessageEvent.type === "error") {
        const message = event.assistantMessageEvent.error.errorMessage || "Pi Agent 请求失败";
        this.emit({
          type: "session_error",
          conversationId: managed.info.conversationId,
          message,
        });
      }
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = managed.assistantText || event.message.content
        .filter((part): part is Extract<(typeof event.message.content)[number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
      this.emit({
        type: "assistant_completed",
        conversationId: managed.info.conversationId,
        text,
      });
    }
  }
}

function restoreConversationHistory(
  session: AgentSession,
  messages: ReturnType<ConversationService["load"]>["messages"],
  modelId: string,
): void {
  const history: typeof session.agent.state.messages = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.parts
      .filter((part): part is Extract<(typeof message.parts)[number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text) continue;
    if (message.role === "user") {
      history.push({ role: "user", content: text, timestamp: message.createdAt });
      continue;
    }
    history.push({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: PROVIDER_ID,
      model: modelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: message.createdAt,
    });
  }
  session.agent.state.messages = history;
}

function registerGatewayModels(
  runtime: ModelRuntime,
  gateway: GatewayAgentConfig,
  fetcher: typeof globalThis.fetch,
  preferredModelId?: string,
): string {
  const baseUrl = responsesBaseURL(gateway.bootstrap.endpoints.responses);
  const models = gateway.bootstrap.models.data
    .filter((model) => model.status === "available")
    .map((model) => toPiModel(model, baseUrl));
  if (models.length === 0) throw new Error("网关没有可用模型");
  const responses = openAIResponsesApi();
  const provider: Provider<"openai-responses"> = {
    id: PROVIDER_ID,
    name: "Tietiezhi Gateway",
    baseUrl,
    auth: {
      apiKey: {
        name: "Tietiezhi Gateway API Key",
        resolve: async () => ({
          auth: { apiKey: gateway.credential.secret },
          source: "runtime",
        }),
      },
    },
    getModels: () => models,
    stream: (model, context, options) => responses.stream(model, context, {
      ...options,
      fetch: fetcher,
    }),
    streamSimple: (model, context, options) => responses.streamSimple(model, context, {
      ...options,
      fetch: fetcher,
    }),
  };
  runtime.registerNativeProvider(provider);
  const configured = process.env["TIETIEZHI_GATEWAY_MODEL"]?.trim();
  if (configured && models.some((model) => model.id === configured)) return configured;
  if (preferredModelId && models.some((model) => model.id === preferredModelId)) return preferredModelId;
  return PREFERRED_MODEL_IDS.find((id) => models.some((model) => model.id === id)) ?? models[0]?.id ?? "";
}

function toPiModel(model: GatewayModel, baseUrl: string) {
  const input: Array<"text" | "image"> = model.capabilities.input_modalities.includes("image")
    ? ["text", "image"]
    : ["text"];
  return {
    id: model.id,
    name: model.display_name,
    api: "openai-responses" as const,
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: model.capabilities.reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.limits.context_window ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.limits.max_output_tokens ?? DEFAULT_MAX_TOKENS,
  };
}

function authFetch(
  auth: GatewayAuthService,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return auth.fetchForAgent(input, init);
}

function responsesBaseURL(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.pathname.endsWith("/responses")) {
    url.pathname = url.pathname.slice(0, -"/responses".length) || "/";
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}
