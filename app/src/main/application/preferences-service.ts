import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { app } from "electron";

import { DEFAULT_SYSTEM_PROMPT, type AgentPreferences } from "@shared/contracts";

const DEFAULT_PREFERENCES: AgentPreferences = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  defaultPermissionProfiles: { "ai-sdk": "ask" },
};

function permissionProfiles(value: unknown): AgentPreferences["defaultPermissionProfiles"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_PREFERENCES.defaultPermissionProfiles;
  }
  const result: AgentPreferences["defaultPermissionProfiles"] = {};
  for (const [engineId, profile] of Object.entries(value)) {
    if (profile === "ask" || profile === "agent-managed" || profile === "full-access") {
      result[engineId] = profile;
    }
  }
  return { ...DEFAULT_PREFERENCES.defaultPermissionProfiles, ...result };
}

export class PreferencesService {
  readonly #path = join(app.getPath("userData"), "agent-preferences.json");

  async get(): Promise<AgentPreferences> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFERENCES;
      const systemPrompt = Reflect.get(parsed, "systemPrompt");
      return {
        systemPrompt: typeof systemPrompt === "string" && systemPrompt.trim()
          ? systemPrompt
          : DEFAULT_SYSTEM_PROMPT,
        defaultPermissionProfiles: permissionProfiles(
          Reflect.get(parsed, "defaultPermissionProfiles"),
        ),
      };
    } catch {
      return DEFAULT_PREFERENCES;
    }
  }

  async save(input: AgentPreferences): Promise<AgentPreferences> {
    const normalized = {
      systemPrompt: (input.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT).slice(0, 20_000),
      defaultPermissionProfiles: permissionProfiles(input.defaultPermissionProfiles),
    };
    await mkdir(dirname(this.#path), { recursive: true });
    const temporaryPath = `${this.#path}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(normalized, null, 2), "utf8");
    await rename(temporaryPath, this.#path);
    return normalized;
  }
}
