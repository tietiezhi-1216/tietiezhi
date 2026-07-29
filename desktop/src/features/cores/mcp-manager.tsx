import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCw,
  Save,
  Server,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  CORES_QUERY_KEY,
  MCP_QUERY_KEY,
  coreStart,
  coreStop,
  mcpList,
  mcpRemove,
  mcpSetEnabled,
  mcpUpsert,
} from "./api";
import { errorMessage, formatPairs, parsePairs, splitLines } from "./helpers";
import { useCoresStore } from "./store";
import type { McpServerDefinition } from "./types";

/** Editable draft: env/headers are edited as `KEY=VALUE` / `Name: value` lines. */
interface McpDraft {
  id: string;
  name: string;
  enabled: boolean;
  type: "stdio" | "http";
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
}

function emptyDraft(): McpDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    enabled: true,
    type: "stdio",
    command: "",
    argsText: "",
    envText: "",
    url: "",
    headersText: "",
  };
}

function toDraft(server: McpServerDefinition): McpDraft {
  const stdio = server.transport.type === "stdio" ? server.transport : null;
  const http = server.transport.type === "http" ? server.transport : null;
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    type: server.transport.type,
    command: stdio?.command ?? "",
    argsText: stdio?.args.join("\n") ?? "",
    envText: formatPairs(stdio?.env, "="),
    url: http?.url ?? "",
    headersText: formatPairs(http?.headers, ": "),
  };
}

function fromDraft(draft: McpDraft): McpServerDefinition {
  if (draft.type === "stdio") {
    const env = parsePairs(draft.envText, "=");
    return {
      id: draft.id,
      name: draft.name.trim(),
      enabled: draft.enabled,
      transport: {
        type: "stdio",
        command: draft.command.trim(),
        args: splitLines(draft.argsText),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    };
  }
  const headers = parsePairs(draft.headersText, ":");
  return {
    id: draft.id,
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: {
      type: "http",
      url: draft.url.trim(),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
  };
}

function draftIncomplete(draft: McpDraft): boolean {
  if (draft.name.trim().length === 0) return true;
  return draft.type === "stdio" ? draft.command.trim().length === 0 : draft.url.trim().length === 0;
}

/** Projection feedback: which cores failed to receive the config, and which
 * are running with a stale copy until they restart. */
function ProjectionNotices() {
  const queryClient = useQueryClient();
  const projection = useCoresStore((state) => state.projection);
  const setProjection = useCoresStore((state) => state.setProjection);

  const restart = useMutation({
    mutationFn: async (coreId: string) => {
      await coreStop(coreId);
      await coreStart(coreId);
      return coreId;
    },
    onSuccess: (coreId) => {
      const current = useCoresStore.getState().projection;
      if (current) {
        setProjection({
          ...current,
          restartRequired: current.restartRequired.filter((id) => id !== coreId),
        });
      }
      void queryClient.invalidateQueries({ queryKey: CORES_QUERY_KEY });
    },
  });

  if (!projection) return null;
  if (projection.failed.length === 0 && projection.restartRequired.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {projection.failed.length > 0 && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>部分核心的配置投影失败</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {projection.failed.map((item) => (
                <li key={item.coreId} className="text-xs">
                  <span className="font-medium">{item.coreId}</span>：{item.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {projection.restartRequired.length > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>以下核心需要重启才会生效</AlertTitle>
          <AlertDescription>
            <p className="text-xs">核心只在启动时读取 MCP 配置，运行中的核心仍在使用旧配置。</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {projection.restartRequired.map((coreId) => (
                <Button
                  key={coreId}
                  size="xs"
                  variant="outline"
                  onClick={() => restart.mutate(coreId)}
                  disabled={restart.isPending}
                >
                  {restart.isPending && restart.variables === coreId ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <RotateCw />
                  )}
                  重启 {coreId}
                </Button>
              ))}
            </div>
            {restart.error && (
              <p className="text-destructive mt-2 text-xs">{errorMessage(restart.error)}</p>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** CRUD for the canonical MCP server list shared by every core. */
export function McpManager({ className }: { className?: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<McpDraft | null>(null);

  const serversQuery = useQuery({ queryKey: MCP_QUERY_KEY, queryFn: mcpList });
  const servers = serversQuery.data ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: MCP_QUERY_KEY });
  };

  const upsert = useMutation({
    mutationFn: mcpUpsert,
    onSuccess: () => {
      setDraft(null);
      invalidate();
    },
  });
  const remove = useMutation({ mutationFn: mcpRemove, onSuccess: invalidate });
  const setEnabled = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      mcpSetEnabled(input.id, input.enabled),
    onSuccess: invalidate,
  });

  if (draft) {
    return (
      <div className={cn("flex flex-col gap-4", className)}>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="core-mcp-name">名称</Label>
            <Input
              id="core-mcp-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="filesystem"
            />
          </div>
          <div className="flex items-end gap-2 pb-1">
            <Switch
              id="core-mcp-enabled"
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            />
            <Label htmlFor="core-mcp-enabled">启用</Label>
          </div>
        </div>

        <Tabs
          value={draft.type}
          onValueChange={(value) =>
            setDraft({ ...draft, type: value === "http" ? "http" : "stdio" })
          }
        >
          <TabsList>
            <TabsTrigger value="stdio">本地命令（stdio）</TabsTrigger>
            <TabsTrigger value="http">远程（HTTP）</TabsTrigger>
          </TabsList>
          <TabsContent value="stdio" className="flex flex-col gap-3 pt-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="core-mcp-command">命令</Label>
              <Input
                id="core-mcp-command"
                value={draft.command}
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                placeholder="npx"
                spellCheck={false}
                className="font-mono"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="core-mcp-args">参数（每行一个）</Label>
              <Textarea
                id="core-mcp-args"
                value={draft.argsText}
                onChange={(event) => setDraft({ ...draft, argsText: event.target.value })}
                spellCheck={false}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir"}
                className="min-h-24 font-mono text-xs"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="core-mcp-env">环境变量（每行 KEY=VALUE）</Label>
              <Textarea
                id="core-mcp-env"
                value={draft.envText}
                onChange={(event) => setDraft({ ...draft, envText: event.target.value })}
                spellCheck={false}
                placeholder={"API_KEY=sk-..."}
                className="min-h-16 font-mono text-xs"
              />
            </div>
          </TabsContent>
          <TabsContent value="http" className="flex flex-col gap-3 pt-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="core-mcp-url">服务器 URL</Label>
              <Input
                id="core-mcp-url"
                value={draft.url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                placeholder="https://example.com/mcp"
                spellCheck={false}
                className="font-mono"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="core-mcp-headers">请求头（每行 Name: value）</Label>
              <Textarea
                id="core-mcp-headers"
                value={draft.headersText}
                onChange={(event) => setDraft({ ...draft, headersText: event.target.value })}
                spellCheck={false}
                placeholder={"Authorization: Bearer ..."}
                className="min-h-16 font-mono text-xs"
              />
            </div>
          </TabsContent>
        </Tabs>

        {upsert.error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>保存失败</AlertTitle>
            <AlertDescription>{errorMessage(upsert.error)}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center gap-2">
          <Button
            onClick={() => upsert.mutate(fromDraft(draft))}
            disabled={draftIncomplete(draft) || upsert.isPending}
          >
            {upsert.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
            保存
          </Button>
          <Button variant="outline" onClick={() => setDraft(null)}>
            <X />
            取消
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base leading-none font-semibold">MCP 服务器</h2>
          <p className="text-muted-foreground text-xs leading-relaxed">
            在这里配置一次，应用会自动投影成各个核心自己的配置格式。
          </p>
        </div>
        <Button size="sm" onClick={() => setDraft(emptyDraft())}>
          <Plus />
          添加服务器
        </Button>
      </div>

      <ProjectionNotices />

      {serversQuery.isError && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>无法读取 MCP 列表</AlertTitle>
          <AlertDescription>{errorMessage(serversQuery.error)}</AlertDescription>
        </Alert>
      )}

      {remove.error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>删除失败</AlertTitle>
          <AlertDescription>{errorMessage(remove.error)}</AlertDescription>
        </Alert>
      )}

      {setEnabled.error && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>切换启用状态失败</AlertTitle>
          <AlertDescription>{errorMessage(setEnabled.error)}</AlertDescription>
        </Alert>
      )}

      {servers.length === 0 && !serversQuery.isLoading ? (
        <p className="text-muted-foreground py-6 text-sm">还没有配置 MCP 服务器。</p>
      ) : (
        <div className="flex flex-col divide-y rounded-lg border">
          {servers.map((server) => (
            <div key={server.id} className="flex items-center gap-3 px-3 py-2.5">
              <Server className="text-muted-foreground size-4 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{server.name || server.id}</span>
                  <Badge variant="outline">
                    {server.transport.type === "stdio" ? "stdio" : "HTTP"}
                  </Badge>
                </div>
                <span className="text-muted-foreground truncate font-mono text-xs">
                  {server.transport.type === "stdio"
                    ? `${server.transport.command} ${server.transport.args.join(" ")}`
                    : server.transport.url}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setDraft(toDraft(server))}
                aria-label="编辑服务器"
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-destructive hover:text-destructive"
                onClick={() => remove.mutate(server.id)}
                disabled={remove.isPending}
                aria-label="删除服务器"
              >
                <Trash2 />
              </Button>
              <Switch
                checked={server.enabled}
                onCheckedChange={(enabled) => setEnabled.mutate({ id: server.id, enabled })}
                aria-label="启用服务器"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
