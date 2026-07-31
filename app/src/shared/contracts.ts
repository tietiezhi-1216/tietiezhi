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

export interface ModelMetadata {
  defaultWireAPI?: ModelWireAPI;
  wireAPIs: ModelWireAPI[];
  reasoning?: boolean;
  supportedParameters: string[];
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
}

export type EngineKind = "native" | "cli";

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
  | "completed"
  | "failed"
  | "cancelled";

export interface UsageInfo {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
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
  runId?: string;
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
  count?: number;
}

export interface MediaArtifact {
  id: string;
  jobId: string;
  type: "image";
  filePath: string;
  mimeType: string;
  createdAt: number;
}

export interface MediaJob {
  id: string;
  type: "image";
  providerId: string;
  modelId: string;
  prompt: string;
  aspectRatio?: `${number}:${number}`;
  count: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  artifacts: MediaArtifact[];
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
    listFiles(conversationId: string): Promise<WorkspaceFile[]>;
    readFile(conversationId: string, path: string): Promise<string>;
  };
  approvals: {
    resolve(approvalId: string, approved: boolean): Promise<void>;
  };
  media: {
    list(): Promise<MediaJob[]>;
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
  onEngineEvent(listener: (event: EngineEvent) => void): () => void;
  onMediaEvent(listener: (event: MediaEvent) => void): () => void;
  onUpdateEvent(listener: (event: UpdateEvent) => void): () => void;
}
