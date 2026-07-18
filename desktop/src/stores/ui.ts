import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProductMode } from "@/lib/product-mode";

export type SettingsCategory =
  | "providers"
  | "titleModel"
  | "systemPrompt"
  | "skills"
  | "mcp"
  | "permissions"
  | "dictationModel"
  | "dictationHotkey"
  | "dictationPrompt"
  | "archives"
  | "appearance"
  | "update"
  | "about";

export const SIDEBAR_MIN_PX = 200;
export const SIDEBAR_MAX_PX = 480;
export const SIDEBAR_DEFAULT_PX = 256; // = shadcn's 16rem

export const clampSidebarWidth = (px: number): number =>
  Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, Math.round(px)));

interface UiState {
  /** Active top-level product area. */
  productMode: ProductMode;
  setProductMode: (mode: ProductMode) => void;
  /** Settings dialog visibility + active category. */
  settingsOpen: boolean;
  settingsCategory: SettingsCategory;
  openSettings: (category?: SettingsCategory) => void;
  closeSettings: () => void;
  setSettingsCategory: (category: SettingsCategory) => void;
  /** Agents management dialog; `editingAgentId` preselects one for editing. */
  agentsOpen: boolean;
  editingAgentId: string | null;
  openAgents: (agentId?: string) => void;
  closeAgents: () => void;
  /** Sidebar width in px (drag-resizable, persisted). */
  sidebarWidth: number;
  setSidebarWidth: (px: number) => void;
  /** Per-project task-list expansion; missing ids default to expanded. */
  expandedProjects: Record<string, boolean>;
  setProjectExpanded: (id: string, expanded: boolean) => void;
  projectsSectionExpanded: boolean;
  setProjectsSectionExpanded: (expanded: boolean) => void;
  tasksSectionExpanded: boolean;
  setTasksSectionExpanded: (expanded: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      productMode: "code",
      setProductMode: (productMode) => set({ productMode }),
      settingsOpen: false,
      settingsCategory: "providers",
      openSettings: (category) =>
        set((s) => ({
          settingsOpen: true,
          settingsCategory: category ?? s.settingsCategory,
        })),
      closeSettings: () => set({ settingsOpen: false }),
      setSettingsCategory: (settingsCategory) => set({ settingsCategory }),
      agentsOpen: false,
      editingAgentId: null,
      openAgents: (agentId) =>
        set({ agentsOpen: true, editingAgentId: agentId ?? null }),
      closeAgents: () => set({ agentsOpen: false, editingAgentId: null }),
      sidebarWidth: SIDEBAR_DEFAULT_PX,
      setSidebarWidth: (px) => set({ sidebarWidth: clampSidebarWidth(px) }),
      expandedProjects: {},
      setProjectExpanded: (id, expanded) =>
        set((state) => ({
          expandedProjects: { ...state.expandedProjects, [id]: expanded },
        })),
      projectsSectionExpanded: true,
      setProjectsSectionExpanded: (projectsSectionExpanded) =>
        set({ projectsSectionExpanded }),
      tasksSectionExpanded: false,
      setTasksSectionExpanded: (tasksSectionExpanded) =>
        set({ tasksSectionExpanded }),
    }),
    {
      name: "tietiezhi-ui",
      partialize: (state) => ({
        productMode: state.productMode,
        sidebarWidth: state.sidebarWidth,
        expandedProjects: state.expandedProjects,
        projectsSectionExpanded: state.projectsSectionExpanded,
        tasksSectionExpanded: state.tasksSectionExpanded,
      }),
    },
  ),
);
