import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server as HTTPServer,
} from "node:http";
import type { Socket } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

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
      avatarOverride?: string;
    }
  | { version: 1; mode: "api_key"; issuer: string; apiKey: string; avatarOverride?: string };

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
const NATIVE_REDIRECT_URI = "tietiezhi://auth/callback";
const LOCAL_CALLBACK_HOST = "127.0.0.1";

interface ActiveBrowserLogin {
  discovery: GatewayDiscovery;
  state: string;
  verifier: string;
  redirectURI: string;
  server?: HTTPServer;
  timeout: NodeJS.Timeout;
  resolve: (status: AuthStatus) => void;
  reject: (error: Error) => void;
}

type GatewayFetcher = (input: string, init?: RequestInit) => Promise<Response>;

function errorRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function errorCode(value: unknown): string | null {
  const source = errorRecord(value);
  if (!source) return null;
  if (typeof source["code"] === "string") return source["code"];
  return errorCode(source["cause"]);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "未知网络错误";
}

function networkFailureMessage(cause: unknown): string {
  const code = errorCode(cause);
  if (code === "ECONNRESET") return "网关连接被重置，请检查系统代理或网络后重试";
  if (code === "ENOTFOUND") return "无法解析网关域名，请检查 DNS 或网络";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "连接网关超时，请稍后重试";
  if (code === "ECONNREFUSED") return "网关连接被拒绝，请检查网络或代理配置";
  return errorMessage(cause);
}

function requestBody(body: RequestInit["body"] | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("当前代理请求体格式不支持");
}

function requestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result.append(key, value);
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    }
  }
  return result;
}

function splitHostPort(value: string): { host: string; port: string | null } {
  const index = value.lastIndexOf(":");
  if (index > 0 && /^\d+$/.test(value.slice(index + 1))) {
    return { host: value.slice(0, index), port: value.slice(index + 1) };
  }
  return { host: value, port: null };
}

function matchesNoProxy(target: URL): boolean {
  const value = process.env["NO_PROXY"]?.trim() || process.env["no_proxy"]?.trim() || "";
  if (!value) return false;
  const hostname = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  return value.split(",").some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern === "*") return true;
    const { host, port: expectedPort } = splitHostPort(pattern);
    if (expectedPort && expectedPort !== port) return false;
    if (host.startsWith(".")) return hostname.endsWith(host);
    return hostname === host || hostname.endsWith(`.${host}`);
  });
}

function proxyFor(target: URL): URL | null {
  if (matchesNoProxy(target)) return null;
  const source = target.protocol === "https:"
    ? process.env["HTTPS_PROXY"]?.trim() || process.env["https_proxy"]?.trim() ||
      process.env["HTTP_PROXY"]?.trim() || process.env["http_proxy"]?.trim()
    : process.env["HTTP_PROXY"]?.trim() || process.env["http_proxy"]?.trim();
  if (!source) return systemProxyFor(target);
  const proxy = new URL(source);
  if (proxy.protocol !== "http:") throw new Error("当前仅支持 HTTP 代理访问登录网关");
  return proxy;
}

function systemProxyFor(target: URL): URL | null {
  if (process.platform !== "darwin") return null;
  const settings = macOSProxySettings();
  if (!settings) return null;
  const secure = target.protocol === "https:";
  const enabled = settings[secure ? "HTTPSEnable" : "HTTPEnable"] === "1";
  const host = settings[secure ? "HTTPSProxy" : "HTTPProxy"];
  const port = settings[secure ? "HTTPSPort" : "HTTPPort"];
  if (!enabled || !host || !port) return null;
  return new URL(`http://${host}:${port}`);
}

function macOSProxySettings(): Record<string, string> | null {
  try {
    const output = execFileSync("scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 1_000,
      windowsHide: true,
    });
    const settings: Record<string, string> = {};
    for (const line of output.split("\n")) {
      const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/u);
      if (match?.[1] && match[2]) settings[match[1]] = match[2];
    }
    return settings;
  } catch {
    return null;
  }
}

function proxyAuthorizationHeader(proxy: URL): string | undefined {
  if (!proxy.username) return undefined;
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function fetchViaHTTPProxy(target: URL, init: RequestInit | undefined, proxy: URL): Promise<Response> {
  const targetPort = target.port || (target.protocol === "https:" ? "443" : "80");
  const body = requestBody(init?.body);
  const headers = requestHeaders(init?.headers);
  const method = init?.method ?? (body ? "POST" : "GET");
  if (!headers["host"]) headers["host"] = target.host;
  if (body && !headers["content-length"]) headers["content-length"] = String(body.byteLength);

  return new Promise((resolve, reject) => {
    let finished = false;
    let proxyRequest: ReturnType<typeof httpRequest> | undefined;
    let tunnelSocket: Socket | undefined;
    let secureSocket: TLSSocket | undefined;
    let finalRequest: ReturnType<typeof httpRequest> | undefined;

    const cleanup = (): void => {
      init?.signal?.removeEventListener("abort", abort);
    };
    const destroySockets = (error: Error): void => {
      proxyRequest?.destroy(error);
      finalRequest?.destroy(error);
      secureSocket?.destroy(error);
      tunnelSocket?.destroy(error);
    };
    const fail = (cause: unknown): void => {
      if (finished) return;
      finished = true;
      const error = cause instanceof Error ? cause : new Error("代理请求失败");
      cleanup();
      destroySockets(error);
      reject(error);
    };
    const done = (response: Response): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(response);
    };
    function abort(): void {
      fail(new Error("请求已取消或超时"));
    }

    if (init?.signal?.aborted) {
      abort();
      return;
    }
    init?.signal?.addEventListener("abort", abort, { once: true });

    const connectHeaders: Record<string, string> = { host: `${target.hostname}:${targetPort}` };
    const authorization = proxyAuthorizationHeader(proxy);
    if (authorization) connectHeaders["proxy-authorization"] = authorization;

    proxyRequest = httpRequest({
      hostname: proxy.hostname,
      port: Number(proxy.port || "80"),
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: connectHeaders,
    });
    proxyRequest.once("error", fail);
    proxyRequest.once("connect", (response, socket) => {
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        socket.destroy();
        fail(new Error(`代理连接失败：HTTP ${response.statusCode ?? 0}`));
        return;
      }
      tunnelSocket = socket;
      secureSocket = tlsConnect({ socket, servername: target.hostname });
      secureSocket.once("error", fail);
      secureSocket.once("secureConnect", () => {
        finalRequest = httpRequest({
          method,
          path: `${target.pathname}${target.search}`,
          headers,
          createConnection: () => secureSocket as TLSSocket,
        }, (gatewayResponse) => {
          const chunks: Buffer[] = [];
          gatewayResponse.on("data", (chunk: unknown) => {
            if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
            else if (chunk instanceof Buffer) chunks.push(chunk);
            else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
          });
          gatewayResponse.once("error", fail);
          gatewayResponse.once("end", () => {
            done(new Response(Buffer.concat(chunks), {
              status: gatewayResponse.statusCode ?? 500,
              statusText: gatewayResponse.statusMessage,
              headers: responseHeaders(gatewayResponse.headers),
            }));
          });
        });
        finalRequest.once("error", fail);
        if (body) finalRequest.write(body);
        finalRequest.end();
      });
    });
    proxyRequest.end();
  });
}

async function gatewayFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (cause) {
    if (init?.signal?.aborted) throw cause;
    const target = new URL(input);
    const proxy = proxyFor(target);
    if (!proxy) throw cause;
    try {
      return await fetchViaHTTPProxy(target, init, proxy);
    } catch (proxyCause) {
      throw new Error(`${networkFailureMessage(cause)}；代理请求失败：${networkFailureMessage(proxyCause)}`);
    }
  }
}

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

function optionalNonEmptyString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function assertEndpoint(issuer: URL, value: string, key: string): string {
  const endpoint = new URL(value);
  if (endpoint.origin !== issuer.origin) throw new Error(`网关端点 ${key} 不同源`);
  if (issuer.protocol !== "https:" && issuer.hostname !== "localhost" && issuer.hostname !== "127.0.0.1") {
    throw new Error("网关必须使用 HTTPS");
  }
  return endpoint.toString();
}

function completionHTML(): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>登录完成</title>",
    "</head>",
    "<body>",
    "<p>登录完成，正在返回 Tietiezhi，可以关闭此页面。</p>",
    "<script>window.close();</script>",
    "</body>",
    "</html>",
  ].join("");
}

export class GatewayAuthService {
  private readonly credentialPath: string;
  private readonly devicePath: string;
  private activeLogin: ActiveBrowserLogin | null = null;

  constructor(
    private readonly userDataPath: string,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly issuer = process.env["TIETIEZHI_GATEWAY_URL"]?.trim() ||
      process.env["TIETIEZHI_GATEWAY_WEB_URL"]?.trim() ||
      "https://tietiezhi.vip",
    private readonly fetcher: GatewayFetcher = gatewayFetch,
  ) {
    this.credentialPath = join(userDataPath, "gateway-credential.bin");
    this.devicePath = join(userDataPath, "gateway-device-id");
  }

  async status(): Promise<AuthStatus> {
    const credential = await this.readCredential();
    if (!credential || (credential.mode === "login" && credential.expires <= Date.now())) {
      return { authenticated: false };
    }
    return this.authStatus(credential);
  }

  async loginWithAPIKey(value: string): Promise<AuthStatus> {
    const apiKey = value.trim();
    if (!apiKey) throw new Error("请输入 API 密钥");
    const issuer = this.normalizedIssuer();
    const response = await this.request(`${issuer}/v1/models`, {
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    }, "验证 API 密钥");
    if (!response.ok) throw new Error(`API 密钥验证失败：HTTP ${response.status}`);
    const credential: StoredCredential = { version: 1, mode: "api_key", issuer, apiKey };
    await this.storeCredential(credential);
    return this.authStatus(credential);
  }

  async logout(): Promise<void> {
    this.cancelLogin();
    await rm(this.credentialPath, { force: true });
  }

  async setAvatar(value: string | null): Promise<AuthStatus> {
    const credential = await this.readCredential();
    if (!credential || (credential.mode === "login" && credential.expires <= Date.now())) {
      throw new Error("请先登录");
    }
    const avatarOverride = this.normalizedAvatar(value);
    const next: StoredCredential = avatarOverride
      ? { ...credential, avatarOverride }
      : { ...credential, avatarOverride: undefined };
    await this.storeCredential(next);
    return this.authStatus(next);
  }

  async loginWithBrowser(): Promise<AuthStatus> {
    this.cancelLogin();
    const discovery = await this.discover();
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const deviceId = await this.deviceId();
    const localCallback = process.defaultApp ? await this.createLocalCallbackServer() : null;
    const redirectURI = localCallback?.redirectURI ?? NATIVE_REDIRECT_URI;
    const result = new Promise<AuthStatus>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.activeLogin || this.activeLogin.state !== state) return;
        this.activeLogin.server?.close();
        this.activeLogin = null;
        reject(new Error("登录已超时，请重新尝试"));
      }, LOGIN_TIMEOUT_MS);
      this.activeLogin = {
        discovery,
        state,
        verifier,
        redirectURI,
        server: localCallback?.server,
        timeout,
        resolve,
        reject,
      };
    });

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
      this.cancelLogin();
      void result.catch(() => undefined);
      throw cause;
    }

    return result;
  }

  async completeBrowserLogin(callbackURL: string): Promise<void> {
    const active = this.activeLogin;
    if (!active) return;

    let url: URL;
    try {
      url = new URL(callbackURL);
    } catch {
      return;
    }
    const expected = new URL(active.redirectURI);
    if (
      url.protocol !== expected.protocol ||
      url.hostname !== expected.hostname ||
      url.port !== expected.port ||
      url.pathname !== expected.pathname
    ) {
      return;
    }
    if (url.searchParams.get("state") !== active.state) {
      this.finishBrowserLogin(active, new Error("登录状态校验失败"));
      return;
    }
    const code = url.searchParams.get("code")?.trim();
    if (!code) {
      this.finishBrowserLogin(active, new Error("网关没有返回授权码"));
      return;
    }

    try {
      const token = await this.exchange(active.discovery, code, active.verifier, active.redirectURI);
      const credential: StoredCredential = {
        version: 1,
        mode: "login",
        issuer: active.discovery.issuer,
        sessionToken: token.session_token,
        apiKey: token.api_key,
        expires: token.expires,
        account: token.account,
      };
      await this.storeCredential(credential);
      this.finishBrowserLogin(active, undefined, this.authStatus(credential));
    } catch (cause) {
      this.finishBrowserLogin(active, cause instanceof Error ? cause : new Error("登录失败"));
    }
  }

  private finishBrowserLogin(active: ActiveBrowserLogin, error?: Error, status?: AuthStatus): void {
    if (this.activeLogin !== active) return;
    clearTimeout(active.timeout);
    active.server?.close();
    this.activeLogin = null;
    if (error) {
      active.reject(error);
      return;
    }
    active.resolve(status ?? { authenticated: false });
  }

  cancelLogin(): void {
    if (!this.activeLogin) return;
    const activeLogin = this.activeLogin;
    clearTimeout(activeLogin.timeout);
    activeLogin.server?.close();
    this.activeLogin = null;
    activeLogin.reject(new Error("登录已取消"));
  }

  registrationURL(): string {
    const url = new URL(this.normalizedIssuer());
    url.searchParams.set("view", "register");
    return url.toString();
  }

  private normalizedIssuer(): string {
    return this.issuer.replace(/\/+$/, "");
  }

  private normalizedAvatar(value: string | null): string | undefined {
    const avatar = value?.trim();
    if (!avatar) return undefined;
    const url = new URL(avatar);
    if (url.protocol !== "https:") throw new Error("头像地址必须使用 HTTPS");
    return url.toString();
  }

  private authStatus(credential: StoredCredential): AuthStatus {
    if (credential.mode === "login") {
      const displayName = credential.account.nickname.trim() || credential.account.email.trim() || "Tietiezhi 用户";
      return {
        authenticated: true,
        mode: "login",
        profile: {
          displayName,
          email: credential.account.email,
          avatar: credential.avatarOverride,
        },
        account: credential.avatarOverride
          ? { ...credential.account, avatar: credential.avatarOverride }
          : credential.account,
      };
    }
    return {
      authenticated: true,
      mode: "api_key",
      profile: {
        displayName: "API Key 用户",
        avatar: credential.avatarOverride,
      },
    };
  }

  private async request(input: string, init: RequestInit, action: string): Promise<Response> {
    try {
      return await this.fetcher(input, init);
    } catch (cause) {
      throw new Error(`${action}失败：${networkFailureMessage(cause)}`);
    }
  }

  private async discover(): Promise<GatewayDiscovery> {
    const expectedIssuer = new URL(this.normalizedIssuer());
    const root = expectedIssuer.toString().replace(/\/$/, "");
    const response = await this.request(`${root}/.well-known/tietiezhi-gateway`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }, "连接登录网关");
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

  private async createLocalCallbackServer(): Promise<{ redirectURI: string; server: HTTPServer }> {
    const server = createServer((request, response) => {
      const host = typeof request.headers.host === "string" ? request.headers.host : LOCAL_CALLBACK_HOST;
      const target = new URL(request.url ?? "/", `http://${host}`);
      if (target.pathname !== "/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(completionHTML());
      void this.completeBrowserLogin(target.toString());
    });

    return new Promise((resolve, reject) => {
      const fail = (error: Error): void => {
        server.close();
        reject(error);
      };
      server.once("error", fail);
      server.listen(0, LOCAL_CALLBACK_HOST, () => {
        server.off("error", fail);
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("本地登录回调服务启动失败"));
          return;
        }
        resolve({
          redirectURI: `http://${LOCAL_CALLBACK_HOST}:${address.port}/callback`,
          server,
        });
      });
    });
  }

  private async exchange(discovery: GatewayDiscovery, code: string, verifier: string, redirectURI: string): Promise<NativeTokenData> {
    const response = await this.request(discovery.tokenEndpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: discovery.clientId, code, code_verifier: verifier, redirect_uri: redirectURI }),
      signal: AbortSignal.timeout(15_000),
    }, "交换登录凭据");
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
      const avatarOverride = optionalNonEmptyString(source, "avatarOverride");
      if (avatarOverride) new URL(avatarOverride);
      return value as StoredCredential;
    } catch {
      return null;
    }
  }
}
