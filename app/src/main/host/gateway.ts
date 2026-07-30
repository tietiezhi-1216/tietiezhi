/**
 * Gateway accounts (relay login, quota, package orders) and the Create studio
 * (image / video generation plus the generated-asset files).
 *
 * Ported from `desktop/src-tauri/src/commands/gateway_auth.rs` and
 * `desktop/src-tauri/src/commands/create.rs`. The renderer is the unchanged
 * Tauri frontend, so every returned shape matches what serde produced field for
 * field — including the optional members that are emitted as `null` rather than
 * omitted. Gateway APIs answer in snake_case while the frontend consumes
 * camelCase (serde bridged the two with `alias` + `rename_all`), so the wire
 * parsers below accept both spellings and always hand out camelCase.
 */

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, extname, join, sep } from "node:path";

import { BrowserWindow, dialog, shell } from "electron";

import {
  closeChannel,
  currentInvocation,
  emitChannel,
  parseChannelId,
  registerCommands,
} from "../bridge/index.js";

import { dataPath, legacyDataDir } from "./paths.js";
import {
  BUILTIN_PROVIDER_ID,
  BUILTIN_PROVIDER_URL,
  isLegacyBuiltinProviderUrl,
  providerHttpError,
  readSettings,
  resolveProvider,
  upgradeLegacyBuiltinProviderUrl,
} from "./settings.js";
import { effectiveKind, type ModelKind } from "./settings-models.js";
import {
  deleteGatewayApiKey,
  deleteGatewayIssuer,
  deleteGatewaySession,
  getGatewayIssuer,
  getGatewaySession,
  setGatewayApiKey,
  setGatewayIssuer,
  setGatewaySession,
} from "./settings-secrets.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID = "tietiezhi-desktop";

const DISCOVERY_TIMEOUT_MS = 10_000;
const GATEWAY_POST_TIMEOUT_MS = 15_000;
/** How long the OAuth callback listener waits, matching the Rust build. */
const LOGIN_TIMEOUT_MS = 180_000;

const MAX_GENERATED_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GENERATED_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_IMAGE_REFERENCES = 4;
const VIDEO_POLL_INTERVAL_MS = 2_000;
const VIDEO_GENERATION_TIMEOUT_MS = 15 * 60 * 1000;

const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
const IMAGE_EDIT_TIMEOUT_MS = 240_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;
const VIDEO_CREATE_TIMEOUT_MS = 90_000;
const VIDEO_POLL_TIMEOUT_MS = 30_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const VIDEO_CANCEL_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same 200-code-point cap the Rust `snippet` applies to error bodies. */
function snippet(body: string): string {
  const trimmed = body.trim();
  const characters = [...trimmed];
  if (characters.length <= 200) return trimmed;
  return `${characters.slice(0, 200).join("")}…`;
}

/** `commands::api_url`: normalize the provider base and append `/v1/<path>`. */
function apiUrl(baseUrl: string, path: string): string {
  let base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/v1beta")) base = base.slice(0, -7);
  else if (base.endsWith("/v1")) base = base.slice(0, -3);
  return `${base}/v1/${path.replace(/^\/+/, "")}`;
}

/** Origin the gateway signs with: the base URL minus a trailing `/v1`. */
function gatewayRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error("baseURL 需以 http:// 或 https:// 开头");
  }
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`参数 ${key} 无效`);
  return value;
}

function requireNumberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`参数 ${key} 无效`);
  return value;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.trunc(value)));
}

// ---------------------------------------------------------------------------
// Wire parsing
//
// serde rejected a response whose required fields were missing or mistyped, and
// each caller turned that into its own user-facing message. The parsers signal
// the mismatch with one sentinel so callers can keep those texts.
// ---------------------------------------------------------------------------

class WireShapeError extends Error {}

function shapeFail(): never {
  throw new WireShapeError("wire shape mismatch");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) shapeFail();
  return value;
}

/** First present alias, required to be a string. */
function wireString(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string") shapeFail();
    return value;
  }
  return shapeFail();
}

function wireOptionalString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") shapeFail();
    return value;
  }
  return null;
}

function wireNumber(source: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) shapeFail();
    return value;
  }
  return shapeFail();
}

function wireOptionalNumber(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) shapeFail();
    return value;
  }
  return null;
}

function wireBoolean(source: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") shapeFail();
    return value;
  }
  return shapeFail();
}

function wireArray(source: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) shapeFail();
    return value;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Gateway types (camelCase — exactly what the renderer expects)
// ---------------------------------------------------------------------------

export interface GatewayAccount {
  userId: number;
  email: string;
  nickname: string;
  avatar: string;
}

export interface GatewayAccountView {
  providerId: string;
  supported: boolean;
  loggedIn: boolean;
  account: GatewayAccount | null;
  expires: number | null;
}

interface GatewayWallet {
  balanceMicro: number;
  frozenMicro: number;
  totalTopupMicro: number;
  totalSpendMicro: number;
}

interface GatewayOwnedPackage {
  id: number;
  name: string;
  status: string;
  meterBy: string;
  quotaPerWindow: number;
  totalQuotaCap: number;
  totalUsed: number;
  windowRemaining: number;
  validUntil: string | null;
}

interface GatewayConsumption {
  requestId: string;
  publicModel: string;
  amountMicro: number;
  userPackageId: number;
  cardMeasure: number;
  createdAt: string;
}

interface GatewayPaymentChannels {
  alipay: boolean;
  wechat: boolean;
}

interface GatewayQuotaView {
  wallet: GatewayWallet;
  packages: GatewayOwnedPackage[];
  recentConsumption: GatewayConsumption[];
  paymentChannels: GatewayPaymentChannels;
}

interface GatewayCatalogPackage {
  id: number;
  name: string;
  description: string;
  meterBy: string;
  quotaPerWindow: number;
  validDays: number;
  maxPurchasesPerUser: number;
  priceMicro: number;
}

interface GatewayPackageCatalog {
  items: GatewayCatalogPackage[];
  paymentChannels: GatewayPaymentChannels;
}

interface GatewayPackageOrder {
  orderNo: string;
  packageId: number;
  packageName: string;
  provider: string;
  payAmountMicro: number;
  payAmountCny: string;
  paymentUrl: string;
  status: number;
}

interface GatewayOrderStatus {
  orderNo: string;
  packageId: number;
  provider: string;
  payAmountMicro: number;
  status: number;
  paidAt: string | null;
  promotionStatus: string | null;
  promotionMessage: string | null;
}

interface Discovery {
  issuer: string;
  responsesApiVersion: number | null;
  wireApis: string[];
  responsesEndpoint: string | null;
  chatCompletionsApiVersion: number | null;
  chatCompletionsEndpoint: string | null;
  anthropicMessagesApiVersion: number | null;
  anthropicMessagesEndpoint: string | null;
  geminiGenerateContentApiVersion: number | null;
  geminiGenerateContentEndpointTemplate: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  sessionEndpoint: string;
  revocationEndpoint: string;
  quotaEndpoint: string | null;
  catalogEndpoint: string | null;
  orderEndpoint: string | null;
  orderStatusEndpoint: string | null;
  clientId: string;
}

interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T | null;
}

// ---------------------------------------------------------------------------
// Gateway wire parsers
// ---------------------------------------------------------------------------

function parseAccount(value: unknown): GatewayAccount {
  const source = asObject(value);
  return {
    userId: wireNumber(source, "userId", "user_id"),
    email: wireString(source, "email"),
    nickname: wireString(source, "nickname"),
    avatar: wireString(source, "avatar"),
  };
}

function parseDiscovery(value: unknown): Discovery {
  const source = asObject(value);
  const wireApis: string[] = [];
  for (const entry of wireArray(source, "wire_apis")) {
    if (typeof entry !== "string") shapeFail();
    wireApis.push(entry);
  }
  return {
    issuer: wireString(source, "issuer"),
    responsesApiVersion: wireOptionalNumber(source, "responses_api_version"),
    wireApis,
    responsesEndpoint: wireOptionalString(source, "responses_endpoint"),
    chatCompletionsApiVersion: wireOptionalNumber(source, "chat_completions_api_version"),
    chatCompletionsEndpoint: wireOptionalString(source, "chat_completions_endpoint"),
    anthropicMessagesApiVersion: wireOptionalNumber(source, "anthropic_messages_api_version"),
    anthropicMessagesEndpoint: wireOptionalString(source, "anthropic_messages_endpoint"),
    geminiGenerateContentApiVersion: wireOptionalNumber(
      source,
      "gemini_generate_content_api_version",
    ),
    geminiGenerateContentEndpointTemplate: wireOptionalString(
      source,
      "gemini_generate_content_endpoint_template",
    ),
    authorizationEndpoint: wireString(source, "authorization_endpoint"),
    tokenEndpoint: wireString(source, "token_endpoint"),
    sessionEndpoint: wireString(source, "session_endpoint"),
    revocationEndpoint: wireString(source, "revocation_endpoint"),
    quotaEndpoint: wireOptionalString(source, "quota_endpoint"),
    catalogEndpoint: wireOptionalString(source, "catalog_endpoint"),
    orderEndpoint: wireOptionalString(source, "order_endpoint"),
    orderStatusEndpoint: wireOptionalString(source, "order_status_endpoint"),
    clientId: wireString(source, "client_id"),
  };
}

function parsePaymentChannels(value: unknown): GatewayPaymentChannels {
  const source = asObject(value);
  return {
    alipay: wireBoolean(source, "alipay"),
    wechat: wireBoolean(source, "wechat"),
  };
}

function parseQuota(value: unknown): GatewayQuotaView {
  const source = asObject(value);
  const wallet = asObject(source["wallet"]);
  const packages: GatewayOwnedPackage[] = [];
  for (const entry of wireArray(source, "packages")) {
    const item = asObject(entry);
    packages.push({
      id: wireNumber(item, "id"),
      name: wireString(item, "name"),
      status: wireString(item, "status"),
      meterBy: wireString(item, "meterBy", "meter_by"),
      quotaPerWindow: wireNumber(item, "quotaPerWindow", "quota_per_window"),
      totalQuotaCap: wireNumber(item, "totalQuotaCap", "total_quota_cap"),
      totalUsed: wireNumber(item, "totalUsed", "total_used"),
      windowRemaining: wireNumber(item, "windowRemaining", "window_remaining"),
      validUntil: wireOptionalString(item, "validUntil", "valid_until"),
    });
  }
  const recentConsumption: GatewayConsumption[] = [];
  for (const entry of wireArray(source, "recentConsumption", "recent_consumption")) {
    const item = asObject(entry);
    recentConsumption.push({
      requestId: wireString(item, "requestId", "request_id"),
      publicModel: wireString(item, "publicModel", "public_model"),
      amountMicro: wireNumber(item, "amountMicro", "amount_micro"),
      userPackageId: wireNumber(item, "userPackageId", "user_package_id"),
      cardMeasure: wireNumber(item, "cardMeasure", "card_measure"),
      createdAt: wireString(item, "createdAt", "created_at"),
    });
  }
  return {
    wallet: {
      balanceMicro: wireNumber(wallet, "balanceMicro", "balance_micro"),
      frozenMicro: wireNumber(wallet, "frozenMicro", "frozen_micro"),
      totalTopupMicro: wireNumber(wallet, "totalTopupMicro", "total_topup_micro"),
      totalSpendMicro: wireNumber(wallet, "totalSpendMicro", "total_spend_micro"),
    },
    packages,
    recentConsumption,
    paymentChannels: parsePaymentChannels(source["paymentChannels"] ?? source["payment_channels"]),
  };
}

function parseCatalog(value: unknown): GatewayPackageCatalog {
  const source = asObject(value);
  const items: GatewayCatalogPackage[] = [];
  for (const entry of wireArray(source, "items")) {
    const item = asObject(entry);
    items.push({
      id: wireNumber(item, "id"),
      name: wireString(item, "name"),
      description: wireString(item, "description"),
      meterBy: wireString(item, "meterBy", "meter_by"),
      quotaPerWindow: wireNumber(item, "quotaPerWindow", "quota_per_window"),
      validDays: wireNumber(item, "validDays", "valid_days"),
      maxPurchasesPerUser: wireNumber(item, "maxPurchasesPerUser", "max_purchases_per_user"),
      priceMicro: wireNumber(item, "priceMicro", "price_micro"),
    });
  }
  return {
    items,
    paymentChannels: parsePaymentChannels(source["paymentChannels"] ?? source["payment_channels"]),
  };
}

function parsePackageOrder(value: unknown): GatewayPackageOrder {
  const source = asObject(value);
  return {
    orderNo: wireString(source, "orderNo", "order_no"),
    packageId: wireNumber(source, "packageId", "package_id"),
    packageName: wireString(source, "packageName", "package_name"),
    provider: wireString(source, "provider"),
    payAmountMicro: wireNumber(source, "payAmountMicro", "pay_amount_micro"),
    payAmountCny: wireString(source, "payAmountCny", "pay_amount_cny"),
    paymentUrl: wireString(source, "paymentUrl", "payment_url"),
    status: wireNumber(source, "status"),
  };
}

function parseOrderStatus(value: unknown): GatewayOrderStatus {
  const source = asObject(value);
  return {
    orderNo: wireString(source, "orderNo", "order_no"),
    packageId: wireNumber(source, "packageId", "package_id"),
    provider: wireString(source, "provider"),
    payAmountMicro: wireNumber(source, "payAmountMicro", "pay_amount_micro"),
    status: wireNumber(source, "status"),
    paidAt: wireOptionalString(source, "paidAt", "paid_at"),
    promotionStatus: wireOptionalString(source, "promotionStatus", "promotion_status"),
    promotionMessage: wireOptionalString(source, "promotionMessage", "promotion_message"),
  };
}

// ---------------------------------------------------------------------------
// Gateway HTTP
// ---------------------------------------------------------------------------

function parseApiResponse<T>(value: unknown, parse: (data: unknown) => T): ApiResponse<T> {
  const source = asObject(value);
  const data = source["data"];
  return {
    success: wireBoolean(source, "success"),
    message: wireOptionalString(source, "message") ?? "",
    data: data === undefined || data === null ? null : parse(data),
  };
}

/** `api_error`: prefer the gateway's own message, fall back to ours. */
function apiError(message: string, fallback: string): string {
  const trimmed = message.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

async function postJson<T>(
  url: string,
  body: unknown,
  parse: (data: unknown) => T,
): Promise<ApiResponse<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_POST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`中转站请求失败：${describe(error)}`);
  }
  try {
    return parseApiResponse(await response.json(), parse);
  } catch {
    throw new Error("中转站返回了无法识别的响应");
  }
}

function endpointOrigin(endpoint: string, invalidMessage: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(invalidMessage);
  }
  if (parsed.hostname.length === 0) throw new Error(invalidMessage);
  return parsed.origin;
}

/**
 * Reject a discovery document that points anywhere but the gateway we asked.
 * A relay that can redirect the token or quota endpoints elsewhere could
 * harvest the session token, so same-origin is enforced before anything is
 * sent.
 */
function validateDiscovery(expectedIssuer: string, discovery: Discovery): void {
  const issuer = gatewayRoot(discovery.issuer);
  if (issuer !== expectedIssuer) throw new Error("中转站登录签发方与当前地址不一致");

  for (const endpoint of [
    discovery.authorizationEndpoint,
    discovery.tokenEndpoint,
    discovery.sessionEndpoint,
    discovery.revocationEndpoint,
  ]) {
    if (endpointOrigin(endpoint, "中转站返回了无效的登录地址") !== issuer) {
      throw new Error("中转站登录端点必须与签发方同源");
    }
  }

  const capabilities = [
    discovery.responsesEndpoint,
    discovery.chatCompletionsEndpoint,
    discovery.anthropicMessagesEndpoint,
    discovery.geminiGenerateContentEndpointTemplate,
    discovery.quotaEndpoint,
    discovery.catalogEndpoint,
    discovery.orderEndpoint,
    discovery.orderStatusEndpoint,
  ];
  for (const endpoint of capabilities) {
    if (endpoint === null) continue;
    if (endpointOrigin(endpoint, "中转站返回了无效的能力地址") !== issuer) {
      throw new Error("中转站能力端点必须与签发方同源");
    }
  }

  if (
    discovery.wireApis.includes("responses") &&
    (discovery.responsesApiVersion !== 1 || discovery.responsesEndpoint === null)
  ) {
    throw new Error("中转站 Responses 能力声明不完整");
  }

  const declared: Array<[string, number | null, string | null]> = [
    ["chat_completions", discovery.chatCompletionsApiVersion, discovery.chatCompletionsEndpoint],
    [
      "anthropic_messages",
      discovery.anthropicMessagesApiVersion,
      discovery.anthropicMessagesEndpoint,
    ],
    [
      "gemini_generate_content",
      discovery.geminiGenerateContentApiVersion,
      discovery.geminiGenerateContentEndpointTemplate,
    ],
  ];
  for (const [wireApi, version, endpoint] of declared) {
    if (discovery.wireApis.includes(wireApi) && (version !== 1 || endpoint === null)) {
      throw new Error(`中转站 ${wireApi} 能力声明不完整`);
    }
  }
}

async function fetchDiscovery(baseUrl: string): Promise<Discovery> {
  const expectedIssuer = gatewayRoot(baseUrl);
  let response: Response;
  try {
    response = await fetch(`${expectedIssuer}/.well-known/tietiezhi-gateway`, {
      method: "GET",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`无法连接当前中转站：${describe(error)}`);
  }
  if (!response.ok) {
    throw new Error("当前服务不是支持账号登录的 Tietiezhi Gateway");
  }
  let discovery: Discovery;
  try {
    discovery = parseDiscovery(await response.json());
  } catch {
    throw new Error(
      "中转站登录配置无效（服务返回了无法识别的内容，可能是旧版或不兼容的中转站）",
    );
  }
  validateDiscovery(expectedIssuer, discovery);
  return discovery;
}

// ---------------------------------------------------------------------------
// Gateway secrets and provider lookup
// ---------------------------------------------------------------------------

async function clearGatewaySecrets(providerId: string): Promise<void> {
  await deleteGatewaySession(providerId);
  await deleteGatewayApiKey(providerId);
  await deleteGatewayIssuer(providerId);
}

async function storeGatewaySecrets(
  providerId: string,
  issuer: string,
  sessionToken: string,
  apiKey: string,
): Promise<void> {
  await setGatewaySession(providerId, sessionToken);
  await setGatewayApiKey(providerId, apiKey);
  await setGatewayIssuer(providerId, issuer);
}

/**
 * The legacy builtin host has no account endpoints, but builtin accounts live
 * on the official gateway, so auth and billing target it even while chat still
 * uses the stored legacy URL.
 */
async function providerBaseUrl(providerId: string): Promise<string> {
  const settings = await readSettings();
  const provider = settings.providers.find((entry) => entry.id === providerId);
  if (!provider) throw new Error("未找到当前中转站");
  if (providerId === BUILTIN_PROVIDER_ID && isLegacyBuiltinProviderUrl(provider.baseUrl)) {
    return BUILTIN_PROVIDER_URL;
  }
  return provider.baseUrl;
}

function unsupportedAccount(providerId: string): GatewayAccountView {
  return { providerId, supported: false, loggedIn: false, account: null, expires: null };
}

function loggedOutAccount(providerId: string): GatewayAccountView {
  return { providerId, supported: true, loggedIn: false, account: null, expires: null };
}

// ---------------------------------------------------------------------------
// Login callback page
// ---------------------------------------------------------------------------

/**
 * Inline mark instead of the Tauri build's embedded PNG: the page must stay
 * self-contained under its own `img-src data:` policy, and an SVG keeps it a
 * few hundred bytes instead of the ~800 kB a base64 icon would cost.
 */
const APP_ICON_DATA_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#bdf2ff"/><stop offset="1" stop-color="#7657ff"/>' +
    "</linearGradient></defs>" +
    '<rect width="128" height="128" rx="30" fill="url(#g)"/>' +
    '<path d="M36 34h56v15H70v45H58V49H36z" fill="#07080d"/>' +
    "</svg>",
)}`;

const CALLBACK_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'";

function callbackHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#07080d">
  <title>已连接铁铁汁</title>
  <link rel="icon" href="${APP_ICON_DATA_URL}">
  <style>
    :root { color-scheme: dark; font-family: "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif; }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      overflow: hidden;
      color: #f7f8fb;
      background:
        radial-gradient(circle at 18% 18%, rgba(90, 216, 255, .18), transparent 32rem),
        radial-gradient(circle at 82% 76%, rgba(118, 87, 255, .2), transparent 34rem),
        #07080d;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: .24;
      background-image:
        radial-gradient(circle, rgba(255, 255, 255, .8) 0 1px, transparent 1.2px),
        radial-gradient(circle, rgba(139, 223, 255, .65) 0 1px, transparent 1.2px);
      background-position: 0 0, 36px 52px;
      background-size: 92px 92px, 136px 136px;
      mask-image: linear-gradient(to bottom, black, transparent 92%);
    }
    main {
      position: relative;
      width: min(92vw, 500px);
      padding: 42px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, .12);
      border-radius: 30px;
      background: linear-gradient(145deg, rgba(28, 31, 43, .82), rgba(12, 14, 21, .72));
      box-shadow: inset 0 1px rgba(255, 255, 255, .1), 0 32px 100px rgba(0, 0, 0, .52);
      backdrop-filter: blur(28px);
    }
    main::after {
      content: "";
      position: absolute;
      width: 220px;
      height: 220px;
      top: -150px;
      right: -80px;
      border-radius: 999px;
      background: rgba(90, 216, 255, .18);
      filter: blur(18px);
    }
    .brand {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 38px;
      color: rgba(255, 255, 255, .78);
      font-size: 13px;
      font-weight: 650;
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    .brand img {
      width: 42px;
      height: 42px;
      border-radius: 13px;
      filter: drop-shadow(0 8px 18px rgba(90, 216, 255, .22));
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 18px;
      padding: 7px 11px;
      border: 1px solid rgba(90, 216, 255, .22);
      border-radius: 999px;
      color: #b9efff;
      background: rgba(90, 216, 255, .08);
      font-size: 12px;
      font-weight: 650;
    }
    .status i {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #75e3ff;
      box-shadow: 0 0 16px #75e3ff;
    }
    h1 {
      margin: 0;
      font-size: clamp(30px, 7vw, 45px);
      line-height: 1.08;
      letter-spacing: -.045em;
    }
    p {
      max-width: 380px;
      margin: 16px 0 30px;
      color: rgba(240, 243, 250, .62);
      font-size: 15px;
      line-height: 1.7;
    }
    button {
      width: 100%;
      min-height: 54px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border: 0;
      border-radius: 17px;
      color: #090b12;
      background: linear-gradient(120deg, #bdf2ff, #d8ccff);
      box-shadow: 0 14px 34px rgba(105, 204, 255, .2);
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      font-weight: 750;
      transition: transform .2s ease, box-shadow .2s ease, opacity .2s ease;
    }
    button:hover { transform: translateY(-2px); box-shadow: 0 18px 42px rgba(105, 204, 255, .28); }
    button:active { transform: translateY(0); }
    button:focus-visible { outline: 3px solid rgba(139, 223, 255, .42); outline-offset: 3px; }
    button:disabled { cursor: wait; opacity: .72; transform: none; }
    button svg { width: 18px; height: 18px; }
    .hint {
      margin: 18px 0 0;
      text-align: center;
      color: rgba(240, 243, 250, .38);
      font-size: 12px;
    }
    @media (max-width: 560px) {
      main { padding: 30px 24px; border-radius: 24px; }
      .brand { margin-bottom: 30px; }
    }
    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
    }
  </style>
</head>
<body>
  <main>
    <div class="brand">
      <img src="${APP_ICON_DATA_URL}" alt="">
      <span>Tietiezhi Desktop</span>
    </div>
    <div class="status"><i></i><span>安全连接已建立</span></div>
    <h1>已连接铁铁汁</h1>
    <p>账号授权已经完成。返回桌面端后即可继续使用中转站账号、模型和额度服务。</p>
    <button id="return-button" type="button">
      <span id="return-label">返回铁铁汁</span>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="hint" id="return-hint">也可以关闭此页面，手动返回桌面端</div>
  </main>
  <script>
    const button = document.getElementById("return-button");
    const label = document.getElementById("return-label");
    const hint = document.getElementById("return-hint");
    button.addEventListener("click", async () => {
      button.disabled = true;
      label.textContent = "正在返回…";
      try {
        const response = await fetch("/return", { cache: "no-store" });
        if (!response.ok) throw new Error("focus request failed");
        label.textContent = "已返回铁铁汁";
        hint.textContent = "此页面现在可以安全关闭";
        window.setTimeout(() => window.close(), 500);
      } catch {
        button.disabled = false;
        label.textContent = "重新返回铁铁汁";
        hint.textContent = "未能自动切换，请手动返回桌面端";
      }
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Login callback server
// ---------------------------------------------------------------------------

function callerWindow(): BrowserWindow | null {
  const sender = currentInvocation()?.sender;
  if (!sender || sender.isDestroyed()) return null;
  return BrowserWindow.fromWebContents(sender);
}

function focusApp(preferred: BrowserWindow | null): void {
  const target =
    preferred && !preferred.isDestroyed() ? preferred : (BrowserWindow.getAllWindows()[0] ?? null);
  if (!target || target.isDestroyed()) return;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

interface CallbackServer {
  port: number;
  /** Resolves with the authorization code, rejects on timeout or a bad callback. */
  code: Promise<{ code: string; state: string }>;
  /** Keep serving `/return` so the page can refocus the app, then shut down. */
  release(): void;
  close(): void;
}

async function startCallbackServer(focusTarget: BrowserWindow | null): Promise<CallbackServer> {
  let settle: ((value: { code: string; state: string }) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;
  const code = new Promise<{ code: string; state: string }>((resolve, fail) => {
    settle = resolve;
    reject = fail;
  });

  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;

  const close = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    server?.close();
    // `close()` only stops accepting; a browser keep-alive socket would hold
    // the port (and the process handle) until it times out on its own.
    server?.closeAllConnections();
  };

  // `/return` is only meaningful after the code has arrived; the redirect URI
  // (and therefore the port) is handed to a user-supplied gateway, so anything
  // that can reach loopback could otherwise hit `/return` first and tear the
  // server down while the code promise is still pending — leaving the login
  // invoke hanging forever, since `close()` neither settles nor rejects.
  let codeReceived = false;

  server = createServer((request, response) => {
    const parsed = new URL(request.url ?? "/", "http://127.0.0.1");
    if (parsed.pathname === "/return") {
      response.writeHead(204, { "Cache-Control": "no-store", Connection: "close" });
      if (codeReceived) {
        // Shut down only once the reply is on the wire: `closeAllConnections()`
        // destroys the socket, and the page treats a cut-off reply as a failure.
        response.end(() => close());
        focusApp(focusTarget);
      } else {
        response.end();
      }
      return;
    }
    if (parsed.pathname !== "/callback") {
      response.writeHead(404, { "Content-Length": "0", Connection: "close" });
      response.end();
      return;
    }
    const authorizationCode = parsed.searchParams.get("code") ?? "";
    if (authorizationCode.length === 0) {
      response.writeHead(400, { "Content-Length": "0", Connection: "close" });
      response.end(() => close());
      reject?.(new Error("中转站未返回授权码"));
      return;
    }
    const html = callbackHtml();
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CALLBACK_CSP,
      "Cache-Control": "no-store",
      "Content-Length": String(Buffer.byteLength(html, "utf8")),
      Connection: "close",
    });
    response.end(html);
    codeReceived = true;
    settle?.({ code: authorizationCode, state: parsed.searchParams.get("state") ?? "" });
  });

  const port = await new Promise<number>((resolve, fail) => {
    server?.once("error", (error) => fail(new Error(`无法启动登录回调：${describe(error)}`)));
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (address === null || address === undefined || typeof address === "string") {
        fail(new Error("无法读取登录回调地址：监听地址不可用"));
        return;
      }
      resolve(address.port);
    });
  });

  timer = setTimeout(() => {
    reject?.(new Error("登录等待超时，请重试"));
    close();
  }, LOGIN_TIMEOUT_MS);
  timer.unref();

  return {
    port,
    code,
    release: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(close, LOGIN_TIMEOUT_MS);
      timer.unref();
    },
    close,
  };
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/**
 * Stable per-install id the gateway registers the session against. Adopts the
 * Tauri build's value when present so an upgrade does not look like a second
 * device to an account with a device limit; the legacy file is only read.
 */
async function loadOrCreateDeviceId(): Promise<string> {
  const path = dataPath("device-id");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch {
    // Not provisioned in the host directory yet.
  }

  let value = "";
  try {
    value = (await readFile(join(legacyDataDir(), "device-id"), "utf8")).trim();
  } catch {
    value = "";
  }
  if (value.length === 0) value = randomUUID();

  try {
    await mkdir(dataPath(), { recursive: true });
  } catch (error) {
    throw new Error(`创建配置目录失败：${describe(error)}`);
  }
  try {
    await writeFile(path, value, "utf8");
  } catch (error) {
    throw new Error(`保存设备标识失败：${describe(error)}`);
  }
  return value;
}

function desktopDeviceName(): string {
  switch (process.platform) {
    case "darwin":
      return "Mac 上的铁铁汁";
    case "win32":
      return "Windows 上的铁铁汁";
    default:
      return "铁铁汁桌面端";
  }
}

/** 32 hex characters, the same shape as Rust's `Uuid::simple()`. */
function randomUrlSafe(): string {
  return randomUUID().replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// Gateway commands
// ---------------------------------------------------------------------------

async function gatewayAccountView(providerId: string): Promise<GatewayAccountView> {
  const baseUrl = await providerBaseUrl(providerId);
  let discovery: Discovery;
  try {
    discovery = await fetchDiscovery(baseUrl);
  } catch {
    // An unreachable or non-gateway relay is simply "no account support here".
    return unsupportedAccount(providerId);
  }

  const issuer = gatewayRoot(baseUrl);
  if ((await getGatewayIssuer(providerId)) !== issuer) {
    await clearGatewaySecrets(providerId);
    return loggedOutAccount(providerId);
  }
  const sessionToken = await getGatewaySession(providerId);
  if (sessionToken === null) {
    await clearGatewaySecrets(providerId);
    return loggedOutAccount(providerId);
  }

  const result = await postJson(
    discovery.sessionEndpoint,
    { session_token: sessionToken },
    (data) => {
      const source = asObject(data);
      return {
        expires: wireNumber(source, "expires"),
        account: parseAccount(source["account"]),
      };
    },
  );
  if (!result.success || result.data === null) {
    await clearGatewaySecrets(providerId);
    return loggedOutAccount(providerId);
  }
  return {
    providerId,
    supported: true,
    loggedIn: true,
    account: result.data.account,
    expires: result.data.expires,
  };
}

async function gatewayLogin(providerId: string): Promise<GatewayAccountView> {
  const baseUrl = await providerBaseUrl(providerId);
  const discovery = await fetchDiscovery(baseUrl);
  if (discovery.clientId !== CLIENT_ID) {
    throw new Error("当前中转站不支持此版本的铁铁汁登录");
  }

  const focusTarget = callerWindow();
  const server = await startCallbackServer(focusTarget);
  try {
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;
    const stateValue = randomUrlSafe();
    const verifier = `${randomUrlSafe()}${randomUrlSafe()}`;
    const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
    const deviceId = await loadOrCreateDeviceId();

    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(discovery.authorizationEndpoint);
    } catch {
      throw new Error("中转站返回了无效的登录地址");
    }
    authorizeUrl.searchParams.append("client_id", CLIENT_ID);
    authorizeUrl.searchParams.append("device_id", deviceId);
    authorizeUrl.searchParams.append("device_name", desktopDeviceName());
    authorizeUrl.searchParams.append("redirect_uri", redirectUri);
    authorizeUrl.searchParams.append("code_challenge", challenge);
    authorizeUrl.searchParams.append("code_challenge_method", "S256");
    authorizeUrl.searchParams.append("state", stateValue);

    try {
      await shell.openExternal(authorizeUrl.toString());
    } catch (error) {
      throw new Error(`无法打开系统浏览器：${describe(error)}`);
    }

    const callback = await server.code;
    // The page keeps its「返回铁铁汁」button, so the listener outlives the code.
    server.release();
    if (callback.state !== stateValue) {
      throw new Error("登录状态校验失败，请重试");
    }

    const token = await postJson(
      discovery.tokenEndpoint,
      {
        client_id: CLIENT_ID,
        code: callback.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      },
      (data) => {
        const source = asObject(data);
        return {
          sessionToken: wireString(source, "session_token"),
          apiKey: wireString(source, "api_key"),
          expires: wireNumber(source, "expires"),
          account: parseAccount(source["account"]),
        };
      },
    );
    if (!token.success || token.data === null) {
      throw new Error(apiError(token.message, "登录失败"));
    }

    const issuer = gatewayRoot(baseUrl);
    try {
      await storeGatewaySecrets(providerId, issuer, token.data.sessionToken, token.data.apiKey);
    } catch (error) {
      // A half-written credential set would make the account look logged in
      // while every request failed, so roll the whole thing back.
      await clearGatewaySecrets(providerId).catch(() => undefined);
      throw new Error(describe(error));
    }

    // The new session belongs to the official gateway; migrate a leftover
    // legacy builtin URL so chat and account use the same host from now on.
    if (providerId === BUILTIN_PROVIDER_ID) {
      try {
        await upgradeLegacyBuiltinProviderUrl();
      } catch (error) {
        console.error(`[gateway] 迁移旧版内置中转站地址失败：${describe(error)}`);
      }
    }

    return {
      providerId,
      supported: true,
      loggedIn: true,
      account: token.data.account,
      expires: token.data.expires,
    };
  } catch (error) {
    server.close();
    throw error;
  }
}

async function gatewayLogout(providerId: string): Promise<void> {
  const session = await getGatewaySession(providerId);
  let baseUrl = await getGatewayIssuer(providerId);
  if (baseUrl === null) {
    try {
      baseUrl = await providerBaseUrl(providerId);
    } catch {
      baseUrl = null;
    }
  }
  if (session !== null && baseUrl !== null) {
    try {
      const discovery = await fetchDiscovery(baseUrl);
      await postJson(discovery.revocationEndpoint, { session_token: session }, () => null);
    } catch {
      // Best effort: the local credentials are dropped either way.
    }
  }
  await clearGatewaySecrets(providerId);
}

/** Billing endpoints need a live session bound to the configured issuer. */
async function billingContext(providerId: string): Promise<{ discovery: Discovery; session: string }> {
  const baseUrl = await providerBaseUrl(providerId);
  const issuer = gatewayRoot(baseUrl);
  if ((await getGatewayIssuer(providerId)) !== issuer) {
    throw new Error("请先登录当前中转站");
  }
  const session = await getGatewaySession(providerId);
  if (session === null) throw new Error("请先登录当前中转站");
  return { discovery: await fetchDiscovery(baseUrl), session };
}

function requireEndpoint(endpoint: string | null, message: string): string {
  if (endpoint === null) throw new Error(message);
  return endpoint;
}

async function gatewayQuota(providerId: string): Promise<GatewayQuotaView> {
  const { discovery, session } = await billingContext(providerId);
  const endpoint = requireEndpoint(discovery.quotaEndpoint, "当前中转站版本不支持额度中心");
  const result = await postJson(endpoint, { session_token: session }, parseQuota);
  if (!result.success || result.data === null) {
    throw new Error(apiError(result.message, "获取额度失败"));
  }
  return result.data;
}

async function gatewayPackageCatalog(providerId: string): Promise<GatewayPackageCatalog> {
  const { discovery, session } = await billingContext(providerId);
  const endpoint = requireEndpoint(discovery.catalogEndpoint, "当前中转站版本不支持套餐目录");
  const result = await postJson(endpoint, { session_token: session }, parseCatalog);
  if (!result.success || result.data === null) {
    throw new Error(apiError(result.message, "获取套餐失败"));
  }
  return result.data;
}

async function gatewayCreatePackageOrder(
  providerId: string,
  packageId: number,
  paymentProvider: string,
): Promise<GatewayPackageOrder> {
  if (paymentProvider !== "alipay" && paymentProvider !== "wechat") {
    throw new Error("不支持的支付方式");
  }
  const { discovery, session } = await billingContext(providerId);
  const endpoint = requireEndpoint(discovery.orderEndpoint, "当前中转站版本不支持桌面购买");
  const result = await postJson(
    endpoint,
    { session_token: session, package_id: packageId, provider: paymentProvider },
    parsePackageOrder,
  );
  if (!result.success || result.data === null) {
    throw new Error(apiError(result.message, "创建订单失败"));
  }
  const order = result.data;
  try {
    await shell.openExternal(checkedPaymentUrl(order.paymentUrl));
  } catch (error) {
    throw new Error(`无法打开系统浏览器：${describe(error)}`);
  }
  return order;
}

/**
 * The gateway base URL is user-supplied, so the order response is untrusted
 * input. Every other endpoint in this file goes through `validateDiscovery`'s
 * same-origin check; the payment URL cannot (payment legitimately hands off to
 * a third-party processor), so the bar is the scheme.
 *
 * Handing an unchecked string to `shell.openExternal` lets the remote side pick
 * the handler: `file://` opens local content, and OS-registered schemes can
 * launch other applications with attacker-chosen arguments.
 */
function checkedPaymentUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("中转站返回的支付地址无效");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`中转站返回的支付地址协议不被允许：${parsed.protocol}`);
  }
  return parsed.toString();
}

async function gatewayPackageOrderStatus(
  providerId: string,
  orderNo: string,
): Promise<GatewayOrderStatus> {
  const { discovery, session } = await billingContext(providerId);
  const endpoint = requireEndpoint(discovery.orderStatusEndpoint, "当前中转站版本不支持订单查询");
  const result = await postJson(
    endpoint,
    { session_token: session, order_no: orderNo },
    parseOrderStatus,
  );
  if (!result.success || result.data === null) {
    throw new Error(apiError(result.message, "查询订单失败"));
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Create: types
// ---------------------------------------------------------------------------

interface CreateImageRequest {
  providerId: string;
  model: string;
  prompt: string;
  aspectRatio: string;
  quality: string;
  resultCount: number;
  referencePaths: string[];
}

interface CreateImageResult {
  providerId: string;
  model: string;
  filePath: string;
  mimeType: string;
  revisedPrompt: string | null;
}

interface CreateVideoRequest {
  providerId: string;
  model: string;
  prompt: string;
  aspectRatio: string;
  quality: string;
  durationSeconds: number;
  referencePath: string | null;
}

interface CreateVideoResult {
  providerId: string;
  model: string;
  filePath: string;
  mimeType: string;
  durationSeconds: number;
}

type CreateVideoEvent =
  | { type: "started"; providerId: string; model: string }
  | { type: "progress"; progress: number; status: string }
  | { type: "completed"; result: CreateVideoResult }
  | { type: "cancelled" }
  | { type: "error"; message: string };

interface VideoJob {
  id: string;
  status: string;
  progress: number | null;
  error: unknown;
}

// ---------------------------------------------------------------------------
// Create: cancellation
// ---------------------------------------------------------------------------

/**
 * Cooperative cancellation for one generation request. The abort controller
 * kills the in-flight fetch; `cancelled` then distinguishes a user cancel from
 * a real timeout, which abort alone cannot express.
 */
class CancelToken {
  private flag = false;
  private waiters: Array<() => void> = [];
  private readonly controller = new AbortController();

  get cancelled(): boolean {
    return this.flag;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    if (this.flag) return;
    this.flag = true;
    this.controller.abort();
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  /** Resolves early when cancelled, so a poll interval stays interruptible. */
  sleep(milliseconds: number): Promise<void> {
    if (this.flag) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        resolve();
      }, milliseconds);
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wake);
    });
  }
}

const createCancels = new Map<number, CancelToken>();

function requestSignal(timeoutMs: number, token?: CancelToken): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return token ? AbortSignal.any([timeout, token.signal]) : timeout;
}

// ---------------------------------------------------------------------------
// Create: model selection and request shaping
// ---------------------------------------------------------------------------

async function resolveSelection(
  requestedProviderId: string,
  requestedModel: string,
  kind: ModelKind,
  label: string,
): Promise<{ providerId: string; model: string }> {
  const settings = await readSettings();
  if (requestedProviderId.length > 0 || requestedModel.length > 0) {
    if (requestedProviderId.length === 0 || requestedModel.length === 0) {
      throw new Error(`${label}模型选择不完整，请重新选择模型`);
    }
    const provider = settings.providers.find((entry) => entry.id === requestedProviderId);
    if (!provider) throw new Error(`找不到所选${label}模型供应商`);
    const model = provider.models.find((entry) => entry.id === requestedModel);
    if (!model) throw new Error(`所选${label}模型已不存在，请重新获取模型`);
    if (effectiveKind(model) !== kind) {
      throw new Error(`模型「${requestedModel}」不是${label}生成模型`);
    }
    return { providerId: requestedProviderId, model: requestedModel };
  }

  for (const provider of settings.providers) {
    const model = provider.models.find((entry) => effectiveKind(entry) === kind);
    if (model) return { providerId: provider.id, model: model.id };
  }
  throw new Error(`没有可用的${label}模型，请先到「设置 → 供应商」获取模型`);
}

function imageQuality(model: string, quality: string): string {
  if (model.toLowerCase().includes("dall-e")) return quality === "high" ? "hd" : "standard";
  return quality === "standard" ? "medium" : "high";
}

function sizeForAspectRatio(aspectRatio: string): string {
  switch (aspectRatio) {
    case "1:1":
      return "1024x1024";
    case "9:16":
    case "3:4":
      return "1024x1536";
    case "4:3":
    case "16:9":
    case "21:9":
      return "1536x1024";
    default:
      return "auto";
  }
}

function videoSize(aspectRatio: string, quality: string): string {
  const portrait = aspectRatio === "9:16" || aspectRatio === "3:4";
  if (portrait) return quality === "high" ? "1024x1792" : "720x1280";
  return quality === "high" ? "1792x1024" : "1280x720";
}

function imageRequestBody(request: CreateImageRequest, model: string): Record<string, unknown> {
  const isDalle = model.toLowerCase().includes("dall-e");
  const body: Record<string, unknown> = {
    model,
    prompt: request.prompt.trim(),
    n: clamp(request.resultCount, 1, 4),
    size: sizeForAspectRatio(request.aspectRatio),
    quality: imageQuality(model, request.quality),
  };
  if (isDalle) body["response_format"] = "b64_json";
  else body["output_format"] = "png";
  return body;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/vnd.microsoft.icon",
  ".jfif": "image/jpeg",
  ".jpe": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

/** Reference images travel as multipart parts; the caps mirror the Rust build. */
async function referenceImagePart(filePath: string): Promise<{ blob: Blob; fileName: string }> {
  let path: string;
  try {
    path = await realpath(filePath);
  } catch (error) {
    throw new Error(`无法读取参考图：${describe(error)}`);
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    throw new Error(`读取参考图信息失败：${describe(error)}`);
  }
  if (!info.isFile()) throw new Error("参考图不是普通文件");
  if (info.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error("参考图超过 20 MB，请压缩后再添加");
  }
  const mimeType = IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()];
  if (mimeType === undefined) throw new Error("参考文件不是支持的图片格式");
  const fileName = basename(path).length > 0 ? basename(path) : "reference.png";
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(`读取参考图失败：${describe(error)}`);
  }
  return { blob: new Blob([toBlobPart(bytes)], { type: mimeType }), fileName };
}

/** `Buffer`'s backing store is `ArrayBufferLike`; `Blob` wants a plain view. */
function toBlobPart(bytes: Buffer): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

async function imageEditForm(request: CreateImageRequest, model: string): Promise<FormData> {
  const paths = request.referencePaths
    .filter((path) => path.trim().length > 0)
    .slice(0, MAX_IMAGE_REFERENCES);
  if (paths.length === 0) throw new Error("请先选择有效的参考图");

  const form = new FormData();
  form.append("model", model);
  form.append("prompt", request.prompt.trim());
  form.append("n", String(clamp(request.resultCount, 1, 4)));
  form.append("size", sizeForAspectRatio(request.aspectRatio));
  form.append("quality", imageQuality(model, request.quality));
  if (model.toLowerCase().includes("dall-e")) form.append("response_format", "b64_json");
  else form.append("output_format", "png");

  const field = paths.length === 1 ? "image" : "image[]";
  for (const path of paths) {
    const part = await referenceImagePart(path);
    form.append(field, part.blob, part.fileName);
  }
  return form;
}

// ---------------------------------------------------------------------------
// Create: image bytes
// ---------------------------------------------------------------------------

/**
 * Rust's base64 engines reject anything outside the alphabet and demand
 * canonical padding; `Buffer.from(_, "base64")` silently skips bad characters,
 * so the input is validated first rather than storing a truncated image.
 */
function isCanonicalBase64(value: string): boolean {
  const match = /^([^=]*)(={0,2})$/.exec(value);
  if (!match) return false;
  const body = match[1] ?? "";
  const padding = match[2] ?? "";
  if (!/^[A-Za-z0-9+/]*$/.test(body) && !/^[A-Za-z0-9\-_]*$/.test(body)) return false;
  if ((body.length + padding.length) % 4 !== 0) return false;
  switch (body.length % 4) {
    case 0:
      return padding.length === 0;
    case 2:
      return padding.length === 2;
    case 3:
      return padding.length === 1;
    default:
      return false;
  }
}

function decodeImageData(value: string): Buffer {
  const comma = value.indexOf(",");
  const encoded = (
    comma >= 0 && value.slice(0, comma).includes("base64") ? value.slice(comma + 1) : value
  ).trim();
  // Reject before decoding: a 40 MB cap on the bytes still lets a hostile
  // payload allocate the whole decoded buffer first.
  if (encoded.length > Math.ceil((MAX_GENERATED_IMAGE_BYTES / 3) * 4) + 4) {
    throw new Error("生成图片超过 40 MB");
  }
  if (!isCanonicalBase64(encoded)) throw new Error("图片模型返回了无效的 Base64 数据");
  return validateImageSize(Buffer.from(encoded, "base64"));
}

function validateImageSize(bytes: Buffer): Buffer {
  if (bytes.length === 0) throw new Error("图片模型返回了空文件");
  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) throw new Error("生成图片超过 40 MB");
  return bytes;
}

function httpStatusText(response: Response): string {
  return response.statusText.length > 0
    ? `${response.status} ${response.statusText}`
    : String(response.status);
}

async function downloadGeneratedImage(url: string): Promise<Buffer> {
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error("图片模型返回了不支持的下载地址");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`下载生成图片失败：${describe(error)}`);
  }
  if (!response.ok) throw new Error(`下载生成图片失败：HTTP ${httpStatusText(response)}`);
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error("生成图片超过 40 MB");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`读取生成图片失败：${describe(error)}`);
  }
  return validateImageSize(bytes);
}

function detectImageFormat(bytes: Buffer): { mimeType: string; extension: string } {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }
  const magic = bytes.length >= 6 ? bytes.subarray(0, 6).toString("latin1") : "";
  if (magic === "GIF87a" || magic === "GIF89a") {
    return { mimeType: "image/gif", extension: "gif" };
  }
  throw new Error("图片模型返回的文件格式不受支持");
}

// ---------------------------------------------------------------------------
// Create: asset directory
// ---------------------------------------------------------------------------

/** Served to the renderer through `tietiezhi-asset://`, which is scoped here. */
function createAssetsDir(): string {
  return dataPath("create-assets");
}

async function ensureCreateAssetsDir(): Promise<string> {
  const directory = createAssetsDir();
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    throw new Error(`创建作品目录失败：${describe(error)}`);
  }
  return directory;
}

async function checkedCreateAssetPath(filePath: string): Promise<string> {
  let root: string;
  try {
    root = await realpath(createAssetsDir());
  } catch (error) {
    throw new Error(`无法定位作品目录：${describe(error)}`);
  }
  let path: string;
  try {
    path = await realpath(filePath);
  } catch (error) {
    throw new Error(`无法读取作品文件：${describe(error)}`);
  }
  // Component-wise containment: a plain prefix test would accept a sibling
  // directory whose name merely starts with the root's name.
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const inside = path === root || path.startsWith(prefix);
  let isFile = false;
  try {
    isFile = (await stat(path)).isFile();
  } catch {
    isFile = false;
  }
  if (!inside || !isFile) throw new Error("作品文件路径无效");
  return path;
}

// ---------------------------------------------------------------------------
// Create: image generation
// ---------------------------------------------------------------------------

function parseImageItems(raw: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`图片模型响应格式不正确：${snippet(raw)}`);
  }
  if (!isRecord(parsed)) throw new Error(`图片模型响应格式不正确：${snippet(raw)}`);
  const data = parsed["data"];
  if (data === undefined || data === null) return [];
  if (!Array.isArray(data)) throw new Error(`图片模型响应格式不正确：${snippet(raw)}`);
  const items: Array<Record<string, unknown>> = [];
  for (const entry of data) {
    if (!isRecord(entry)) throw new Error(`图片模型响应格式不正确：${snippet(raw)}`);
    items.push(entry);
  }
  return items;
}

function optionalWireString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

async function generateCreateImage(request: CreateImageRequest): Promise<CreateImageResult[]> {
  const prompt = request.prompt.trim();
  if (prompt.length === 0) throw new Error("请先填写图片生成描述");

  const selection = await resolveSelection(
    request.providerId.trim(),
    request.model.trim(),
    "image",
    "图片",
  );
  const provider = await resolveProvider(selection.providerId);
  const base = provider.baseUrl.trim();
  if (base.length === 0) throw new Error("图片模型供应商未配置 baseURL");
  const key = provider.key !== null && provider.key.trim().length > 0 ? provider.key : null;
  if (key === null) {
    throw new Error("图片模型供应商缺少 API Key，请到「设置 → 供应商」填写");
  }

  const useEdits = request.referencePaths.length > 0;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  let body: BodyInit;
  if (useEdits) {
    body = await imageEditForm(request, selection.model);
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(imageRequestBody(request, selection.model));
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(base, useEdits ? "images/edits" : "images/generations"), {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(useEdits ? IMAGE_EDIT_TIMEOUT_MS : IMAGE_GENERATION_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`图片生成请求失败：${describe(error)}`);
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    throw new Error(`读取图片生成响应失败：${describe(error)}`);
  }
  if (!response.ok) throw new Error(providerHttpError("图片模型", response.status, raw));

  const items = parseImageItems(raw);
  if (items.length === 0) throw new Error("图片模型没有返回生成结果");

  const directory = await ensureCreateAssetsDir();
  const results: CreateImageResult[] = [];
  for (const item of items.slice(0, clamp(request.resultCount, 1, 4))) {
    const encoded = optionalWireString(item, "b64_json");
    const url = optionalWireString(item, "url");
    let bytes: Buffer;
    if (encoded !== null) bytes = decodeImageData(encoded);
    else if (url !== null) bytes = await downloadGeneratedImage(url);
    else throw new Error("图片模型没有返回 b64_json 或 url");

    const format = detectImageFormat(bytes);
    const path = join(directory, `${randomUUID()}.${format.extension}`);
    try {
      await writeFile(path, bytes);
    } catch (error) {
      throw new Error(`保存生成图片失败：${describe(error)}`);
    }
    results.push({
      providerId: selection.providerId,
      model: selection.model,
      filePath: path,
      mimeType: format.mimeType,
      revisedPrompt: optionalWireString(item, "revised_prompt"),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Create: video generation
// ---------------------------------------------------------------------------

function parseVideoJob(raw: string): VideoJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WireShapeError("invalid job json");
  }
  const source = asObject(parsed);
  const id = source["id"];
  const status = source["status"];
  if (id !== undefined && id !== null && typeof id !== "string") shapeFail();
  if (status !== undefined && status !== null && typeof status !== "string") shapeFail();
  return {
    id: typeof id === "string" ? id : "",
    status: typeof status === "string" ? status : "",
    progress: wireOptionalNumber(source, "progress"),
    error: source["error"] ?? null,
  };
}

function videoJobError(job: VideoJob): string {
  const error = job.error;
  let message: string | null = null;
  if (isRecord(error)) {
    const nested = error["message"];
    if (typeof nested === "string") message = nested;
  } else if (typeof error === "string") {
    message = error;
  }
  if (message === null) return "视频生成失败，供应商没有返回具体原因";
  return `视频生成失败：${message}`;
}

function normalizeVideoMime(value: string): string | null {
  const mime = (value.split(";")[0] ?? "").trim().toLowerCase();
  switch (mime) {
    case "video/mp4":
      return "video/mp4";
    case "video/webm":
      return "video/webm";
    case "video/quicktime":
      return "video/quicktime";
    default:
      return null;
  }
}

function extensionForVideoMime(mimeType: string): string {
  switch (mimeType) {
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    default:
      return "mp4";
  }
}

async function videoGenerationForm(
  request: CreateVideoRequest,
  model: string,
): Promise<FormData> {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", request.prompt.trim());
  form.append("seconds", String(clamp(request.durationSeconds, 1, 60)));
  form.append("size", videoSize(request.aspectRatio, request.quality));
  const reference = request.referencePath?.trim() ?? "";
  if (reference.length > 0) {
    const part = await referenceImagePart(reference);
    form.append("input_reference", part.blob, part.fileName);
  }
  return form;
}

async function cancelRemoteVideo(base: string, key: string, id: string): Promise<void> {
  try {
    await fetch(apiUrl(base, `videos/${id}`), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(VIDEO_CANCEL_TIMEOUT_MS),
    });
  } catch {
    // Cancelling remotely is courtesy; the local task is already gone.
  }
}

async function downloadGeneratedVideo(
  base: string,
  key: string,
  providerId: string,
  model: string,
  jobId: string,
  durationSeconds: number,
  token: CancelToken,
): Promise<CreateVideoResult | null> {
  if (token.cancelled) return null;
  let response: Response;
  try {
    response = await fetch(apiUrl(base, `videos/${jobId}/content`), {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: requestSignal(VIDEO_DOWNLOAD_TIMEOUT_MS, token),
    });
  } catch (error) {
    if (token.cancelled) return null;
    throw new Error(`下载生成视频失败：${describe(error)}`);
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(providerHttpError("下载生成视频失败", response.status, raw));
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_GENERATED_VIDEO_BYTES) {
    throw new Error("生成视频超过 500 MB");
  }
  const mimeType =
    normalizeVideoMime(response.headers.get("content-type") ?? "") ?? "video/mp4";
  const extension = extensionForVideoMime(mimeType);

  const directory = await ensureCreateAssetsDir();
  const id = randomUUID();
  const path = join(directory, `${id}.${extension}`);
  const temporary = join(directory, `${id}.${extension}.download`);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(temporary, "w");
  } catch (error) {
    throw new Error(`创建视频文件失败：${describe(error)}`);
  }

  const discard = async (): Promise<void> => {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  };

  const stream = response.body;
  let written = 0;
  if (stream !== null) {
    const reader = stream.getReader();
    for (;;) {
      if (token.cancelled) {
        await reader.cancel().catch(() => undefined);
        await discard();
        return null;
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (token.cancelled) {
          await discard();
          return null;
        }
        await discard();
        throw new Error(`读取生成视频失败：${describe(error)}`);
      }
      if (chunk.done) break;
      const value = chunk.value;
      written += value.byteLength;
      if (written > MAX_GENERATED_VIDEO_BYTES) {
        await reader.cancel().catch(() => undefined);
        await discard();
        throw new Error("生成视频超过 500 MB");
      }
      try {
        await handle.write(value);
      } catch (error) {
        await discard();
        throw new Error(`写入生成视频失败：${describe(error)}`);
      }
    }
  }

  // fsync before the rename publishes the file, but best-effort: a filesystem
  // that refuses it must not throw away a download that is already complete.
  await handle.sync().catch(() => undefined);
  try {
    await handle.close();
  } catch (error) {
    await discard();
    throw new Error(`写入生成视频失败：${describe(error)}`);
  }
  if (written === 0) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new Error("视频模型返回了空文件");
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new Error(`保存生成视频失败：${describe(error)}`);
  }

  return { providerId, model, filePath: path, mimeType, durationSeconds };
}

/** Returns `null` when the user cancelled; throws with the user-facing text. */
async function runVideoGeneration(
  request: CreateVideoRequest,
  token: CancelToken,
  emit: (event: CreateVideoEvent) => void,
): Promise<CreateVideoResult | null> {
  if (request.prompt.trim().length === 0) throw new Error("请先填写视频生成描述");

  const selection = await resolveSelection(
    request.providerId.trim(),
    request.model.trim(),
    "video",
    "视频",
  );
  const provider = await resolveProvider(selection.providerId);
  if (provider.baseUrl.trim().length === 0) throw new Error("视频模型供应商未配置 baseURL");
  const key = provider.key !== null && provider.key.trim().length > 0 ? provider.key : null;
  if (key === null) {
    throw new Error("视频模型供应商缺少 API Key，请到「设置 → 供应商」填写");
  }
  emit({ type: "started", providerId: selection.providerId, model: selection.model });

  const form = await videoGenerationForm(request, selection.model);
  if (token.cancelled) return null;
  let response: Response;
  try {
    response = await fetch(apiUrl(provider.baseUrl, "videos"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: requestSignal(VIDEO_CREATE_TIMEOUT_MS, token),
    });
  } catch (error) {
    if (token.cancelled) return null;
    throw new Error(`视频生成请求失败：${describe(error)}`);
  }
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    throw new Error(`读取视频生成响应失败：${describe(error)}`);
  }
  if (!response.ok) {
    throw new Error(providerHttpError("视频模型", response.status, raw));
  }
  let job: VideoJob;
  try {
    job = parseVideoJob(raw);
  } catch {
    throw new Error(`视频模型响应格式不正确：${snippet(raw)}`);
  }
  if (job.id.trim().length === 0) throw new Error("视频模型没有返回任务 ID");

  const started = Date.now();
  let lastProgress = 4;
  for (;;) {
    const normalized = job.status.trim().toLowerCase();
    if (normalized === "completed" || normalized === "succeeded") break;
    if (normalized === "failed" || normalized === "error") throw new Error(videoJobError(job));
    if (normalized === "cancelled" || normalized === "canceled") return null;
    if (Date.now() - started > VIDEO_GENERATION_TIMEOUT_MS) {
      throw new Error("视频生成超过 15 分钟，请稍后在供应商控制台检查任务状态");
    }

    lastProgress =
      job.progress === null
        ? Math.min(92, lastProgress + 2)
        : clamp(Math.round(job.progress), 0, 99);
    emit({
      type: "progress",
      progress: lastProgress,
      status: job.status.length === 0 ? "processing" : job.status,
    });

    await token.sleep(VIDEO_POLL_INTERVAL_MS);
    if (token.cancelled) {
      await cancelRemoteVideo(provider.baseUrl, key, job.id);
      return null;
    }

    let poll: Response;
    try {
      poll = await fetch(apiUrl(provider.baseUrl, `videos/${job.id}`), {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: requestSignal(VIDEO_POLL_TIMEOUT_MS, token),
      });
    } catch (error) {
      if (token.cancelled) {
        await cancelRemoteVideo(provider.baseUrl, key, job.id);
        return null;
      }
      throw new Error(`查询视频生成进度失败：${describe(error)}`);
    }
    let pollRaw: string;
    try {
      pollRaw = await poll.text();
    } catch (error) {
      throw new Error(`读取视频生成进度失败：${describe(error)}`);
    }
    if (!poll.ok) {
      throw new Error(providerHttpError("查询视频生成进度失败", poll.status, pollRaw));
    }
    try {
      job = parseVideoJob(pollRaw);
    } catch {
      throw new Error(`视频任务状态格式不正确：${snippet(pollRaw)}`);
    }
  }

  emit({ type: "progress", progress: 96, status: "downloading" });
  return downloadGeneratedVideo(
    provider.baseUrl,
    key,
    selection.providerId,
    selection.model,
    job.id,
    clamp(request.durationSeconds, 0, 65535),
    token,
  );
}

// ---------------------------------------------------------------------------
// Create: assets
// ---------------------------------------------------------------------------

async function readCreateAssetDataUrl(filePath: string): Promise<string> {
  const path = await checkedCreateAssetPath(filePath);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    throw new Error(`读取作品信息失败：${describe(error)}`);
  }
  // Guard before reading: a data URL costs the file plus ~4/3 of it as a
  // string, so an oversized asset is refused rather than exhausting memory.
  if (info.size > MAX_GENERATED_IMAGE_BYTES) throw new Error("图片作品超过 40 MB");
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(`读取作品文件失败：${describe(error)}`);
  }
  const format = detectImageFormat(bytes);
  return `data:${format.mimeType};base64,${bytes.toString("base64")}`;
}

async function exportCreateAsset(filePath: string): Promise<string | null> {
  const source = await checkedCreateAssetPath(filePath);
  const fileName = basename(source);
  if (fileName.length === 0) throw new Error("作品文件名无效");

  const parent = callerWindow();
  const options: Electron.SaveDialogOptions = { title: "导出作品", defaultPath: fileName };
  const result = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || result.filePath === undefined || result.filePath.length === 0) {
    return null;
  }
  try {
    await copyFile(source, result.filePath);
  } catch (error) {
    throw new Error(`导出作品失败：${describe(error)}`);
  }
  return result.filePath;
}

async function deleteCreateAsset(filePath: string): Promise<void> {
  const path = await checkedCreateAssetPath(filePath);
  try {
    await rm(path, { force: false });
  } catch (error) {
    throw new Error(`删除作品文件失败：${describe(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Argument decoding
// ---------------------------------------------------------------------------

function readImageRequest(args: Record<string, unknown>): CreateImageRequest {
  const source = args["request"];
  if (!isRecord(source)) throw new Error("参数 request 无效");
  const paths: string[] = [];
  const raw = source["referencePaths"];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") throw new Error("参数 referencePaths 无效");
      paths.push(entry);
    }
  } else if (raw !== undefined && raw !== null) {
    throw new Error("参数 referencePaths 无效");
  }
  return {
    providerId: requireStringArg(source, "providerId"),
    model: requireStringArg(source, "model"),
    prompt: requireStringArg(source, "prompt"),
    aspectRatio: requireStringArg(source, "aspectRatio"),
    quality: requireStringArg(source, "quality"),
    resultCount: requireNumberArg(source, "resultCount"),
    referencePaths: paths,
  };
}

function readVideoRequest(args: Record<string, unknown>): CreateVideoRequest {
  const source = args["request"];
  if (!isRecord(source)) throw new Error("参数 request 无效");
  const reference = source["referencePath"];
  if (reference !== undefined && reference !== null && typeof reference !== "string") {
    throw new Error("参数 referencePath 无效");
  }
  return {
    providerId: requireStringArg(source, "providerId"),
    model: requireStringArg(source, "model"),
    prompt: requireStringArg(source, "prompt"),
    aspectRatio: requireStringArg(source, "aspectRatio"),
    quality: requireStringArg(source, "quality"),
    durationSeconds: requireNumberArg(source, "durationSeconds"),
    referencePath: typeof reference === "string" ? reference : null,
  };
}

/**
 * Drives one video job and always closes the renderer channel: the frontend
 * releases its callback on the end marker, so an unclosed channel leaks it for
 * the lifetime of the document.
 */
async function handleGenerateCreateVideo(args: Record<string, unknown>): Promise<null> {
  const requestId = requireNumberArg(args, "requestId");
  const request = readVideoRequest(args);
  const channel = parseChannelId(args["onEvent"]);
  if (channel === null) throw new Error("参数 onEvent 无效");
  // Captured now: the sender is read from async-local state, and the final
  // event is emitted after many awaits.
  const sender = currentInvocation()?.sender ?? null;

  const emit = (event: CreateVideoEvent): void => {
    if (sender === null || sender.isDestroyed()) return;
    emitChannel(sender, channel, event);
  };

  const token = new CancelToken();
  createCancels.set(requestId, token);
  let final: CreateVideoEvent;
  try {
    const result = await runVideoGeneration(request, token, emit);
    final = result === null ? { type: "cancelled" } : { type: "completed", result };
  } catch (error) {
    final = { type: "error", message: describe(error) };
  } finally {
    createCancels.delete(requestId);
  }
  emit(final);
  if (sender !== null && !sender.isDestroyed()) closeChannel(sender, channel);
  return null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGatewayCommands(): void {
  registerCommands({
    gateway_account: async (args) => gatewayAccountView(requireStringArg(args, "providerId")),

    gateway_login: async (args) => gatewayLogin(requireStringArg(args, "providerId")),

    gateway_logout: async (args) => {
      await gatewayLogout(requireStringArg(args, "providerId"));
      return null;
    },

    gateway_quota: async (args) => gatewayQuota(requireStringArg(args, "providerId")),

    gateway_package_catalog: async (args) =>
      gatewayPackageCatalog(requireStringArg(args, "providerId")),

    gateway_create_package_order: async (args) =>
      gatewayCreatePackageOrder(
        requireStringArg(args, "providerId"),
        requireNumberArg(args, "packageId"),
        requireStringArg(args, "paymentProvider"),
      ),

    gateway_package_order_status: async (args) =>
      gatewayPackageOrderStatus(
        requireStringArg(args, "providerId"),
        requireStringArg(args, "orderNo"),
      ),

    generate_create_image: async (args) => generateCreateImage(readImageRequest(args)),

    generate_create_video: async (args) => handleGenerateCreateVideo(args),

    cancel_create_generation: async (args) => {
      createCancels.get(requireNumberArg(args, "requestId"))?.cancel();
      return null;
    },

    read_create_asset_data_url: async (args) =>
      readCreateAssetDataUrl(requireStringArg(args, "filePath")),

    export_create_asset: async (args) => exportCreateAsset(requireStringArg(args, "filePath")),

    delete_create_asset: async (args) => {
      await deleteCreateAsset(requireStringArg(args, "filePath"));
      return null;
    },
  });
}
