import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, RotateCw, Save, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  loadSettings,
  mcpRestartServer,
  mcpServerStatus,
  mcpStopServer,
  saveSettings,
} from "@/lib/api";
import type { AppSettings, McpServer } from "@/lib/api";
import { SettingsSection } from "@/features/settings/settings-section";

/** Editable draft: env/headers as text lines (`KEY=VALUE` / `Name: value`). */
interface McpDraft {
  id: string;
  name: string;
  enabled: boolean;
  kind: "stdio" | "http";
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
}

const toDraft = (s: McpServer): McpDraft => ({
  id: s.id,
  name: s.name,
  enabled: s.enabled,
  kind: s.transport.kind,
  command: s.transport.kind === "stdio" ? s.transport.command : "",
  argsText: s.transport.kind === "stdio" ? s.transport.args.join("\n") : "",
  envText:
    s.transport.kind === "stdio"
      ? Object.entries(s.transport.env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "",
  url: s.transport.kind === "http" ? s.transport.url : "",
  headersText:
    s.transport.kind === "http"
      ? Object.entries(s.transport.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "",
});

const parsePairs = (text: string, sep: "=" | ":"): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(sep);
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
};

const fromDraft = (d: McpDraft): McpServer => ({
  id: d.id,
  name: d.name.trim(),
  enabled: d.enabled,
  transport:
    d.kind === "stdio"
      ? {
          kind: "stdio",
          command: d.command.trim(),
          args: d.argsText
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          env: parsePairs(d.envText, "="),
        }
      : {
          kind: "http",
          url: d.url.trim(),
          headers: parsePairs(d.headersText, ":"),
        },
});

const STATE_BADGE: Record<string, { label: string; className: string }> = {
  running: { label: "运行中", className: "text-emerald-600 dark:text-emerald-400" },
  stopped: { label: "未启动", className: "text-muted-foreground" },
  error: { label: "出错", className: "text-destructive" },
};

/** 智能体 → MCP：configured Model Context Protocol servers. */
export function McpSection() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const statusQuery = useQuery({
    queryKey: ["mcpStatus"],
    queryFn: mcpServerStatus,
    refetchInterval: 5000,
  });

  const settings = settingsQuery.data;
  const servers = settings?.mcpServers ?? [];
  const [draft, setDraft] = useState<McpDraft | null>(null);

  const saveServers = useMutation({
    mutationFn: async (next: McpServer[]) => {
      if (!settings) return;
      const nextSettings: AppSettings = { ...settings, mcpServers: next };
      await saveSettings(nextSettings);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["mcpStatus"] });
    },
  });

  const restart = useMutation({
    mutationFn: mcpRestartServer,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcpStatus"] }),
  });

  const upsert = (server: McpServer) => {
    const next = servers.some((s) => s.id === server.id)
      ? servers.map((s) => (s.id === server.id ? server : s))
      : [...servers, server];
    saveServers.mutate(next);
    // Config changes take effect on the next (re)connect.
    void mcpStopServer(server.id);
    setDraft(null);
  };

  if (draft) {
    return (
      <SettingsSection>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="mcp-name">名称</Label>
              <Input
                id="mcp-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="filesystem"
              />
            </div>
            <div className="flex items-end gap-2 pb-1">
              <Switch
                id="mcp-enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
              />
              <Label htmlFor="mcp-enabled">启用</Label>
            </div>
          </div>

          <Tabs
            value={draft.kind}
            onValueChange={(v) => setDraft({ ...draft, kind: v as "stdio" | "http" })}
          >
            <TabsList>
              <TabsTrigger value="stdio">本地命令（stdio）</TabsTrigger>
              <TabsTrigger value="http">远程（HTTP）</TabsTrigger>
            </TabsList>
            <TabsContent value="stdio" className="flex flex-col gap-3 pt-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-command">命令</Label>
                <Input
                  id="mcp-command"
                  value={draft.command}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  placeholder="npx"
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-args">参数（每行一个）</Label>
                <Textarea
                  id="mcp-args"
                  value={draft.argsText}
                  onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
                  spellCheck={false}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir"}
                  className="min-h-24 font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-env">环境变量（每行 KEY=VALUE）</Label>
                <Textarea
                  id="mcp-env"
                  value={draft.envText}
                  onChange={(e) => setDraft({ ...draft, envText: e.target.value })}
                  spellCheck={false}
                  placeholder={"API_KEY=${secret:service_api_key}"}
                  className="min-h-16 font-mono text-xs"
                />
              </div>
            </TabsContent>
            <TabsContent value="http" className="flex flex-col gap-3 pt-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-url">服务器 URL</Label>
                <Input
                  id="mcp-url"
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  placeholder="https://example.com/mcp"
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-headers">请求头（每行 Name: value）</Label>
                <Textarea
                  id="mcp-headers"
                  value={draft.headersText}
                  onChange={(e) => setDraft({ ...draft, headersText: e.target.value })}
                  spellCheck={false}
                  placeholder={"Authorization: Bearer ${secret:service_api_key}"}
                  className="min-h-16 font-mono text-xs"
                />
              </div>
            </TabsContent>
          </Tabs>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => upsert(fromDraft(draft))}
              disabled={
                !draft.name.trim() ||
                (draft.kind === "stdio" ? !draft.command.trim() : !draft.url.trim()) ||
                saveServers.isPending
              }
            >
              {saveServers.isPending ? <Loader2 className="animate-spin" /> : <Save />}
              保存
            </Button>
            <Button variant="outline" onClick={() => setDraft(null)}>
              <X /> 取消
            </Button>
          </div>
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection>
      <div className="flex flex-col gap-3">
        <div>
          <Button
            size="sm"
            onClick={() =>
              setDraft({
                id: crypto.randomUUID(),
                name: "",
                enabled: true,
                kind: "stdio",
                command: "",
                argsText: "",
                envText: "",
                url: "",
                headersText: "",
              })
            }
          >
            <Plus /> 添加 MCP 服务器
          </Button>
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">
          MCP（Model Context Protocol）服务器为模型提供额外工具。本地命令方式会在首次使用时启动进程；远程方式直接连接 HTTP 端点。
        </p>

        {servers.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">还没有配置 MCP 服务器。</p>
        ) : (
          <div className="flex flex-col divide-y rounded-lg border">
            {servers.map((server) => {
              const status = statusQuery.data?.find((s) => s.id === server.id);
              const badge = STATE_BADGE[status?.state ?? "stopped"] ?? STATE_BADGE.stopped;
              return (
                <div key={server.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{server.name}</span>
                      <Badge variant="secondary" className={badge.className}>
                        {badge.label}
                      </Badge>
                    </div>
                    <span className="text-muted-foreground truncate font-mono text-xs">
                      {server.transport.kind === "stdio"
                        ? `${server.transport.command} ${server.transport.args.join(" ")}`
                        : server.transport.url}
                    </span>
                    {status?.error && (
                      <span className="text-destructive truncate text-xs">{status.error}</span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => restart.mutate(server.id)}
                    disabled={restart.isPending}
                    aria-label="重启服务器"
                    title="重启"
                  >
                    <RotateCw className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => setDraft(toDraft(server))}
                    aria-label="编辑服务器"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive size-7"
                    onClick={() => {
                      saveServers.mutate(servers.filter((s) => s.id !== server.id));
                      void mcpStopServer(server.id);
                    }}
                    aria-label="删除服务器"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                  <Switch
                    checked={server.enabled}
                    onCheckedChange={(enabled) => {
                      saveServers.mutate(
                        servers.map((s) => (s.id === server.id ? { ...s, enabled } : s)),
                      );
                      if (!enabled) void mcpStopServer(server.id);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
