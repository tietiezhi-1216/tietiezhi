import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { createChatEventNormalizer } = await server.ssrLoadModule(
    "/src/lib/chat-events.ts",
  );
  const normalize = createChatEventNormalizer("thread-migration", 42);

  const firstDelta = normalize({ type: "delta", content: "a" });
  const secondDelta = normalize({ type: "delta", content: "b" });
  assert.equal(firstDelta.threadId, "thread-migration");
  assert.equal(firstDelta.turnId, "legacy_turn_42");
  assert.equal(firstDelta.itemId, secondDelta.itemId);
  assert.equal(secondDelta.sequence, firstDelta.sequence + 1);
  assert.ok(firstDelta.emittedAtMs > 0);

  const toolStart = normalize({
    type: "toolCallStart",
    id: "call-1",
    name: "bash",
    args: { command: "pwd" },
  });
  const permission = normalize({
    type: "permissionRequest",
    id: "permission-1",
    tool: "bash",
    description: "Run pwd",
    args: { command: "pwd" },
    scope: "once",
  });
  const toolResult = normalize({
    type: "toolResult",
    id: "call-1",
    output: "/tmp",
    isError: false,
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    truncated: false,
  });
  assert.equal(toolStart.itemId, "call-1");
  assert.equal(permission.itemId, "call-1");
  assert.equal(toolResult.itemId, "call-1");

  const compactionStarted = normalize({
    type: "contextCompactionStarted",
    automatic: true,
    estimatedTokens: 10,
    contextWindow: 100,
  });
  const compacted = normalize({
    type: "contextCompacted",
    automatic: true,
    duringTurn: true,
    summary: "summary",
    estimatedTokensBefore: 10,
    estimatedTokensAfter: 2,
    contextWindow: 100,
  });
  const nextContext = normalize({
    type: "contextUsage",
    estimatedTokens: 3,
    contextWindow: 100,
    compactAtTokens: 80,
  });
  assert.equal(compactionStarted.itemId, compacted.itemId);
  assert.notEqual(compacted.itemId, nextContext.itemId);

  const scoped = {
    type: "done",
    cancelled: false,
    threadId: "thread-native",
    turnId: "turn-native",
    itemId: "item-native",
    sequence: 99,
    emittedAtMs: 1,
  };
  assert.equal(normalize(scoped), scoped);
} finally {
  await server.close();
}

console.log("Chat event migration adapter checks passed.");
