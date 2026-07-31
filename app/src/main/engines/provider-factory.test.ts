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
  providerType: "openai-compatible",
  displayName: "Compatible",
  baseURL: "https://gateway.example.test/v1",
  credentialRef: "provider:compatible-test",
  enabled: true,
  models: ["test-model"],
  modelMetadata: {},
  builtIn: false,
};

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
