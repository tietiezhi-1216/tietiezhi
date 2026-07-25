import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Loader2, PlugZap, RefreshCw, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  errorMessage,
  installedCodexApps,
  listCodexApps,
  readCodexApps,
} from "@/lib/api";

interface AppsView {
  catalog: Awaited<ReturnType<typeof listCodexApps>>["data"];
  metadata: Awaited<ReturnType<typeof readCodexApps>>["apps"];
  installed: Awaited<ReturnType<typeof installedCodexApps>>["apps"];
}

async function loadApps(threadId: string, refresh: boolean): Promise<AppsView> {
  const [catalog, installed] = await Promise.all([
    listCodexApps(threadId, refresh),
    installedCodexApps(threadId, refresh),
  ]);
  const metadata = await readCodexApps(
    catalog.data.map((app) => app.id),
    true,
  );
  return {
    catalog: catalog.data,
    metadata: metadata.apps,
    installed: installed.apps,
  };
}

export function CodexAppsPanel({
  threadId,
  disabled,
}: {
  threadId: string;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const query = useQuery({
    queryKey: ["codex-apps", threadId],
    queryFn: () => loadApps(threadId, false),
    enabled: open,
  });

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const next = await loadApps(threadId, true);
      queryClient.setQueryData(["codex-apps", threadId], next);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-7 gap-1.5 px-2 text-[11px]"
        >
          <PlugZap />
          Apps
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[min(94vw,38rem)] gap-0 sm:max-w-none">
        <SheetHeader className="border-b">
          <div className="flex items-start justify-between gap-3">
            <div>
              <SheetTitle className="flex items-center gap-2">
                <AppWindow className="size-4" /> Apps 与连接器
              </SheetTitle>
              <SheetDescription>
                所有工具通过 Codex Dynamic Tool、审批、Hook 与 Item 生命周期执行。
              </SheetDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={refreshing || query.isFetching}
              onClick={() => void refresh()}
            >
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
              刷新
            </Button>
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {query.isLoading ? (
            <div className="text-muted-foreground grid min-h-48 place-items-center text-sm">
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> 正在读取连接器目录
              </span>
            </div>
          ) : query.error ? (
            <p className="text-destructive rounded-lg border p-3 text-sm">
              {errorMessage(query.error)}
            </p>
          ) : (
            <div className="space-y-3">
              {query.data?.catalog.map((app) => {
                const metadata = query.data.metadata.find((item) => item.id === app.id);
                const runtime = query.data.installed.find((item) => item.id === app.id);
                return (
                  <article
                    key={app.id}
                    className="bg-card overflow-hidden rounded-xl border shadow-sm"
                  >
                    <div className="flex items-start gap-3 p-3">
                      <span className="bg-primary/10 text-primary grid size-9 shrink-0 place-items-center rounded-lg">
                        <AppWindow className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="text-sm font-semibold">{app.name}</h3>
                          <Badge variant={runtime?.callable ? "default" : "secondary"}>
                            {runtime?.callable ? "可调用" : app.isEnabled ? "目录" : "已停用"}
                          </Badge>
                          {app.distributionChannel && (
                            <Badge variant="outline">{app.distributionChannel}</Badge>
                          )}
                        </div>
                        <p className="text-muted-foreground mt-1 text-xs leading-5">
                          {app.description || "未提供说明"}
                        </p>
                        <code className="text-muted-foreground text-[10px]">{app.id}</code>
                      </div>
                    </div>
                    {metadata?.toolSummaries?.length ? (
                      <div className="border-t px-3 py-2">
                        <p className="text-muted-foreground mb-1.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide">
                          <Wrench className="size-3" />
                          Dynamic Tools
                        </p>
                        <div className="space-y-1">
                          {metadata.toolSummaries.map((tool) => (
                            <div
                              key={tool.name}
                              className="bg-muted/50 rounded-md px-2 py-1.5"
                            >
                              <p className="font-mono text-[11px] font-medium">
                                {tool.title || tool.name}
                              </p>
                              <p className="text-muted-foreground text-[10px] leading-4">
                                {tool.description}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}
              {query.data?.catalog.length === 0 && (
                <p className="text-muted-foreground py-12 text-center text-sm">
                  当前没有可用 Apps。
                </p>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
