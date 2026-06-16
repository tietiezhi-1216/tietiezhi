// Mirrors the Rust `config` module (serde JSON shapes).

export type ModelType = "asr" | "llm";
export type Transport = "http" | "realtime_ws" | "volcano_ws";

export type ProviderKind = "openai" | "volcano";

export interface Provider {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  /** OpenAI API key, or — for volcano — the Access Token. */
  api_key: string;
  /** Volcano AppID (X-Api-App-Key). */
  app_id: string;
  /** Volcano resource id (X-Api-Resource-Id). */
  resource_id: string;
}

export interface Model {
  id: string;
  provider_id: string;
  name: string;
  model: string;
  type: ModelType;
  transport: Transport;
  language?: string | null;
}

export interface PromptTemplate {
  id: string;
  name: string;
  template: string;
}

export interface Settings {
  providers: Provider[];
  models: Model[];
  templates: PromptTemplate[];
  hotkey: string;
  asr_model_id?: string | null;
  llm_model_id?: string | null;
  active_template_id?: string | null;
  llm_polish_enabled: boolean;
  auto_insert: boolean;
  insert_position: string;
}

/** Payload for the `dictation://state` event driving the recording pill. */
export interface DictState {
  status: string;
  text: string;
  level: number;
}
