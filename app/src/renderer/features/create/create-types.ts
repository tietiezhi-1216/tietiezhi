import type { ProviderAccount } from "@shared/contracts";

export type ImageProvider = ProviderAccount & { imageModels: string[] };

export interface CreateController {
  providers: ImageProvider[];
  providerId: string;
  model: string;
  prompt: string;
  busy: boolean;
  running: boolean;
  error: string;
  setProvider: (providerId: string) => void;
  setModel: (model: string) => void;
  setPrompt: (prompt: string) => void;
  generate: () => Promise<void>;
  cancel: () => Promise<void>;
}
