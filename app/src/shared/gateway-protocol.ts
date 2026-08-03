export const GATEWAY_SCHEMA_VERSION = "tietiezhi.gateway.v1" as const;

export type GatewayAuthMode = "login" | "api_key";
export type GatewayModality = "text" | "image" | "audio" | "video" | "file";

export interface GatewayDiscovery {
  schema_version: typeof GATEWAY_SCHEMA_VERSION;
  issuer: string;
  api_base: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  bootstrap_endpoint: string;
  models_endpoint: string;
  authentication_methods: ["oauth_pkce", "api_key"] | ["api_key", "oauth_pkce"];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  native_clients: Array<{
    client_id: string;
    redirect_uris: string[];
  }>;
}

export interface GatewayModel {
  id: string;
  object: "model";
  display_name: string;
  description?: string;
  owned_by: string;
  created: number;
  status: "available" | "deprecated" | "disabled";
  capabilities: {
    input_modalities: GatewayModality[];
    output_modalities: GatewayModality[];
    streaming: boolean;
    tool_calling: boolean;
    structured_output: boolean;
    reasoning: boolean;
  };
  limits: {
    context_window: number | null;
    max_output_tokens: number | null;
  };
  supported_parameters: string[];
  reasoning?: {
    efforts: string[];
    default_effort?: string;
  };
  deprecation?: {
    at: string;
    replacement_model?: string;
  };
}

export interface GatewayModelList {
  schema_version: typeof GATEWAY_SCHEMA_VERSION;
  object: "list";
  revision: string;
  data: GatewayModel[];
}

export interface GatewayBootstrap {
  schema_version: typeof GATEWAY_SCHEMA_VERSION;
  object: "gateway.bootstrap";
  issued_at: string;
  auth: {
    mode: GatewayAuthMode;
    subject: string;
    scopes: string[];
    expires_at?: string;
  };
  account?: {
    id: string;
    email?: string;
    display_name?: string;
    avatar_url?: string;
  };
  endpoints: {
    models: string;
    responses: string;
  };
  models: GatewayModelList;
}

export interface GatewayOAuthToken {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface GatewayAPIError {
  error: {
    code: string;
    message: string;
    request_id?: string;
  };
}
