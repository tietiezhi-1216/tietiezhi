/**
 * Connects the agent core to the app's settings and secret vault.
 *
 * Kept separate from `commands.ts` so the core stays testable without the
 * settings module: the tests inject their own resolver.
 */

import { net } from "electron";

import { readSettings, resolveProvider } from "../host/settings.js";
import { setAgentFetch } from "./provider.js";
import { setKeyResolver, type KeyResolver } from "./commands.js";
import type { ProviderKind } from "./types.js";

/**
 * Maps a settings provider entry onto the agent's provider kinds.
 *
 * The settings model predates this core and stores a looser `type` plus an
 * optional wire-api override, so the mapping is explicit rather than a cast.
 */
function providerKindOf(type: string, wireApi: string | null): ProviderKind | null {
  if (wireApi === "anthropicMessages") return "anthropic";
  if (wireApi === "geminiGenerateContent") return "google";
  if (wireApi === "responses" || wireApi === "chatCompletions") return "openai";
  switch (type) {
    case "anthropic":
      return "anthropic";
    case "google":
    case "gemini":
      return "google";
    case "openai":
      return "openai";
    default:
      return null;
  }
}

/**
 * Finds a configured provider that speaks the requested protocol and returns its
 * credentials. Returns null rather than throwing so the caller can produce a
 * message naming the provider the user needs to configure.
 */
const resolver: KeyResolver = async (provider) => {
  const settings = await readSettings();

  // Prefer whatever the user picked for chat; fall back to any provider that
  // speaks the right protocol.
  const ordered = [
    ...settings.providers.filter((entry) => entry.id === settings.chatProviderId),
    ...settings.providers.filter((entry) => entry.id !== settings.chatProviderId),
  ];

  for (const entry of ordered) {
    if (providerKindOf(entry.type, entry.wireApi) !== provider) continue;
    const resolved = await resolveProvider(entry.id).catch(() => null);
    // A provider with no usable key is skipped rather than reported: the next
    // one may work, and the caller's message names the protocol, not the entry.
    if (resolved === null || resolved.key === null || resolved.key === "") continue;
    const apiKey = resolved.key;

    const model =
      entry.id === settings.chatProviderId && settings.chatModel !== ""
        ? settings.chatModel
        : (resolved.models[0]?.id ?? "");
    if (model === "") continue;

    return {
      apiKey,
      model,
      // The provider layer normalises the version segment itself, so the raw
      // configured url is passed straight through.
      ...(resolved.baseUrl === "" ? {} : { baseUrl: resolved.baseUrl }),
    };
  }
  return null;
};


export function wireAgentProviders(): void {
  setKeyResolver(resolver);
  // Node's fetch ignores every form of proxy configuration; Chromium's does not.
  // Without this, any user behind a proxy sees `ECONNRESET` with no status code,
  // which reads as "the model is broken" rather than "configure your proxy".
  setAgentFetch(net.fetch as unknown as typeof globalThis.fetch);
}
