import type {
  MediaReferenceRole,
  MediaResolution,
  MediaType,
} from "./contracts.js";

export interface MediaParameterOption<T extends string | number> {
  value: T;
  label: string;
}

export interface MediaModelCapabilities {
  vendorId: "agnes" | "google" | "openai" | "other";
  vendorLabel: string;
  mode: MediaType;
  aspectRatios: MediaParameterOption<`${number}:${number}`>[];
  resolutions: MediaParameterOption<MediaResolution>[];
  qualities: MediaParameterOption<"auto" | "low" | "medium" | "high">[];
  durations: MediaParameterOption<number>[];
  counts: MediaParameterOption<number>[];
  defaultAspectRatio?: `${number}:${number}`;
  defaultResolution?: MediaResolution;
  defaultQuality?: "auto" | "low" | "medium" | "high";
  defaultDuration?: number;
  defaultCount: number;
  acceptedReferenceTypes: MediaType[];
  maxReferences: number;
  referenceRoles: MediaReferenceRole[];
}

const IMAGE_REFERENCE_ROLES: MediaReferenceRole[] = ["reference"];
const VIDEO_REFERENCE_ROLES: MediaReferenceRole[] = [
  "reference",
  "first-frame",
  "last-frame",
];

const FULL_IMAGE_RATIOS: MediaParameterOption<`${number}:${number}`>[] = [
  { value: "1:1", label: "1:1 方形" },
  { value: "2:3", label: "2:3 竖版" },
  { value: "3:2", label: "3:2 横版" },
  { value: "3:4", label: "3:4 竖版" },
  { value: "4:3", label: "4:3 横版" },
  { value: "4:5", label: "4:5 竖版" },
  { value: "5:4", label: "5:4 横版" },
  { value: "9:16", label: "9:16 手机竖屏" },
  { value: "16:9", label: "16:9 宽屏" },
  { value: "21:9", label: "21:9 超宽屏" },
];

const IMAGEN_RATIOS = FULL_IMAGE_RATIOS.filter((option) =>
  ["1:1", "3:4", "4:3", "9:16", "16:9"].includes(option.value),
);
const OPENAI_COMPATIBLE_RATIOS = FULL_IMAGE_RATIOS.filter((option) =>
  ["1:1", "2:3", "3:2"].includes(option.value),
);

const LEGACY_OPENAI_SIZES: MediaParameterOption<MediaResolution>[] = [
  { value: "1024x1024", label: "1K · 1:1" },
  { value: "1536x1024", label: "1.5K · 3:2" },
  { value: "1024x1536", label: "1.5K · 2:3" },
];

const GPT_IMAGE_2_SIZES: MediaParameterOption<MediaResolution>[] = [
  ...LEGACY_OPENAI_SIZES,
  { value: "2048x2048", label: "2K · 1:1" },
  { value: "2048x1152", label: "2K · 16:9" },
  { value: "3840x2160", label: "4K · 16:9" },
  { value: "2160x3840", label: "4K · 9:16" },
];

const IMAGE_QUALITIES: MediaParameterOption<
  "auto" | "low" | "medium" | "high"
>[] = [
  { value: "auto", label: "自动质量" },
  { value: "low", label: "低质量" },
  { value: "medium", label: "中等质量" },
  { value: "high", label: "高质量" },
];

const ONE_COUNT: MediaParameterOption<number>[] = [{ value: 1, label: "1 个" }];
const FOUR_COUNTS: MediaParameterOption<number>[] = [
  { value: 1, label: "1 个" },
  { value: 2, label: "2 个" },
  { value: 3, label: "3 个" },
  { value: 4, label: "4 个" },
];
const VIDEO_RATIOS: MediaParameterOption<`${number}:${number}`>[] = [
  { value: "16:9", label: "16:9 横屏" },
  { value: "9:16", label: "9:16 竖屏" },
];

function imageCapabilities(model: string): MediaModelCapabilities {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("gemini-")) {
    const flash31 = /gemini-3\.1-flash-image/.test(normalized);
    const flashLite31 = /gemini-3\.1-flash-lite-image/.test(normalized);
    const pro3 = /gemini-3(?:\.1)?-pro-image/.test(normalized);
    const resolutions: MediaParameterOption<MediaResolution>[] =
      flashLite31 || normalized.includes("2.5-flash-image")
        ? [{ value: "1K", label: "1K" }]
        : flash31
          ? [
              { value: "512", label: "512px" },
              { value: "1K", label: "1K" },
              { value: "2K", label: "2K" },
              { value: "4K", label: "4K" },
            ]
          : pro3
            ? [
                { value: "1K", label: "1K" },
                { value: "2K", label: "2K" },
                { value: "4K", label: "4K" },
              ]
            : [{ value: "1K", label: "1K" }];
    return {
      vendorId: "google",
      vendorLabel: "Google",
      mode: "image",
      aspectRatios: FULL_IMAGE_RATIOS,
      resolutions,
      qualities: [],
      durations: [],
      counts: ONE_COUNT,
      defaultAspectRatio: "1:1",
      defaultResolution: resolutions.some((option) => option.value === "1K")
        ? "1K"
        : resolutions[0]?.value,
      defaultCount: 1,
      acceptedReferenceTypes: ["image"],
      maxReferences: normalized.includes("2.5-flash-image") ? 3 : 14,
      referenceRoles: IMAGE_REFERENCE_ROLES,
    };
  }
  if (normalized.startsWith("imagen-")) {
    return {
      vendorId: "google",
      vendorLabel: "Google",
      mode: "image",
      aspectRatios: IMAGEN_RATIOS,
      resolutions: [],
      qualities: [],
      durations: [],
      counts: FOUR_COUNTS,
      defaultAspectRatio: "1:1",
      defaultCount: 1,
      acceptedReferenceTypes: [],
      maxReferences: 0,
      referenceRoles: [],
    };
  }
  if (/^(?:gpt-image|chatgpt-image|dall-e)/.test(normalized)) {
    const resolutions = normalized.startsWith("gpt-image-2")
      ? GPT_IMAGE_2_SIZES
      : LEGACY_OPENAI_SIZES;
    return {
      vendorId: "openai",
      vendorLabel: "OpenAI",
      mode: "image",
      aspectRatios: [],
      resolutions,
      qualities: IMAGE_QUALITIES,
      durations: [],
      counts: FOUR_COUNTS,
      defaultResolution: "1024x1024",
      defaultQuality: "auto",
      defaultCount: 1,
      acceptedReferenceTypes: ["image"],
      maxReferences: 10,
      referenceRoles: IMAGE_REFERENCE_ROLES,
    };
  }
  if (normalized.startsWith("agnes-image")) {
    return {
      vendorId: "agnes",
      vendorLabel: "Agnes",
      mode: "image",
      aspectRatios: OPENAI_COMPATIBLE_RATIOS,
      resolutions: [{ value: "1K", label: "1K" }],
      qualities: [],
      durations: [],
      counts: ONE_COUNT,
      defaultAspectRatio: "1:1",
      defaultResolution: "1K",
      defaultCount: 1,
      acceptedReferenceTypes: ["image"],
      maxReferences: 4,
      referenceRoles: IMAGE_REFERENCE_ROLES,
    };
  }
  return {
    vendorId: "other",
    vendorLabel: "其他图片模型",
    mode: "image",
    aspectRatios: [{ value: "1:1", label: "1:1 方形" }],
    resolutions: [],
    qualities: [],
    durations: [],
    counts: ONE_COUNT,
    defaultAspectRatio: "1:1",
    defaultCount: 1,
    acceptedReferenceTypes: [],
    maxReferences: 0,
    referenceRoles: [],
  };
}

function videoCapabilities(model: string): MediaModelCapabilities {
  const normalized = model.toLowerCase();
  if (normalized === "") {
    return {
      vendorId: "other",
      vendorLabel: "其他视频模型",
      mode: "video",
      aspectRatios: [],
      resolutions: [],
      qualities: [],
      durations: [],
      counts: ONE_COUNT,
      defaultCount: 1,
      acceptedReferenceTypes: [],
      maxReferences: 0,
      referenceRoles: [],
    };
  }
  const veo31 = normalized.includes("veo-3.1");
  const veo31Lite = veo31 && normalized.includes("lite");
  const veo3 = normalized.includes("veo-3.0");
  const veo2 = normalized.includes("veo-2");
  const resolutions: MediaParameterOption<MediaResolution>[] = [
    { value: "1280x720", label: "720p" },
    ...((veo31 || veo3)
      ? [{ value: "1920x1080" as const, label: "1080p" }]
      : []),
    ...(veo31 && !veo31Lite
      ? [{ value: "3840x2160" as const, label: "4K" }]
      : []),
  ];
  const durations: MediaParameterOption<number>[] = veo31
    ? [
        { value: 4, label: "4 秒" },
        { value: 6, label: "6 秒" },
        { value: 8, label: "8 秒" },
      ]
    : veo2
      ? [
          { value: 5, label: "5 秒" },
          { value: 6, label: "6 秒" },
          { value: 8, label: "8 秒" },
        ]
      : [{ value: 8, label: "8 秒" }];
  return {
    vendorId: normalized.startsWith("veo-") ? "google" : "other",
    vendorLabel: normalized.startsWith("veo-") ? "Google" : "其他视频模型",
    mode: "video",
    aspectRatios: VIDEO_RATIOS,
    resolutions,
    qualities: [],
    durations,
    counts:
      veo2
        ? [
            { value: 1, label: "1 个" },
            { value: 2, label: "2 个" },
          ]
        : ONE_COUNT,
    defaultAspectRatio: "16:9",
    defaultResolution: "1280x720",
    defaultDuration: veo3 ? 8 : durations.at(-1)?.value ?? 8,
    defaultCount: 1,
    acceptedReferenceTypes: ["image", "video"],
    maxReferences: veo31 ? 3 : 1,
    referenceRoles: VIDEO_REFERENCE_ROLES,
  };
}

export function mediaModelCapabilities(
  model: string,
  mode: MediaType,
): MediaModelCapabilities {
  return mode === "video" ? videoCapabilities(model) : imageCapabilities(model);
}

export function aspectRatioForResolution(
  resolution: MediaResolution | undefined,
): `${number}:${number}` | undefined {
  switch (resolution) {
    case "1024x1024":
    case "2048x2048":
      return "1:1";
    case "1536x1024":
      return "3:2";
    case "1024x1536":
      return "2:3";
    case "2048x1152":
    case "3840x2160":
    case "1920x1080":
    case "1280x720":
      return "16:9";
    case "2160x3840":
      return "9:16";
    default:
      return undefined;
  }
}
