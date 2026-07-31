import assert from "node:assert/strict";
import test from "node:test";

import { isRetryableStreamError, normalizeEngineError } from "./ai-sdk-engine.js";

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
