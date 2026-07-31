import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { ImageModel, LanguageModel } from "ai";

import type { ProviderAccount } from "@shared/contracts";

let transport: typeof globalThis.fetch = globalThis.fetch;

export function setProviderFetch(value: typeof globalThis.fetch): void {
  transport = value;
}

const brandedFetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("user-agent", "Tietiezhi/0.4.1");
  return transport(input, { ...init, headers });
};

function normalizedBaseURL(provider: ProviderAccount): string | undefined {
  const value = provider.baseURL.trim().replace(/\/+$/, "");
  if (value === "") return undefined;
  if (/\/v1(beta)?$/.test(value)) return value;
  return `${value}/${provider.providerType === "google" ? "v1beta" : "v1"}`;
}

function googleBaseURL(provider: ProviderAccount): string | undefined {
  const baseURL = normalizedBaseURL(provider);
  return baseURL?.replace(/\/v1$/, "/v1beta");
}

function builtInWireAPI(provider: ProviderAccount, model: string) {
  if (!provider.builtIn) return undefined;
  const metadata = provider.modelMetadata[model];
  if (!metadata) return undefined;
  if (metadata.defaultWireAPI && metadata.wireAPIs.includes(metadata.defaultWireAPI)) {
    return metadata.defaultWireAPI;
  }
  return metadata.wireAPIs[0];
}

export function languageModel(
  provider: ProviderAccount,
  apiKey: string,
  model: string,
): LanguageModel {
  const baseURL = normalizedBaseURL(provider);
  const shared = {
    apiKey,
    fetch: brandedFetch,
    ...(baseURL === undefined ? {} : { baseURL }),
  };
  const wireAPI = builtInWireAPI(provider, model);
  if (wireAPI === "anthropic_messages") return createAnthropic(shared)(model);
  if (wireAPI === "gemini_generate_content") {
    return createGoogleGenerativeAI({
      ...shared,
      baseURL: googleBaseURL(provider),
    })(model);
  }
  if (wireAPI === "chat_completions") {
    return createOpenAI({ ...shared, name: provider.id }).chat(model);
  }
  if (wireAPI === "responses") return createOpenAI(shared).responses(model);
  switch (provider.providerType) {
    case "anthropic":
      return createAnthropic(shared)(model);
    case "google":
      return createGoogleGenerativeAI(shared)(model);
    case "openai":
      return createOpenAI(shared)(model);
    case "openai-compatible":
      return createOpenAI({ ...shared, name: provider.id }).chat(model);
  }
}

export function imageProviderKind(
  provider: ProviderAccount,
  model: string,
): "openai" | "google" {
  if (
    provider.providerType === "google" ||
    builtInWireAPI(provider, model) === "gemini_generate_content"
  ) {
    return "google";
  }
  return "openai";
}

export function imageModel(
  provider: ProviderAccount,
  apiKey: string,
  model: string,
): ImageModel {
  const baseURL = normalizedBaseURL(provider);
  const shared = {
    apiKey,
    fetch: brandedFetch,
    ...(baseURL === undefined ? {} : { baseURL }),
  };
  if (imageProviderKind(provider, model) === "google") {
    return createGoogleGenerativeAI({
      ...shared,
      baseURL: googleBaseURL(provider),
    }).image(model);
  }
  switch (provider.providerType) {
    case "google":
      return createGoogleGenerativeAI(shared).image(model);
    case "openai":
    case "openai-compatible":
      return createOpenAI(shared).image(model);
    case "anthropic":
      throw new Error("Anthropic 当前不提供 AI SDK 图片生成模型");
  }
}
