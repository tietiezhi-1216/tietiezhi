import type {
  ModelMetadata,
  ModelModality,
  ProviderAccount,
} from "@shared/contracts";

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

export interface ModelCapabilities {
  inputModalities: ModelModality[];
  toolCall: boolean;
  streaming: boolean;
  reasoning: boolean;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

const OPENAI_EFFORTS = ["low", "medium", "high"];

/**
 * Name-based capability guesses for providers whose /models endpoint carries
 * no capability fields. Intentionally conservative: unknown families default
 * to text-only chat with tools and streaming.
 */
function guessCapabilities(model: string): ModelCapabilities {
  const id = model.toLowerCase();
  const base: ModelCapabilities = {
    inputModalities: ["text"],
    toolCall: true,
    streaming: true,
    reasoning: false,
  };
  if (/^(gpt-5|o[134])(?:[-_.]|$)/.test(id)) {
    return {
      ...base,
      inputModalities: ["text", "image"],
      reasoning: true,
      reasoningEfforts: OPENAI_EFFORTS,
      defaultReasoningEffort: "medium",
    };
  }
  if (/^(gpt|chatgpt)(?:[-_.]|$)/.test(id)) {
    return { ...base, inputModalities: ["text", "image"] };
  }
  if (/^claude(?:[-_.]|$)/.test(id)) {
    return {
      ...base,
      inputModalities: ["text", "image", "file"],
      reasoning: /-(4|opus-4|sonnet-4|3-7)/.test(id),
    };
  }
  if (/^gemini(?:[-_.]|$)/.test(id)) {
    return {
      ...base,
      inputModalities: ["text", "image", "audio", "video"],
      reasoning: /2\.5|3/.test(id),
    };
  }
  if (/^deepseek(?:[-_.]|$)/.test(id)) {
    return { ...base, reasoning: /reasoner|r1/.test(id) };
  }
  if (/^(qwen|qwq)(?:[-_.]|$)/.test(id)) {
    return {
      ...base,
      inputModalities: /vl|omni/.test(id) ? ["text", "image"] : ["text"],
      reasoning: /^qwq|think/.test(id),
    };
  }
  if (/^(kimi|moonshot)(?:[-_.]|$)/.test(id)) {
    return { ...base, inputModalities: ["text", "image"], reasoning: /think|k2/.test(id) };
  }
  if (/^(glm|chatglm)(?:[-_.]|$)/.test(id)) {
    return { ...base, inputModalities: /v(?:[-_.]|$)/.test(id) ? ["text", "image"] : ["text"] };
  }
  if (/^grok(?:[-_.]|$)/.test(id)) {
    return { ...base, inputModalities: ["text", "image"], reasoning: /-[34]/.test(id) };
  }
  if (/^(doubao|ernie|hunyuan|minimax|abab|step)(?:[-_.]|$)/.test(id)) {
    return { ...base, inputModalities: /v|vision|4o/.test(id) ? ["text", "image"] : ["text"] };
  }
  return base;
}

/**
 * Effective capabilities for one model: explicit provider metadata wins,
 * name-based inference fills whatever the provider left blank.
 */
export function modelCapabilities(
  model: string,
  metadata?: ModelMetadata,
): ModelCapabilities {
  const guessed = guessCapabilities(model);
  return {
    inputModalities: metadata?.inputModalities ?? guessed.inputModalities,
    toolCall: metadata?.toolCall ?? guessed.toolCall,
    streaming: metadata?.streaming ?? guessed.streaming,
    reasoning: metadata?.reasoning ?? guessed.reasoning,
    reasoningEfforts: metadata?.reasoningEfforts ?? guessed.reasoningEfforts,
    defaultReasoningEffort:
      metadata?.defaultReasoningEffort ?? guessed.defaultReasoningEffort,
  };
}
