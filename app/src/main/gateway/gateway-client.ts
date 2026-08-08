import {
  GATEWAY_SCHEMA_VERSION,
  type GatewayAuthMode,
  type GatewayBootstrap,
  type GatewayDiscovery,
  type GatewayModel,
  type GatewayModelList,
} from "@shared/gateway-protocol";

export interface GatewayCredential {
  mode: GatewayAuthMode;
  secret: string;
}

export type GatewayFetcher = (input: string, init?: RequestInit) => Promise<Response>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value === "") throw new Error(`网关字段 ${key} 无效`);
  return value;
}

function sameOrigin(issuer: string, endpoint: string): boolean {
  try {
    return new URL(issuer).origin === new URL(endpoint).origin;
  } catch {
    return false;
  }
}

export function parseGatewayDiscovery(value: unknown, expectedIssuer: string): GatewayDiscovery {
  const source = record(value, "网关发现文档");
  if (source["schema_version"] !== GATEWAY_SCHEMA_VERSION) {
    throw new Error("网关协议版本不受支持");
  }
  const issuer = requiredString(source, "issuer").replace(/\/+$/, "");
  if (issuer !== expectedIssuer.replace(/\/+$/, "")) throw new Error("网关签发方不匹配");
  const endpointKeys = [
    "api_base",
    "authorization_endpoint",
    "token_endpoint",
    "revocation_endpoint",
    "bootstrap_endpoint",
    "models_endpoint",
  ] as const;
  for (const key of endpointKeys) {
    if (!sameOrigin(issuer, requiredString(source, key))) throw new Error(`网关端点 ${key} 不同源`);
  }
  const methods = source["authentication_methods"];
  if (!Array.isArray(methods) || !methods.includes("oauth_pkce") || !methods.includes("api_key")) {
    throw new Error("网关必须同时支持登录和 API Key");
  }
  return value as GatewayDiscovery;
}

function validateModel(value: unknown): asserts value is GatewayModel {
  const source = record(value, "模型");
  requiredString(source, "id");
  requiredString(source, "display_name");
  if (source["object"] !== "model") throw new Error("模型 object 无效");
  record(source["capabilities"], "模型能力");
  record(source["limits"], "模型限制");
}

export function parseGatewayModelList(value: unknown): GatewayModelList {
  const source = record(value, "模型列表");
  if (source["schema_version"] !== GATEWAY_SCHEMA_VERSION || source["object"] !== "list") {
    throw new Error("模型列表协议版本无效");
  }
  requiredString(source, "revision");
  if (!Array.isArray(source["data"])) throw new Error("模型列表 data 无效");
  source["data"].forEach(validateModel);
  return value as GatewayModelList;
}

export function parseGatewayBootstrap(value: unknown): GatewayBootstrap {
  const source = record(value, "网关 Bootstrap");
  if (
    source["schema_version"] !== GATEWAY_SCHEMA_VERSION ||
    source["object"] !== "gateway.bootstrap"
  ) {
    throw new Error("网关 Bootstrap 协议版本无效");
  }
  const auth = record(source["auth"], "鉴权信息");
  if (auth["mode"] !== "login" && auth["mode"] !== "api_key") {
    throw new Error("网关鉴权模式无效");
  }
  parseGatewayModelList(source["models"]);
  return value as GatewayBootstrap;
}

export class GatewayClient {
  constructor(private readonly fetch: GatewayFetcher) {}

  async discover(issuer: string): Promise<GatewayDiscovery> {
    const root = issuer.trim().replace(/\/+$/, "");
    const response = await this.fetch(`${root}/.well-known/tietiezhi-gateway`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`发现网关失败：HTTP ${response.status}`);
    return parseGatewayDiscovery((await response.json()) as unknown, root);
  }

  async bootstrap(
    discovery: GatewayDiscovery,
    credential: GatewayCredential,
  ): Promise<GatewayBootstrap> {
    const secret = credential.secret.trim();
    if (!secret) throw new Error(credential.mode === "login" ? "登录令牌为空" : "API Key 为空");
    const response = await this.fetch(discovery.bootstrap_endpoint, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${secret}`,
        "x-tietiezhi-auth-mode": credential.mode,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`连接网关失败：HTTP ${response.status}`);
    const bootstrap = parseGatewayBootstrap((await response.json()) as unknown);
    if (bootstrap.auth.mode !== credential.mode) throw new Error("网关返回了不同的鉴权模式");
    return bootstrap;
  }

  async models(
    discovery: GatewayDiscovery,
    credential: GatewayCredential,
  ): Promise<GatewayModelList> {
    const response = await this.fetch(discovery.models_endpoint, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential.secret.trim()}`,
        "x-tietiezhi-auth-mode": credential.mode,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`获取模型失败：HTTP ${response.status}`);
    return parseGatewayModelList((await response.json()) as unknown);
  }
}
