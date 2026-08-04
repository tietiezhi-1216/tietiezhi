export type WorkspaceKind = "project" | "temporary";

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

export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
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
}

export const IPC = {
  invoke: "tietiezhi:invoke",
} as const;
