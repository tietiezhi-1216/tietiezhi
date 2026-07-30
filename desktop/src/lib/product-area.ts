export type ProductArea =
  | "tietiezhi"
  | "workspace"
  | "cores"
  | "automations"
  | "create";

export interface ProductAreaDefinition {
  id: ProductArea;
  name: string;
  description: string;
  mascotSrc: string;
  blinkMascotSrc?: string;
  gradientClassName: string;
  selectedSurfaceClassName: string;
  /**
   * Hidden from the switcher while its backend is being rebuilt. The code stays
   * so its timeline / diff / approval UI can be reused, but the area is not
   * reachable — its host commands answer with a "migrating to ACP" error.
   */
  hidden?: boolean;
}

export const PRODUCT_AREAS = [
  {
    id: "tietiezhi",
    name: "Tietiezhi",
    description: "记忆、陪伴与日常",
    mascotSrc: "/tietiezhi.png",
    blinkMascotSrc: undefined,
    gradientClassName: "from-cyan-300 via-sky-400 to-blue-500",
    selectedSurfaceClassName: "bg-cyan-500/10 dark:bg-cyan-400/10",
    hidden: true,
  },
  {
    id: "workspace",
    name: "Workspace",
    description: "项目、工作与代码",
    mascotSrc: "/mode-mascots/paper-plane/code.png",
    blinkMascotSrc: "/mode-mascots/paper-plane/code-blink.png",
    gradientClassName: "from-sky-300 via-indigo-400 to-violet-500",
    selectedSurfaceClassName: "bg-indigo-500/10 dark:bg-indigo-400/10",
    hidden: true,
  },
  {
    id: "cores",
    name: "Cores",
    description: "ACP 核心与 MCP 服务器",
    mascotSrc: "/mode-mascots/paper-plane/work.png",
    blinkMascotSrc: undefined,
    gradientClassName: "from-emerald-300 via-teal-400 to-cyan-500",
    selectedSurfaceClassName: "bg-teal-500/10 dark:bg-teal-400/10",
  },
  {
    id: "automations",
    name: "Automations",
    description: "触发器、计划与运行",
    mascotSrc: "/mode-mascots/paper-plane/automations.png",
    blinkMascotSrc: undefined,
    gradientClassName: "from-amber-300 via-orange-400 to-rose-400",
    selectedSurfaceClassName: "bg-orange-500/10 dark:bg-orange-400/10",
  },
  {
    id: "create",
    name: "Create",
    description: "图片与视频创作",
    mascotSrc: "/mode-mascots/paper-plane/create.png",
    blinkMascotSrc: "/mode-mascots/paper-plane/create-blink.png",
    gradientClassName: "from-fuchsia-300 via-pink-400 to-amber-300",
    selectedSurfaceClassName: "bg-fuchsia-500/10 dark:bg-fuchsia-400/10",
  },
] as const satisfies readonly ProductAreaDefinition[];

/** The area shown on first run and whenever a stored choice is unavailable. */
export const DEFAULT_PRODUCT_AREA: ProductArea = "cores";

/** Areas the switcher offers. */
export const VISIBLE_PRODUCT_AREAS: readonly ProductAreaDefinition[] = (
  PRODUCT_AREAS as readonly ProductAreaDefinition[]
).filter((area) => area.hidden !== true);

export function isProductAreaVisible(id: ProductArea): boolean {
  return VISIBLE_PRODUCT_AREAS.some((area) => area.id === id);
}

export function getProductArea(id: ProductArea): ProductAreaDefinition {
  return (
    PRODUCT_AREAS.find((area) => area.id === id) ??
    PRODUCT_AREAS.find((area) => area.id === DEFAULT_PRODUCT_AREA) ??
    PRODUCT_AREAS[0]
  );
}
