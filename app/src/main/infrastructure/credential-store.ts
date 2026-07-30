import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { app, safeStorage } from "electron";

interface SecretFile {
  version: 1;
  entries: Record<string, string>;
}

const EMPTY: SecretFile = { version: 1, entries: {} };

function path(): string {
  return join(app.getPath("userData"), "credentials.enc.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function read(): Promise<SecretFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path(), "utf8")) as unknown;
  } catch {
    return { ...EMPTY, entries: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed["entries"])) return { ...EMPTY, entries: {} };
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed["entries"])) {
    if (typeof value === "string") entries[key] = value;
  }
  return { version: 1, entries };
}

async function write(store: SecretFile): Promise<void> {
  const target = path();
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统安全存储不可用，无法安全保存 API Key");
  }
}

export class CredentialStore {
  async set(reference: string, value: string): Promise<void> {
    requireEncryption();
    const encrypted = safeStorage.encryptString(value).toString("base64");
    await serialized(async () => {
      const store = await read();
      store.entries[reference] = encrypted;
      await write(store);
    });
  }

  async get(reference: string): Promise<string | null> {
    requireEncryption();
    const encoded = (await read()).entries[reference];
    if (encoded === undefined) return null;
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  }

  async remove(reference: string): Promise<void> {
    await serialized(async () => {
      const store = await read();
      if (store.entries[reference] === undefined) return;
      delete store.entries[reference];
      await write(store);
    });
  }
}
