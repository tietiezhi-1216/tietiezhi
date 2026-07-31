import type { ProductArea } from "@/App";

export interface ProductAreaDefinition {
  id: ProductArea;
  name: string;
  description: string;
  mascotSrc: string;
  gradientClassName: string;
}

export const PRODUCT_AREAS = [
  {
    id: "workspace",
    name: "Workspace",
    description: "项目、工作与代码",
    mascotSrc: "./mode-mascots/paper-plane/code.png",
    gradientClassName: "from-sky-300 via-indigo-400 to-violet-500",
  },
  {
    id: "create",
    name: "Create",
    description: "AI 图片创作",
    mascotSrc: "./mode-mascots/paper-plane/create.png",
    gradientClassName: "from-fuchsia-300 via-pink-400 to-amber-300",
  },
] as const satisfies readonly ProductAreaDefinition[];

export function getProductArea(id: ProductArea): ProductAreaDefinition {
  return PRODUCT_AREAS.find((area) => area.id === id) ?? PRODUCT_AREAS[0];
}
