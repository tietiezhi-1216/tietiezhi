/**
 * Suggestion support wiring.
 *
 * `projects.ts` owns the recommendation deck but deliberately depends on
 * neither the task store nor provider credentials. This module supplies both
 * halves — task history read straight off disk, and a text completion issued
 * through the settings layer's resolved provider — so the deck module stays
 * free of credential handling.
 *
 * The model-selection policy mirrors the Rust `select_suggestion_model`: a paid
 * provider is only allowed to spend tokens on suggestions when the user opted
 * in, otherwise generation falls back to a cheap built-in chat model.
 */

import { readFile, readdir } from "node:fs/promises";

import { dataPath } from "./paths.js";
import {
  effectiveKind,
  providerHttpError,
  readSettings,
  resolveProvider,
} from "./settings.js";
import type { AppSettings, ResolvedProvider } from "./settings.js";
import type { ModelInfo, ModelWireApi } from "./settings-models.js";
import type {
  SuggestionGenerationRequest,
  SuggestionGenerationResult,
  SuggestionHistory,
  SuggestionSupport,
  SuggestionTaskDigest,
  TaskMode,
} from "./projects.js";

// ---------------------------------------------------------------------------
// Task history
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Same redaction the Rust build applies before a transcript excerpt is handed
 * to a third-party model. Keys pasted into a chat must never leave the machine
 * inside a suggestion prompt.
 */
const SENSITIVE_VALUE =
  /(?:sk|pk)-[a-z0-9_-]{8,}|(?:api[_ -]?key|access[_ -]?token|token|password|passwd|secret)\s*[:=]\s*[^\s,;]+/gi;

function compactExcerpt(value: string, limit: number): string {
  const compact = value.split(/\s+/).filter((part) => part !== "").join(" ");
  const redacted = compact.replace(SENSITIVE_VALUE, "[已隐藏]");
  return [...redacted].slice(0, limit).join("");
}

async function readTaskIds(): Promise<string[]> {
  try {
    const entries = await readdir(dataPath("tasks"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readTaskDigest(
  id: string,
  projectId: string,
  taskMode: TaskMode,
): Promise<SuggestionTaskDigest | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(dataPath("tasks", id, "task.json"), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (readString(parsed, "projectId") !== projectId) return null;
  // Missing taskMode means Code, matching TaskMode::default() in Rust and
  // conversations.ts. Defaulting to Work instead would file every pre-split
  // task under the wrong mode's suggestion history.
  const mode = readString(parsed, "taskMode") === "work" ? "work" : "code";
  if (mode !== taskMode) return null;

  const rawMessages = parsed["messages"];
  const messages = Array.isArray(rawMessages) ? rawMessages.filter(isRecord) : [];
  const opening = messages.find(
    (message) =>
      readString(message, "kind") === "message" &&
      readString(message, "role") === "user" &&
      readString(message, "content").trim() !== "",
  );
  // BTreeSet in Rust: deduplicated and sorted, capped at the first 8 seen.
  const tools = new Set<string>();
  for (const message of messages) {
    const name = readString(message, "toolName");
    if (name !== "") tools.add(name);
    if (tools.size >= 8) break;
  }

  return {
    id: readString(parsed, "id") || id,
    title: readString(parsed, "title"),
    updatedAt: readNumber(parsed, "updatedAt"),
    openingRequest: opening ? compactExcerpt(readString(opening, "content"), 180) : "",
    tools: [...tools].sort(),
  };
}

async function suggestionHistory(
  projectId: string | null,
  taskMode: TaskMode,
  limit: number,
): Promise<SuggestionHistory> {
  const ids = await readTaskIds();
  const digests = await Promise.all(
    ids.map(async (id) => readTaskDigest(id, projectId ?? "", taskMode)),
  );
  const tasks = digests.filter((digest): digest is SuggestionTaskDigest => digest !== null);
  tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  return { totalTasks: tasks.length, recentTasks: tasks.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

interface ModelChoice {
  providerId: string;
  model: string;
}

function selectSuggestionModel(settings: AppSettings): ModelChoice | null {
  const allowed = (providerId: string): boolean => {
    const provider = settings.providers.find((entry) => entry.id === providerId);
    if (!provider) return false;
    return provider.builtIn || settings.smartSuggestionsAllowPaidModels;
  };

  for (const [providerId, model] of [
    [settings.titleProviderId, settings.titleModel],
    [settings.chatProviderId, settings.chatModel],
  ] as const) {
    if (providerId.trim() !== "" && model.trim() !== "" && allowed(providerId)) {
      return { providerId, model };
    }
  }

  const builtin = settings.providers.find((provider) => provider.builtIn);
  if (!builtin) return null;
  const chatModels = builtin.models.filter((model) => effectiveKind(model) === "chat");
  const cheap = chatModels.find((model) => {
    const id = model.id.toLowerCase();
    return id.includes("flash") || id.includes("mini") || id.includes("fast");
  });
  const chosen = cheap ?? chatModels[0];
  if (!chosen) return null;
  return { providerId: builtin.id, model: chosen.id };
}

// ---------------------------------------------------------------------------
// Text generation
// ---------------------------------------------------------------------------

type WireApi = Exclude<ModelWireApi, "auto">;

function wireApiForModel(provider: ResolvedProvider, modelId: string): WireApi {
  if (provider.wireApi !== "auto") return provider.wireApi;
  const model: ModelInfo | undefined = provider.models.find((entry) => entry.id === modelId);
  const override = model?.overrides.wireApi;
  if (override !== undefined && override !== null && override !== "auto") return override;
  const preferred = model?.defaultWireApi;
  if (preferred !== undefined && preferred !== null && preferred !== "auto") return preferred;
  const first = model?.supportedWireApis.find((entry) => entry !== "auto");
  return first ?? "chatCompletions";
}

function apiUrl(baseUrl: string, path: string): string {
  let base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/v1beta")) base = base.slice(0, -7);
  else if (base.endsWith("/v1")) base = base.slice(0, -3);
  return `${base}/v1/${path.replace(/^\/+/, "")}`;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(providerHttpError("任务建议", response.status, text));
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("任务建议服务返回的不是合法 JSON");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("生成任务建议超时，请稍后重试");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function pathValue(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function firstItem(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

/** Flattens the several shapes a "content" field takes across the wire APIs. */
function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).join("");
  if (isRecord(value)) {
    const text = value["text"];
    if (typeof text === "string") return text;
  }
  return "";
}

/** Usage fields differ per wire API; missing counts report as 0, like Rust. */
function totalTokensOf(payload: unknown): number {
  const candidates: readonly (readonly string[])[] = [
    ["usage", "total_tokens"],
    ["usage", "totalTokens"],
    ["usageMetadata", "totalTokenCount"],
  ];
  for (const keys of candidates) {
    const value = pathValue(payload, keys);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const input = pathValue(payload, ["usage", "input_tokens"]);
  const output = pathValue(payload, ["usage", "output_tokens"]);
  if (typeof input === "number" && typeof output === "number") return input + output;
  return 0;
}

async function generateText(
  provider: ResolvedProvider,
  model: string,
  key: string,
  request: SuggestionGenerationRequest,
): Promise<SuggestionGenerationResult> {
  const wireApi = wireApiForModel(provider, model);
  const { instructions, prompt, timeoutMs } = request;

  switch (wireApi) {
    case "chatCompletions": {
      const payload = await postJson(
        apiUrl(provider.baseUrl, "chat/completions"),
        { authorization: `Bearer ${key}` },
        {
          model,
          messages: [
            { role: "system", content: instructions },
            { role: "user", content: prompt },
          ],
          stream: false,
        },
        timeoutMs,
      );
      const choice = firstItem(pathValue(payload, ["choices"]));
      return {
        text: collectText(pathValue(choice, ["message", "content"])),
        model,
        totalTokens: totalTokensOf(payload),
      };
    }
    case "anthropicMessages": {
      const payload = await postJson(
        apiUrl(provider.baseUrl, "messages"),
        { "x-api-key": key, "anthropic-version": "2023-06-01", authorization: `Bearer ${key}` },
        {
          model,
          max_tokens: 2048,
          system: instructions,
          messages: [{ role: "user", content: prompt }],
        },
        timeoutMs,
      );
      return {
        text: collectText(pathValue(payload, ["content"])),
        model,
        totalTokens: totalTokensOf(payload),
      };
    }
    case "geminiGenerateContent": {
      const root = apiUrl(provider.baseUrl, "").replace(/\/v1\/$/, "");
      const payload = await postJson(
        `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": key },
        {
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        },
        timeoutMs,
      );
      return {
        text: collectText(
          pathValue(firstItem(pathValue(payload, ["candidates"])), ["content", "parts"]),
        ),
        model,
        totalTokens: totalTokensOf(payload),
      };
    }
    case "responses": {
      const payload = await postJson(
        apiUrl(provider.baseUrl, "responses"),
        { authorization: `Bearer ${key}` },
        {
          model,
          instructions,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
          ],
          stream: false,
        },
        timeoutMs,
      );
      const shortcut = collectText(pathValue(payload, ["output_text"]));
      if (shortcut !== "") {
        return { text: shortcut, model, totalTokens: totalTokensOf(payload) };
      }
      const output = pathValue(payload, ["output"]);
      const text = Array.isArray(output)
        ? output.map((item) => collectText(pathValue(item, ["content"]))).join("")
        : "";
      return { text, model, totalTokens: totalTokensOf(payload) };
    }
  }
}

async function generate(
  request: SuggestionGenerationRequest,
): Promise<SuggestionGenerationResult | null> {
  const settings = await readSettings();
  const choice = selectSuggestionModel(settings);
  if (!choice) return null;

  // A missing key is "no provider can pay for this", not an error the user
  // should see on a background refresh — the deck simply stays as it was.
  let provider: ResolvedProvider;
  try {
    provider = await resolveProvider(choice.providerId);
  } catch {
    return null;
  }
  if (provider.key === null || provider.key === "") return null;

  return generateText(provider, choice.model, provider.key, request);
}

export const suggestionSupport: SuggestionSupport = {
  history: suggestionHistory,
  generate,
};
