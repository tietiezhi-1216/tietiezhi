export type WorkspaceKind = "project" | "temporary";

export type AgentAvailability = "idle" | "working" | "offline";

/** A persistent digital employee owned by the user. */
export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  description: string;
  avatar?: string;
  modelId?: string;
  availability: AgentAvailability;
  isBuiltIn: boolean;
  presetId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Read-only template used to create an AgentDefinition. */
export interface AgentPreset {
  id: string;
  name: string;
  role: string;
  description: string;
  avatar?: string;
  defaultModelId?: string;
}

export interface CreateAgentInput {
  presetId?: string;
  name: string;
  role: string;
  description?: string;
  avatar?: string;
  modelId?: string;
  systemPrompt?: string;
}

export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  agentIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentGroupInput {
  name: string;
  description?: string;
  agentIds: string[];
}

export interface Workspace {
  id: string;
  kind: WorkspaceKind;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessageStatus = "completed" | "streaming" | "failed" | "cancelled";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "attachment"; name: string; path: string; mimeType?: string }
  | { type: "error"; code: string; message: string };

export interface Message {
  id: string;
  conversationId: string;
  parentMessageId?: string;
  role: MessageRole;
  status: MessageStatus;
  parts: MessagePart[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentStartInput {
  conversationId: string;
  workspaceId: string;
  agentId?: string;
  groupId?: string;
}

export interface AgentPromptInput {
  conversationId: string;
  text: string;
}

export interface AgentSessionInfo {
  conversationId: string;
  agentId?: string;
  sessionId: string;
  modelId: string;
}

export type AgentEvent =
  | ({ type: "session_started" } & AgentSessionInfo)
  | {
      type: "assistant_text_delta";
      conversationId: string;
      delta: string;
    }
  | {
      type: "assistant_completed";
      conversationId: string;
      text: string;
    }
  | {
      type: "session_error";
      conversationId: string;
      message: string;
    }
  | {
      type: "session_stopped";
      conversationId: string;
    };

export interface Conversation {
  id: string;
  workspaceId: string;
  agentId?: string;
  groupId?: string;
  title: string;
  messageCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationDetail {
  conversation: Conversation;
  workspace: Workspace;
  messages: Message[];
}

export interface CreateConversationInput {
  workspaceId: string;
  agentId?: string;
  groupId?: string;
  title?: string;
}

export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  parts: MessagePart[];
  parentMessageId?: string;
}

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  hidden: boolean;
}

export interface AuthStatus {
  authenticated: boolean;
  mode?: "login" | "api_key";
  profile?: {
    displayName: string;
    email?: string;
    avatar?: string;
  };
  account?: {
    user_id: number;
    email: string;
    nickname: string;
    avatar: string;
  };
}

export interface DesktopAPI {
  app: {
    setWindowMode(mode: "setup" | "normal"): Promise<void>;
  };
  auth: {
    status(): Promise<AuthStatus>;
    openLogin(): Promise<AuthStatus>;
    cancelLogin(): Promise<void>;
    loginWithAPIKey(apiKey: string): Promise<AuthStatus>;
    openRegistration(): Promise<void>;
    logout(): Promise<void>;
    setAvatar(avatar: string | null): Promise<AuthStatus>;
  };
  workspaces: {
    list(): Promise<Workspace[]>;
    chooseProject(): Promise<Workspace | null>;
    createTemporary(): Promise<Workspace>;
    reveal(id: string): Promise<void>;
    listDirectory(id: string, path?: string): Promise<WorkspaceDirectoryEntry[]>;
    readTextFile(id: string, path: string): Promise<string>;
  };
  conversations: {
    list(workspaceId?: string): Promise<Conversation[]>;
    create(input: CreateConversationInput): Promise<ConversationDetail>;
    load(id: string): Promise<ConversationDetail>;
    appendMessage(input: AppendMessageInput): Promise<Message>;
    rename(id: string, title: string): Promise<Conversation>;
    remove(id: string): Promise<void>;
  };
  agentProfiles: {
    list(): Promise<AgentDefinition[]>;
    presets(): Promise<AgentPreset[]>;
    create(input: CreateAgentInput): Promise<AgentDefinition>;
  };
  agentGroups: {
    list(): Promise<AgentGroup[]>;
    create(input: CreateAgentGroupInput): Promise<AgentGroup>;
    remove(id: string): Promise<void>;
  };
  agents: {
    start(input: AgentStartInput): Promise<AgentSessionInfo>;
    prompt(input: AgentPromptInput): Promise<void>;
    abort(conversationId: string): Promise<void>;
    stop(conversationId: string): Promise<void>;
    onEvent(listener: (event: AgentEvent) => void): () => void;
  };
}

export const IPC = {
  invoke: "tietiezhi:invoke",
  agentEvent: "tietiezhi:agent-event",
} as const;
