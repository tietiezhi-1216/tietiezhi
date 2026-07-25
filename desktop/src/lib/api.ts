import { Channel, invoke } from "@tauri-apps/api/core";
import {
  createChatEventNormalizer,
  type ChatEvent,
  type LegacyChatEvent,
} from "@/lib/chat-events";
import type { TaskMode } from "@/lib/task-mode";
import type { ClientRequest as CodexClientRequest } from "../../../shared/codex/v2/typescript/ClientRequest";
import type { RequestId as CodexRequestId } from "../../../shared/codex/v2/typescript/RequestId";
import type { ServerNotification as CodexServerNotification } from "../../../shared/codex/v2/typescript/ServerNotification";
import type { ServerRequest as CodexServerRequest } from "../../../shared/codex/v2/typescript/ServerRequest";
import type { AppsInstalledResponse } from "../../../shared/codex/v2/typescript/v2/AppsInstalledResponse";
import type { AppsListResponse } from "../../../shared/codex/v2/typescript/v2/AppsListResponse";
import type { AppsReadResponse } from "../../../shared/codex/v2/typescript/v2/AppsReadResponse";

export type { ChatEvent } from "@/lib/chat-events";

export type CodexV2Notification = CodexServerNotification & {
  recipients: string[];
};

export type CodexV2ServerRequest = CodexServerRequest & {
  recipients: string[];
};

export const CODEX_V2_SERVER_REQUEST_EVENT = "codex-v2-server-request";
export const CODEX_V2_NOTIFICATION_EVENT = "codex-v2-notification";

export interface CodexV2Response {
  id: CodexRequestId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface CodexV2DispatchOutput {
  response: CodexV2Response;
  notifications: CodexV2Notification[];
}

export async function codexV2Request(
  connectionId: string,
  request: CodexClientRequest,
): Promise<CodexV2DispatchOutput> {
  return invoke<CodexV2DispatchOutput>("codex_v2_request", {
    connectionId,
    request,
  });
}

export async function codexV2ServerResponse(response: CodexV2Response): Promise<boolean> {
  return invoke<boolean>("codex_v2_server_response", { response });
}

let codexExperimentalRequestId = 0;

export async function codexExperimentalRequest<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  codexExperimentalRequestId += 1;
  const output = await codexV2Request("desktop", {
    id: `experimental-${codexExperimentalRequestId}`,
    method,
    params,
  } as CodexClientRequest);
  if (output.response.error) {
    throw new Error(output.response.error.message);
  }
  return output.response.result as T;
}

export type CodexDoctorStatus = "ok" | "warning" | "fail";

export interface CodexDoctorIssue {
  severity: CodexDoctorStatus;
  cause: string;
  measured: string | null;
  expected: string | null;
  remedy: string | null;
  fields: string[];
}

export interface CodexDoctorCheck {
  id: string;
  category: string;
  status: CodexDoctorStatus;
  summary: string;
  details: string[];
  issues: CodexDoctorIssue[];
  remediation: string | null;
  durationMs: number;
}

export interface CodexDoctorReport {
  schemaVersion: number;
  generatedAtMs: number;
  overallStatus: CodexDoctorStatus;
  serviceVersion: string;
  checks: CodexDoctorCheck[];
}

export interface CodexHistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface CodexMetricsSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, CodexHistogramSnapshot>;
}

export function codexDoctorReport(): Promise<CodexDoctorReport> {
  return invoke<CodexDoctorReport>("codex_doctor_report");
}

export function codexRuntimeMetrics(): Promise<CodexMetricsSnapshot> {
  return invoke<CodexMetricsSnapshot>("codex_runtime_metrics");
}

export function codexExportTelemetry(): Promise<boolean> {
  return invoke<boolean>("codex_export_telemetry");
}

export function codexRequestAttestation(threadId: string): Promise<string> {
  return invoke<string>("codex_request_attestation", { threadId });
}

export type RemoteControlConnectionStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "errored";

export interface RemoteControlStatus {
  status: RemoteControlConnectionStatus;
  serverName: string;
  installationId: string;
  environmentId: string | null;
}

export interface RemoteControlPairing {
  pairingCode: string;
  manualPairingCode: string | null;
  environmentId: string;
  expiresAt: number;
}

export interface RemoteControlClient {
  clientId: string;
  displayName: string | null;
  deviceType: string | null;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  appVersion: string | null;
  lastSeenAt: number | null;
}

export function readRemoteControlStatus(): Promise<RemoteControlStatus> {
  return codexExperimentalRequest("remoteControl/status/read");
}

export function setRemoteControlEnabled(
  enabled: boolean,
): Promise<RemoteControlStatus> {
  return codexExperimentalRequest(
    enabled ? "remoteControl/enable" : "remoteControl/disable",
    { ephemeral: false },
  );
}

export function startRemoteControlPairing(): Promise<RemoteControlPairing> {
  return codexExperimentalRequest("remoteControl/pairing/start", {
    manualCode: true,
  });
}

export function listRemoteControlClients(
  environmentId: string,
): Promise<{ data: RemoteControlClient[]; nextCursor: string | null }> {
  return codexExperimentalRequest("remoteControl/clients/list", {
    environmentId,
    cursor: null,
    limit: 100,
    order: "desc",
  });
}

export function revokeRemoteControlClient(
  environmentId: string,
  clientId: string,
): Promise<void> {
  return codexExperimentalRequest("remoteControl/clients/revoke", {
    environmentId,
    clientId,
  });
}

export function grantRemoteThread(clientId: string, threadId: string): Promise<string[]> {
  return invoke<string[]>("codex_remote_grant_thread", { clientId, threadId });
}

export function revokeRemoteThread(clientId: string, threadId: string): Promise<string[]> {
  return invoke<string[]>("codex_remote_revoke_thread", { clientId, threadId });
}

export function remoteThreadGrants(clientId: string): Promise<string[]> {
  return invoke<string[]>("codex_remote_thread_grants", { clientId });
}

export interface RealtimeAudioChunk {
  data: string;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel: number | null;
  itemId: string | null;
}

export function startThreadRealtime(
  threadId: string,
  outputModality: "text" | "audio" = "audio",
): Promise<void> {
  return codexExperimentalRequest("thread/realtime/start", {
    threadId,
    outputModality,
    includeStartupContext: true,
    transport: { type: "websocket" },
    version: "v2",
    voice: "marin",
  });
}

export function appendThreadRealtimeAudio(
  threadId: string,
  audio: RealtimeAudioChunk,
): Promise<void> {
  return codexExperimentalRequest("thread/realtime/appendAudio", {
    threadId,
    audio,
  });
}

export function appendThreadRealtimeText(
  threadId: string,
  text: string,
  role: "user" | "developer" | "assistant" = "user",
): Promise<void> {
  return codexExperimentalRequest("thread/realtime/appendText", {
    threadId,
    text,
    role,
  });
}

export function stopThreadRealtime(threadId: string): Promise<void> {
  return codexExperimentalRequest("thread/realtime/stop", { threadId });
}

let codexAppsRequestId = 0;

async function codexAppsRequest<T>(
  method: "app/list" | "app/read" | "app/installed",
  params: Record<string, unknown>,
): Promise<T> {
  codexAppsRequestId += 1;
  const output = await codexV2Request("desktop", {
    id: `apps-${codexAppsRequestId}`,
    method,
    params,
  } as CodexClientRequest);
  if (output.response.error) {
    throw new Error(output.response.error.message);
  }
  return output.response.result as T;
}

export function listCodexApps(
  threadId?: string,
  forceRefetch = false,
): Promise<AppsListResponse> {
  return codexAppsRequest("app/list", {
    threadId: threadId ?? null,
    cursor: null,
    limit: 100,
    forceRefetch,
  });
}

export function readCodexApps(
  appIds: string[],
  includeTools = true,
): Promise<AppsReadResponse> {
  return codexAppsRequest("app/read", { appIds, includeTools });
}

export function installedCodexApps(
  threadId?: string,
  forceRefresh = false,
): Promise<AppsInstalledResponse> {
  return codexAppsRequest("app/installed", {
    threadId: threadId ?? null,
    forceRefresh,
  });
}

export type ProviderType = "openai" | "mimo";
export type WireApi = "auto" | "responses" | "chatCompletions";

/** What a model can be used for. Rust merges provider metadata with local fallbacks. */
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
  wireApi: WireApi;
  builtIn: boolean;
  models: ModelInfo[];
}

export interface ProviderView extends Provider {
  hasKey: boolean;
}

export interface GatewayAccount {
  userId: number;
  email: string;
  nickname: string;
  avatar: string;
}

export interface GatewayAccountView {
  providerId: string;
  supported: boolean;
  loggedIn: boolean;
  account?: GatewayAccount;
  expires?: number;
}

export interface GatewayWallet {
  balanceMicro: number;
  frozenMicro: number;
  totalTopupMicro: number;
  totalSpendMicro: number;
}

export interface GatewayOwnedPackage {
  id: number;
  name: string;
  status: string;
  meterBy: string;
  quotaPerWindow: number;
  totalQuotaCap: number;
  totalUsed: number;
  windowRemaining: number;
  validUntil?: string;
}

export interface GatewayConsumption {
  requestId: string;
  publicModel: string;
  amountMicro: number;
  userPackageId: number;
  cardMeasure: number;
  createdAt: string;
}

export interface GatewayPaymentChannels {
  alipay: boolean;
  wechat: boolean;
}

export interface GatewayQuotaView {
  wallet: GatewayWallet;
  packages: GatewayOwnedPackage[];
  recentConsumption: GatewayConsumption[];
  paymentChannels: GatewayPaymentChannels;
}

export interface GatewayCatalogPackage {
  id: number;
  name: string;
  description: string;
  meterBy: string;
  quotaPerWindow: number;
  validDays: number;
  maxPurchasesPerUser: number;
  priceMicro: number;
}

export interface GatewayPackageCatalog {
  items: GatewayCatalogPackage[];
  paymentChannels: GatewayPaymentChannels;
}

export interface GatewayPackageOrder {
  orderNo: string;
  packageId: number;
  packageName: string;
  provider: "alipay" | "wechat";
  payAmountMicro: number;
  payAmountCny: string;
  paymentUrl: string;
  status: number;
}

export interface GatewayOrderStatus {
  orderNo: string;
  packageId: number;
  provider: "alipay" | "wechat";
  payAmountMicro: number;
  status: number;
  paidAt?: string;
  promotionStatus?: string;
  promotionMessage?: string;
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
  projectRoot?: string | null;
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
  publishedRevision: number;
  paused: boolean;
  lastRunAt: number;
  nextRunAt: number;
  lastRunStatus: string;
}

export type AutomationRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AutomationRun {
  id: string;
  automationId: string;
  revision: number;
  trigger: string;
  status: AutomationRunStatus;
  input: JsonValue;
  threadId: string;
  turnId: string;
  workspacePath: string;
  startedAt: number;
  finishedAt: number;
  output?: string | null;
  error?: string | null;
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

export interface TietiezhiConfig {
  version: number;
  systemPrompt: string;
  /** Exact skill names assigned to Tietiezhi; empty means none. */
  skills: string[];
  /** Exact MCP server ids assigned to Tietiezhi; empty means none. */
  mcpServers: string[];
  /** Explicit safe builtin-tool allowlist; never interpreted as all tools. */
  tools: string[];
  permissionMode: PermissionMode;
  memoryEnabled: boolean;
}

export interface TietiezhiTimelineMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  attachments?: ChatAttachment[];
}

export interface TietiezhiFileEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  protected: boolean;
}

export interface TietiezhiHomeOverview {
  path: string;
  fileCount: number;
  memoryFileCount: number;
  totalSize: number;
  timelineCount: number;
}

export interface TietiezhiSecret {
  name: string;
  label: string;
  description: string;
  updatedAt: number;
  hasValue: boolean;
  reference: string;
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
  threadId?: string;
  turnId?: string;
  itemId?: string;
  reasoningItemId?: string;
  toolName?: string;
  toolCallId?: string;
  permissionRequestId?: string;
  toolArgs?: unknown;
  toolOutput?: string;
  toolStatus?: "running" | "success" | "error" | "cancelled";
  toolDurationMs?: number;
  toolExitCode?: number;
  toolTimedOut?: boolean;
  toolTruncated?: boolean;
  decision?: PermissionDecision | LegacyPermissionDecision;
  permissionScope?: string;
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
  contextDuringTurn?: boolean;
  contextTokensBefore?: number;
  contextTokensAfter?: number;
  contextWindow?: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt?: number;
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
  createdAt?: number;
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

export type ExecutionEnvironment = "local" | "worktree";

export interface WorkspaceSnapshot {
  id: string;
  label: string;
  reference: string;
  commit: string;
  createdAtMs: number;
}

export interface WorkspaceHandoff {
  branch: string;
  commit: string;
  snapshotId: string;
  createdAtMs: number;
}

export interface WorkspaceGitChange {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  stagedDiff: string;
  unstagedDiff: string;
  truncated: boolean;
}

export interface WorkspaceGitDiff {
  head: string | null;
  branch: string | null;
  detached: boolean;
  remotes: string[];
  changes: WorkspaceGitChange[];
}

export interface WorkspaceGitCommit {
  commit: string;
  summary: string;
}

export interface TaskWorkspaceOverview {
  work: TaskWorkspaceModeStatus;
  code: TaskWorkspaceModeStatus;
  environment: ExecutionEnvironment;
  initialized: boolean;
  rootPath: string;
  projectRoot: string | null;
  head: string | null;
  branch: string | null;
  detached: boolean;
  snapshots: WorkspaceSnapshot[];
  handoffs: WorkspaceHandoff[];
}

export function taskWorkspaceOverview(taskId: string): Promise<TaskWorkspaceOverview> {
  return invoke<TaskWorkspaceOverview>("task_workspace_overview", { taskId });
}

export function setTaskWorkspaceEnvironment(args: {
  taskId: string;
  environment: ExecutionEnvironment;
}): Promise<TaskWorkspaceOverview> {
  return invoke<TaskWorkspaceOverview>("set_task_workspace_environment", args);
}

export function createTaskWorkspaceSnapshot(args: {
  taskId: string;
  label: string;
}): Promise<WorkspaceSnapshot> {
  return invoke<WorkspaceSnapshot>("create_task_workspace_snapshot", args);
}

export function restoreTaskWorkspaceSnapshot(args: {
  taskId: string;
  snapshotId: string;
}): Promise<TaskWorkspaceOverview> {
  return invoke<TaskWorkspaceOverview>("restore_task_workspace_snapshot", args);
}

export function handoffTaskWorkspace(args: {
  taskId: string;
  branch?: string;
  label: string;
}): Promise<WorkspaceHandoff> {
  return invoke<WorkspaceHandoff>("handoff_task_workspace", args);
}

export function taskWorkspaceGitDiff(taskId: string): Promise<WorkspaceGitDiff> {
  return invoke<WorkspaceGitDiff>("task_workspace_git_diff", { taskId });
}

export function stageTaskWorkspacePaths(args: {
  taskId: string;
  paths: string[];
}): Promise<WorkspaceGitDiff> {
  return invoke<WorkspaceGitDiff>("stage_task_workspace_paths", args);
}

export function unstageTaskWorkspacePaths(args: {
  taskId: string;
  paths: string[];
}): Promise<WorkspaceGitDiff> {
  return invoke<WorkspaceGitDiff>("unstage_task_workspace_paths", args);
}

export function discardTaskWorkspacePaths(args: {
  taskId: string;
  paths: string[];
}): Promise<WorkspaceGitDiff> {
  return invoke<WorkspaceGitDiff>("discard_task_workspace_paths", args);
}

export function commitTaskWorkspace(args: {
  taskId: string;
  message: string;
}): Promise<WorkspaceGitCommit> {
  return invoke<WorkspaceGitCommit>("commit_task_workspace", args);
}

export function pushTaskWorkspace(args: {
  taskId: string;
  remote: string;
  branch: string;
}): Promise<WorkspaceGitDiff> {
  return invoke<WorkspaceGitDiff>("push_task_workspace", args);
}

export function taskWorkspacePullRequestUrl(args: {
  taskId: string;
  remote: string;
  branch: string;
}): Promise<string> {
  return invoke<string>("task_workspace_pull_request_url", args);
}

/** @deprecated Work and Code now share one Local/Worktree environment. */
export function transferTaskWorkspaceFile(args: {
  taskId: string;
  fromMode: TaskMode;
  toMode: TaskMode;
  path: string;
}): Promise<string> {
  return invoke<string>("transfer_task_workspace_file", args);
}

export interface TerminalSession {
  id: string;
  taskId: string;
  title: string;
  cwd: string;
  createdAtMs: number;
  running: boolean;
  exitCode: number | null;
}

export interface TerminalOutputChunk {
  cursor: number;
  stream: "stdout" | "stderr";
  data: string;
  capReached: boolean;
}

export interface TerminalReadResult {
  chunks: TerminalOutputChunk[];
  nextCursor: number;
  running: boolean;
  exitCode: number | null;
  timedOut: boolean;
}

export function terminalList(taskId: string): Promise<TerminalSession[]> {
  return invoke<TerminalSession[]>("terminal_list", { taskId });
}

export function terminalStart(args: {
  taskId: string;
  rows?: number;
  cols?: number;
}): Promise<TerminalSession> {
  return invoke<TerminalSession>("terminal_start", args);
}

export function terminalRead(args: {
  taskId: string;
  sessionId: string;
  cursor: number;
  waitMs?: number;
}): Promise<TerminalReadResult> {
  return invoke<TerminalReadResult>("terminal_read", args);
}

export function terminalWrite(args: {
  taskId: string;
  sessionId: string;
  data: string;
}): Promise<void> {
  return invoke("terminal_write", args);
}

export function terminalResize(args: {
  taskId: string;
  sessionId: string;
  rows: number;
  cols: number;
}): Promise<void> {
  return invoke("terminal_resize", args);
}

export function terminalTerminate(args: {
  taskId: string;
  sessionId: string;
}): Promise<void> {
  return invoke("terminal_terminate", args);
}

export function terminalClose(args: {
  taskId: string;
  sessionId: string;
}): Promise<void> {
  return invoke("terminal_close", args);
}

export interface SaveConversationResult {
  updatedAt: number;
  title: string;
}

export type PermissionDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type LegacyPermissionDecision = "allow" | "allowAlways" | "deny";

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

export function gatewayAccount(providerId: string): Promise<GatewayAccountView> {
  return invoke<GatewayAccountView>("gateway_account", { providerId });
}

export function gatewayLogin(providerId: string): Promise<GatewayAccountView> {
  return invoke<GatewayAccountView>("gateway_login", { providerId });
}

export function gatewayLogout(providerId: string): Promise<void> {
  return invoke("gateway_logout", { providerId });
}

export function gatewayQuota(providerId: string): Promise<GatewayQuotaView> {
  return invoke<GatewayQuotaView>("gateway_quota", { providerId });
}

export function gatewayPackageCatalog(providerId: string): Promise<GatewayPackageCatalog> {
  return invoke<GatewayPackageCatalog>("gateway_package_catalog", { providerId });
}

export function gatewayCreatePackageOrder(
  providerId: string,
  packageId: number,
  paymentProvider: "alipay" | "wechat",
): Promise<GatewayPackageOrder> {
  return invoke<GatewayPackageOrder>("gateway_create_package_order", {
    providerId,
    packageId,
    paymentProvider,
  });
}

export function gatewayPackageOrderStatus(
  providerId: string,
  orderNo: string,
): Promise<GatewayOrderStatus> {
  return invoke<GatewayOrderStatus>("gateway_package_order_status", {
    providerId,
    orderNo,
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
  const channel = new Channel<ChatEvent | LegacyChatEvent>();
  const threadId = args.conversationId?.trim()
    ? args.conversationId
    : `chat_${args.requestId}`;
  const normalize = createChatEventNormalizer(
    threadId,
    args.requestId,
  );
  channel.onmessage = (event) => args.onEvent(normalize(event));
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
  const channel = new Channel<ChatEvent | LegacyChatEvent>();
  const normalize = createChatEventNormalizer(
    "tietiezhi_main",
    args.requestId,
  );
  channel.onmessage = (event) => args.onEvent(normalize(event));
  return invoke("tietiezhi_stream", {
    requestId: args.requestId,
    deviceId: args.deviceId,
    deviceName: args.deviceName,
    messages: args.messages,
    onEvent: channel,
  });
}

export function getTietiezhiConfig(): Promise<TietiezhiConfig> {
  return invoke<TietiezhiConfig>("get_tietiezhi_config");
}

export function saveTietiezhiConfig(
  config: TietiezhiConfig,
): Promise<TietiezhiConfig> {
  return invoke<TietiezhiConfig>("save_tietiezhi_config", { config });
}

export function listTietiezhiFiles(): Promise<TietiezhiFileEntry[]> {
  return invoke<TietiezhiFileEntry[]>("list_tietiezhi_files");
}

export function listTietiezhiSecrets(): Promise<TietiezhiSecret[]> {
  return invoke<TietiezhiSecret[]>("list_tietiezhi_secrets");
}

export function upsertTietiezhiSecret(
  name: string,
  label: string,
  description: string,
  value?: string,
): Promise<TietiezhiSecret> {
  return invoke<TietiezhiSecret>("upsert_tietiezhi_secret", {
    name,
    label,
    description,
    value: value ?? null,
  });
}

export function revealTietiezhiSecret(name: string): Promise<string> {
  return invoke<string>("reveal_tietiezhi_secret", { name });
}

export function deleteTietiezhiSecret(name: string): Promise<void> {
  return invoke("delete_tietiezhi_secret", { name });
}

export function readTietiezhiFile(path: string): Promise<string> {
  return invoke<string>("read_tietiezhi_file", { path });
}

export function writeTietiezhiFile(path: string, content: string): Promise<void> {
  return invoke("write_tietiezhi_file", { path, content });
}

export function deleteTietiezhiFile(path: string): Promise<void> {
  return invoke("delete_tietiezhi_file", { path });
}

export function getTietiezhiHomeOverview(): Promise<TietiezhiHomeOverview> {
  return invoke<TietiezhiHomeOverview>("tietiezhi_home_overview");
}

export function revealTietiezhiHome(): Promise<void> {
  return invoke("reveal_tietiezhi_home");
}

export function loadTietiezhiTimeline(): Promise<TietiezhiTimelineMessage[]> {
  return invoke<TietiezhiTimelineMessage[]>("load_tietiezhi_timeline");
}

export function saveTietiezhiTimeline(
  messages: TietiezhiTimelineMessage[],
): Promise<void> {
  return invoke("save_tietiezhi_timeline", { messages });
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

export function publishAutomation(id: string): Promise<AutomationMeta> {
  return invoke<AutomationMeta>("publish_automation", { id });
}

export function pauseAutomation(
  id: string,
  paused: boolean,
): Promise<AutomationMeta> {
  return invoke<AutomationMeta>("pause_automation", { id, paused });
}

export function runAutomation(
  id: string,
  input: JsonValue = {},
): Promise<AutomationRun> {
  return invoke<AutomationRun>("run_automation", { id, input });
}

export function listAutomationRuns(
  automationId?: string,
  limit = 100,
): Promise<AutomationRun[]> {
  return invoke<AutomationRun[]>("list_automation_runs", {
    automationId: automationId || null,
    limit,
  });
}

export function cancelAutomationRun(
  automationId: string,
  runId: string,
): Promise<AutomationRun> {
  return invoke<AutomationRun>("cancel_automation_run", {
    automationId,
    runId,
  });
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
  requestId: number;
  providerId: string;
  model: string;
  wavBase64: string;
  /** auto | zh | en (MiMo) */
  language: string;
}

export function transcribe(args: TranscribeArgs): Promise<string> {
  return invoke<string>("transcribe", {
    requestId: args.requestId,
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
  const channel = new Channel<ChatEvent | LegacyChatEvent>();
  const normalize = createChatEventNormalizer(
    `polish_${args.requestId}`,
    args.requestId,
  );
  channel.onmessage = (event) => args.onEvent(normalize(event));
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

export function accessibilityTrusted(prompt = false): Promise<boolean> {
  return invoke<boolean>("accessibility_trusted", { prompt });
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
