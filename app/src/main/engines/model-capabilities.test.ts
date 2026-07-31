import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderAccount } from "@shared/contracts";
import {
  providerImageModels,
  providerVideoModels,
} from "../../renderer/lib/model-capabilities.js";
import { mediaModelCapabilities } from "../../shared/media-model-capabilities.js";

const provider: ProviderAccount = {
  id: "builtin-official",
  providerType: "openai-compatible",
  displayName: "Tietiezhi Gateway",
  baseURL: "https://gateway.example.test/v1",
  credentialRef: "provider:builtin-official",
  enabled: true,
  models: [
    "gemini-2.5-flash-image",
    "gpt-image-2",
    "veo-3.1-generate-preview",
  ],
  modelMetadata: {
    "gemini-2.5-flash-image": {
      defaultWireAPI: "gemini_generate_content",
      wireAPIs: ["gemini_generate_content"],
      supportedParameters: [],
    },
    "gpt-image-2": {
      defaultWireAPI: "responses",
      wireAPIs: ["responses"],
      supportedParameters: [],
    },
    "veo-3.1-generate-preview": {
      defaultWireAPI: "gemini_generate_content",
      wireAPIs: ["gemini_generate_content"],
      supportedParameters: [],
    },
  },
  builtIn: true,
};

test("Create 保留 Gemini 协议图片模型", () => {
  assert.deepEqual(providerImageModels(provider), [
    "gemini-2.5-flash-image",
    "gpt-image-2",
  ]);
});

test("Create 只向视频模式暴露 Gemini 协议 Veo 模型", () => {
  assert.deepEqual(providerVideoModels(provider), [
    "veo-3.1-generate-preview",
  ]);
});

test("Gemini 3.1 Flash 图片模型提供 512、1K、2K 和 4K", () => {
  const capabilities = mediaModelCapabilities(
    "gemini-3.1-flash-image",
    "image",
  );
  assert.deepEqual(
    capabilities.resolutions.map((option) => option.value),
    ["512", "1K", "2K", "4K"],
  );
  assert.equal(capabilities.aspectRatios.length, 10);
  assert.equal(capabilities.defaultResolution, "1K");
  assert.deepEqual(capabilities.acceptedReferenceTypes, ["image"]);
  assert.equal(capabilities.maxReferences, 14);
});

test("GPT Image 2 使用带比例的像素尺寸和质量参数", () => {
  const capabilities = mediaModelCapabilities("gpt-image-2", "image");
  assert.deepEqual(
    capabilities.resolutions.map((option) => option.value),
    [
      "1024x1024",
      "1536x1024",
      "1024x1536",
      "2048x2048",
      "2048x1152",
      "3840x2160",
      "2160x3840",
    ],
  );
  assert.deepEqual(
    capabilities.qualities.map((option) => option.value),
    ["auto", "low", "medium", "high"],
  );
});

test("Veo 3.1 暴露官方分辨率与时长", () => {
  const capabilities = mediaModelCapabilities(
    "veo-3.1-generate-preview",
    "video",
  );
  assert.deepEqual(
    capabilities.resolutions.map((option) => option.value),
    ["1280x720", "1920x1080", "3840x2160"],
  );
  assert.deepEqual(
    capabilities.durations.map((option) => option.value),
    [4, 6, 8],
  );
  assert.deepEqual(capabilities.acceptedReferenceTypes, ["image", "video"]);
  assert.deepEqual(capabilities.referenceRoles, [
    "reference",
    "first-frame",
    "last-frame",
  ]);
});
