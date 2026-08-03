import { randomUUID } from "node:crypto";

import type {
  ModelMetadata,
  ModelModality,
  ModelWireAPI,
  ProviderAccount,
  ProviderAccountInput,
  ProviderModelList,
  ProviderModelProbeInput,
  ProviderType,
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

const MODALITIES = new Set<ModelModality>([
  "text",
  "image",
  "audio",
  "video",
  "file",
]);

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function defaultBaseURL(type: ProviderAccount["providerType"]): string {
  switch (type) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "google":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "moonshotai":
      return "https://api.moonshot.cn/v1";
    case "zhipu":
      return "https://open.bigmodel.cn/api/paas/v4";
    case "alibaba":
      return "https://dashscope.aliyuncs.com/compatible-mode/v1";
    case "minimax":
      return "https://api.minimaxi.com/v1";
    case "xai":
      return "https://api.x.ai/v1";
    case "mistral":
      return "https://api.mistral.ai/v1";
    case "groq":
      return "https://api.groq.com/openai/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "togetherai":
      return "https://api.together.xyz/v1";
    case "cerebras":
      return "https://api.cerebras.ai/v1";
    case "ollama":
      return "http://127.0.0.1:11434/api";
    case "openai-compatible":
      return "";
  }
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${label}不能为空`);
  return normalized;
}

function isLocalBaseURL(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function preserveModelOverrides(
  result: ProviderModelList,
  existing?: ProviderAccount,
): ProviderModelList {
  if (!existing) return result;
  return {
    models: result.models,
    modelMetadata: Object.fromEntries(
      result.models.map((model) => {
        const overrides = existing.modelMetadata[model]?.overrides;
        const detected = result.modelMetadata[model] ?? {
          wireAPIs: [],
          supportedParameters: [],
        };
        return [
          model,
          overrides
            ? { ...detected, overrides }
            : detected,
        ];
      }),
    ),
  };
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
        vendorId: "tietiezhi",
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
    const resolvedBaseURL = (input.baseURL ?? defaultBaseURL(input.providerType)).trim();
    if (!existing && !input.apiKey?.trim() && !isLocalBaseURL(resolvedBaseURL)) {
      throw new Error("API Key 不能为空");
    }
    if (input.apiKey?.trim()) await this.credentials.set(credentialRef, input.apiKey.trim());
    const provider: ProviderAccount = {
      id,
      vendorId: requireNonEmpty(input.vendorId, "供应商"),
      providerType: input.providerType,
      displayName: requireNonEmpty(input.displayName, "供应商名称"),
      baseURL: resolvedBaseURL,
      credentialRef,
      enabled: input.enabled ?? true,
      models: [...new Set(input.models.map((model) => model.trim()).filter(Boolean))],
      modelMetadata: input.modelMetadata ?? existing?.modelMetadata ?? {},
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
    if (!key && !isLocalBaseURL(provider.baseURL)) {
      throw new Error(
        provider.builtIn
          ? "尚未登录铁铁汁账号，登录后自动配置"
          : `供应商“${provider.displayName}”尚未配置 API Key`,
      );
    }
    return key ?? "";
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
    const result = preserveModelOverrides(await this.#probeModels(
      provider.providerType,
      provider.baseURL,
      apiKey,
    ), provider);
    return this.updateModels(id, result.models, result.modelMetadata);
  }

  /** Probe a provider's /models without requiring it to be saved first. */
  async fetchModels(input: ProviderModelProbeInput): Promise<ProviderModelList> {
    let apiKey = input.apiKey?.trim() ?? "";
    if (!apiKey && input.id) {
      const existing = this.database.provider(input.id);
      if (existing) apiKey = (await this.credentials.get(existing.credentialRef)) ?? "";
    }
    const baseURL = (input.baseURL ?? defaultBaseURL(input.providerType)).trim();
    if (!baseURL) throw new Error("请先填写 Base URL");
    if (!apiKey && !isLocalBaseURL(baseURL)) throw new Error("请先填写 API Key");
    const result = await this.#probeModels(input.providerType, baseURL, apiKey);
    return preserveModelOverrides(
      result,
      input.id ? this.database.provider(input.id) ?? undefined : undefined,
    );
  }

  async #probeModels(
    providerType: ProviderType,
    baseURL: string,
    apiKey: string,
  ): Promise<ProviderModelList> {
    const base = baseURL.replace(/\/+$/, "");
    const headers = new Headers({ accept: "application/json" });
    if (providerType === "google") {
      headers.set("x-goog-api-key", apiKey);
    } else if (providerType === "anthropic") {
      headers.set("x-api-key", apiKey);
      headers.set("anthropic-version", "2023-06-01");
    } else if (apiKey) {
      headers.set("authorization", `Bearer ${apiKey}`);
    }
    const modelPath = providerType === "ollama" ? "tags" : "models";
    const response = await this.fetch(`${base}/${modelPath}`, {
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
      const inputModalities = stringList(record["input_modalities"]).filter(
        (modality): modality is ModelModality =>
          MODALITIES.has(modality as ModelModality),
      );
      const reasoningEfforts = stringList(record["reasoning_efforts"]);
      const defaultReasoningEffort =
        typeof record["default_reasoning_effort"] === "string"
          ? record["default_reasoning_effort"]
          : undefined;
      // The gateway emits `reasoning` as a profile object; plain providers may
      // use a boolean. Either shape marks the model as reasoning-capable.
      const rawReasoning = record["reasoning"];
      const metadata: ModelMetadata = {
        defaultWireAPI,
        wireAPIs,
        reasoning:
          typeof rawReasoning === "boolean"
            ? rawReasoning
            : typeof rawReasoning === "object" && rawReasoning !== null
              ? true
              : undefined,
        reasoningEfforts: reasoningEfforts.length > 0 ? reasoningEfforts : undefined,
        defaultReasoningEffort,
        inputModalities: inputModalities.length > 0 ? inputModalities : undefined,
        toolCall: optionalBoolean(record["tool_call"]),
        streaming: optionalBoolean(record["streaming"]),
        supportedParameters: stringList(record["supported_parameters"]),
      };
      return [{ id, metadata }];
    });
    const models = entries.map((entry) => entry.id);
    if (models.length === 0) throw new Error("供应商没有返回可用模型");
    return {
      models,
      modelMetadata: Object.fromEntries(
        entries.map((entry) => [entry.id, entry.metadata]),
      ),
    };
  }
}
