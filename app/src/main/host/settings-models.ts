/**
 * Model capability classification, ported from `commands/models.rs`.
 *
 * OpenAI-compatible `/v1/models` carries no capability metadata — every entry
 * is just `{"id": "...", "object": "model"}` — so the id is all we have to go
 * on. Matching is token-based (split on non-alphanumerics) rather than plain
 * substring so "agnes-…" can't be mistaken for an ASR model.
 *
 * This is what keeps an image model out of the chat picker and a chat model out
 * of the dictation (ASR) picker.
 */

import registryJson from "../../../../shared/model-registry/models.json";

/** Temporary product-wide context policy, mirroring `agent::context`. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256 * 1024;

export type ModelWireApi =
  | "auto"
  | "responses"
  | "chatCompletions"
  | "anthropicMessages"
  | "geminiGenerateContent";

export type ModelKind =
  | "chat"
  | "asr"
  | "tts"
  | "audio"
  | "image"
  | "video"
  | "embedding"
  | "other";

export type ModelCapability = "tool-call" | "reasoning" | "structured-output" | "web-search";

export type ModelModality = "text" | "image" | "audio" | "video" | "file" | "vector";

export type ReasoningEffort =
  | "auto"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type ReasoningMode = "fixed" | "effort";

export type ReasoningTransport =
  | "none"
  | "responses-reasoning"
  | "openai-reasoning-effort"
  | "openrouter-reasoning"
  | "enable-thinking"
  | "anthropic-adaptive"
  | "anthropic-thinking-budget"
  | "gemini-thinking-level"
  | "gemini-thinking-budget";

export interface ReasoningProfile {
  mode: ReasoningMode;
  supportedEfforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort | null;
  transport: ReasoningTransport;
  protocolTransports: Record<string, ReasoningTransport>;
}

export interface ModelOverrides {
  kind: ModelKind | null;
  inputModalities: ModelModality[] | null;
  outputModalities: ModelModality[] | null;
  capabilities: Partial<Record<ModelCapability, boolean>>;
  reasoning: ReasoningProfile | null;
  wireApi: ModelWireApi | null;
}

export interface ModelInfo {
  id: string;
  kind: ModelKind;
  inputModalities: ModelModality[];
  outputModalities: ModelModality[];
  capabilities: ModelCapability[];
  reasoning: ReasoningProfile | null;
  supportedWireApis: ModelWireApi[];
  defaultWireApi: ModelWireApi | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilitySource: string;
  overrides: ModelOverrides;
}

const MODEL_WIRE_APIS: readonly ModelWireApi[] = [
  "auto",
  "responses",
  "chatCompletions",
  "anthropicMessages",
  "geminiGenerateContent",
];
const MODEL_KINDS: readonly ModelKind[] = [
  "chat",
  "asr",
  "tts",
  "audio",
  "image",
  "video",
  "embedding",
  "other",
];
const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  "tool-call",
  "reasoning",
  "structured-output",
  "web-search",
];
const MODEL_MODALITIES: readonly ModelModality[] = [
  "text",
  "image",
  "audio",
  "video",
  "file",
  "vector",
];
const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "auto",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const REASONING_MODES: readonly ReasoningMode[] = ["fixed", "effort"];
const REASONING_TRANSPORTS: readonly ReasoningTransport[] = [
  "none",
  "responses-reasoning",
  "openai-reasoning-effort",
  "openrouter-reasoning",
  "enable-thinking",
  "anthropic-adaptive",
  "anthropic-thinking-budget",
  "gemini-thinking-level",
  "gemini-thinking-budget",
];

// MARK: - Lenient parsing helpers

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asEnum<T extends string>(allowed: readonly T[], value: unknown): T | null {
  if (typeof value !== "string") return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function asEnumArray<T extends string>(allowed: readonly T[], value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    const parsed = asEnum(allowed, entry);
    if (parsed !== null && !out.includes(parsed)) out.push(parsed);
  }
  return out;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export function parseReasoningProfile(value: unknown): ReasoningProfile | null {
  if (!isRecord(value)) return null;
  const mode = asEnum(REASONING_MODES, value["mode"]);
  const transport = asEnum(REASONING_TRANSPORTS, value["transport"]);
  if (mode === null || transport === null) return null;
  const protocolTransports: Record<string, ReasoningTransport> = {};
  const rawTransports = value["protocolTransports"] ?? value["protocol_transports"];
  if (isRecord(rawTransports)) {
    for (const key of Object.keys(rawTransports)) {
      const parsed = asEnum(REASONING_TRANSPORTS, rawTransports[key]);
      if (parsed !== null) protocolTransports[key] = parsed;
    }
  }
  return {
    mode,
    supportedEfforts: asEnumArray(
      REASONING_EFFORTS,
      value["supportedEfforts"] ?? value["supported_efforts"],
    ),
    defaultEffort: asEnum(REASONING_EFFORTS, value["defaultEffort"] ?? value["default_effort"]),
    transport,
    protocolTransports,
  };
}

/** The transport a reasoning profile uses on a given wire protocol. */
export function transportForWireApi(
  profile: ReasoningProfile,
  wireApi: ModelWireApi,
): ReasoningTransport {
  const key =
    wireApi === "chatCompletions"
      ? "chat_completions"
      : wireApi === "anthropicMessages"
        ? "anthropic_messages"
        : wireApi === "geminiGenerateContent"
          ? "gemini_generate_content"
          : "responses";
  if (Object.keys(profile.protocolTransports).length === 0) return profile.transport;
  return profile.protocolTransports[key] ?? "none";
}

function emptyOverrides(): ModelOverrides {
  return {
    kind: null,
    inputModalities: null,
    outputModalities: null,
    capabilities: {},
    reasoning: null,
    wireApi: null,
  };
}

function parseOverrides(value: unknown): ModelOverrides {
  const overrides = emptyOverrides();
  if (!isRecord(value)) return overrides;
  overrides.kind = asEnum(MODEL_KINDS, value["kind"]);
  overrides.inputModalities = Array.isArray(value["inputModalities"])
    ? asEnumArray(MODEL_MODALITIES, value["inputModalities"])
    : null;
  overrides.outputModalities = Array.isArray(value["outputModalities"])
    ? asEnumArray(MODEL_MODALITIES, value["outputModalities"])
    : null;
  const capabilities = value["capabilities"];
  if (isRecord(capabilities)) {
    for (const key of Object.keys(capabilities)) {
      const capability = asEnum(MODEL_CAPABILITIES, key);
      const enabled = capabilities[key];
      if (capability !== null && typeof enabled === "boolean") {
        overrides.capabilities[capability] = enabled;
      }
    }
  }
  overrides.reasoning = parseReasoningProfile(value["reasoning"]);
  overrides.wireApi = asEnum(MODEL_WIRE_APIS, value["wireApi"]);
  return overrides;
}

/**
 * Parses one stored model entry. Deliberately lenient: a settings file written
 * by a newer build must degrade to defaults rather than take the whole
 * configuration down with it.
 */
export function parseModelInfo(value: unknown): ModelInfo | null {
  if (typeof value === "string") {
    // Legacy shape: settings written before capabilities existed stored ids.
    return value.trim().length === 0 ? null : newModelInfo(value);
  }
  if (!isRecord(value)) return null;
  const id = value["id"];
  if (typeof id !== "string" || id.trim().length === 0) return null;
  const capabilitySource = value["capabilitySource"];
  return {
    id,
    kind: asEnum(MODEL_KINDS, value["kind"]) ?? "chat",
    inputModalities: asEnumArray(MODEL_MODALITIES, value["inputModalities"]),
    outputModalities: asEnumArray(MODEL_MODALITIES, value["outputModalities"]),
    capabilities: asEnumArray(MODEL_CAPABILITIES, value["capabilities"]),
    reasoning: parseReasoningProfile(value["reasoning"]),
    supportedWireApis: asEnumArray(MODEL_WIRE_APIS, value["supportedWireApis"]),
    defaultWireApi: asEnum(MODEL_WIRE_APIS, value["defaultWireApi"]),
    contextWindow: asPositiveInt(value["contextWindow"]),
    maxOutputTokens: asPositiveInt(value["maxOutputTokens"]),
    capabilitySource: typeof capabilitySource === "string" ? capabilitySource : "inferred",
    overrides: parseOverrides(value["overrides"]),
  };
}

/** Accepts both the current `[{id, kind, …}]` shape and the legacy `["id", …]`. */
export function parseModels(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) return [];
  const out: ModelInfo[] = [];
  for (const entry of value) {
    const model = parseModelInfo(entry);
    if (model) out.push(model);
  }
  return out;
}

export function cloneModelInfo(model: ModelInfo): ModelInfo {
  return {
    ...model,
    inputModalities: [...model.inputModalities],
    outputModalities: [...model.outputModalities],
    capabilities: [...model.capabilities],
    reasoning: model.reasoning ? cloneReasoning(model.reasoning) : null,
    supportedWireApis: [...model.supportedWireApis],
    overrides: cloneOverrides(model.overrides),
  };
}

function cloneReasoning(profile: ReasoningProfile): ReasoningProfile {
  return {
    ...profile,
    supportedEfforts: [...profile.supportedEfforts],
    protocolTransports: { ...profile.protocolTransports },
  };
}

export function cloneOverrides(overrides: ModelOverrides): ModelOverrides {
  return {
    kind: overrides.kind,
    inputModalities: overrides.inputModalities ? [...overrides.inputModalities] : null,
    outputModalities: overrides.outputModalities ? [...overrides.outputModalities] : null,
    capabilities: { ...overrides.capabilities },
    reasoning: overrides.reasoning ? cloneReasoning(overrides.reasoning) : null,
    wireApi: overrides.wireApi,
  };
}

// MARK: - Effective values (user overrides beat detected metadata)

export function effectiveKind(model: ModelInfo): ModelKind {
  return model.overrides.kind ?? model.kind;
}

export function hasCapability(model: ModelInfo, capability: ModelCapability): boolean {
  const override = model.overrides.capabilities[capability];
  if (typeof override === "boolean") return override;
  return model.capabilities.includes(capability);
}

export function effectiveReasoning(model: ModelInfo): ReasoningProfile | null {
  if (!hasCapability(model, "reasoning")) return null;
  return model.overrides.reasoning ?? model.reasoning;
}

export function effectiveWireApi(model: ModelInfo): ModelWireApi | null {
  const selected =
    model.overrides.wireApi ?? model.defaultWireApi ?? model.supportedWireApis[0] ?? null;
  return selected === "auto" ? null : selected;
}

// MARK: - Bundled registry

interface RegistryEntry {
  ids: string[];
  prefixes: string[];
  kind: ModelKind | null;
  inputModalities: ModelModality[] | null;
  outputModalities: ModelModality[] | null;
  capabilities: ModelCapability[] | null;
  reasoning: ReasoningProfile | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

function parseRegistryEntries(source: unknown): RegistryEntry[] {
  if (!isRecord(source) || !Array.isArray(source["entries"])) return [];
  const entries: RegistryEntry[] = [];
  for (const raw of source["entries"]) {
    if (!isRecord(raw)) continue;
    const ids = Array.isArray(raw["ids"])
      ? raw["ids"].filter((value): value is string => typeof value === "string")
      : [];
    const prefixes = Array.isArray(raw["prefixes"])
      ? raw["prefixes"].filter((value): value is string => typeof value === "string")
      : [];
    entries.push({
      ids,
      prefixes,
      kind: asEnum(MODEL_KINDS, raw["kind"]),
      inputModalities: Array.isArray(raw["inputModalities"])
        ? asEnumArray(MODEL_MODALITIES, raw["inputModalities"])
        : null,
      outputModalities: Array.isArray(raw["outputModalities"])
        ? asEnumArray(MODEL_MODALITIES, raw["outputModalities"])
        : null,
      capabilities: Array.isArray(raw["capabilities"])
        ? asEnumArray(MODEL_CAPABILITIES, raw["capabilities"])
        : null,
      reasoning: parseReasoningProfile(raw["reasoning"]),
      contextWindow: asPositiveInt(raw["contextWindow"]),
      maxOutputTokens: asPositiveInt(raw["maxOutputTokens"]),
    });
  }
  return entries;
}

let registryCache: RegistryEntry[] | null = null;

function registry(): RegistryEntry[] {
  if (!registryCache) registryCache = parseRegistryEntries(registryJson as unknown);
  return registryCache;
}

function findRegistryEntry(normalizedId: string): RegistryEntry | null {
  const entries = registry();
  for (const entry of entries) {
    if (entry.ids.some((id) => id.toLowerCase() === normalizedId)) return entry;
  }
  // No exact id: the most specific prefix wins, and — matching Rust's
  // `max_by_key` — the last entry wins a tie.
  let best: RegistryEntry | null = null;
  let bestLength = -1;
  for (const entry of entries) {
    let matched = -1;
    for (const prefix of entry.prefixes) {
      const lower = prefix.toLowerCase();
      if (normalizedId.startsWith(lower) && lower.length > matched) matched = lower.length;
    }
    if (matched >= 0 && matched >= bestLength) {
      best = entry;
      bestLength = matched;
    }
  }
  return best;
}

function defaultModalities(kind: ModelKind): [ModelModality[], ModelModality[]] {
  switch (kind) {
    case "chat":
      return [["text"], ["text"]];
    case "asr":
      return [["audio"], ["text"]];
    case "tts":
      return [["text"], ["audio"]];
    case "audio":
      return [
        ["text", "audio"],
        ["audio"],
      ];
    case "image":
      return [
        ["text", "image"],
        ["image"],
      ];
    case "video":
      return [
        ["text", "image", "video"],
        ["video"],
      ];
    case "embedding":
      return [["text"], ["vector"]];
    case "other":
      return [["text"], ["text"]];
  }
}

/** Fresh model metadata for an id: classification plus bundled registry data. */
export function newModelInfo(id: string): ModelInfo {
  const kind = classify(id);
  const [inputModalities, outputModalities] = defaultModalities(kind);
  const model: ModelInfo = {
    id,
    kind,
    inputModalities,
    outputModalities,
    capabilities: [],
    reasoning: null,
    supportedWireApis: [],
    defaultWireApi: null,
    contextWindow: DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: null,
    capabilitySource: "inferred",
    overrides: emptyOverrides(),
  };

  const entry = findRegistryEntry(id.trim().toLowerCase());
  if (entry) {
    if (entry.kind !== null) model.kind = entry.kind;
    if (entry.inputModalities !== null) model.inputModalities = [...entry.inputModalities];
    if (entry.outputModalities !== null) model.outputModalities = [...entry.outputModalities];
    if (entry.capabilities !== null) model.capabilities = [...entry.capabilities];
    if (entry.reasoning !== null) model.reasoning = cloneReasoning(entry.reasoning);
    model.contextWindow = entry.contextWindow ?? model.contextWindow;
    model.maxOutputTokens = entry.maxOutputTokens ?? model.maxOutputTokens;
    model.capabilitySource = "registry";
  }

  // Temporary product-wide policy. Provider-specific limits will replace this
  // once the Gateway catalog exposes trustworthy context metadata.
  model.contextWindow = DEFAULT_CONTEXT_WINDOW_TOKENS;
  return model;
}

// MARK: - Classification

/** Lowercased alphanumeric tokens of a model id. */
function tokens(id: string): string[] {
  return id
    .split(/[^a-zA-Z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

/** Curated capability overrides for model ids whose names are ambiguous. */
export function knownKindOverride(id: string): ModelKind | null {
  switch (id.trim().toLowerCase()) {
    case "sensenova-u1-fast":
      return "image";
    default:
      return null;
  }
}

/** Derive a model's capability from its id. */
export function classify(id: string): ModelKind {
  const lower = id.toLowerCase();
  const parts = tokens(id);
  const has = (token: string): boolean => parts.includes(token);

  // Some provider model ids do not expose their capability in the name. Keep
  // exact, documented exceptions here so they never fall through to the
  // permissive Chat default.
  const override = knownKindOverride(lower);
  if (override !== null) return override;

  // Speech-to-text first: "speech" alone is ambiguous, so ASR's distinctive
  // markers get to claim it before the TTS rule below.
  if (has("asr") || has("stt") || lower.includes("whisper") || lower.includes("transcrib")) {
    return "asr";
  }
  if (has("tts") || lower.includes("text-to-speech") || has("speech") || has("voice")) {
    return "tts";
  }
  if (
    has("music") ||
    has("suno") ||
    has("udio") ||
    has("sfx") ||
    lower.includes("text-to-music") ||
    lower.includes("sound-effect")
  ) {
    return "audio";
  }
  if (
    has("image") ||
    has("img") ||
    lower.includes("dall-e") ||
    has("dalle") ||
    has("flux") ||
    lower.includes("stable-diffusion") ||
    has("midjourney")
  ) {
    return "image";
  }
  if (has("video") || has("sora") || has("veo") || has("kling") || has("runway")) {
    return "video";
  }
  if (has("embedding") || has("embed") || has("bge") || has("m3e")) {
    return "embedding";
  }
  if (has("rerank") || has("moderation")) {
    return "other";
  }
  return "chat";
}
