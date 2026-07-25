export interface ChatEventMeta {
  threadId: string;
  turnId: string;
  itemId: string;
  sequence: number;
  emittedAtMs: number;
}

export type LegacyChatEvent =
  | { type: "started"; model: string }
  | { type: "delta"; content: string }
  | { type: "reasoning"; content: string }
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedTokens: number;
    }
  | {
      type: "toolCallStart";
      id: string;
      name: string;
      args: unknown;
      timeoutMs?: number;
    }
  | {
      type: "toolProgress";
      id: string;
      output: string;
      elapsedMs: number;
      truncated: boolean;
    }
  | {
      type: "toolResult";
      id: string;
      output: string;
      isError: boolean;
      durationMs: number;
      exitCode?: number;
      timedOut: boolean;
      cancelled: boolean;
      truncated: boolean;
    }
  | {
      type: "permissionRequest";
      id: string;
      tool: string;
      description: string;
      args: unknown;
      scope: string;
    }
  | {
      type: "retrying";
      attempt: number;
      maxRetries: number;
      delayMs: number;
      reason: string;
    }
  | {
      type: "contextCompactionStarted";
      automatic: boolean;
      estimatedTokens: number;
      contextWindow: number;
    }
  | {
      type: "contextCompacted";
      automatic: boolean;
      duringTurn: boolean;
      summary: string;
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
      contextWindow: number;
    }
  | {
      type: "contextUsage";
      estimatedTokens: number;
      contextWindow: number;
      compactAtTokens: number;
    }
  | { type: "done"; cancelled: boolean }
  | {
      type: "error";
      message: string;
      detail: string;
      code?: string;
      status?: number;
      retryable: boolean;
      retries: number;
    };

export type ChatEvent = LegacyChatEvent & ChatEventMeta;

function hasEventMeta(
  event: ChatEvent | LegacyChatEvent,
): event is ChatEvent {
  const candidate = event as Partial<ChatEventMeta>;
  return (
    typeof candidate.threadId === "string" &&
    candidate.threadId.length > 0 &&
    typeof candidate.turnId === "string" &&
    candidate.turnId.length > 0 &&
    typeof candidate.itemId === "string" &&
    candidate.itemId.length > 0 &&
    typeof candidate.sequence === "number" &&
    Number.isSafeInteger(candidate.sequence) &&
    candidate.sequence > 0 &&
    typeof candidate.emittedAtMs === "number" &&
    Number.isFinite(candidate.emittedAtMs) &&
    candidate.emittedAtMs > 0
  );
}

export function createChatEventNormalizer(
  requestedThreadId: string,
  requestId: number,
): (event: ChatEvent | LegacyChatEvent) => ChatEvent {
  const suffix = Number.isSafeInteger(requestId) ? String(requestId) : "unknown";
  const threadId = requestedThreadId || `legacy_thread_${suffix}`;
  const turnId = `legacy_turn_${suffix}`;
  const turnItemId = `item_legacy_turn_${suffix}`;
  let sequence = 0;
  let agentMessageItemId: string | undefined;
  let reasoningItemId: string | undefined;
  let contextItemId: string | undefined;
  let contextGeneration = 0;
  let currentToolItemId: string | undefined;

  const generatedItemId = (kind: string) =>
    `item_legacy_${kind}_${suffix}_${sequence}`;

  const itemIdFor = (event: LegacyChatEvent): string => {
    switch (event.type) {
      case "delta":
        agentMessageItemId ??= `item_legacy_agent_${suffix}`;
        return agentMessageItemId;
      case "reasoning":
        reasoningItemId ??= `item_legacy_reasoning_${suffix}`;
        return reasoningItemId;
      case "usage":
        return agentMessageItemId ?? turnItemId;
      case "toolCallStart": {
        const itemId = event.id || generatedItemId("tool");
        currentToolItemId = itemId;
        return itemId;
      }
      case "toolProgress":
      case "toolResult":
        return event.id || currentToolItemId || generatedItemId("tool");
      case "permissionRequest":
        return currentToolItemId || event.id || generatedItemId("permission");
      case "contextCompactionStarted":
      case "contextCompacted":
      case "contextUsage": {
        if (!contextItemId) {
          contextGeneration += 1;
          contextItemId = `item_legacy_context_${suffix}_${contextGeneration}`;
        }
        return contextItemId;
      }
      case "started":
      case "retrying":
      case "done":
      case "error":
        return turnItemId;
    }
  };

  return (event) => {
    if (hasEventMeta(event)) {
      sequence = Math.max(sequence, event.sequence);
      return event;
    }

    sequence += 1;
    const itemId = itemIdFor(event);
    const normalized = {
      ...event,
      threadId,
      turnId,
      itemId,
      sequence,
      emittedAtMs: Date.now(),
    } as ChatEvent;

    if (
      event.type === "toolResult" &&
      currentToolItemId === normalized.itemId
    ) {
      currentToolItemId = undefined;
    }
    if (event.type === "contextCompacted") {
      contextItemId = undefined;
    }

    return normalized;
  };
}
