import { lazy, Suspense, useEffect, useState } from "react";
import { LoaderCircle, Settings } from "lucide-react";

import { GatewayAccountButton } from "@/components/gateway-account-button";
import { ProductSwitcher } from "@/components/product-switcher";
import { Button } from "@/components/ui/button";
import { ProviderDialog } from "@/features/settings/provider-dialog";
import { WorkspacePage } from "@/features/workspace/workspace-page";

export type ProductArea = "workspace" | "create";
const IS_MACOS = navigator.userAgent.includes("Mac");
const CreatePage = lazy(async () => {
  const module = await import("@/features/create/create-page");
  return { default: module.CreatePage };
});

export function App() {
  const [area, setArea] = useState<ProductArea>("workspace");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providerVersion, setProviderVersion] = useState(0);

  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  return (
    <div className="bg-background text-foreground h-svh min-w-[900px] overflow-hidden">
      {area === "workspace" ? (
        <WorkspacePage
          providerVersion={providerVersion}
          onOpenSettings={() => setSettingsOpen(true)}
          onProviderChanged={() => setProviderVersion((value) => value + 1)}
          onSwitchArea={setArea}
        />
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <CreateHeader
            onOpenSettings={() => setSettingsOpen(true)}
            onProviderChanged={() => setProviderVersion((value) => value + 1)}
            onSwitchArea={setArea}
          />
          <div className="min-h-0 flex-1">
            <Suspense
              fallback={
                <div className="grid h-full place-items-center bg-[#0d0e11] text-white/50">
                  <LoaderCircle className="size-5 animate-spin" />
                </div>
              }
            >
              <CreatePage providerVersion={providerVersion} />
            </Suspense>
          </div>
        </div>
      )}
      <ProviderDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onChanged={() => setProviderVersion((value) => value + 1)}
      />
    </div>
  );
}

function CreateHeader({
  onOpenSettings,
  onProviderChanged,
  onSwitchArea,
}: {
  onOpenSettings: () => void;
  onProviderChanged: () => void;
  onSwitchArea: (area: ProductArea) => void;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3 [-webkit-app-region:drag]">
      {IS_MACOS && <div aria-hidden="true" className="w-16 shrink-0" />}
      <ProductSwitcher area="create" onSwitch={onSwitchArea} />
      <div className="ml-auto flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onOpenSettings}
          aria-label="设置"
        >
          <Settings />
        </Button>
        <GatewayAccountButton
          compact
          onOpenSettings={onOpenSettings}
          onChanged={onProviderChanged}
        />
      </div>
    </header>
  );
}
