import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { CorePermissionDialog } from "./core-permission-dialog";
import { CorePicker } from "./core-picker";
import { CoreSessionPanel } from "./core-session-panel";
import { McpManager } from "./mcp-manager";
import { useCoreEventBridge } from "./store";

/**
 * Front door of the multi-core product: pick a core, run a session against it,
 * and manage the MCP servers every core shares. The approval dialog lives at
 * this level so a permission request is answerable from any tab.
 */
export function CoresPage({ className }: { className?: string }) {
  useCoreEventBridge();

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <Tabs defaultValue="cores" className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <TabsList className="self-start">
          <TabsTrigger value="cores">核心与会话</TabsTrigger>
          <TabsTrigger value="mcp">MCP 服务器</TabsTrigger>
        </TabsList>

        <TabsContent
          value="cores"
          className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]"
        >
          <CorePicker className="min-h-0" />
          <CoreSessionPanel className="min-h-0" />
        </TabsContent>

        <TabsContent value="mcp" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <McpManager className="max-w-3xl pr-3" />
          </ScrollArea>
        </TabsContent>
      </Tabs>

      <CorePermissionDialog />
    </div>
  );
}
