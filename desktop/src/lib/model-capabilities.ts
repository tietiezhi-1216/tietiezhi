import type {
  ModelCapability,
  ModelInfo,
  ModelKind,
  ModelModality,
  ReasoningProfile,
} from "@/lib/api";

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
