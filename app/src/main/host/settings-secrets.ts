/**
 * Secret storage for provider credentials and gateway session material.
 *
 * The Tauri build kept these in the OS credential store via `keyring`. Electron
 * has no equivalent binding without a native module, so the ciphertext lives in
 * `<userData>/secrets.enc.json` and `safeStorage` — which is itself backed by
 * the Keychain / DPAPI / libsecret — holds the key material.
 *
 * There is deliberately no plaintext fallback: AGENTS.md rule 5 forbids API
 * keys on disk in the clear, so an unavailable `safeStorage` is a hard error
 * rather than a downgrade.
 */

import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { safeStorage } from "electron";

import { dataPath, legacyDataDir } from "./paths.js";

const STORE_VERSION = 1;
const STORE_FILE = "secrets.enc.json";
const LEGACY_IMPORT_MARKER = ".legacy-secrets-imported";

/** Legacy plaintext store written by `tauri dev`; read once, never written. */
const LEGACY_DEV_SECRETS = "dev-secrets.json";

/** Account key of the pre multi-provider single relay key. Migration only. */
const LEGACY_API_KEY_ACCOUNT = "relay-api-key";

const UNAVAILABLE =
  "系统安全存储不可用，无法安全保存 API Key。请确认系统钥匙串 / 凭据管理器可正常访问后重试";

interface SecretStore {
  version: number;
  /** account -> base64 ciphertext produced by `safeStorage.encryptString`. */
  entries: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storePath(): string {
  return dataPath(STORE_FILE);
}

// MARK: - Account naming (kept byte-identical to the Tauri build)

export function providerAccount(providerId: string): string {
  return `provider-${providerId}`;
}

export function deviceCoreAccount(coreId: string): string {
  return `device-core-${coreId}`;
}

export function gatewaySessionAccount(providerId: string): string {
  return `gateway-session-${providerId}`;
}

export function gatewayApiKeyAccount(providerId: string): string {
  return `gateway-api-key-${providerId}`;
}

export function gatewayIssuerAccount(providerId: string): string {
  return `gateway-issuer-${providerId}`;
}

export function tietiezhiSecretAccount(name: string): string {
  return `tietiezhi-secret-${name}`;
}

// MARK: - Store I/O

/**
 * Writes are serialized: every mutation is read-modify-write over one small
 * file, so two concurrent `set` calls would otherwise lose one of the secrets.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function backupUnreadable(path: string): Promise<void> {
  const target = `${path}.corrupt-${Date.now()}.bak`;
  try {
    await copyFile(path, target);
  } catch {
    // A backup is best-effort; losing it must not block re-provisioning keys.
  }
}

async function loadStore(): Promise<SecretStore> {
  const path = storePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { version: STORE_VERSION, entries: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await backupUnreadable(path);
    return { version: STORE_VERSION, entries: {} };
  }
  const entries: Record<string, string> = {};
  if (isRecord(parsed) && isRecord(parsed["entries"])) {
    const source = parsed["entries"];
    for (const account of Object.keys(source)) {
      const value = source[account];
      if (typeof value === "string") entries[account] = value;
    }
  }
  return { version: STORE_VERSION, entries };
}

async function saveStore(store: SecretStore): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  // Unique temp name: a shared one would let a second writer truncate the file
  // this rename is about to publish.
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

// MARK: - Encryption

export function isSecretStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encrypt(value: string): string {
  if (!isSecretStorageAvailable()) throw new Error(UNAVAILABLE);
  try {
    return safeStorage.encryptString(value).toString("base64");
  } catch (error) {
    throw new Error(`保存密钥失败：${String(error)}`);
  }
}

function decrypt(ciphertext: string): string {
  if (!isSecretStorageAvailable()) throw new Error(UNAVAILABLE);
  try {
    return safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
  } catch (error) {
    throw new Error(`读取密钥失败：${String(error)}`);
  }
}

// MARK: - One-time migration from the Tauri dev store

let legacyImport: Promise<void> | null = null;

async function importLegacyDevSecrets(): Promise<void> {
  const marker = dataPath(LEGACY_IMPORT_MARKER);
  try {
    await readFile(marker, "utf8");
    return;
  } catch {
    // Not imported yet.
  }

  let imported: Record<string, string> = {};
  try {
    const raw = await readFile(join(legacyDataDir(), LEGACY_DEV_SECRETS), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      for (const account of Object.keys(parsed)) {
        const value = parsed[account];
        if (typeof value === "string" && value.length > 0) imported[account] = value;
      }
    }
  } catch {
    imported = {};
  }

  const accounts = Object.keys(imported);
  // Without encryption the plaintext keys would have to stay plaintext, so the
  // import is skipped entirely and the marker is not written — a later launch
  // on a machine with a working keychain can still pick them up.
  if (accounts.length > 0 && isSecretStorageAvailable()) {
    await serialized(async () => {
      const store = await loadStore();
      let changed = false;
      for (const account of accounts) {
        const value = imported[account];
        if (value === undefined || store.entries[account] !== undefined) continue;
        store.entries[account] = encrypt(value);
        changed = true;
      }
      if (changed) await saveStore(store);
    });
  } else if (accounts.length > 0) {
    return;
  }

  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, new Date().toISOString(), "utf8");
}

function ensureLegacyImport(): Promise<void> {
  if (!legacyImport) {
    legacyImport = importLegacyDevSecrets().catch(() => undefined);
  }
  return legacyImport;
}

// MARK: - Generic accessors

export async function setSecret(account: string, value: string): Promise<void> {
  await ensureLegacyImport();
  const ciphertext = encrypt(value);
  await serialized(async () => {
    const store = await loadStore();
    store.entries[account] = ciphertext;
    await saveStore(store);
  });
}

export async function getSecret(account: string): Promise<string | null> {
  await ensureLegacyImport();
  const store = await loadStore();
  const ciphertext = store.entries[account];
  if (ciphertext === undefined) return null;
  return decrypt(ciphertext);
}

/**
 * Whether a secret exists, without decrypting it. The settings list only needs
 * "is a key configured", and answering that must not fail on a machine where
 * the keychain is momentarily locked.
 */
export async function hasSecret(account: string): Promise<boolean> {
  await ensureLegacyImport();
  const store = await loadStore();
  return store.entries[account] !== undefined;
}

export async function deleteSecret(account: string): Promise<void> {
  await ensureLegacyImport();
  await serialized(async () => {
    const store = await loadStore();
    if (store.entries[account] === undefined) return;
    delete store.entries[account];
    await saveStore(store);
  });
}

// MARK: - Named accessors (mirrors the Tauri `secrets` module)

export function setProviderKey(providerId: string, value: string): Promise<void> {
  return setSecret(providerAccount(providerId), value);
}

export function getProviderKey(providerId: string): Promise<string | null> {
  return getSecret(providerAccount(providerId));
}

export function hasProviderKey(providerId: string): Promise<boolean> {
  return hasSecret(providerAccount(providerId));
}

export function deleteProviderKey(providerId: string): Promise<void> {
  return deleteSecret(providerAccount(providerId));
}

export function setGatewaySession(providerId: string, value: string): Promise<void> {
  return setSecret(gatewaySessionAccount(providerId), value);
}

export function getGatewaySession(providerId: string): Promise<string | null> {
  return getSecret(gatewaySessionAccount(providerId));
}

export function hasGatewaySession(providerId: string): Promise<boolean> {
  return hasSecret(gatewaySessionAccount(providerId));
}

export function deleteGatewaySession(providerId: string): Promise<void> {
  return deleteSecret(gatewaySessionAccount(providerId));
}

export function setGatewayApiKey(providerId: string, value: string): Promise<void> {
  return setSecret(gatewayApiKeyAccount(providerId), value);
}

export function getGatewayApiKey(providerId: string): Promise<string | null> {
  return getSecret(gatewayApiKeyAccount(providerId));
}

export function deleteGatewayApiKey(providerId: string): Promise<void> {
  return deleteSecret(gatewayApiKeyAccount(providerId));
}

export function setGatewayIssuer(providerId: string, value: string): Promise<void> {
  return setSecret(gatewayIssuerAccount(providerId), value);
}

export function getGatewayIssuer(providerId: string): Promise<string | null> {
  return getSecret(gatewayIssuerAccount(providerId));
}

export function deleteGatewayIssuer(providerId: string): Promise<void> {
  return deleteSecret(gatewayIssuerAccount(providerId));
}

export function setDeviceCoreToken(coreId: string, value: string): Promise<void> {
  return setSecret(deviceCoreAccount(coreId), value);
}

export function getDeviceCoreToken(coreId: string): Promise<string | null> {
  return getSecret(deviceCoreAccount(coreId));
}

export function deleteDeviceCoreToken(coreId: string): Promise<void> {
  return deleteSecret(deviceCoreAccount(coreId));
}

export function setTietiezhiSecret(name: string, value: string): Promise<void> {
  return setSecret(tietiezhiSecretAccount(name), value);
}

export function getTietiezhiSecret(name: string): Promise<string | null> {
  return getSecret(tietiezhiSecretAccount(name));
}

export function deleteTietiezhiSecret(name: string): Promise<void> {
  return deleteSecret(tietiezhiSecretAccount(name));
}

/** Legacy single-relay key. Read-only, used by the one-time settings migration. */
export function getLegacyApiKey(): Promise<string | null> {
  return getSecret(LEGACY_API_KEY_ACCOUNT);
}
