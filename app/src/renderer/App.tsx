import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { LoaderCircle } from "lucide-react";

import { GatewayAccountButton } from "@/components/gateway-account-button";
import { ProductSwitcher } from "@/components/product-switcher";
import {
  ProviderDialog,
  type SettingsCategory,
} from "@/features/settings/provider-dialog";
import { WorkspacePage } from "@/features/workspace/workspace-page";
import { cn } from "@/lib/utils";

export type ProductArea = "workspace" | "create";
const IS_MACOS = navigator.userAgent.includes("Mac");
const importCreatePage = () => import("@/features/create/create-page");
const CreatePage = lazy(async () => {
  const module = await importCreatePage();
  return { default: module.CreatePage };
});

export function App() {
  const [area, setArea] = useState<ProductArea>("workspace");
  // 访问过的分区会一直挂着：切回来时状态、滚动位置、进行中的任务都还在，
  // 也才有两层同时存在的交叉淡入可做。
  const [mounted, setMounted] = useState<ProductArea[]>(["workspace"]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] =
    useState<SettingsCategory>("providers");
  const [providerVersion, setProviderVersion] = useState(0);

  const switchArea = useCallback((next: ProductArea) => {
    setMounted((current) =>
      current.includes(next) ? current : [...current, next],
    );
    setArea(next);
  }, []);

  const openSettings = useCallback((category: SettingsCategory = "providers") => {
    setSettingsCategory(category);
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // 启动后空闲时把 Create 的分包先取回来，首次切换就不会停在 Suspense 兜底上。
  useEffect(() => {
    const timer = window.setTimeout(() => void importCreatePage(), 800);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="text-foreground h-svh min-w-[900px] overflow-hidden bg-transparent">
      <div className="relative h-full">
        <AreaLayer active={area === "workspace"}>
          <WorkspacePage
            active={area === "workspace"}
            providerVersion={providerVersion}
            onOpenSettings={openSettings}
            onProviderChanged={() => setProviderVersion((value) => value + 1)}
            onSwitchArea={switchArea}
          />
        </AreaLayer>
        {mounted.includes("create") && (
          <AreaLayer active={area === "create"}>
            <div className="bg-background flex h-full min-h-0 flex-col">
              <CreateHeader
                onOpenSettings={openSettings}
                onProviderChanged={() => setProviderVersion((value) => value + 1)}
                onSwitchArea={switchArea}
              />
              <div className="min-h-0 flex-1">
                <Suspense fallback={<CreateFallback />}>
                  <CreatePage
                    active={area === "create"}
                    providerVersion={providerVersion}
                  />
                </Suspense>
              </div>
            </div>
          </AreaLayer>
        )}
      </div>
      <ProviderDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onChanged={() => setProviderVersion((value) => value + 1)}
        initialCategory={settingsCategory}
      />
    </div>
  );
}

/**
 * 两个分区叠在一起做交叉淡入。非活动层用 inert 移出焦点与命中测试，
 * 但不卸载——卸载就等于每次切换都重新拉一遍数据。
 */
function AreaLayer({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      inert={!active}
      className={cn(
        "absolute inset-0 transition-[opacity,scale] duration-300 ease-out motion-reduce:transition-none",
        active
          ? "z-10 scale-100 opacity-100"
          : "pointer-events-none z-0 scale-[0.99] opacity-0",
      )}
    >
      {children}
    </div>
  );
}

/** 分包已预取时通常一帧就过，所以转圈延迟 300ms 才淡入，快路径上完全看不见。 */
function CreateFallback() {
  return (
    <div className="grid h-full place-items-center bg-[#080a10] text-white/50">
      <span className="animate-in fade-in-0 fill-mode-both delay-300 duration-200">
        <LoaderCircle className="size-5 animate-spin" />
      </span>
    </div>
  );
}

function CreateHeader({
  onOpenSettings,
  onProviderChanged,
  onSwitchArea,
}: {
  onOpenSettings: (category?: SettingsCategory) => void;
  onProviderChanged: () => void;
  onSwitchArea: (area: ProductArea) => void;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3 [-webkit-app-region:drag]">
      {IS_MACOS && <div aria-hidden="true" className="w-16 shrink-0" />}
      <ProductSwitcher area="create" onSwitch={onSwitchArea} />
      <div className="ml-auto flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
        <GatewayAccountButton
          compact
          onOpenSettings={onOpenSettings}
          onChanged={onProviderChanged}
        />
      </div>
    </header>
  );
}
