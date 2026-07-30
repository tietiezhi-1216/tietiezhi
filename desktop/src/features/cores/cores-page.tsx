import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { CorePermissionDialog } from "./core-permission-dialog";
import { CorePicker } from "./core-picker";
import { CoreSessionPanel } from "./core-session-panel";
import { AgentPanel } from "@/features/agent/agent-panel";
import { McpManager } from "./mcp-manager";
import { useCoreEventBridge } from "./store";

/**
 * Front door of the product: the first-party agent, the external ACP cores, and
 * the MCP servers all of them share.
 *
 * The ACP approval dialog lives at this level so a permission request from an
 * external core is answerable from any tab. The first-party agent renders its
 * own approval inline instead — the user needs to read the transcript to judge
 * a command, and a modal would cover exactly that.
 */
export function CoresPage({ className }: { className?: string }) {
  useCoreEventBridge();

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <Tabs defaultValue="agent" className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <TabsList className="self-start">
          <TabsTrigger value="agent">铁铁汁</TabsTrigger>
          <TabsTrigger value="cores">外部核心</TabsTrigger>
          <TabsTrigger value="mcp">MCP 服务器</TabsTrigger>
        </TabsList>

        {/* The first-party agent leads: it is the product's own core, and the
            external ones are alternatives to it rather than the other way round. */}
        <TabsContent value="agent" className="min-h-0 flex-1">
          <AgentPanel className="h-full" />
        </TabsContent>

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
