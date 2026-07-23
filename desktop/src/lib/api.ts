import { Channel, invoke } from "@tauri-apps/api/core";
import type { TaskMode } from "@/lib/task-mode";

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
  | "audio"
  | "image"
  | "video"
  | "embedding"
  | "other";

export type ModelCapability =
  | "tool-call"
  | "reasoning"
  | "structured-output"
  | "web-search";

export type ModelModality = "text" | "image" | "audio" | "video" | "file" | "vector";

export type ReasoningEffort =
  | "auto"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ReasoningProfile {
  mode: "fixed" | "effort";
  supportedEfforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  transport:
    | "none"
    | "openai-reasoning-effort"
    | "openrouter-reasoning"
    | "enable-thinking";
}

export interface ModelOverrides {
  kind?: ModelKind;
  inputModalities?: ModelModality[];
  outputModalities?: ModelModality[];
  capabilities?: Partial<Record<ModelCapability, boolean>>;
  reasoning?: ReasoningProfile;
}

export interface ModelInfo {
  id: string;
  kind: ModelKind;
  inputModalities?: ModelModality[];
  outputModalities?: ModelModality[];
  capabilities?: ModelCapability[];
  reasoning?: ReasoningProfile;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilitySource?: "inferred" | "registry" | "provider" | string;
  overrides?: ModelOverrides;
}

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  builtIn: boolean;
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
  /** Empty = follow chat; otherwise English reasoning effort. */
  reasoningEffort: "" | ReasoningEffort;
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

export interface ProjectSuggestion {
  id: string;
  title: string;
  description: string;
  prompt: string;
  category: "explore" | "quality" | "test" | "docs";
}

export interface ProjectRecommendations {
  projectId: string;
  taskMode: TaskMode;
  generatedAt: number;
  model: string;
  tokenUsage: number;
  technologies: string[];
  suggestions: ProjectSuggestion[];
}

export interface DeviceCore {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: number;
  online: boolean;
  latencyMs?: number;
  deviceCount: number;
  lastError: string;
  hasToken: boolean;
}

export type TietiezhiDeviceRole = "core" | "device";

export interface TietiezhiDevice {
  /** Stable target id accepted by invokeDevice/device_call. */
  id: string;
  /** Device id inside its owning Core. */
  nativeId: string;
  name: string;
  platform: string;
  coreId: string;
  coreName: string;
  role: TietiezhiDeviceRole;
  online: boolean;
  capabilities: string[];
}

export interface DeviceInvokeResult {
  requestId: string;
  deviceId: string;
  capability: string;
  ok: boolean;
  output: unknown;
  message: string;
  durationMs: number;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AutomationNodeType =
  | "manualTrigger"
  | "scheduleTrigger"
  | "model"
  | "agent"
  | "skill"
  | "mcpTool"
  | "builtinTool"
  | "code"
  | "condition"
  | "merge"
  | "approval"
  | "output"
  | `custom.${string}`;

export type AutomationValueBinding =
  | { kind: "literal"; value: JsonValue }
  | { kind: "triggerInput"; path: string }
  | { kind: "nodeOutput"; nodeId: string; path: string }
  | { kind: "secretRef"; credentialId: string; key?: string };

export interface AutomationPosition {
  x: number;
  y: number;
}

export interface AutomationNode {
  id: string;
  type: AutomationNodeType;
  typeVersion: number;
  name: string;
  position: AutomationPosition;
  disabled: boolean;
  config: Record<string, JsonValue>;
  inputs: Record<string, AutomationValueBinding>;
}

export interface AutomationEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

export interface AutomationSettings {
  timezone: string;
  maxDurationMs: number;
  maxConcurrency: number;
  onMissedSchedule: "skip" | "runLatest";
}

export interface AutomationDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  revision: number;
  nodes: AutomationNode[];
  edges: AutomationEdge[];
  settings: AutomationSettings;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationMeta {
  id: string;
  name: string;
  description: string;
  revision: number;
  nodeCount: number;
  triggerType: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number;
}

export interface AutomationValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
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
  chatReasoningEffort: ReasoningEffort;
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
  /** Show per-reply stats inline under each assistant message; off by default. */
  showMessageStats: boolean;
  /** Show the model's reasoning / chain-of-thought (collapsed) above replies. */
  showReasoning: boolean;
  /** Show cached AI-generated starters in the workspace empty state. */
  smartSuggestionsEnabled: boolean;
  /** Permit background suggestions to use a user-paid provider. */
  smartSuggestionsAllowPaidModels: boolean;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatAttachment {
  id: string;
  /** Legacy image-only attachments omit kind and are treated as images. */
  kind?: "image" | "file" | "folder";
  name: string;
  mimeType: string;
  path?: string;
  size?: number;
  dataUrl?: string;
  /** Embedded text/code or a bounded directory manifest. */
  textContent?: string;
  truncated?: boolean;
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentPart[];
}

/** One persisted transcript entry; legacy files omit `kind` (= "message"). */
export interface StoredMessage {
  kind?: "message" | "toolCall" | "permission" | "error" | "context";
  role?: ChatRole;
  content?: string;
  /** Reasoning / chain-of-thought, shown collapsed above the answer. */
  reasoning?: string;
  attachments?: ChatAttachment[];
  error?: boolean;
  /** ms since epoch; 0 for conversations saved before messages had timestamps. */
  createdAt: number;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: unknown;
  toolOutput?: string;
  toolStatus?: "running" | "success" | "error" | "cancelled";
  toolDurationMs?: number;
  toolExitCode?: number;
  toolTimedOut?: boolean;
  toolTruncated?: boolean;
  decision?: PermissionDecision;
  model?: string;
  providerId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  usageEstimated?: boolean;
  firstTokenMs?: number;
  durationMs?: number;
  completedAt?: number;
  errorDetail?: string;
  errorCode?: string;
  errorStatus?: number;
  errorRetryable?: boolean;
  errorRetries?: number;
  contextAction?: "compaction" | "usage";
  contextSummary?: string;
  contextAutomatic?: boolean;
  contextTokensBefore?: number;
  contextTokensAfter?: number;
  contextWindow?: number;
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
  /** Last execution space selected inside this shared task. */
  taskMode?: TaskMode;
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
  taskMode: TaskMode;
  archivedAt: number;
  pinnedAt: number;
}

export interface WorkspaceFileEntry {
  path: string;
  size: number;
  modifiedAt: number;
}

export interface TaskWorkspaceModeStatus {
  mode: TaskMode;
  initialized: boolean;
  rootPath: string;
  isGit: boolean;
  fileCount: number;
  fileCountCapped: boolean;
  changedFiles: string[];
  deliverables: WorkspaceFileEntry[];
  transferableFiles: WorkspaceFileEntry[];
}

export interface TaskWorkspaceOverview {
  work: TaskWorkspaceModeStatus;
  code: TaskWorkspaceModeStatus;
}

export function taskWorkspaceOverview(taskId: string): Promise<TaskWorkspaceOverview> {
  return invoke<TaskWorkspaceOverview>("task_workspace_overview", { taskId });
}

export function transferTaskWorkspaceFile(args: {
  taskId: string;
  fromMode: TaskMode;
  toMode: TaskMode;
  path: string;
}): Promise<string> {
  return invoke<string>("transfer_task_workspace_file", args);
}

export interface SaveConversationResult {
  updatedAt: number;
  title: string;
}

export type PermissionDecision = "allow" | "allowAlways" | "deny";

export type ChatEvent =
  | { type: "started"; model: string }
  | { type: "delta"; content: string }
  | { type: "reasoning"; content: string }
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedTokens: number;
    }
  | {
      type: "toolCallStart";
      id: string;
      name: string;
      args: unknown;
      timeoutMs?: number;
    }
  | {
      type: "toolProgress";
      id: string;
      output: string;
      elapsedMs: number;
      truncated: boolean;
    }
  | {
      type: "toolResult";
      id: string;
      output: string;
      isError: boolean;
      durationMs: number;
      exitCode?: number;
      timedOut: boolean;
      cancelled: boolean;
      truncated: boolean;
    }
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
  | {
      type: "contextCompactionStarted";
      automatic: boolean;
      estimatedTokens: number;
      contextWindow: number;
    }
  | {
      type: "contextCompacted";
      automatic: boolean;
      summary: string;
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
      contextWindow: number;
    }
  | {
      type: "contextUsage";
      estimatedTokens: number;
      contextWindow: number;
      compactAtTokens: number;
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

// MARK: - Create

export interface CreateImageGenerationRequest {
  providerId: string;
  model: string;
  prompt: string;
  aspectRatio: "1:1" | "4:3" | "3:4" | "16:9" | "9:16" | "21:9";
  quality: "standard" | "high";
  resultCount: number;
  referencePaths: string[];
}

export interface CreateImageGenerationResult {
  providerId: string;
  model: string;
  filePath: string;
  mimeType: string;
  revisedPrompt?: string;
  /** Dev mock only; production results are always read from filePath. */
  previewDataUrl?: string;
}

export function generateCreateImage(
  request: CreateImageGenerationRequest,
): Promise<CreateImageGenerationResult[]> {
  return invoke<CreateImageGenerationResult[]>("generate_create_image", { request });
}

export interface CreateVideoGenerationRequest {
  requestId: number;
  providerId: string;
  model: string;
  prompt: string;
  aspectRatio: "1:1" | "4:3" | "3:4" | "16:9" | "9:16" | "21:9";
  quality: "standard" | "high";
  durationSeconds: number;
  referencePath?: string;
  onEvent: (event: CreateVideoGenerationEvent) => void;
}

export interface CreateVideoGenerationResult {
  providerId: string;
  model: string;
  filePath: string;
  mimeType: string;
  durationSeconds: number;
}

export type CreateVideoGenerationEvent =
  | { type: "started"; providerId: string; model: string }
  | { type: "progress"; progress: number; status: string }
  | { type: "completed"; result: CreateVideoGenerationResult }
  | { type: "cancelled" }
  | { type: "error"; message: string };

export function generateCreateVideo(
  request: CreateVideoGenerationRequest,
): Promise<void> {
  const channel = new Channel<CreateVideoGenerationEvent>();
  channel.onmessage = request.onEvent;
  return invoke("generate_create_video", {
    requestId: request.requestId,
    request: {
      providerId: request.providerId,
      model: request.model,
      prompt: request.prompt,
      aspectRatio: request.aspectRatio,
      quality: request.quality,
      durationSeconds: request.durationSeconds,
      referencePath: request.referencePath ?? null,
    },
    onEvent: channel,
  });
}

export function cancelCreateGeneration(requestId: number): Promise<void> {
  return invoke("cancel_create_generation", { requestId });
}

export function exportCreateAsset(filePath: string): Promise<string | null> {
  return invoke<string | null>("export_create_asset", { filePath });
}

export function deleteCreateAssetFile(filePath: string): Promise<void> {
  return invoke("delete_create_asset", { filePath });
}

export function readCreateAssetDataUrl(filePath: string): Promise<string> {
  return invoke<string>("read_create_asset_data_url", { filePath });
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
  taskMode: TaskMode;
  contextAction?: "compact" | "inspect";
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
    taskMode: args.taskMode,
    contextAction: args.contextAction ?? null,
    onEvent: channel,
  });
}

export interface TietiezhiStreamArgs {
  requestId: number;
  deviceId: string;
  deviceName: string;
  messages: ChatMessage[];
  onEvent: (event: ChatEvent) => void;
}

export function tietiezhiStream(args: TietiezhiStreamArgs): Promise<void> {
  const channel = new Channel<ChatEvent>();
  channel.onmessage = args.onEvent;
  return invoke("tietiezhi_stream", {
    requestId: args.requestId,
    deviceId: args.deviceId,
    deviceName: args.deviceName,
    messages: args.messages,
    onEvent: channel,
  });
}

export function pickChatFiles(imagesOnly = false): Promise<ChatAttachment[]> {
  return invoke<ChatAttachment[]>("pick_chat_files", { imagesOnly });
}

export function pickChatFolder(): Promise<ChatAttachment[]> {
  return invoke<ChatAttachment[]>("pick_chat_folder");
}

export function inspectChatAssetPaths(paths: string[]): Promise<ChatAttachment[]> {
  return invoke<ChatAttachment[]>("inspect_chat_asset_paths", { paths });
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

// MARK: - Automations

export function listAutomations(includeArchived = false): Promise<AutomationMeta[]> {
  return invoke<AutomationMeta[]>("list_automations", { includeArchived });
}

export function loadAutomation(id: string): Promise<AutomationDocument> {
  return invoke<AutomationDocument>("load_automation", { id });
}

export function createAutomation(name?: string): Promise<AutomationDocument> {
  return invoke<AutomationDocument>("create_automation", {
    name: name?.trim() || null,
  });
}

export function saveAutomation(
  automation: AutomationDocument,
): Promise<AutomationDocument> {
  return invoke<AutomationDocument>("save_automation", { automation });
}

export function validateAutomation(
  automation: AutomationDocument,
  publish = false,
): Promise<AutomationValidationIssue[]> {
  return invoke<AutomationValidationIssue[]>("validate_automation", {
    automation,
    publish,
  });
}

export function archiveAutomation(
  id: string,
  archived = true,
): Promise<AutomationMeta> {
  return invoke<AutomationMeta>("archive_automation", { id, archived });
}

export function deleteAutomation(id: string): Promise<void> {
  return invoke("delete_automation", { id });
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

export function projectRecommendations(
  projectId: string,
  taskMode: TaskMode,
): Promise<ProjectRecommendations | null> {
  return invoke<ProjectRecommendations | null>("project_recommendations", {
    projectId: projectId || null,
    taskMode,
  });
}

export function refreshProjectRecommendations(
  projectId: string,
  taskMode: TaskMode,
  force = false,
): Promise<ProjectRecommendations | null> {
  return invoke<ProjectRecommendations | null>("refresh_project_recommendations", {
    projectId: projectId || null,
    taskMode,
    force,
  });
}

export function markProjectSuggestionUsed(
  projectId: string,
  taskMode: TaskMode,
  suggestionId: string,
): Promise<void> {
  return invoke("mark_project_suggestion_used", {
    projectId: projectId || null,
    taskMode,
    suggestionId,
  });
}

// MARK: - Tietiezhi devices

export function listDeviceCores(): Promise<DeviceCore[]> {
  return invoke<DeviceCore[]>("list_device_cores");
}

export function addDeviceCore(args: {
  name: string;
  baseUrl: string;
  accessToken?: string;
}): Promise<DeviceCore> {
  return invoke<DeviceCore>("add_device_core", {
    name: args.name,
    baseUrl: args.baseUrl,
    accessToken: args.accessToken?.trim() || null,
  });
}

export function removeDeviceCore(id: string): Promise<void> {
  return invoke("remove_device_core", { id });
}

export function probeDeviceCore(id: string): Promise<DeviceCore> {
  return invoke<DeviceCore>("probe_device_core", { id });
}

export function listConnectedDevices(): Promise<TietiezhiDevice[]> {
  return invoke<TietiezhiDevice[]>("list_connected_devices");
}

export function invokeDevice(args: {
  deviceId: string;
  capability: string;
  input?: Record<string, unknown>;
}): Promise<DeviceInvokeResult> {
  return invoke<DeviceInvokeResult>("invoke_device", {
    deviceId: args.deviceId,
    capability: args.capability,
    input: args.input ?? {},
  });
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
