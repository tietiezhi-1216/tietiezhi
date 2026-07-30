/**
 * Normalizes ACP's session configuration options into the host's own shape.
 *
 * This is how model switching works: a core advertises a `select` option whose
 * `category` is `"model"`, listing the models it can run, and the client calls
 * `session/set_config_option` to change it. The core owns the list — a CLI only
 * offers providers it integrates with — so this switches models *within* a
 * core, it does not move a model between cores.
 */

import type { CoreConfigChoice, CoreConfigOption, CoreMode } from "@shared/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Flattens `SessionConfigSelectOptions`, which is either a flat option array or
 * an array of groups. The group label is kept on each choice so the renderer
 * can still show the grouping without special-casing two shapes.
 */
function flattenChoices(value: unknown): CoreConfigChoice[] {
  if (!Array.isArray(value)) return [];
  const out: CoreConfigChoice[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry["options"])) {
      const group = optionalString(entry["name"]) ?? optionalString(entry["group"]);
      for (const nested of entry["options"]) {
        if (!isRecord(nested)) continue;
        const choice = toChoice(nested, group);
        if (choice) out.push(choice);
      }
      continue;
    }
    const choice = toChoice(entry, null);
    if (choice) out.push(choice);
  }
  return out;
}

function toChoice(entry: Record<string, unknown>, group: string | null): CoreConfigChoice | null {
  const value = entry["value"];
  if (typeof value !== "string" || value.length === 0) return null;
  return {
    value,
    name: optionalString(entry["name"]) ?? value,
    description: optionalString(entry["description"]),
    group,
  };
}

/** Returns null for anything that is not a usable config option. */
export function normalizeConfigOption(value: unknown): CoreConfigOption | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value["id"]);
  if (id === null) return null;

  const type = value["type"];
  if (type === "boolean") {
    return {
      id,
      name: optionalString(value["name"]) ?? id,
      description: optionalString(value["description"]),
      category: optionalString(value["category"]),
      kind: "boolean",
      currentValue: value["currentValue"] === true,
      choices: [],
    };
  }
  if (type === "select") {
    const current = value["currentValue"];
    return {
      id,
      name: optionalString(value["name"]) ?? id,
      description: optionalString(value["description"]),
      category: optionalString(value["category"]),
      kind: "select",
      currentValue: typeof current === "string" ? current : "",
      choices: flattenChoices(value["options"]),
    };
  }
  // An unknown option type is skipped rather than guessed: rendering a control
  // whose semantics we do not know would let the user set a value the core
  // cannot accept.
  return null;
}

export function normalizeConfigOptions(value: unknown): CoreConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = normalizeConfigOption(entry);
    return option ? [option] : [];
  });
}

/** `SessionModeState` -> the host's mode list plus the active id. */
export function normalizeModeState(value: unknown): {
  currentModeId: string | null;
  modes: CoreMode[];
} {
  if (!isRecord(value)) return { currentModeId: null, modes: [] };
  const available = value["availableModes"];
  const modes: CoreMode[] = Array.isArray(available)
    ? available.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const id = optionalString(entry["id"]);
        if (id === null) return [];
        return [
          {
            id,
            name: optionalString(entry["name"]) ?? id,
            description: optionalString(entry["description"]),
          },
        ];
      })
    : [];
  return { currentModeId: optionalString(value["currentModeId"]), modes };
}

/** True when this option is the core's model selector. */
export function isModelOption(option: CoreConfigOption): boolean {
  return option.category === "model" && option.kind === "select";
}
