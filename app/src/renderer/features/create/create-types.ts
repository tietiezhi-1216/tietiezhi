import type {
  MediaArtifact,
  MediaJob,
  ProviderAccount,
} from "@shared/contracts";

export type CreateView = "inspiration" | "generations" | "assets";
export type ImageRatio = NonNullable<MediaJob["aspectRatio"]>;
export type ImageProvider = ProviderAccount & { imageModels: string[] };

export interface CreateAsset {
  artifact: MediaArtifact;
  job: MediaJob;
}

export interface CreateController {
  providers: ImageProvider[];
  jobs: MediaJob[];
  providerId: string;
  model: string;
  prompt: string;
  ratio: ImageRatio;
  ratios: readonly ImageRatio[];
  count: number;
  busy: boolean;
  running: boolean;
  error: string;
  favorites: ReadonlySet<string>;
  setProvider: (providerId: string) => void;
  setModel: (model: string) => void;
  setPrompt: (prompt: string) => void;
  setRatio: (ratio: ImageRatio) => void;
  setCount: (count: number) => void;
  generate: () => Promise<void>;
  retry: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reuse: (job: MediaJob) => void;
  saveArtifact: (path: string) => Promise<void>;
  toggleFavorite: (artifactId: string) => void;
}
