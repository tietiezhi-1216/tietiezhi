import assert from "node:assert/strict";
import test from "node:test";

import { generateImage, generateText } from "ai";

import type { ProviderAccount } from "@shared/contracts";

import { imageModel, languageModel, setProviderFetch } from "./provider-factory.js";

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
  setProviderFetch(async (input) => {
    requestedURL = input instanceof Request ? input.url : String(input);
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
    }),
    /停止测试请求/,
  );

  assert.match(
    requestedURL,
    /^https:\/\/gateway\.example\.test\/v1beta\/models\/gemini-image-test:generateContent/,
  );
  setProviderFetch(globalThis.fetch);
});
