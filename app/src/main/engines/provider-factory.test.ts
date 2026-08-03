import assert from "node:assert/strict";
import test from "node:test";

import {
  experimental_generateVideo as generateVideo,
  generateImage,
  generateText,
} from "ai";

import type { ProviderAccount } from "@shared/contracts";

import {
  imageModel,
  languageModel,
  setProviderFetch,
  videoModel,
} from "./provider-factory.js";

const provider: ProviderAccount = {
  id: "compatible-test",
  vendorId: "other",
  providerType: "openai-compatible",
  displayName: "Compatible",
  baseURL: "https://gateway.example.test/v1",
  credentialRef: "provider:compatible-test",
  enabled: true,
  models: ["test-model"],
  modelMetadata: {},
  builtIn: false,
};

const nativeProviderCases: Array<{
  type: ProviderAccount["providerType"];
  providerName: string;
  baseURL: string;
}> = [
  { type: "deepseek", providerName: "deepseek.chat", baseURL: "https://api.deepseek.com/v1" },
  { type: "moonshotai", providerName: "moonshotai.chat", baseURL: "https://api.moonshot.cn/v1" },
  { type: "zhipu", providerName: "zhipu.chat", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
  { type: "alibaba", providerName: "alibaba.chat", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { type: "minimax", providerName: "minimax.chat", baseURL: "https://api.minimaxi.com/v1" },
  { type: "xai", providerName: "xai.responses", baseURL: "https://api.x.ai/v1" },
  { type: "mistral", providerName: "mistral.chat", baseURL: "https://api.mistral.ai/v1" },
  { type: "groq", providerName: "groq.chat", baseURL: "https://api.groq.com/openai/v1" },
  { type: "openrouter", providerName: "openrouter", baseURL: "https://openrouter.ai/api/v1" },
  { type: "togetherai", providerName: "togetherai.chat", baseURL: "https://api.together.xyz/v1" },
  { type: "cerebras", providerName: "cerebras.chat", baseURL: "https://api.cerebras.ai/v1" },
  { type: "ollama", providerName: "ollama.responses", baseURL: "http://127.0.0.1:11434/api" },
];

for (const item of nativeProviderCases) {
  test(`${item.type} 使用独立的 AI SDK Provider`, () => {
    const model = languageModel(
      { ...provider, providerType: item.type, baseURL: item.baseURL },
      "test-key",
      "test-model",
    );
    if (typeof model === "string") throw new Error("预期创建 AI SDK Provider 模型实例");
    assert.equal(model.provider, item.providerName);
  });
}

test("OpenAI-compatible 文本模型使用 Chat Completions 协议", async () => {
  let requestedURL = "";
  setProviderFetch(async (input) => {
    requestedURL = input instanceof Request ? input.url : String(input);
    throw new Error("停止测试请求");
  });

  await assert.rejects(
    generateText({
      model: languageModel(provider, "test-key", "test-model"),
      prompt: "hello",
    }),
    /停止测试请求/,
  );

  assert.equal(requestedURL, "https://gateway.example.test/v1/chat/completions");
  setProviderFetch(globalThis.fetch);
});

test("供应商的非 v1 版本地址不会被重复追加版本路径", async () => {
  let requestedURL = "";
  setProviderFetch(async (input) => {
    requestedURL = input instanceof Request ? input.url : String(input);
    throw new Error("停止测试请求");
  });

  await assert.rejects(
    generateText({
      model: languageModel(
        { ...provider, baseURL: "https://ark.example.test/api/v3" },
        "test-key",
        "test-model",
      ),
      prompt: "hello",
    }),
    /停止测试请求/,
  );

  assert.equal(requestedURL, "https://ark.example.test/api/v3/chat/completions");
  setProviderFetch(globalThis.fetch);
});

test("内置中转站按模型选择 Anthropic Messages 协议", async () => {
  let requestedURL = "";
  setProviderFetch(async (input) => {
    requestedURL = input instanceof Request ? input.url : String(input);
    throw new Error("停止测试请求");
  });
  const builtIn: ProviderAccount = {
    ...provider,
    id: "builtin-official",
    builtIn: true,
    models: ["claude-sonnet-test"],
    modelMetadata: {
      "claude-sonnet-test": {
        defaultWireAPI: "anthropic_messages",
        wireAPIs: ["anthropic_messages"],
        supportedParameters: [],
      },
    },
  };

  await assert.rejects(
    generateText({
      model: languageModel(builtIn, "test-key", "claude-sonnet-test"),
      prompt: "hello",
    }),
    /停止测试请求/,
  );

  assert.equal(requestedURL, "https://gateway.example.test/v1/messages");
  setProviderFetch(globalThis.fetch);
});

test("内置中转站 Gemini 图片模型使用 generateContent 协议", async () => {
  let requestedURL = "";
  let requestedBody = "";
  setProviderFetch(async (input, init) => {
    requestedURL = input instanceof Request ? input.url : String(input);
    requestedBody = typeof init?.body === "string" ? init.body : "";
    throw new Error("停止测试请求");
  });
  const builtIn: ProviderAccount = {
    ...provider,
    id: "builtin-official",
    builtIn: true,
    models: ["gemini-image-test"],
    modelMetadata: {
      "gemini-image-test": {
        defaultWireAPI: "gemini_generate_content",
        wireAPIs: ["gemini_generate_content"],
        supportedParameters: [],
      },
    },
  };

  await assert.rejects(
    generateImage({
      model: imageModel(builtIn, "test-key", "gemini-image-test"),
      prompt: "hello",
      aspectRatio: "16:9",
      providerOptions: {
        google: {
          imageConfig: {
            aspectRatio: "16:9",
            imageSize: "4K",
          },
        },
      },
    }),
    /停止测试请求/,
  );

  assert.match(
    requestedURL,
    /^https:\/\/gateway\.example\.test\/v1beta\/models\/gemini-image-test:generateContent/,
  );
  const body = JSON.parse(requestedBody) as {
    generationConfig?: {
      imageConfig?: { aspectRatio?: string; imageSize?: string };
    };
  };
  assert.deepEqual(body.generationConfig?.imageConfig, {
    aspectRatio: "16:9",
    imageSize: "4K",
  });
  setProviderFetch(globalThis.fetch);
});

test("内置中转站 Veo 模型使用 Gemini 长任务视频协议", async () => {
  let requestedURL = "";
  setProviderFetch(async (input) => {
    requestedURL = input instanceof Request ? input.url : String(input);
    throw new Error("停止测试请求");
  });
  const builtIn: ProviderAccount = {
    ...provider,
    id: "builtin-official",
    builtIn: true,
    models: ["veo-3.1-generate-preview"],
    modelMetadata: {
      "veo-3.1-generate-preview": {
        defaultWireAPI: "gemini_generate_content",
        wireAPIs: ["gemini_generate_content"],
        supportedParameters: [],
      },
    },
  };

  await assert.rejects(
    generateVideo({
      model: videoModel(builtIn, "test-key", "veo-3.1-generate-preview"),
      prompt: "hello",
      maxRetries: 0,
    }),
    /停止测试请求/,
  );

  assert.equal(
    requestedURL,
    "https://gateway.example.test/v1beta/models/veo-3.1-generate-preview:predictLongRunning",
  );
  setProviderFetch(globalThis.fetch);
});
