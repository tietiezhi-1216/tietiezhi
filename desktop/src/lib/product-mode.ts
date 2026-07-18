export type ProductMode = "work" | "code" | "automations" | "create";

export interface ProductModeDefinition {
  id: ProductMode;
  name: string;
  description: string;
  mascotSrc: string;
  gradientClassName: string;
  selectedSurfaceClassName: string;
}

export const PRODUCT_MODES = [
  {
    id: "work",
    name: "Work",
    description: "文件、应用与研究",
    mascotSrc: "/mode-mascots/work.png",
    gradientClassName: "from-cyan-300 via-sky-400 to-blue-500",
    selectedSurfaceClassName: "bg-cyan-500/10 dark:bg-cyan-400/10",
  },
  {
    id: "code",
    name: "Code",
    description: "仓库、终端与测试",
    mascotSrc: "/mode-mascots/code.png",
    gradientClassName: "from-sky-300 via-indigo-400 to-violet-500",
    selectedSurfaceClassName: "bg-indigo-500/10 dark:bg-indigo-400/10",
  },
  {
    id: "automations",
    name: "Automations",
    description: "触发器、计划与运行",
    mascotSrc: "/mode-mascots/automations.png",
    gradientClassName: "from-amber-300 via-orange-400 to-rose-400",
    selectedSurfaceClassName: "bg-orange-500/10 dark:bg-orange-400/10",
  },
  {
    id: "create",
    name: "Create",
    description: "文档、图像与站点",
    mascotSrc: "/mode-mascots/create.png",
    gradientClassName: "from-fuchsia-300 via-pink-400 to-amber-300",
    selectedSurfaceClassName: "bg-fuchsia-500/10 dark:bg-fuchsia-400/10",
  },
] as const satisfies readonly ProductModeDefinition[];

export function getProductMode(id: ProductMode): ProductModeDefinition {
  return PRODUCT_MODES.find((mode) => mode.id === id) ?? PRODUCT_MODES[0];
}
