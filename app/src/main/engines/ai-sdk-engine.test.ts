import assert from "node:assert/strict";
import test from "node:test";

import { isRetryableStreamError, normalizeEngineError, toModelMessages } from "./ai-sdk-engine.js";

test("Provider 错误优先展示响应体中的具体原因", () => {
  const error = new Error("Failed after 3 attempts");
  Object.assign(error, {
    lastError: {
      responseBody: JSON.stringify({
        error: {
          message: "上游请求受限",
        },
      }),
    },
  });

  assert.equal(normalizeEngineError(error).message, "上游请求受限");
});

test("连接中断允许进入流重试", () => {
  assert.equal(isRetryableStreamError(new Error("net::ERR_CONNECTION_CLOSED")), true);
  assert.equal(isRetryableStreamError(new Error("socket hang up")), true);
});

test("配额和请求参数错误不进入流重试", () => {
  assert.equal(isRetryableStreamError(new Error("HTTP 429: quota exceeded")), false);
  assert.equal(isRetryableStreamError(new Error("invalid request")), false);
});

test("恢复会话时保留工具调用和工具结果", () => {
  const messages = toModelMessages([
    {
      id: "assistant-1",
      conversationId: "conversation-1",
      role: "assistant",
      createdAt: 1,
      status: "completed",
      parts: [
        { type: "text", text: "正在检查" },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "readFile",
          input: { path: "README.md" },
          status: "completed",
        },
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "readFile",
          output: { content: "hello" },
          isError: false,
        },
      ],
    },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "assistant");
  assert.equal(messages[1]?.role, "tool");
});
