import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEngineError } from "./ai-sdk-engine.js";

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
