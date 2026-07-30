import { useEffect, useState } from "react";

import { ProviderDialog } from "@/features/settings/provider-dialog";
import { CreatePage } from "@/features/create/create-page";
import { WorkspacePage } from "@/features/workspace/workspace-page";

export type ProductArea = "workspace" | "create";

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

  const common = {
    providerVersion,
    onOpenSettings: () => setSettingsOpen(true),
    onProviderChanged: () => setProviderVersion((value) => value + 1),
    onSwitchArea: setArea,
  };

  return (
    <div className="bg-background text-foreground h-svh min-w-[960px] overflow-hidden">
      {area === "workspace" ? <WorkspacePage {...common} /> : <CreatePage {...common} />}
      <ProviderDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onChanged={() => setProviderVersion((value) => value + 1)}
      />
    </div>
  );
}
