import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { SettingsSection } from "@/features/settings/settings-section";
import type { WorkspaceToolDescriptor } from "@shared/contracts";

export function ToolsSection() {
  const [tools, setTools] = useState<WorkspaceToolDescriptor[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.tietiezhi.tools.list().then(setTools).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);

  return (
    <SettingsSection>
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground text-xs leading-relaxed">
          工具由 Electron Main 执行，所有路径限制在当前 Workspace。写入文件与 Shell 命令始终需要批准。
        </p>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <div className="flex flex-col divide-y rounded-lg border">
          {tools.map((tool) => (
            <div key={tool.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{tool.name}</span>
                <span className="text-muted-foreground text-xs">{tool.description}</span>
              </div>
              <code className="text-muted-foreground text-[10px]">{tool.id}</code>
              <Badge variant={tool.approvalRequired ? "outline" : "secondary"}>
                {tool.approvalRequired ? "每次询问" : "自动允许"}
              </Badge>
            </div>
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}
