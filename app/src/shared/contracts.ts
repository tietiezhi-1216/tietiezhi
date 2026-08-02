export const IPC = {
  invoke: "tietiezhi:invoke",
  engineEvent: "tietiezhi:engine-event",
  mediaEvent: "tietiezhi:media-event",
  updateEvent: "tietiezhi:update-event",
} as const;

export type ProviderType = "openai" | "anthropic" | "google" | "openai-compatible";
export type ModelWireAPI =
  | "responses"
  | "chat_completions"
  | "anthropic_messages"
  | "gemini_generate_content";

export type ModelModality = "text" | "image" | "audio" | "video" | "file";

export interface ModelMetadata {
  defaultWireAPI?: ModelWireAPI;
  wireAPIs: ModelWireAPI[];
  reasoning?: boolean;
  /** Reasoning effort levels the model accepts, e.g. ["low","medium","high"]. */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  inputModalities?: ModelModality[];
  toolCall?: boolean;
  streaming?: boolean;
  supportedParameters: string[];
}

export interface ProviderModelList {
  models: string[];
  modelMetadata: Record<string, ModelMetadata>;
}

export interface ProviderModelProbeInput {
  /** Saved provider id — lets the probe reuse the stored API key. */
  id?: string;
  providerType: ProviderType;
  baseURL?: string;
  apiKey?: string;
}

export interface ProviderAccount {
  id: string;
  providerType: ProviderType;
  displayName: string;
  baseURL: string;
  credentialRef: string;
  enabled: boolean;
  models: string[];
  modelMetadata: Record<string, ModelMetadata>;
  builtIn: boolean;
}

export interface ProviderAccountInput {
  id?: string;
  providerType: ProviderType;
  displayName: string;
  baseURL?: string;
  apiKey?: string;
  enabled?: boolean;
  models: string[];
  modelMetadata?: Record<string, ModelMetadata>;
}

export type EngineKind = "native" | "cli";
export type TaskMode = "work" | "code";

export interface EngineDescriptor {
  id: string;
  name: string;
  kind: EngineKind;
  version?: string;
  capabilities: {
    chat: boolean;
    tools: boolean;
    reasoning: boolean;
    attachments: boolean;
    images: boolean;
    video: boolean;
    sessionResume: boolean;
    workspaceAccess: boolean;
  };
}

export interface EngineDetectionResult {
  installed: boolean;
  executablePath?: string;
  version?: string;
  authenticated?: boolean;
  compatible?: boolean;
  warning?: string;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessageStatus =
  | "pending"
  | "streaming"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface UsageInfo {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

export type ApprovalDecision = "allow-once" | "allow-for-run" | "deny";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface ApprovalRecord {
  id: string;
  runId: string;
  conversationId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  description: string;
  input: unknown;
  risk: "medium" | "high";
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  decision?: ApprovalDecision;
  reason?: string;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; providerData?: Record<string, unknown> }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      status: "running" | "approval" | "completed" | "failed" | "denied";
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    }
  | {
      type: "diff";
      toolCallId: string;
      path: string;
      before: string;
      after: string;
      omitted?: boolean;
      bytes?: number;
    }
  | { type: "image"; artifactId: string; mimeType: string }
  | { type: "attachment"; name: string; path?: string; mimeType?: string }
  | { type: "error"; code: string; message: string };

export interface AppMessage {
  id: string;
  conversationId: string;
  parentMessageId?: string;
  role: MessageRole;
  createdAt: number;
  status: MessageStatus;
  parts: MessagePart[];
  engineId?: string;
  modelId?: string;
  providerAccountId?: string;
  runId?: string;
  firstTokenAt?: number;
  completedAt?: number;
  usage?: UsageInfo;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  activeEngineId: string;
  activeModelId?: string;
  providerAccountId?: string;
  workspace?: string;
  taskMode: TaskMode;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: AppMessage[];
}

export interface SendMessageInput {
  conversationId?: string;
  text: string;
  providerAccountId: string;
  model: string;
  engineId?: string;
  systemPrompt?: string;
  workspace?: string;
  taskMode?: TaskMode;
}

export type FinishReason = "stop" | "length" | "tool" | "cancelled" | "error";

interface EngineEventBase {
  schemaVersion: 1;
  type: string;
  runId: string;
  conversationId: string;
  createdAt: number;
}

export type EngineEvent =
  | (EngineEventBase & { type: "run.started"; messageId: string })
  | (EngineEventBase & {
      type: "run.retrying";
      messageId: string;
      attempt: number;
      maxRetries: number;
      delayMs: number;
      reason: string;
    })
  | (EngineEventBase & {
      type: "run.retry.started";
      messageId: string;
      attempt: number;
    })
  | (EngineEventBase & { type: "text.start"; messageId: string })
  | (EngineEventBase & { type: "text.delta"; messageId: string; delta: string })
  | (EngineEventBase & { type: "text.end"; messageId: string; text: string })
  | (EngineEventBase & { type: "reasoning.delta"; messageId: string; delta: string })
  | (EngineEventBase & {
      type: "tool.call";
      messageId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    })
  | (EngineEventBase & {
      type: "tool.approval_required";
      messageId: string;
      approvalId: string;
      toolCallId: string;
      toolName: string;
      description: string;
      input: unknown;
      risk: "medium" | "high";
      expiresAt: number;
    })
  | (EngineEventBase & {
      type: "tool.approval_resolved";
      messageId: string;
      approvalId: string;
      toolCallId: string;
      toolName: string;
      decision: ApprovalDecision;
      reason?: string;
    })
  | (EngineEventBase & {
      type: "tool.result";
      messageId: string;
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    })
  | (EngineEventBase & {
      type: "artifact.diff";
      messageId: string;
      toolCallId: string;
      path: string;
      before: string;
      after: string;
      omitted?: boolean;
      bytes?: number;
    })
  | (EngineEventBase & { type: "usage"; messageId: string; usage: UsageInfo })
  | (EngineEventBase & {
      type: "run.completed";
      messageId: string;
      finishReason: FinishReason;
    })
  | (EngineEventBase & {
      type: "run.failed";
      messageId: string;
      error: AppError;
    });

export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  detail?: string;
}

export interface WorkspaceInfo {
  path: string;
  name: string;
  temporary: boolean;
}

export interface WorkspaceFile {
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface WorkspaceToolDescriptor {
  id: string;
  name: string;
  description: string;
  category: "read" | "write" | "shell" | "skill";
  approvalRequired: boolean;
}

export interface SkillSummary {
  name: string;
  description: string;
  enabled: boolean;
}

export interface SkillDetail extends SkillSummary {
  body: string;
}

export interface SkillInput {
  name: string;
  description: string;
  body: string;
}

export interface AgentPreferences {
  systemPrompt: string;
}

export const DEFAULT_SYSTEM_PROMPT = `你是铁铁汁（Tietiezhi），一个运行在用户桌面上的智能体助手。

# 工作方式
- 回答默认使用简体中文，除非用户使用其它语言。
- 你可以调用本轮实际提供的工具来读写文件、搜索或执行操作；需要动手时直接调用可用工具。
- 工具的文件路径一律使用相对工作区的路径。
- 修改文件前先读取并确认原文，编辑时做精确替换。
- 执行有风险的命令前先向用户说明意图。
- 完成任务后简要总结做了什么；出错时如实报告错误内容。

# 输出
- 使用 Markdown。代码引用用代码块并标注语言。
- 保持简洁：直接给结论，再给必要的细节。`;

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

export interface ImageGenerationRequest {
  providerAccountId: string;
  model: string;
  prompt: string;
  aspectRatio?: `${number}:${number}`;
  resolution?: MediaResolution;
  quality?: "auto" | "low" | "medium" | "high";
  count?: number;
  references?: MediaReferenceInput[];
}

export type MediaResolution =
  | `${number}x${number}`
  | "512"
  | "1K"
  | "2K"
  | "4K";

export interface VideoGenerationRequest {
  providerAccountId: string;
  model: string;
  prompt: string;
  aspectRatio?: `${number}:${number}`;
  resolution?: MediaResolution;
  duration?: number;
  count?: number;
  references?: MediaReferenceInput[];
}

export type MediaType = "image" | "video";
export type MediaReferenceRole = "reference" | "first-frame" | "last-frame";

export interface MediaReferenceInput {
  assetId: string;
  role: MediaReferenceRole;
}

export interface LocalMediaAsset {
  id: string;
  name: string;
  type: MediaType;
  source: "imported" | "generated";
  filePath: string;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
  createdAt: number;
  originJobId?: string;
}

export interface MediaJobReference extends MediaReferenceInput {
  order: number;
  asset: LocalMediaAsset;
}

export interface MediaArtifact {
  id: string;
  jobId: string;
  type: MediaType;
  filePath: string;
  mimeType: string;
  createdAt: number;
}

export interface MediaJob {
  id: string;
  type: MediaType;
  providerId: string;
  modelId: string;
  prompt: string;
  aspectRatio?: `${number}:${number}`;
  resolution?: MediaResolution;
  quality?: "auto" | "low" | "medium" | "high";
  duration?: number;
  count: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  artifacts: MediaArtifact[];
  references: MediaJobReference[];
  error?: AppError;
}

export type MediaEvent =
  | {
      schemaVersion: 1;
      type: "media.job.updated";
      job: MediaJob;
    }
  | {
      schemaVersion: 1;
      type: "media.job.removed";
      jobId: string;
    };

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export interface UpdateState {
  currentVersion: string;
  platform: string;
  architecture: string;
  supported: boolean;
  status: UpdateStatus;
  availableVersion?: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  checkedAt?: number;
  error?: string;
}

export interface UpdateEvent {
  schemaVersion: 1;
  type: "app.update.state";
  state: UpdateState;
}

export interface DesktopAPI {
  engines: {
    list(): Promise<EngineDescriptor[]>;
  };
  providers: {
    list(): Promise<ProviderAccount[]>;
    save(input: ProviderAccountInput): Promise<ProviderAccount>;
    remove(id: string): Promise<void>;
    refreshModels(id: string): Promise<ProviderAccount>;
    fetchModels(input: ProviderModelProbeInput): Promise<ProviderModelList>;
  };
  gateway: {
    account(): Promise<GatewayAccountView>;
    login(): Promise<GatewayAccountView>;
    logout(): Promise<void>;
  };
  conversations: {
    list(): Promise<Conversation[]>;
    load(id: string): Promise<ConversationDetail>;
    send(input: SendMessageInput): Promise<{ conversationId: string; runId: string }>;
    cancel(runId: string): Promise<void>;
    remove(id: string): Promise<void>;
    rename(id: string, title: string): Promise<void>;
  };
  workspace: {
    createTemporary(): Promise<WorkspaceInfo>;
    choose(): Promise<WorkspaceInfo | null>;
    reveal(path: string): Promise<void>;
    listFiles(conversationId: string): Promise<WorkspaceFile[]>;
    readFile(conversationId: string, path: string): Promise<string>;
  };
  tools: {
    list(): Promise<WorkspaceToolDescriptor[]>;
  };
  skills: {
    list(): Promise<SkillSummary[]>;
    read(name: string): Promise<SkillDetail>;
    save(input: SkillInput): Promise<SkillDetail>;
    remove(name: string): Promise<void>;
    setEnabled(name: string, enabled: boolean): Promise<void>;
    import(): Promise<SkillDetail | null>;
  };
  preferences: {
    get(): Promise<AgentPreferences>;
    save(input: AgentPreferences): Promise<AgentPreferences>;
  };
  approvals: {
    list(conversationId?: string): Promise<ApprovalRecord[]>;
    resolve(approvalId: string, decision: ApprovalDecision): Promise<void>;
  };
  media: {
    list(): Promise<MediaJob[]>;
    listAssets(): Promise<LocalMediaAsset[]>;
    importAssets(): Promise<LocalMediaAsset[]>;
    removeAsset(id: string): Promise<void>;
    generateImage(input: ImageGenerationRequest): Promise<MediaJob>;
    cancel(id: string): Promise<void>;
    retry(id: string): Promise<MediaJob>;
    remove(id: string): Promise<void>;
    saveArtifact(path: string): Promise<boolean>;
    assetURL(path: string): string;
    thumbnailURL(path: string): string;
  };
  updates: {
    state(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    download(): Promise<UpdateState>;
    install(): Promise<void>;
  };
  appWindow: {
    setMode(mode: "setup" | "normal"): Promise<void>;
  };
  onEngineEvent(listener: (event: EngineEvent) => void): () => void;
  onMediaEvent(listener: (event: MediaEvent) => void): () => void;
  onUpdateEvent(listener: (event: UpdateEvent) => void): () => void;
}
