export interface GatewayDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  sessionEndpoint: string;
  revocationEndpoint: string;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("中转站返回了无法识别的响应");
  }
  return value as Record<string, unknown>;
}

function string(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export function gatewayRoot(value: string): string {
  const url = new URL(value.trim().replace(/\/+$/, ""));
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) url.pathname = path.slice(0, -3) || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function parseGatewayDiscovery(
  value: unknown,
  expectedIssuer: string,
): GatewayDiscovery {
  const source = record(value);
  const discovery: GatewayDiscovery = {
    issuer: gatewayRoot(string(source, "issuer")),
    authorizationEndpoint: string(source, "authorization_endpoint", "authorizationEndpoint"),
    tokenEndpoint: string(source, "token_endpoint", "tokenEndpoint"),
    sessionEndpoint: string(source, "session_endpoint", "sessionEndpoint"),
    revocationEndpoint: string(source, "revocation_endpoint", "revocationEndpoint"),
  };
  if (discovery.issuer !== expectedIssuer) throw new Error("中转站登录签发方与当前地址不一致");
  for (const endpoint of [
    discovery.authorizationEndpoint,
    discovery.tokenEndpoint,
    discovery.sessionEndpoint,
    discovery.revocationEndpoint,
  ]) {
    if (!endpoint || new URL(discovery.issuer).origin !== new URL(endpoint).origin) {
      throw new Error("中转站登录端点无效或不同源");
    }
  }
  const clientId = string(source, "client_id", "clientId");
  if (clientId !== "tietiezhi-desktop") throw new Error("当前中转站不支持此版本的桌面登录");
  return discovery;
}
