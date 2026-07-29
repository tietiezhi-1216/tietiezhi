/**
 * Argument serialization for `invoke()`.
 *
 * Tauri JSON-encodes the command payload, which is what the frontend was
 * written against: `Channel` instances collapse into `"__CHANNEL__:<id>"`
 * through `toJSON()`, `undefined` members disappear, `Date` becomes a string.
 * Electron instead structured-clones, and `contextBridge` drops prototypes on
 * the way out of the main world — so `Channel` would arrive as a bare
 * `{ id }` object with no `toJSON`. We therefore normalize the payload here,
 * reproducing JSON semantics and recognizing channels by their callback id.
 */

/** Marker Tauri uses to pass a channel handle to the backend. */
export const CHANNEL_MARKER = "__CHANNEL__:";

/** Key Tauri classes implement to override their IPC representation. */
const SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";

/** Tells the serializer whether an id belongs to a live preload callback. */
export type CallbackIdProbe = (id: number) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function callSerializer(value: Record<string, unknown>, key: string): unknown | undefined {
  const fn = value[key];
  if (typeof fn !== "function") return undefined;
  try {
    return (fn as (this: unknown) => unknown).call(value);
  } catch {
    return undefined;
  }
}

/**
 * A `Channel` that lost its prototype still carries the callback id it got
 * from `transformCallback`, so a numeric `id` that is live in our callback
 * table identifies it. As shipped, `Channel` keeps its state in module-level
 * WeakMaps, leaving `id` as its only own property; the `onmessage` fallback
 * covers builds where the private fields end up as own properties instead.
 */
function asStrippedChannel(value: Record<string, unknown>, isCallbackId: CallbackIdProbe): string | null {
  const id = value["id"];
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  if (!isCallbackId(id)) return null;
  const looksLikeHandle = Object.keys(value).every((key) => key === "id" || key === "onmessage");
  if (!looksLikeHandle && typeof value["onmessage"] !== "function") return null;
  return CHANNEL_MARKER + String(id);
}

function convert(value: unknown, isCallbackId: CallbackIdProbe, seen: Set<object>): unknown {
  switch (typeof value) {
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "bigint":
      // JSON.stringify throws on bigint; a decimal string is the only lossless
      // shape a JSON-speaking backend can accept.
      return value.toString();
    case "number":
      return Number.isFinite(value) ? value : null;
    case "string":
    case "boolean":
      return value;
    default:
      break;
  }
  if (value === null) return null;
  if (!isRecord(value)) return null;

  if (seen.has(value)) {
    throw new Error("invoke: arguments contain a circular reference");
  }
  seen.add(value);
  try {
    const viaIpcKey = callSerializer(value, SERIALIZE_TO_IPC_FN);
    if (viaIpcKey !== undefined) return convert(viaIpcKey, isCallbackId, seen);

    const stripped = asStrippedChannel(value, isCallbackId);
    if (stripped !== null) return stripped;

    const viaToJson = callSerializer(value, "toJSON");
    if (viaToJson !== undefined) return convert(viaToJson, isCallbackId, seen);

    if (Array.isArray(value)) {
      return value.map((entry) => {
        const converted = convert(entry, isCallbackId, seen);
        return converted === undefined ? null : converted;
      });
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const converted = convert(value[key], isCallbackId, seen);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Normalize a command payload into a structured-cloneable, JSON-shaped record. */
export function toIpcArgs(
  args: Record<string, unknown> | undefined,
  isCallbackId: CallbackIdProbe,
): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  const converted = convert(args, isCallbackId, new Set<object>());
  return isRecord(converted) && !Array.isArray(converted) ? converted : {};
}
