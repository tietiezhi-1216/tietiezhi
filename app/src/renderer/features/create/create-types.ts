import type {
  LocalMediaAsset,
  MediaReferenceInput,
  MediaResolution,
  MediaType,
  ProviderAccount,
} from "@shared/contracts";
import type { MediaModelCapabilities } from "@shared/media-model-capabilities";

export type CreateProvider = ProviderAccount & {
  imageModels: string[];
  videoModels: string[];
};

export interface CreateController {
  mode: MediaType;
  providers: CreateProvider[];
  providerId: string;
  model: string;
  prompt: string;
  assets: LocalMediaAsset[];
  references: MediaReferenceInput[];
  capabilities: MediaModelCapabilities;
  aspectRatio?: `${number}:${number}`;
  resolution?: MediaResolution;
  quality?: "auto" | "low" | "medium" | "high";
  duration?: number;
  count: number;
  busy: boolean;
  running: boolean;
  collapsed: boolean;
  error: string;
  setMode: (mode: MediaType) => void;
  setProvider: (providerId: string) => void;
  setModel: (model: string) => void;
  setPrompt: (prompt: string) => void;
  setReferences: (references: MediaReferenceInput[]) => void;
  importAssets: () => Promise<void>;
  removeAsset: (id: string) => Promise<void>;
  setAspectRatio: (aspectRatio: `${number}:${number}`) => void;
  setResolution: (resolution: MediaResolution) => void;
  setQuality: (quality: "auto" | "low" | "medium" | "high") => void;
  setDuration: (duration: number) => void;
  setCount: (count: number) => void;
  generate: () => Promise<void>;
  cancel: () => Promise<void>;
  expand: () => void;
}
