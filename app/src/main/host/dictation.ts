/**
 * Voice dictation: transcription, LLM polish, and delivering the result into
 * whatever app the user was typing in.
 *
 * The ASR protocol is dispatched on the **model**, not the provider type —
 * users routinely register MiMo as an "openai"-typed provider, so only real
 * Whisper models get the multipart endpoint and everything else goes through
 * chat-audio `input_audio`. This mirrors the Rust original exactly.
 */

import { spawn } from "node:child_process";

import { clipboard, globalShortcut, systemPreferences } from "electron";

import {
  closeChannel,
  emitChannel,
  parseChannelId,
  registerCommands,
  requireInvocation,
} from "../bridge/index.js";
import { dataPath, readJson, writeJsonAtomic } from "./paths.js";
import { providerHttpError, readSettings, resolveProvider } from "./settings.js";
import { classify } from "./settings-models.js";

const ASR_TIMEOUT_MS = 90_000;
const POLISH_TIMEOUT_MS = 120_000;
const DEFAULT_HOTKEY = "CommandOrControl+Shift+D";

/**
 * In-flight requests, so `chat_cancel` can abort a transcription or polish that
 * is already on the wire rather than only flipping a status flag.
 */
const inFlight = new Map<number, AbortController>();

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`参数 ${name} 必须是字符串`);
  return value;
}

function requireNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`参数 ${name} 必须是数字`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `base` may or may not already carry the `/v1` suffix. */
function apiUrl(base: string, path: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/${path}` : `${trimmed}/v1/${path}`;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function normalizeLanguage(language: string): string {
  switch (language.trim()) {
    case "":
    case "auto":
      return "auto";
    case "zhCn":
    case "zhTw":
    case "zh":
      return "zh";
    case "en":
      return "en";
    default:
      return language.trim();
  }
}

/** Whisper uses the multipart endpoint; other ASR models use chat-audio. */
function usesWhisperProtocol(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("whisper") || lower.includes("transcribe");
}

function extractChatContent(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const choices = payload["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (!isRecord(first)) return "";
  const message = first["message"];
  if (!isRecord(message)) return "";
  const content = message["content"];
  if (typeof content === "string") return content;
  // Some providers answer with content parts instead of a plain string.
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
      .join("");
  }
  return "";
}

/** Registers the abort controller for a request id, cancelling any predecessor. */
function beginRequest(requestId: number): AbortController {
  inFlight.get(requestId)?.abort();
  const controller = new AbortController();
  inFlight.set(requestId, controller);
  return controller;
}

function endRequest(requestId: number): void {
  inFlight.delete(requestId);
}

async function requireKeyedProvider(
  providerId: string,
  service: string,
): Promise<{ baseUrl: string; key: string }> {
  const resolved = await resolveProvider(providerId);
  const baseUrl = resolved.baseUrl.trim();
  if (baseUrl === "") throw new Error(`${service}供应商未配置 baseURL`);
  const key = resolved.key?.trim() ?? "";
  if (key === "") throw new Error(`${service}供应商缺少 API Key，请到「设置」填写`);
  return { baseUrl, key };
}

async function transcribe(args: Record<string, unknown>): Promise<string> {
  const requestId = requireNumber(args, "requestId");
  const model = requireString(args, "model");
  const wavBase64 = requireString(args, "wavBase64");
  const language = normalizeLanguage(requireString(args, "language"));
  const { baseUrl, key } = await requireKeyedProvider(
    requireString(args, "providerId"),
    "语音识别",
  );

  // Backstop for a stale model selection: the picker only offers ASR models, but
  // a rename would otherwise surface as an opaque upstream error. `other` is let
  // through because an unrecognised name may still be an ASR.
  const kind = classify(model);
  if (kind !== "asr" && kind !== "other") {
    throw new Error(
      `「${model}」看起来不是语音识别模型（识别为 ${kind}），请到「设置 → 语音听写 → 模型」选择 ASR 模型，例如 mimo-v2.5-asr。`,
    );
  }

  const controller = beginRequest(requestId);
  const timer = setTimeout(() => controller.abort(), ASR_TIMEOUT_MS);
  try {
    return usesWhisperProtocol(model)
      ? await transcribeWhisper(baseUrl, key, model, wavBase64, language, controller.signal)
      : await transcribeChatAudio(baseUrl, key, model, wavBase64, language, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("语音识别已取消");
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
    endRequest(requestId);
  }
}

async function transcribeChatAudio(
  baseUrl: string,
  key: string,
  model: string,
  wavBase64: string,
  language: string,
  signal: AbortSignal,
): Promise<string> {
  const resolvedModel = model.trim() === "" ? "mimo-v2.5-asr" : model;
  const body = {
    model: resolvedModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: `data:audio/wav;base64,${wavBase64}` } },
        ],
      },
    ],
    asr_options: { language },
    stream: false,
  };

  const response = await fetch(apiUrl(baseUrl, "chat/completions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }).catch((error: unknown) => {
    throw new Error(`无法连接语音识别服务：${String(error)}`);
  });

  const text = await response.text();
  if (!response.ok) throw new Error(providerHttpError("语音识别", response.status, text));
  try {
    return extractChatContent(JSON.parse(text)).trim();
  } catch {
    throw new Error(`语音识别响应异常：${snippet(text)}`);
  }
}

async function transcribeWhisper(
  baseUrl: string,
  key: string,
  model: string,
  wavBase64: string,
  language: string,
  signal: AbortSignal,
): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(wavBase64, "base64");
  } catch (error) {
    throw new Error(`音频编码异常：${String(error)}`);
  }
  const form = new FormData();
  // Copy into a standalone Uint8Array: a Buffer's backing store may be a slice
  // of Node's shared pool, which the Blob constructor will not take.
  const audio = new Uint8Array(bytes.byteLength);
  audio.set(bytes);
  form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");
  if (language !== "auto") form.append("language", language);

  const response = await fetch(apiUrl(baseUrl, "audio/transcriptions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal,
  }).catch((error: unknown) => {
    throw new Error(`无法连接语音识别服务：${String(error)}`);
  });

  const text = await response.text();
  if (!response.ok) throw new Error(providerHttpError("语音识别", response.status, text));
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && typeof parsed["text"] === "string" ? parsed["text"].trim() : "";
  } catch {
    throw new Error(`语音识别响应异常：${snippet(text)}`);
  }
}

/**
 * Streams the polished transcript back over the Tauri channel the renderer
 * passed in. Every exit path closes the channel: leaving it open would keep the
 * renderer's callback registered forever.
 */
async function polishStream(args: Record<string, unknown>): Promise<null> {
  const requestId = requireNumber(args, "requestId");
  const model = requireString(args, "model");
  const transcript = requireString(args, "transcript");
  const channelId = parseChannelId(args["onEvent"]);
  // Captured before the first `await`: the invocation context is only reliably
  // available while the handler is still on the call stack.
  const sender = requireInvocation().sender;
  const options = isRecord(args["options"]) ? args["options"] : {};
  const outputLanguage =
    typeof options["outputLanguage"] === "string" ? options["outputLanguage"] : "";
  const frontApp = typeof options["frontApp"] === "string" ? options["frontApp"] : null;

  const settings = await readSettings();
  const prompt = buildPolishPrompt(settings.polishPrompt, outputLanguage, frontApp);
  const { baseUrl, key } = await requireKeyedProvider(
    requireString(args, "providerId"),
    "文本润色",
  );

  const controller = beginRequest(requestId);
  const timer = setTimeout(() => controller.abort(), POLISH_TIMEOUT_MS);
  const send = (event: unknown): void => {
    if (channelId !== null) emitChannel(sender, channelId, event);
  };

  try {
    const response = await fetch(apiUrl(baseUrl, "chat/completions"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: transcript },
        ],
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(providerHttpError("文本润色", response.status, body));
    }
    if (response.body === null) throw new Error("文本润色响应为空");

    for await (const delta of readSseDeltas(response.body)) {
      send({ type: "delta", delta });
    }
    send({ type: "completed" });
    return null;
  } catch (error) {
    send({
      type: "error",
      message: controller.signal.aborted ? "文本润色已取消" : String(error),
    });
    if (!controller.signal.aborted) throw error;
    return null;
  } finally {
    clearTimeout(timer);
    endRequest(requestId);
    if (channelId !== null) closeChannel(sender, channelId);
  }
}

/** Yields `choices[0].delta.content` fragments from an OpenAI-style SSE body. */
async function* readSseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let boundary = buffered.indexOf("\n");
    while (boundary >= 0) {
      const line = buffered.slice(0, boundary).trim();
      buffered = buffered.slice(boundary + 1);
      boundary = buffered.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const parsed: unknown = JSON.parse(payload);
        if (!isRecord(parsed)) continue;
        const choices = parsed["choices"];
        if (!Array.isArray(choices) || choices.length === 0) continue;
        const first = choices[0];
        if (!isRecord(first)) continue;
        const delta = first["delta"];
        const content = isRecord(delta) ? delta["content"] : undefined;
        if (typeof content === "string" && content !== "") yield content;
      } catch {
        // A malformed frame is skipped rather than failing the turn: gateways
        // interleave heartbeats and vendor-specific frames.
      }
    }
  }
}

function buildPolishPrompt(base: string, outputLanguage: string, frontApp: string | null): string {
  const parts = [base];
  if (outputLanguage.trim() !== "") parts.push(`输出语言：${outputLanguage}`);
  if (frontApp !== null && frontApp.trim() !== "") parts.push(`当前应用：${frontApp}`);
  return parts.join("\n\n");
}

function chatCancel(args: Record<string, unknown>): null {
  inFlight.get(requireNumber(args, "requestId"))?.abort();
  return null;
}

// ---------------------------------------------------------------------------
// Delivering text into the focused app
// ---------------------------------------------------------------------------

/**
 * Puts the text on the clipboard and, when permitted, pastes it at the caret.
 *
 * Electron has no key-injection API, so the paste goes through AppleScript —
 * which is exactly the capability the accessibility permission grants, the same
 * one the Rust build required.
 */
async function deliverText(args: Record<string, unknown>): Promise<{
  inserted: boolean;
  needsAccessibility: boolean;
}> {
  const text = requireString(args, "text");
  if (text.trim() === "") return { inserted: false, needsAccessibility: false };

  const previous = clipboard.readText();
  clipboard.writeText(text);

  if (process.platform !== "darwin") {
    // Only macOS delivery is implemented, as in the Tauri build.
    return { inserted: false, needsAccessibility: false };
  }
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    return { inserted: false, needsAccessibility: true };
  }

  try {
    await pasteViaAppleScript();
  } catch {
    // Paste failed but the clipboard still holds the text, so the user can
    // paste manually — report not-inserted rather than an error.
    return { inserted: false, needsAccessibility: false };
  }

  // Restore only if nothing else claimed the clipboard in the meantime, so a
  // copy the user made during the paste is not clobbered.
  setTimeout(() => {
    if (clipboard.readText() === text) clipboard.writeText(previous);
  }, 600);
  return { inserted: true, needsAccessibility: false };
}

function pasteViaAppleScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "osascript",
      ["-e", 'tell application "System Events" to keystroke "v" using command down'],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `osascript 退出码 ${String(code)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Hotkey
// ---------------------------------------------------------------------------

interface HotkeyFile {
  shortcut: string;
}

function hotkeyPath(): string {
  return dataPath("dictation-hotkey.json");
}

async function readHotkey(): Promise<string> {
  const stored = await readJson<HotkeyFile | null>(hotkeyPath(), null);
  const shortcut = stored !== null && typeof stored.shortcut === "string" ? stored.shortcut : "";
  return shortcut === "" ? DEFAULT_HOTKEY : shortcut;
}

/** Fired when the hotkey is pressed; the renderer drives the recorder. */
let onHotkey: (() => void) | null = null;

export function setHotkeyHandler(handler: () => void): void {
  onHotkey = handler;
}

async function applyHotkey(shortcut: string): Promise<void> {
  globalShortcut.unregisterAll();
  if (shortcut === "") return;
  const ok = globalShortcut.register(shortcut, () => onHotkey?.());
  if (!ok) {
    // A silent failure here is worse than an error: the user would think
    // dictation is armed when nothing is listening.
    throw new Error(`快捷键「${shortcut}」注册失败，可能已被其它应用占用`);
  }
}

/** Registers the stored hotkey at startup. Safe to call before any renderer. */
export async function initDictationHotkey(): Promise<void> {
  try {
    await applyHotkey(await readHotkey());
  } catch (error) {
    // Startup must not fail because a saved shortcut is now taken.
    console.error("[dictation] hotkey registration failed:", error);
  }
}

/** Releases the global hotkey. Electron keeps it bound until told otherwise. */
export function disposeDictation(): void {
  globalShortcut.unregisterAll();
  for (const controller of inFlight.values()) controller.abort();
  inFlight.clear();
}

export function registerDictationCommands(): void {
  registerCommands({
    transcribe: (args) => transcribe(args),
    polish_stream: (args) => polishStream(args),
    chat_cancel: (args) => chatCancel(args),
    deliver_text: (args) => deliverText(args),

    dictation_hotkey: () => readHotkey(),

    set_dictation_hotkey: async (args) => {
      const shortcut = requireString(args, "shortcut");
      await applyHotkey(shortcut);
      await writeJsonAtomic(hotkeyPath(), { shortcut });
      return null;
    },

    dictation_reset: async () => {
      await applyHotkey(DEFAULT_HOTKEY);
      await writeJsonAtomic(hotkeyPath(), { shortcut: DEFAULT_HOTKEY });
      return null;
    },

    dictation_toggle: () => {
      onHotkey?.();
      return null;
    },
  });
}
