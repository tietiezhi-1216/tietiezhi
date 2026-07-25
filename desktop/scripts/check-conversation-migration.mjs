import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { persistConversationItems, restoreConversationItems } =
    await server.ssrLoadModule("/src/stores/chat.ts");

  const [legacy] = restoreConversationItems([
    { role: "user", content: "legacy", createdAt: 0 },
  ]);
  assert.equal(legacy.kind, "message");
  assert.equal(legacy.content, "legacy");
  assert.equal(legacy.threadId, undefined);
  assert.equal(legacy.turnId, undefined);
  assert.equal(legacy.itemId, undefined);

  const stored = [
    {
      kind: "message",
      role: "assistant",
      content: "answer",
      reasoning: "thought",
      createdAt: 100,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      reasoningItemId: "reasoning-1",
    },
    {
      kind: "permission",
      createdAt: 101,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "call-1",
      permissionRequestId: "approval-1",
      toolName: "bash",
      content: "Run command",
      permissionScope: "once",
    },
    {
      kind: "toolCall",
      createdAt: 102,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "call-1",
      toolCallId: "call-1",
      toolName: "bash",
      toolStatus: "running",
      toolOutput: "partial",
    },
  ];
  const restored = restoreConversationItems(stored);
  assert.equal(restored[0].itemId, "message-1");
  assert.equal(restored[0].reasoningItemId, "reasoning-1");
  assert.equal(restored[1].kind, "permission");
  assert.equal(restored[1].requestId, "approval-1");
  assert.equal(restored[2].kind, "toolCall");
  assert.equal(restored[2].status, "cancelled");
  assert.match(restored[2].output, /上次运行未正常结束/);

  const roundtrip = persistConversationItems(restored);
  assert.equal(roundtrip[0].threadId, "thread-1");
  assert.equal(roundtrip[0].itemId, "message-1");
  assert.equal(roundtrip[0].reasoningItemId, "reasoning-1");
  assert.equal(roundtrip[1].permissionRequestId, "approval-1");
  assert.equal(roundtrip[2].itemId, "call-1");
} finally {
  await server.close();
}

console.log("Conversation persistence migration checks passed.");
