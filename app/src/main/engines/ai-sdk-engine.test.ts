import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderAccount } from "@shared/contracts";

import {
  isRetryableStreamError,
  modelProviderOptions,
  modelSupportsTools,
  normalizeEngineError,
  toModelMessages,
} from "./ai-sdk-engine.js";

const configurableProvider: ProviderAccount = {
  id: "compatible-test",
  vendorId: "other",
  providerType: "openai-compatible",
  displayName: "Compatible",
  baseURL: "https://example.test/v1",
  credentialRef: "provider:compatible-test",
  enabled: true,
  models: ["reasoning-model"],
  modelMetadata: {
    "reasoning-model": {
      wireAPIs: ["chat_completions"],
      toolCall: true,
      supportedParameters: [],
      overrides: {
        toolCall: false,
        defaultReasoningEffort: "high",
      },
    },
  },
  builtIn: false,
};

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

test("恢复会话时忽略没有结果的中断工具调用", () => {
  const messages = toModelMessages([
    {
      id: "assistant-interrupted",
      conversationId: "conversation-1",
      role: "assistant",
      createdAt: 1,
      status: "cancelled",
      parts: [
        { type: "text", text: "准备读取文件" },
        {
          type: "tool-call",
          toolCallId: "call-orphaned",
          toolName: "readFile",
          input: { path: "README.md" },
          status: "running",
        },
      ],
    },
  ]);
  assert.deepEqual(messages, [
    { role: "assistant", content: [{ type: "text", text: "准备读取文件" }] },
  ]);
});

test("用户粘贴图片会转换为 AI SDK 多模态消息", () => {
  const messages = toModelMessages([
    {
      id: "user-image",
      conversationId: "conversation-1",
      role: "user",
      createdAt: 1,
      status: "completed",
      parts: [
        { type: "text", text: "分析这张图" },
        {
          type: "attachment",
          name: "paste.png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,aGVsbG8=",
        },
      ],
    },
  ]);
  assert.deepEqual(messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "分析这张图" },
        {
          type: "image",
          image: "data:image/png;base64,aGVsbG8=",
          mediaType: "image/png",
        },
      ],
    },
  ]);
});

test("模型规则会关闭工具并传递默认思考等级", () => {
  assert.equal(modelSupportsTools(configurableProvider, "reasoning-model"), false);
  assert.deepEqual(modelProviderOptions(configurableProvider, "reasoning-model"), {
    compatible: { reasoningEffort: "high" },
  });
});
