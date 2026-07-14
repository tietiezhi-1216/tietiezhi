import { create } from "zustand";

export type Page = "chat" | "providers" | "settings";

interface UiState {
  page: Page;
  setPage: (page: Page) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  page: "chat",
  setPage: (page) => set({ page }),
}));
