import type {
  ModelCapability,
  ModelInfo,
  ModelKind,
  ModelModality,
  Provider,
  ReasoningProfile,
} from "@/lib/api";

const CODEX_BUILTIN_AGENT_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.2",
]);

export function effectiveModelKind(model: ModelInfo): ModelKind {
  return model.overrides?.kind ?? model.kind;
}

export function modelHasCapability(
  model: ModelInfo,
  capability: ModelCapability,
): boolean {
  return model.overrides?.capabilities?.[capability] ??
    model.capabilities?.includes(capability) ??
    false;
}

export function modelInputModalities(model: ModelInfo): ModelModality[] {
  return model.overrides?.inputModalities ?? model.inputModalities ?? ["text"];
}

export function modelOutputModalities(model: ModelInfo): ModelModality[] {
  return model.overrides?.outputModalities ?? model.outputModalities ?? ["text"];
}

export function modelReasoning(model: ModelInfo): ReasoningProfile | undefined {
  if (!modelHasCapability(model, "reasoning")) return undefined;
  return model.overrides?.reasoning ?? model.reasoning;
}

export function hasModelOverrides(model: ModelInfo): boolean {
  const overrides = model.overrides;
  return Boolean(
    overrides?.kind ||
      overrides?.inputModalities ||
      overrides?.outputModalities ||
      overrides?.reasoning ||
      Object.keys(overrides?.capabilities ?? {}).length > 0,
  );
}

/** Built-in Gateway Agent choices follow the pinned Codex public model catalog. */
export function isWorkspaceAgentModel(
  provider: Pick<Provider, "builtIn">,
  model: ModelInfo,
): boolean {
  return (
    effectiveModelKind(model) === "chat" &&
    (!provider.builtIn ||
      CODEX_BUILTIN_AGENT_MODELS.has(model.id.trim().toLowerCase()))
  );
}
