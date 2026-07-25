import { create } from "zustand";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import {
  archiveAutomation as archiveAutomationApi,
  createAutomation as createAutomationApi,
  deleteAutomation as deleteAutomationApi,
  errorMessage,
  listAutomations,
  loadAutomation,
  publishAutomation,
  saveAutomation,
} from "@/lib/api";
import type {
  AutomationDocument,
  AutomationMeta,
  AutomationNodeType,
  AutomationValueBinding,
  JsonValue,
} from "@/lib/api";
import {
  createAutomationNode,
  toCanvasEdges,
  toCanvasNodes,
  type AutomationCanvasNode,
  wouldCreateCycle,
} from "@/lib/automation";

export type AutomationSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

interface AutomationState {
  automations: AutomationMeta[];
  document: AutomationDocument | null;
  selectedNodeId: string | null;
  loading: boolean;
  saveState: AutomationSaveState;
  error: string;
  init: () => Promise<void>;
  create: (name?: string) => Promise<void>;
  open: (id: string) => Promise<void>;
  close: () => Promise<void>;
  saveNow: () => Promise<void>;
  publish: () => Promise<boolean>;
  archive: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  selectNode: (id: string | null) => void;
  updateDocumentInfo: (patch: Pick<Partial<AutomationDocument>, "name" | "description">) => void;
  updateDocumentSettings: (patch: Partial<AutomationDocument["settings"]>) => void;
  addNode: (type: AutomationNodeType, position: { x: number; y: number }) => void;
  applyNodeChanges: (changes: NodeChange<AutomationCanvasNode>[]) => void;
  commitNodePositions: (
    positions: { id: string; position: { x: number; y: number } }[],
  ) => void;
  applyEdgeChanges: (changes: EdgeChange[]) => void;
  connect: (connection: Connection) => void;
  updateNode: (
    id: string,
    patch: { name?: string; disabled?: boolean },
  ) => void;
  updateNodeConfig: (id: string, key: string, value: JsonValue) => void;
  updateNodeInput: (id: string, key: string, binding: AutomationValueBinding) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let activeSave: Promise<void> | null = null;
let editVersion = 0;

const newestFirst = (items: AutomationMeta[]): AutomationMeta[] =>
  [...items].sort((left, right) => right.updatedAt - left.updatedAt);

const metaFromDocument = (
  document: AutomationDocument,
  existing?: AutomationMeta,
): AutomationMeta => ({
  id: document.id,
  name: document.name,
  description: document.description,
  revision: document.revision,
  nodeCount: document.nodes.length,
  triggerType:
    document.nodes.find((node) =>
      node.type === "manualTrigger" || node.type === "scheduleTrigger",
    )?.type ?? "",
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  archivedAt: existing?.archivedAt ?? 0,
  publishedRevision: existing?.publishedRevision ?? 0,
  paused: existing?.paused ?? true,
  lastRunAt: existing?.lastRunAt ?? 0,
  nextRunAt: existing?.nextRunAt ?? 0,
  lastRunStatus: existing?.lastRunStatus ?? "",
});

const scheduleSave = () => {
  if (saveTimer != null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void useAutomationStore.getState().saveNow();
  }, 600);
};

export const useAutomationStore = create<AutomationState>()((set, get) => {
  const changeDocument = (
    transform: (document: AutomationDocument) => AutomationDocument,
  ) => {
    if (!get().document) return;
    editVersion += 1;
    set((state) => ({
      document: state.document ? transform(state.document) : null,
      saveState: "dirty",
      error: "",
    }));
    scheduleSave();
  };

  return {
    automations: [],
    document: null,
    selectedNodeId: null,
    loading: false,
    saveState: "idle",
    error: "",

    async init() {
      set({ loading: true, error: "" });
      try {
        set({ automations: newestFirst(await listAutomations()) });
      } catch (error) {
        set({ error: errorMessage(error) });
      } finally {
        set({ loading: false });
      }
    },

    async create(name) {
      await get().saveNow();
      if (get().document && get().saveState === "error") return;
      set({ loading: true, error: "" });
      try {
        const document = await createAutomationApi(name);
        editVersion = 0;
        set((state) => ({
          document,
          selectedNodeId: document.nodes[0]?.id ?? null,
          saveState: "saved",
          automations: newestFirst([
            metaFromDocument(document),
            ...state.automations.filter((item) => item.id !== document.id),
          ]),
        }));
      } catch (error) {
        set({ error: errorMessage(error) });
      } finally {
        set({ loading: false });
      }
    },

    async open(id) {
      if (get().document?.id === id) return;
      await get().saveNow();
      if (get().document && get().saveState === "error") return;
      set({ loading: true, error: "" });
      try {
        const document = await loadAutomation(id);
        editVersion = 0;
        set({
          document,
          selectedNodeId: null,
          saveState: "saved",
        });
      } catch (error) {
        set({ error: errorMessage(error) });
      } finally {
        set({ loading: false });
      }
    },

    async close() {
      await get().saveNow();
      if (get().document && get().saveState === "error") return;
      set({ document: null, selectedNodeId: null, saveState: "idle", error: "" });
    },

    async saveNow() {
      if (saveTimer != null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (activeSave) {
        await activeSave;
        if (get().saveState === "dirty") await get().saveNow();
        return;
      }
      const document = get().document;
      if (!document || get().saveState === "saved") return;
      const savingVersion = editVersion;
      set({ saveState: "saving", error: "" });
      const operation = (async () => {
        try {
          const saved = await saveAutomation(document);
          const current = get().document;
          if (!current || current.id !== saved.id) return;
          const unchanged = savingVersion === editVersion;
          const visibleDocument = unchanged
            ? saved
            : { ...current, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
          const existing = get().automations.find((item) => item.id === saved.id);
          set((state) => ({
            document: visibleDocument,
            saveState: unchanged ? "saved" : "dirty",
            automations: newestFirst([
              metaFromDocument(visibleDocument, existing),
              ...state.automations.filter((item) => item.id !== saved.id),
            ]),
          }));
          if (!unchanged) scheduleSave();
        } catch (error) {
          set({ saveState: "error", error: errorMessage(error) });
        }
      })();
      activeSave = operation;
      try {
        await operation;
      } finally {
        if (activeSave === operation) activeSave = null;
      }
    },

    async publish() {
      await get().saveNow();
      const current = get().document;
      if (!current || get().saveState === "error") return false;
      set({ loading: true, error: "" });
      try {
        const meta = await publishAutomation(current.id);
        const document = await loadAutomation(current.id);
        editVersion = 0;
        set((state) => ({
          document,
          saveState: "saved",
          automations: newestFirst([
            meta,
            ...state.automations.filter((item) => item.id !== meta.id),
          ]),
        }));
        return true;
      } catch (error) {
        set({ error: errorMessage(error) });
        return false;
      } finally {
        set({ loading: false });
      }
    },

    async archive(id) {
      try {
        await archiveAutomationApi(id, true);
        if (get().document?.id === id) {
          set({ document: null, selectedNodeId: null, saveState: "idle" });
        }
        set((state) => ({
          automations: state.automations.filter((item) => item.id !== id),
        }));
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },

    async remove(id) {
      try {
        await deleteAutomationApi(id);
        if (get().document?.id === id) {
          set({ document: null, selectedNodeId: null, saveState: "idle" });
        }
        set((state) => ({
          automations: state.automations.filter((item) => item.id !== id),
        }));
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },

    selectNode(selectedNodeId) {
      set({ selectedNodeId });
    },

    updateDocumentInfo(patch) {
      changeDocument((document) => ({ ...document, ...patch }));
    },

    updateDocumentSettings(patch) {
      changeDocument((document) => ({
        ...document,
        settings: { ...document.settings, ...patch },
      }));
    },

    addNode(type, position) {
      changeDocument((document) => ({
        ...document,
        nodes: [...document.nodes, createAutomationNode(type, position)],
      }));
      const node = get().document?.nodes.at(-1);
      if (node) set({ selectedNodeId: node.id });
    },

    applyNodeChanges(changes) {
      const document = get().document;
      if (!document) return;
      const canvasNodes = applyNodeChanges<AutomationCanvasNode>(
        changes,
        toCanvasNodes(document.nodes, get().selectedNodeId),
      );
      const selectedNodeId = canvasNodes.find((node) => node.selected)?.id ?? null;
      const structural = changes.some(
        (change) => change.type === "position" || change.type === "remove",
      );
      if (!structural) {
        set({ selectedNodeId });
        return;
      }
      const remainingIds = new Set(canvasNodes.map((node) => node.id));
      changeDocument((current) => ({
        ...current,
        nodes: canvasNodes.map((canvasNode) => {
          const existing = current.nodes.find((node) => node.id === canvasNode.id);
          const node = existing
            ? { ...existing, position: canvasNode.position }
            : canvasNode.data.automationNode;
          return {
            ...node,
            inputs: Object.fromEntries(
              Object.entries(node.inputs).filter(([, binding]) =>
                binding.kind !== "nodeOutput" || remainingIds.has(binding.nodeId),
              ),
            ),
          };
        }),
        edges: current.edges.filter(
          (edge) => remainingIds.has(edge.sourceNodeId) && remainingIds.has(edge.targetNodeId),
        ),
      }));
      set({
        selectedNodeId:
          selectedNodeId && remainingIds.has(selectedNodeId) ? selectedNodeId : null,
      });
    },

    commitNodePositions(positions) {
      const document = get().document;
      if (!document || positions.length === 0) return;
      const positionById = new Map(
        positions.map(({ id, position }) => [id, position]),
      );
      const changed = document.nodes.some((node) => {
        const position = positionById.get(node.id);
        return (
          position != null &&
          (position.x !== node.position.x || position.y !== node.position.y)
        );
      });
      if (!changed) return;

      changeDocument((current) => ({
        ...current,
        nodes: current.nodes.map((node) => {
          const position = positionById.get(node.id);
          return position ? { ...node, position } : node;
        }),
      }));
    },

    applyEdgeChanges(changes) {
      const document = get().document;
      if (!document || !changes.some((change) => change.type === "remove")) return;
      const remaining = applyEdgeChanges(changes, toCanvasEdges(document.edges));
      const remainingIds = new Set(remaining.map((edge) => edge.id));
      const removed = document.edges.filter((edge) => !remainingIds.has(edge.id));
      changeDocument((current) => ({
        ...current,
        edges: current.edges.filter((edge) => remainingIds.has(edge.id)),
        nodes: current.nodes.map((node) => {
          const ports = removed
            .filter((edge) => edge.targetNodeId === node.id)
            .map((edge) => edge.targetPort);
          if (ports.length === 0) return node;
          return {
            ...node,
            inputs: Object.fromEntries(
              Object.entries(node.inputs).filter(([key]) => !ports.includes(key)),
            ),
          };
        }),
      }));
    },

    connect(connection) {
      const document = get().document;
      const source = connection.source;
      const target = connection.target;
      if (!document || !source || !target || wouldCreateCycle(document, source, target)) {
        return;
      }
      const sourcePort = connection.sourceHandle ?? "output";
      const targetPort = connection.targetHandle ?? "input";
      changeDocument((current) => ({
        ...current,
        edges: [
          ...current.edges.filter(
            (edge) =>
              !(edge.targetNodeId === target && edge.targetPort === targetPort),
          ),
          {
            id: crypto.randomUUID(),
            sourceNodeId: source,
            sourcePort,
            targetNodeId: target,
            targetPort,
          },
        ],
        nodes: current.nodes.map((node) =>
          node.id === target
            ? {
                ...node,
                inputs: {
                  ...node.inputs,
                  [targetPort]: {
                    kind: "nodeOutput" as const,
                    nodeId: source,
                    path: "/",
                  },
                },
              }
            : node,
        ),
      }));
    },

    updateNode(id, patch) {
      changeDocument((document) => ({
        ...document,
        nodes: document.nodes.map((node) =>
          node.id === id ? { ...node, ...patch } : node,
        ),
      }));
    },

    updateNodeConfig(id, key, value) {
      changeDocument((document) => ({
        ...document,
        nodes: document.nodes.map((node) =>
          node.id === id
            ? { ...node, config: { ...node.config, [key]: value } }
            : node,
        ),
      }));
    },

    updateNodeInput(id, key, binding) {
      changeDocument((document) => ({
        ...document,
        nodes: document.nodes.map((node) =>
          node.id === id
            ? { ...node, inputs: { ...node.inputs, [key]: binding } }
            : node,
        ),
      }));
    },
  };
});
