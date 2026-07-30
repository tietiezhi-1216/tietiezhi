import { randomUUID } from "node:crypto";

import type {
  ModelMetadata,
  ModelWireAPI,
  ProviderAccount,
  ProviderAccountInput,
} from "@shared/contracts";

import { CredentialStore } from "../infrastructure/credential-store.js";
import { AppDatabase } from "../infrastructure/database.js";

export const BUILTIN_PROVIDER_ID = "builtin-official";
export const BUILTIN_PROVIDER_NAME = "Tietiezhi Gateway";
export const BUILTIN_PROVIDER_URL = "https://tietiezhi.vip/v1";

const WIRE_APIS = new Set<ModelWireAPI>([
  "responses",
  "chat_completions",
  "anthropic_messages",
  "gemini_generate_content",
]);

function defaultBaseURL(type: ProviderAccount["providerType"]): string {
  switch (type) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "google":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "openai-compatible":
      return "";
  }
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${label}不能为空`);
  return normalized;
}

export class ProviderService {
  constructor(
    private readonly database: AppDatabase,
    private readonly credentials: CredentialStore,
    private readonly fetch: typeof globalThis.fetch,
  ) {
    if (database.provider(BUILTIN_PROVIDER_ID) === null) {
      database.saveProvider({
        id: BUILTIN_PROVIDER_ID,
        providerType: "openai-compatible",
        displayName: BUILTIN_PROVIDER_NAME,
        baseURL: BUILTIN_PROVIDER_URL,
        credentialRef: `provider:${BUILTIN_PROVIDER_ID}`,
        enabled: true,
        models: [],
        modelMetadata: {},
        builtIn: true,
      });
    }
  }

  list(): ProviderAccount[] {
    return this.database.listProviders();
  }

  async save(input: ProviderAccountInput): Promise<ProviderAccount> {
    const id = input.id?.trim() || randomUUID();
    const existing = this.database.provider(id);
    if (existing?.builtIn) {
      throw new Error("内置中转站配置由账号登录自动管理");
    }
    const credentialRef = existing?.credentialRef ?? `provider:${id}`;
    if (!existing && !input.apiKey?.trim()) throw new Error("API Key 不能为空");
    if (input.apiKey?.trim()) await this.credentials.set(credentialRef, input.apiKey.trim());
    const provider: ProviderAccount = {
      id,
      providerType: input.providerType,
      displayName: requireNonEmpty(input.displayName, "供应商名称"),
      baseURL: (input.baseURL ?? defaultBaseURL(input.providerType)).trim(),
      credentialRef,
      enabled: input.enabled ?? true,
      models: [...new Set(input.models.map((model) => model.trim()).filter(Boolean))],
      modelMetadata: existing?.modelMetadata ?? {},
      builtIn: existing?.builtIn ?? false,
    };
    if (provider.models.length === 0) throw new Error("至少填写一个模型");
    if (provider.providerType === "openai-compatible" && provider.baseURL === "") {
      throw new Error("OpenAI-compatible 供应商必须填写 Base URL");
    }
    this.database.saveProvider(provider);
    return provider;
  }

  async remove(id: string): Promise<void> {
    const existing = this.database.provider(id);
    if (existing === null) return;
    if (existing.builtIn) throw new Error("内置中转站不能删除");
    this.database.removeProvider(id);
    await this.credentials.remove(existing.credentialRef);
  }

  require(id: string): ProviderAccount {
    const provider = this.database.provider(id);
    if (provider === null || !provider.enabled) throw new Error("供应商不存在或未启用");
    return provider;
  }

  async key(provider: ProviderAccount): Promise<string> {
    const key = await this.credentials.get(provider.credentialRef);
    if (!key) throw new Error(`供应商“${provider.displayName}”尚未配置 API Key`);
    return key;
  }

  updateModels(
    id: string,
    models: string[],
    modelMetadata?: Record<string, ModelMetadata>,
  ): ProviderAccount {
    const provider = this.require(id);
    provider.models = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
    if (modelMetadata !== undefined) provider.modelMetadata = modelMetadata;
    this.database.saveProvider(provider);
    return provider;
  }

  async refreshModels(id: string): Promise<ProviderAccount> {
    const provider = this.require(id);
    const apiKey = await this.key(provider);
    const base = provider.baseURL.replace(/\/+$/, "");
    const headers = new Headers({ accept: "application/json" });
    if (provider.providerType === "google") {
      headers.set("x-goog-api-key", apiKey);
    } else if (provider.providerType === "anthropic") {
      headers.set("x-api-key", apiKey);
      headers.set("anthropic-version", "2023-06-01");
    } else {
      headers.set("authorization", `Bearer ${apiKey}`);
    }
    const response = await this.fetch(`${base}/models`, {
      headers,
    });
    if (!response.ok) throw new Error(`获取模型失败：HTTP ${response.status}`);
    const body = (await response.json()) as unknown;
    if (typeof body !== "object" || body === null) throw new Error("模型接口返回格式无效");
    const source = body as Record<string, unknown>;
    const items = Array.isArray(source["data"])
      ? source["data"]
      : Array.isArray(source["models"])
        ? source["models"]
        : [];
    const entries = items.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      const value =
        typeof record["id"] === "string"
          ? record["id"]
          : typeof record["name"] === "string"
            ? record["name"]
            : "";
      const id = value.replace(/^models\//, "");
      if (!id) return [];
      const rawWireAPIs = Array.isArray(record["wire_apis"])
        ? record["wire_apis"]
        : Array.isArray(record["protocols"])
          ? record["protocols"]
          : [];
      const wireAPIs = rawWireAPIs.filter(
        (wireAPI): wireAPI is ModelWireAPI =>
          typeof wireAPI === "string" && WIRE_APIS.has(wireAPI as ModelWireAPI),
      );
      const defaultWireAPI =
        typeof record["default_wire_api"] === "string" &&
        WIRE_APIS.has(record["default_wire_api"] as ModelWireAPI)
          ? (record["default_wire_api"] as ModelWireAPI)
          : undefined;
      const supportedParameters = Array.isArray(record["supported_parameters"])
        ? record["supported_parameters"].filter(
            (parameter): parameter is string => typeof parameter === "string",
          )
        : [];
      const metadata: ModelMetadata = {
        defaultWireAPI,
        wireAPIs,
        reasoning: typeof record["reasoning"] === "boolean" ? record["reasoning"] : undefined,
        supportedParameters,
      };
      return [{ id, metadata }];
    });
    const models = entries.map((entry) => entry.id);
    if (models.length === 0) throw new Error("供应商没有返回可用模型");
    return this.updateModels(
      id,
      models,
      Object.fromEntries(entries.map((entry) => [entry.id, entry.metadata])),
    );
  }
}
