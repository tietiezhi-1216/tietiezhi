import { createAnthropic } from "@ai-sdk/anthropic";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createCerebras } from "@ai-sdk/cerebras";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ImageModel, LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { createMinimaxOpenAI } from "vercel-minimax-ai-provider";
import { createZhipu } from "zhipu-ai-provider";

import type { ProviderAccount, ProviderType } from "@shared/contracts";

let transport: typeof globalThis.fetch = globalThis.fetch;

export function setProviderFetch(value: typeof globalThis.fetch): void {
  transport = value;
}

const brandedFetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("user-agent", "Tietiezhi/0.4.2");
  return transport(input, { ...init, headers });
};

function normalizedBaseURL(provider: ProviderAccount): string | undefined {
  const value = provider.baseURL.trim().replace(/\/+$/, "");
  return value === "" ? undefined : value;
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

export function languageModelProviderName(
  provider: ProviderAccount,
  model: string,
): Exclude<ProviderType, "openai-compatible"> | "compatible" {
  const wireAPI = builtInWireAPI(provider, model);
  if (wireAPI === "anthropic_messages") return "anthropic";
  if (wireAPI === "gemini_generate_content") return "google";
  if (wireAPI === "responses") return "openai";
  if (wireAPI === "chat_completions") return "compatible";
  return provider.providerType === "openai-compatible" ? "compatible" : provider.providerType;
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
  const compatible = () => {
    if (baseURL === undefined) throw new Error("兼容供应商必须配置 API 地址");
    return createOpenAICompatible({
      apiKey,
      baseURL,
      fetch: brandedFetch,
      name: "compatible",
    });
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
    return compatible().chatModel(model);
  }
  if (wireAPI === "responses") return createOpenAI(shared).responses(model);
  switch (provider.providerType) {
    case "anthropic":
      return createAnthropic(shared)(model);
    case "google":
      return createGoogleGenerativeAI(shared)(model);
    case "openai":
      return createOpenAI(shared)(model);
    case "deepseek":
      return createDeepSeek(shared)(model);
    case "moonshotai":
      return createMoonshotAI(shared)(model);
    case "zhipu":
      return createZhipu(shared)(model);
    case "alibaba":
      return createAlibaba(shared)(model);
    case "minimax":
      return createMinimaxOpenAI(shared)(model);
    case "xai":
      return createXai(shared)(model);
    case "mistral":
      return createMistral(shared)(model);
    case "groq":
      return createGroq(shared)(model);
    case "openrouter":
      return createOpenRouter({ ...shared, compatibility: "strict" }).chat(model);
    case "togetherai":
      return createTogetherAI(shared)(model);
    case "cerebras":
      return createCerebras(shared)(model);
    case "ollama":
      return createOllama({ baseURL, fetch: brandedFetch, compatibility: "strict" })(model);
    case "openai-compatible":
      return compatible().chatModel(model);
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
  const compatible = () => {
    if (baseURL === undefined) throw new Error("兼容供应商必须配置 API 地址");
    return createOpenAICompatible({
      apiKey,
      baseURL,
      fetch: brandedFetch,
      name: "compatible",
    });
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
      return createOpenAI(shared).image(model);
    case "xai":
      return createXai(shared).image(model);
    case "zhipu":
      return createZhipu(shared).image(model);
    case "openrouter":
      return createOpenRouter({ ...shared, compatibility: "strict" }).imageModel(model);
    case "togetherai":
      return createTogetherAI(shared).image(model);
    case "openai-compatible":
      return compatible().imageModel(model);
    case "anthropic":
      throw new Error("Anthropic 当前不提供 AI SDK 图片生成模型");
    case "deepseek":
    case "moonshotai":
    case "alibaba":
    case "minimax":
    case "mistral":
    case "groq":
    case "cerebras":
    case "ollama":
      throw new Error("当前供应商不提供 AI SDK 图片生成模型");
  }
}

export function videoModel(
  provider: ProviderAccount,
  apiKey: string,
  model: string,
) {
  const wireAPI = builtInWireAPI(provider, model);
  const baseURL = normalizedBaseURL(provider);
  const shared = {
    apiKey,
    fetch: brandedFetch,
    ...(baseURL === undefined ? {} : { baseURL }),
  };
  if (provider.providerType === "xai") return createXai(shared).video(model);
  if (provider.providerType === "openrouter") {
    return createOpenRouter({ ...shared, compatibility: "strict" }).videoModel(model);
  }
  if (provider.providerType === "alibaba") return createAlibaba(shared).video(model);
  if (provider.providerType !== "google" && wireAPI !== "gemini_generate_content") {
    throw new Error("当前供应商不支持 AI SDK 视频生成");
  }
  return createGoogleGenerativeAI({
    ...shared,
    baseURL: googleBaseURL(provider),
  }).video(model);
}
