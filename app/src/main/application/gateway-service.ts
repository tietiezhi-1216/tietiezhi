import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { app, BrowserWindow, shell } from "electron";

import type { GatewayAccount, GatewayAccountView } from "@shared/contracts";

import { CredentialStore } from "../infrastructure/credential-store.js";
import {
  BUILTIN_PROVIDER_ID,
  BUILTIN_PROVIDER_URL,
  ProviderService,
} from "./provider-service.js";
import {
  gatewayRoot,
  parseGatewayDiscovery,
  type GatewayDiscovery as Discovery,
} from "./gateway-protocol.js";

const CLIENT_ID = "tietiezhi-desktop";
const SESSION_REF = `gateway:${BUILTIN_PROVIDER_ID}:session`;
const ISSUER_REF = `gateway:${BUILTIN_PROVIDER_ID}:issuer`;

interface TokenData {
  sessionToken: string;
  apiKey: string;
  expires: number;
  account: GatewayAccount;
}

interface APIResponse<T> {
  success: boolean;
  message: string;
  data?: T;
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

function number(source: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number") return value;
  }
  return 0;
}

function parseAccount(value: unknown): GatewayAccount {
  const source = record(value);
  return {
    userId: number(source, "user_id", "userId"),
    email: string(source, "email"),
    nickname: string(source, "nickname"),
    avatar: string(source, "avatar"),
  };
}

function parseResponse<T>(value: unknown, parseData: (data: unknown) => T): APIResponse<T> {
  const source = record(value);
  const success = source["success"] === true;
  return {
    success,
    message: string(source, "message"),
    data: source["data"] === undefined ? undefined : parseData(source["data"]),
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("无法启动登录回调");
  return address.port;
}

function callbackPage(): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>已连接铁铁汁</title><body><main><h1>已连接铁铁汁</h1><p>账号授权已经完成，请返回桌面应用继续使用。此页面现在可以安全关闭。</p></main></body></html>`;
}

export class GatewayService {
  constructor(
    private readonly providers: ProviderService,
    private readonly credentials: CredentialStore,
    private readonly fetch: typeof globalThis.fetch,
  ) {}

  async #discovery(): Promise<Discovery> {
    const issuer = gatewayRoot(BUILTIN_PROVIDER_URL);
    const response = await this.fetch(`${issuer}/.well-known/tietiezhi-gateway`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("当前服务不是支持账号登录的 Tietiezhi Gateway");
    return parseGatewayDiscovery((await response.json()) as unknown, issuer);
  }

  async #post<T>(
    url: string,
    body: Record<string, unknown>,
    parseData: (value: unknown) => T,
  ): Promise<APIResponse<T>> {
    const response = await this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return parseResponse((await response.json()) as unknown, parseData);
  }

  async account(): Promise<GatewayAccountView> {
    // Without a stored session the app must not talk to the gateway at all —
    // logged-out users stay fully local until they explicitly sign in.
    const sessionToken = await this.credentials.get(SESSION_REF);
    if (!sessionToken) {
      return {
        providerId: BUILTIN_PROVIDER_ID,
        supported: true,
        loggedIn: false,
      };
    }
    let discovery: Discovery;
    try {
      discovery = await this.#discovery();
    } catch {
      return {
        providerId: BUILTIN_PROVIDER_ID,
        supported: false,
        loggedIn: false,
      };
    }
    const issuer = await this.credentials.get(ISSUER_REF);
    if (issuer !== discovery.issuer) {
      return {
        providerId: BUILTIN_PROVIDER_ID,
        supported: true,
        loggedIn: false,
      };
    }
    const result = await this.#post(
      discovery.sessionEndpoint,
      { session_token: sessionToken },
      (value) => {
        const source = record(value);
        return {
          expires: number(source, "expires"),
          account: parseAccount(source["account"]),
        };
      },
    );
    if (!result.success || result.data === undefined) {
      await this.#clearCredentials();
      return {
        providerId: BUILTIN_PROVIDER_ID,
        supported: true,
        loggedIn: false,
      };
    }
    return {
      providerId: BUILTIN_PROVIDER_ID,
      supported: true,
      loggedIn: true,
      account: result.data.account,
      expires: result.data.expires,
    };
  }

  async login(): Promise<GatewayAccountView> {
    const discovery = await this.#discovery();
    const state = randomUUID().replaceAll("-", "");
    const verifier = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const deviceId = await this.#deviceId();
    let resolveCallback: (value: { code: string; state: string }) => void = () => {};
    let rejectCallback: (error: Error) => void = () => {};
    const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    const server = createServer((request, response) => {
      try {
        const target = new URL(request.url ?? "/", "http://127.0.0.1");
        if (target.pathname !== "/callback") {
          response.writeHead(404).end();
          return;
        }
        const code = target.searchParams.get("code") ?? "";
        const returnedState = target.searchParams.get("state") ?? "";
        if (!code) throw new Error("中转站未返回授权码");
        const html = callbackPage();
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'",
        });
        response.end(html);
        resolveCallback({ code, state: returnedState });
      } catch (error) {
        response.writeHead(400).end();
        rejectCallback(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const port = await listen(server);
    const redirectURI = `http://127.0.0.1:${port}/callback`;
    const authorizeURL = new URL(discovery.authorizationEndpoint);
    authorizeURL.searchParams.set("client_id", CLIENT_ID);
    authorizeURL.searchParams.set("device_id", deviceId);
    authorizeURL.searchParams.set(
      "device_name",
      process.platform === "darwin" ? "Mac 上的铁铁汁" : "Windows 上的铁铁汁",
    );
    authorizeURL.searchParams.set("redirect_uri", redirectURI);
    authorizeURL.searchParams.set("code_challenge", challenge);
    authorizeURL.searchParams.set("code_challenge_method", "S256");
    authorizeURL.searchParams.set("state", state);

    let timeout: NodeJS.Timeout | undefined;
    try {
      await shell.openExternal(authorizeURL.toString());
      const returned = await Promise.race([
        callback,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("登录等待超时，请重试")), 180_000);
        }),
      ]);
      if (returned.state !== state) throw new Error("登录状态校验失败，请重试");
      const result = await this.#post<TokenData>(
        discovery.tokenEndpoint,
        {
          client_id: CLIENT_ID,
          code: returned.code,
          code_verifier: verifier,
          redirect_uri: redirectURI,
        },
        (value) => {
          const source = record(value);
          return {
            sessionToken: string(source, "session_token", "sessionToken"),
            apiKey: string(source, "api_key", "apiKey"),
            expires: number(source, "expires"),
            account: parseAccount(source["account"]),
          };
        },
      );
      if (!result.success || !result.data?.sessionToken || !result.data.apiKey) {
        throw new Error(result.message || "登录失败");
      }
      try {
        await Promise.all([
          this.credentials.set(SESSION_REF, result.data.sessionToken),
          this.credentials.set(ISSUER_REF, discovery.issuer),
          this.credentials.set(`provider:${BUILTIN_PROVIDER_ID}`, result.data.apiKey),
        ]);
      } catch (error) {
        await this.#clearCredentials();
        throw error;
      }
      try {
        await this.providers.refreshModels(BUILTIN_PROVIDER_ID);
      } catch {
        // Login remains valid when model discovery is temporarily unavailable.
      }
      for (const window of BrowserWindow.getAllWindows()) {
        window.show();
        window.focus();
      }
      return {
        providerId: BUILTIN_PROVIDER_ID,
        supported: true,
        loggedIn: true,
        account: result.data.account,
        expires: result.data.expires,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      server.close();
    }
  }

  async logout(): Promise<void> {
    const sessionToken = await this.credentials.get(SESSION_REF);
    if (sessionToken) {
      try {
        const discovery = await this.#discovery();
        await this.#post(discovery.revocationEndpoint, { session_token: sessionToken }, (value) => value);
      } catch {
        // Local logout must still complete when the gateway is unavailable.
      }
    }
    await this.#clearCredentials();
  }

  async #clearCredentials(): Promise<void> {
    await Promise.all([
      this.credentials.remove(SESSION_REF),
      this.credentials.remove(ISSUER_REF),
      this.credentials.remove(`provider:${BUILTIN_PROVIDER_ID}`),
    ]);
  }

  async #deviceId(): Promise<string> {
    const directory = app.getPath("userData");
    const path = join(directory, "device-id");
    try {
      const existing = (await readFile(path, "utf8")).trim();
      if (existing) return existing;
    } catch {
      // Create a stable identifier below.
    }
    const value = randomUUID();
    await mkdir(directory, { recursive: true });
    await writeFile(path, value, "utf8");
    return value;
  }
}
