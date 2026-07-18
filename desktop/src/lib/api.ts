import { Channel, invoke } from "@tauri-apps/api/core";

export type ProviderType = "openai" | "mimo";

/**
 * What a model can be used for. `/v1/models` carries no capability metadata, so
 * Rust derives this from the model id (see commands/models.rs) — the same
 * name-based fallback the relay itself uses.
 */
export type ModelKind =
  | "chat"
  | "asr"
  | "tts"
  | "image"
  | "video"
  | "embedding"
  | "other";

export interface ModelInfo {
  id: string;
  kind: ModelKind;
}

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  models: ModelInfo[];
}

export interface ProviderView extends Provider {
  hasKey: boolean;
}

export type PermissionMode = "ask" | "auto" | "full";

export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { kind: "http"; url: string; headers: Record<string, string> };

export interface McpServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
}

export interface McpServerStatus {
  id: string;
  state: "running" | "stopped" | "error";
  toolCount: number;
  error: string;
}

export interface Agent {
  id: string;
  name: string;
  systemPrompt: string;
  /** Model override; empty = follow the chat selection. */
  model: string;
  modelProviderId: string;
  /** Skill names visible to this agent; empty = all enabled skills. */
  skills: string[];
  /** MCP server ids; empty = all enabled servers. */
  mcpServers: string[];
  /** Allowed builtin tools; empty = all. */
  tools: string[];
  permissionMode: PermissionMode;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface Skill {
  name: string;
  description: string;
  enabled: boolean;
}

export interface AppSettings {
  /** Internal settings schema version; preserved when settings are saved. */
  settingsVersion: number;
  providers: Provider[];
  chatProviderId: string;
  chatModel: string;
  /** Empty pair = use the model selected for the conversation. */
  titleProviderId: string;
  titleModel: string;
  asrProviderId: string;
  asrModel: string;
  polishProviderId: string;
  polishModel: string;
  polishEnabled: boolean;
  /** auto | zhCn | zhTw | en | ja | ko */
  outputLanguage: string;
  /** Global dictation trigger, e.g. "Alt+Space"; empty = built-in default. */
  dictationHotkey: string;
  /** Custom polish system prompt; empty = built-in default. */
  polishPrompt: string;
  /** Custom chat system prompt; empty = built-in default. */
  systemPrompt: string;
  /** Default permission mode for chats without an agent. */
  permissionMode: PermissionMode;
  /** Skills the user switched off. */
  skillsDisabled: string[];
  mcpServers: McpServer[];
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** One persisted transcript entry; legacy files omit `kind` (= "message"). */
export interface StoredMessage {
  kind?: "message" | "toolCall" | "permission" | "error";
  role?: ChatRole;
  content?: string;
  error?: boolean;
  /** ms since epoch; 0 for conversations saved before messages had timestamps. */
  createdAt: number;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: unknown;
  toolOutput?: string;
  decision?: PermissionDecision;
  model?: string;
  providerId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  usageEstimated?: boolean;
  firstTokenMs?: number;
  durationMs?: number;
  completedAt?: number;
  errorDetail?: string;
  errorCode?: string;
  errorStatus?: number;
  errorRetryable?: boolean;
  errorRetries?: number;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: StoredMessage[];
  /** Agent profile bound to this conversation; empty = default assistant. */
  agentId?: string;
  /** Optional project binding; empty = standalone task. */
  projectId?: string;
  /** 0/undefined for active tasks; otherwise archive time in milliseconds. */
  archivedAt?: number;
  /** 0/undefined for normal tasks; otherwise pin time in milliseconds. */
  pinnedAt?: number;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
  projectId: string;
  archivedAt: number;
  pinnedAt: number;
}

export interface SaveConversationResult {
  updatedAt: number;
  title: string;
}

export type PermissionDecision = "allow" | "allowAlways" | "deny";

export type ChatEvent =
  | { type: "started"; model: string }
  | { type: "delta"; content: string }
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }
  | { type: "toolCallStart"; id: string; name: string; args: unknown }
  | { type: "toolResult"; id: string; output: string; isError: boolean }
  | {
      type: "permissionRequest";
      id: string;
      tool: string;
      description: string;
      args: unknown;
    }
  | {
      type: "retrying";
      attempt: number;
      maxRetries: number;
      delayMs: number;
      reason: string;
    }
  | { type: "done"; cancelled: boolean }
  | {
      type: "error";
      message: string;
      detail: string;
      code?: string;
      status?: number;
      retryable: boolean;
      retries: number;
    };

// MARK: - Settings

export function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export function saveSettings(settings: AppSettings): Promise<void> {
  return invoke("save_settings", { settings });
}

// MARK: - Providers

export function listProviders(): Promise<ProviderView[]> {
  return invoke<ProviderView[]>("list_providers");
}

/** The stored API key of a provider, for the settings editor's reveal toggle. */
export function providerKey(id: string): Promise<string | null> {
  return invoke<string | null>("provider_key", { id });
}

export function upsertProvider(provider: Provider, apiKey?: string): Promise<void> {
  return invoke("upsert_provider", { provider, apiKey: apiKey ?? null });
}

export function deleteProvider(id: string): Promise<void> {
  return invoke("delete_provider", { id });
}

export interface FetchModelsArgs {
  id: string;
  baseUrl?: string;
  kind?: ProviderType;
  apiKey?: string;
}

export function fetchProviderModels(args: FetchModelsArgs): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("fetch_provider_models", {
    id: args.id,
    baseUrl: args.baseUrl ?? null,
    kind: args.kind ?? null,
    apiKey: args.apiKey ?? null,
  });
}

// MARK: - Chat

export interface ChatStreamArgs {
  requestId: number;
  providerId: string;
  model: string;
  messages: ChatMessage[];
  conversationId?: string;
  agentId?: string;
  projectId?: string;
  onEvent: (event: ChatEvent) => void;
}

export function chatStream(args: ChatStreamArgs): Promise<void> {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = args.onEvent;
  return invoke("chat_stream", {
    requestId: args.requestId,
    providerId: args.providerId,
    model: args.model,
    messages: args.messages,
    conversationId: args.conversationId ?? null,
    agentId: args.agentId ?? null,
    projectId: args.projectId ?? null,
    onEvent: channel,
  });
}

/** Answer a `permissionRequest` chat event. */
export function permissionRespond(
  id: string,
  decision: PermissionDecision,
): Promise<void> {
  return invoke("permission_respond", { id, decision });
}

// MARK: - Agents

export function listAgents(): Promise<Agent[]> {
  return invoke<Agent[]>("list_agents");
}

export function upsertAgent(agent: Agent): Promise<void> {
  return invoke("upsert_agent", { agent });
}

export function deleteAgent(id: string): Promise<void> {
  return invoke("delete_agent", { id });
}

/** Builtin tool names, for the agent editor's toggles. */
export function listBuiltinTools(): Promise<string[]> {
  return invoke<string[]>("list_builtin_tools");
}

// MARK: - Skills

export function listSkills(): Promise<Skill[]> {
  return invoke<Skill[]>("list_skills");
}

/** Full SKILL.md content, for the editor. */
export function readSkill(name: string): Promise<string> {
  return invoke<string>("read_skill", { name });
}

export function upsertSkill(
  name: string,
  description: string,
  body: string,
): Promise<void> {
  return invoke("upsert_skill", { name, description, body });
}

export function deleteSkill(name: string): Promise<void> {
  return invoke("delete_skill", { name });
}

export function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  return invoke("set_skill_enabled", { name, enabled });
}

/** Import a skill folder (must contain SKILL.md). */
export function importSkill(path: string): Promise<Skill> {
  return invoke<Skill>("import_skill", { path });
}

// MARK: - MCP

export function mcpServerStatus(): Promise<McpServerStatus[]> {
  return invoke<McpServerStatus[]>("mcp_server_status");
}

export function mcpRestartServer(id: string): Promise<void> {
  return invoke("mcp_restart_server", { id });
}

export function mcpStopServer(id: string): Promise<void> {
  return invoke("mcp_stop_server", { id });
}

// MARK: - Workspace / system prompt

/** Folder picker; resolves null when dismissed. */
export function pickWorkspaceDir(): Promise<string | null> {
  return invoke<string | null>("pick_workspace_dir");
}

// MARK: - Projects

export function listProjects(): Promise<Project[]> {
  return invoke<Project[]>("list_projects");
}

export function addProject(path: string): Promise<Project> {
  return invoke<Project>("add_project", { path });
}

export function touchProject(id: string): Promise<Project> {
  return invoke<Project>("touch_project", { id });
}

export function renameProject(id: string, name: string): Promise<Project> {
  return invoke<Project>("rename_project", { id, name });
}

export function revealProject(id: string): Promise<void> {
  return invoke("reveal_project", { id });
}

/** The built-in chat system prompt (settings editor's reset target). */
export function defaultSystemPrompt(): Promise<string> {
  return invoke<string>("default_system_prompt");
}

export function chatCancel(requestId: number): Promise<void> {
  return invoke("chat_cancel", { requestId });
}

// MARK: - Dictation

export interface TranscribeArgs {
  providerId: string;
  model: string;
  wavBase64: string;
  /** auto | zh | en (MiMo) */
  language: string;
}

export function transcribe(args: TranscribeArgs): Promise<string> {
  return invoke<string>("transcribe", {
    providerId: args.providerId,
    model: args.model,
    wavBase64: args.wavBase64,
    language: args.language,
  });
}

export interface PolishOptions {
  outputLanguage: string;
  frontApp?: string;
}

export interface PolishStreamArgs {
  requestId: number;
  providerId: string;
  model: string;
  transcript: string;
  options: PolishOptions;
  onEvent: (event: ChatEvent) => void;
}

export function polishStream(args: PolishStreamArgs): Promise<void> {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = args.onEvent;
  return invoke("polish_stream", {
    requestId: args.requestId,
    providerId: args.providerId,
    model: args.model,
    transcript: args.transcript,
    options: {
      outputLanguage: args.options.outputLanguage,
      frontApp: args.options.frontApp ?? null,
    },
    onEvent: channel,
  });
}

export interface DeliverResult {
  inserted: boolean;
  needsAccessibility: boolean;
}

/** Put text on the clipboard and auto-insert at the caret when possible. */
export function deliverText(text: string): Promise<DeliverResult> {
  return invoke<DeliverResult>("deliver_text", { text });
}

export function accessibilityTrusted(): Promise<boolean> {
  return invoke<boolean>("accessibility_trusted");
}

/** The built-in polish template (settings editor's reset target). */
export function defaultPolishPrompt(): Promise<string> {
  return invoke<string>("default_polish_prompt");
}

// MARK: - Dictation hotkey

/** The hotkey currently in effect (stored value, or the built-in default). */
export function dictationHotkey(): Promise<string> {
  return invoke<string>("dictation_hotkey");
}

/** Rebind + persist the global dictation trigger; live immediately. */
export function setDictationHotkey(shortcut: string): Promise<void> {
  return invoke("set_dictation_hotkey", { shortcut });
}

/** Clear the gesture state after a session ends or is cancelled from the UI. */
export function dictationReset(): Promise<void> {
  return invoke("dictation_reset");
}

/** Start / stop dictation as if the hotkey was clicked. */
export function dictationToggle(): Promise<void> {
  return invoke("dictation_toggle");
}

// MARK: - Capsule window

export function hideCapsule(): Promise<void> {
  return invoke("hide_capsule");
}

export function showCapsule(): Promise<void> {
  return invoke("show_capsule");
}

/** Resize the capsule window (kept glued to the screen's bottom edge). */
export function capsuleSetHeight(height: number): Promise<void> {
  return invoke("capsule_set_height", { height });
}

// MARK: - Conversations

export function listConversations(): Promise<ConversationMeta[]> {
  return invoke<ConversationMeta[]>("list_conversations");
}

export function listArchivedConversations(): Promise<ConversationMeta[]> {
  return invoke<ConversationMeta[]>("list_archived_conversations");
}

export function loadConversation(id: string): Promise<Conversation> {
  return invoke<Conversation>("load_conversation", { id });
}

/** Returns server-authoritative metadata after preserving generated titles. */
export function saveConversation(
  conversation: Omit<Conversation, "updatedAt">,
): Promise<SaveConversationResult> {
  return invoke<SaveConversationResult>("save_conversation", {
    conversation: { ...conversation, updatedAt: 0 },
  });
}

export function generateConversationTitle(
  id: string,
  conversationProviderId: string,
  conversationModel: string,
  userMessage: string,
  assistantMessage: string,
): Promise<string | null> {
  return invoke<string | null>("generate_conversation_title", {
    id,
    conversationProviderId,
    conversationModel,
    userMessage,
    assistantMessage,
  });
}

export function deleteConversation(id: string): Promise<void> {
  return invoke("delete_conversation", { id });
}

export function archiveConversation(id: string): Promise<void> {
  return invoke("archive_conversation", { id });
}

export function restoreConversation(id: string): Promise<void> {
  return invoke("restore_conversation", { id });
}

export function setConversationPinned(id: string, pinned: boolean): Promise<number> {
  return invoke<number>("set_conversation_pinned", { id, pinned });
}

export function archiveProjectConversations(projectId: string): Promise<number> {
  return invoke<number>("archive_project_conversations", { projectId });
}

/** Normalize command rejections (Rust returns plain strings). */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}
