/**
 * Translation layer between ACP `session/update` notifications and the flat
 * `CoreStreamEvent` union the renderer consumes.
 */

import type {
  ContentBlock,
  SessionNotification,
  SessionUpdate,
  ToolCallStatus,
} from "@agentclientprotocol/sdk";
import type { CoreStreamEvent } from "@shared/contracts";

/** Reported for update variants the host has no dedicated event for. */
export interface UnhandledSessionUpdate {
  sessionId: string;
  /** The `sessionUpdate` discriminator exactly as it arrived on the wire. */
  sessionUpdate: string;
  update: unknown;
}

export type UnhandledUpdateSink = (info: UnhandledSessionUpdate) => void;

/**
 * Status reported when a core omits it. `tool_call_update` may carry only the
 * fields that changed, so an absent status means "unchanged", not "unknown to
 * the core" — the renderer keeps whatever it already had for this call.
 */
const UNCHANGED_STATUS = "unchanged";

/** Flattens a content block into displayable text. */
export function contentBlockToText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return `[image ${block.mimeType}]`;
    case "audio":
      return `[audio ${block.mimeType}]`;
    case "resource_link":
      return `[${block.name}](${block.uri})`;
    case "resource": {
      const resource = block.resource;
      if ("text" in resource) return resource.text;
      return `[resource ${resource.uri}]`;
    }
    default:
      return "";
  }
}

function toolCallStatus(status: ToolCallStatus | null | undefined): string {
  return status ?? UNCHANGED_STATUS;
}

/**
 * Maps one ACP notification to zero or more renderer events.
 *
 * Never throws: a core that speaks a newer ACP revision than we compiled
 * against must not be able to kill a turn, so unrecognised variants are handed
 * to `onUnhandled` and produce no events.
 */
export function normalizeSessionUpdate(
  notification: SessionNotification,
  onUnhandled?: UnhandledUpdateSink,
): CoreStreamEvent[] {
  const sessionId = notification.sessionId;
  const update: SessionUpdate = notification.update;

  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return [{ kind: "message-delta", sessionId, text: contentBlockToText(update.content) }];

    case "agent_thought_chunk":
      return [{ kind: "thought-delta", sessionId, text: contentBlockToText(update.content) }];

    case "tool_call":
      return [
        {
          kind: "tool-call",
          sessionId,
          callId: update.toolCallId,
          title: update.title,
          status: update.status ?? "pending",
          raw: update,
        },
      ];

    case "tool_call_update":
      return [
        {
          kind: "tool-call-update",
          sessionId,
          callId: update.toolCallId,
          status: toolCallStatus(update.status),
          raw: update,
        },
      ];

    // All three plan variants share one renderer event; `raw` carries the
    // discriminator so the UI can tell a full plan from an incremental patch.
    case "plan":
    case "plan_update":
    case "plan_removed":
      return [{ kind: "plan", sessionId, raw: update }];

    default: {
      // Covers both variants we deliberately do not surface
      // (user_message_chunk, usage_update, mode/config/command updates) and
      // variants added by a newer ACP revision than we compiled against.
      const kind: unknown = update.sessionUpdate;
      onUnhandled?.({
        sessionId,
        sessionUpdate: typeof kind === "string" ? kind : "<missing>",
        update,
      });
      return [];
    }
  }
}
