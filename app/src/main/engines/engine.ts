import type {
  AppMessage,
  EngineDescriptor,
  EngineDetectionResult,
  EngineEvent,
  ProviderAccount,
} from "@shared/contracts";

export interface EngineRunOptions {
  runId: string;
  conversationId: string;
  messageId: string;
  provider: ProviderAccount;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  workspace: string;
  messages: AppMessage[];
  abortSignal: AbortSignal;
}

export interface AIEngine {
  descriptor(): Promise<EngineDescriptor>;
  detect(): Promise<EngineDetectionResult>;
  run(options: EngineRunOptions): AsyncIterable<EngineEvent>;
  cancel(runId: string): Promise<void>;
  dispose(): Promise<void>;
}
