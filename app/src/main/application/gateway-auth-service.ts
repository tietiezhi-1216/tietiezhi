import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";

import { safeStorage } from "electron";

import type { AuthStatus } from "@shared/contracts";

interface GatewayDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
}

interface NativeTokenData {
  session_token: string;
  api_key: string;
  expires: number;
  account: { user_id: number; email: string; nickname: string; avatar: string };
}

type StoredCredential =
  | {
      version: 1;
      mode: "login";
      issuer: string;
      sessionToken: string;
      apiKey: string;
      expires: number;
      account: NativeTokenData["account"];
    }
  | { version: 1; mode: "api_key"; issuer: string; apiKey: string };

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`网关字段 ${key} 无效`);
  return value.trim();
}

function assertEndpoint(issuer: URL, value: string, key: string): string {
  const endpoint = new URL(value);
  if (endpoint.origin !== issuer.origin) throw new Error(`网关端点 ${key} 不同源`);
  if (issuer.protocol !== "https:" && issuer.hostname !== "localhost" && issuer.hostname !== "127.0.0.1") {
    throw new Error("网关必须使用 HTTPS");
  }
  return endpoint.toString();
}

function escapeHTML(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

function completionHTML(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已登录 Tietiezhi</title><style>:root{color-scheme:dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#171717;color:#f5f5f5}header{position:fixed;top:20px;left:20px;font-size:18px;font-weight:650;letter-spacing:-.02em}main{min-height:100vh;display:grid;place-items:center;padding:32px}.content{text-align:center;transform:translateY(-10px)}p{margin:0 0 26px;color:#a3a3a3;font-size:14px}.button{display:inline-flex;min-width:168px;height:48px;align-items:center;justify-content:center;border:1px solid #393939;border-radius:999px;background:#292929;color:#f5f5f5;font-size:14px;font-weight:600;cursor:pointer}.button:hover{background:#333}</style></head><body><header>Tietiezhi Gateway</header><main><div class="content"><p>你已登录，可以关闭此标签页</p><button class="button" onclick="window.close()">返回 Tietiezhi</button></div></main></body></html>`;
}

function errorHTML(message: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>登录失败</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#171717;color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><main style="text-align:center"><h1 style="font-size:20px">登录没有完成</h1><p style="color:#aaa">${escapeHTML(message)}</p></main></body></html>`;
}

function respond(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
}

export class GatewayAuthService {
  private readonly credentialPath: string;
  private readonly devicePath: string;
  private activeLogin: { cancel: () => void } | null = null;

  constructor(
    private readonly userDataPath: string,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly issuer = process.env["TIETIEZHI_GATEWAY_URL"]?.trim() ||
      process.env["TIETIEZHI_GATEWAY_WEB_URL"]?.trim() ||
      "https://tietiezhi.vip",
  ) {
    this.credentialPath = join(userDataPath, "gateway-credential.bin");
    this.devicePath = join(userDataPath, "gateway-device-id");
  }

  async status(): Promise<AuthStatus> {
    const credential = await this.readCredential();
    if (!credential || (credential.mode === "login" && credential.expires <= Date.now())) {
      return { authenticated: false };
    }
    return {
      authenticated: true,
      mode: credential.mode,
      account: credential.mode === "login" ? credential.account : undefined,
    };
  }

  async loginWithAPIKey(value: string): Promise<AuthStatus> {
    const apiKey = value.trim();
    if (!apiKey) throw new Error("请输入 API 密钥");
    const issuer = this.normalizedIssuer();
    const response = await fetch(`${issuer}/v1/models`, {
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`API 密钥验证失败：HTTP ${response.status}`);
    await this.storeCredential({ version: 1, mode: "api_key", issuer, apiKey });
    return { authenticated: true, mode: "api_key" };
  }

  async loginWithBrowser(): Promise<AuthStatus> {
    this.cancelLogin();
    const discovery = await this.discover();
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const deviceId = await this.deviceId();
    let redirectURI = "";
    let settled = false;
    let resolveLogin: (status: AuthStatus) => void = () => undefined;
    let rejectLogin: (error: Error) => void = () => undefined;
    const result = new Promise<AuthStatus>((resolve, reject) => {
      resolveLogin = resolve;
      rejectLogin = reject;
    });

    const server = createServer(async (request, response) => {
      const url = new URL(request.url || "/", redirectURI);
      if (url.pathname !== "/callback") {
        respond(response, 404, errorHTML("回调地址无效"));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        respond(response, 400, errorHTML("登录状态校验失败"));
        return;
      }
      const code = url.searchParams.get("code")?.trim();
      if (!code) {
        respond(response, 400, errorHTML("网关没有返回授权码"));
        return;
      }
      try {
        const token = await this.exchange(discovery, code, verifier, redirectURI);
        if (settled) return;
        await this.storeCredential({
          version: 1,
          mode: "login",
          issuer: discovery.issuer,
          sessionToken: token.session_token,
          apiKey: token.api_key,
          expires: token.expires,
          account: token.account,
        });
        respond(response, 200, completionHTML());
        settled = true;
        resolveLogin({ authenticated: true, mode: "login", account: token.account });
        server.close();
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error("登录失败");
        respond(response, 500, errorHTML(error.message));
        settled = true;
        rejectLogin(error);
        server.close();
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("无法创建本地登录回调");
    }
    redirectURI = `http://127.0.0.1:${address.port}/callback`;
    this.activeLogin = {
      cancel: () => {
        if (settled) return;
        settled = true;
        server.close();
        rejectLogin(new Error("登录已取消"));
      },
    };
    const authorizationURL = new URL(discovery.authorizationEndpoint);
    authorizationURL.search = new URLSearchParams({
      client_id: discovery.clientId,
      device_id: deviceId,
      device_name: hostname() || "Tietiezhi Desktop",
      redirect_uri: redirectURI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();

    try {
      await this.openExternal(authorizationURL.toString());
    } catch (cause) {
      server.close();
      this.activeLogin = null;
      throw cause;
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      rejectLogin(new Error("登录已超时，请重新尝试"));
    }, LOGIN_TIMEOUT_MS);
    try {
      return await result;
    } finally {
      clearTimeout(timeout);
      this.activeLogin = null;
    }
  }

  cancelLogin(): void {
    if (!this.activeLogin) return;
    const activeLogin = this.activeLogin;
    this.activeLogin = null;
    activeLogin.cancel();
  }

  registrationURL(): string {
    const url = new URL(this.normalizedIssuer());
    url.searchParams.set("view", "register");
    return url.toString();
  }

  private normalizedIssuer(): string {
    return this.issuer.replace(/\/+$/, "");
  }

  private async discover(): Promise<GatewayDiscovery> {
    const expectedIssuer = new URL(this.normalizedIssuer());
    const root = expectedIssuer.toString().replace(/\/$/, "");
    const response = await fetch(`${root}/.well-known/tietiezhi-gateway`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`发现网关失败：HTTP ${response.status}`);
    const source = record((await response.json()) as unknown, "网关发现文档");
    const issuer = new URL(requiredString(source, "issuer"));
    if (issuer.origin !== expectedIssuer.origin) throw new Error("网关签发方不匹配");
    return {
      issuer: issuer.toString().replace(/\/$/, ""),
      authorizationEndpoint: assertEndpoint(issuer, requiredString(source, "authorization_endpoint"), "authorization_endpoint"),
      tokenEndpoint: assertEndpoint(issuer, requiredString(source, "token_endpoint"), "token_endpoint"),
      clientId: requiredString(source, "client_id"),
    };
  }

  private async exchange(discovery: GatewayDiscovery, code: string, verifier: string, redirectURI: string): Promise<NativeTokenData> {
    const response = await fetch(discovery.tokenEndpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: discovery.clientId, code, code_verifier: verifier, redirect_uri: redirectURI }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`交换登录凭据失败：HTTP ${response.status}`);
    const payload = (await response.json()) as unknown;
    const source = record(payload, "网关登录响应");
    if (source["success"] !== true) {
      throw new Error(typeof source["message"] === "string" ? source["message"] : "网关拒绝了登录请求");
    }
    const data = record(source["data"], "网关登录凭据") as unknown as NativeTokenData;
    if (!data.session_token || !data.api_key || !Number.isFinite(data.expires) || !data.account) {
      throw new Error("网关登录凭据格式无效");
    }
    return data;
  }

  private async deviceId(): Promise<string> {
    try {
      const value = (await readFile(this.devicePath, "utf8")).trim();
      if (/^[0-9a-f-]{36}$/i.test(value)) return value;
    } catch {
      // Create the stable non-secret device identifier below.
    }
    await mkdir(this.userDataPath, { recursive: true });
    const value = randomUUID();
    await writeFile(this.devicePath, value, { encoding: "utf8", mode: 0o600 });
    return value;
  }

  private async storeCredential(credential: StoredCredential): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储当前不可用");
    await mkdir(this.userDataPath, { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(credential));
    const temporaryPath = `${this.credentialPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, encrypted, { mode: 0o600 });
    await rename(temporaryPath, this.credentialPath);
  }

  private async readCredential(): Promise<StoredCredential | null> {
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      const encrypted = await readFile(this.credentialPath);
      const value = JSON.parse(safeStorage.decryptString(encrypted)) as unknown;
      const source = record(value, "本地登录凭据");
      if (source["version"] !== 1 || (source["mode"] !== "login" && source["mode"] !== "api_key")) return null;
      return value as StoredCredential;
    } catch {
      return null;
    }
  }
}
