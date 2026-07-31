import type {
  AppMessage,
  EngineDescriptor,
  EngineDetectionResult,
  EngineEvent,
  ProviderAccount,
  SkillDetail,
} from "@shared/contracts";

export interface EngineRunOptions {
  runId: string;
  conversationId: string;
  messageId: string;
  provider: ProviderAccount;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  skills: SkillDetail[];
  workspace: string;
  messages: AppMessage[];
  abortSignal: AbortSignal;
}

export interface EngineTitleOptions {
  provider: ProviderAccount;
  apiKey: string;
  model: string;
  prompt: string;
  abortSignal: AbortSignal;
}

export interface AIEngine {
  descriptor(): Promise<EngineDescriptor>;
  detect(): Promise<EngineDetectionResult>;
  generateTitle(options: EngineTitleOptions): Promise<string | undefined>;
  run(options: EngineRunOptions): AsyncIterable<EngineEvent>;
  cancel(runId: string): Promise<void>;
  dispose(): Promise<void>;
}
