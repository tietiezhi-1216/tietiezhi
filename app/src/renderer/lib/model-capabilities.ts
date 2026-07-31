import type { ProviderAccount } from "@shared/contracts";

const IMAGE_MODEL_PATTERN =
  /image|imagen|dall|flux|recraft|seedream|kolors|stable.?diffusion|ideogram/i;
const VIDEO_MODEL_PATTERN = /video|veo|sora|kling|hailuo|runway/i;

export function isImageModel(model: string): boolean {
  return IMAGE_MODEL_PATTERN.test(model);
}

export function imageModels(models: string[]): string[] {
  return models.filter(isImageModel);
}

export function providerImageModels(provider: ProviderAccount): string[] {
  return imageModels(provider.models);
}

export function providerVideoModels(provider: ProviderAccount): string[] {
  const models = provider.models.filter((model) => VIDEO_MODEL_PATTERN.test(model));
  if (provider.providerType === "google") return models;
  if (!provider.builtIn) return [];
  return models.filter((model) =>
    provider.modelMetadata[model]?.wireAPIs.includes("gemini_generate_content"),
  );
}

export function chatModels(models: string[]): string[] {
  return models.filter((model) => !isImageModel(model) && !VIDEO_MODEL_PATTERN.test(model));
}
