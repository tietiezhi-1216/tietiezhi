import type { ReactNode } from "react";
import { FolderOpen, Info, Settings2, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { pickWorkspaceDir, type AutomationValueBinding } from "@/lib/api";
import { getAutomationNodeDefinition } from "@/lib/automation";
import { cn } from "@/lib/utils";
import { useAutomationStore } from "@/stores/automations";
import {
  AUTOMATION_CATEGORY_ICON,
  AUTOMATION_NODE_ICONS,
  FALLBACK_AUTOMATION_NODE_ICON,
} from "@/features/automations/node-visuals";

export function NodeInspector({ onClose }: { onClose?: () => void } = {}) {
  const document = useAutomationStore((state) => state.document);
  const selectedNodeId = useAutomationStore((state) => state.selectedNodeId);
  const updateDocumentInfo = useAutomationStore((state) => state.updateDocumentInfo);
  const updateDocumentSettings = useAutomationStore(
    (state) => state.updateDocumentSettings,
  );
  const updateNode = useAutomationStore((state) => state.updateNode);
  const updateNodeConfig = useAutomationStore((state) => state.updateNodeConfig);
  const updateNodeInput = useAutomationStore((state) => state.updateNodeInput);
  const applyNodeChanges = useAutomationStore((state) => state.applyNodeChanges);
  const node = document?.nodes.find((candidate) => candidate.id === selectedNodeId);

  if (!document) return null;
  if (!node) {
    return (
      <aside className="bg-popover flex h-full min-h-0 w-full flex-col text-popover-foreground">
        <div className="border-b px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Settings2 className="text-muted-foreground size-4" />
            <p className="min-w-0 flex-1 text-sm font-semibold">工作流设置</p>
            {onClose && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="关闭配置面板"
                onClick={onClose}
              >
                <X />
              </Button>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            未选择节点时编辑全局信息
          </p>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 p-4">
            <Field label="名称" htmlFor="automation-name">
              <Input
                id="automation-name"
                maxLength={80}
                value={document.name}
                onChange={(event) => updateDocumentInfo({ name: event.target.value })}
              />
            </Field>
            <Field label="描述" htmlFor="automation-description">
              <Textarea
                id="automation-description"
                maxLength={500}
                value={document.description}
                placeholder="说明此自动化的用途"
                onChange={(event) =>
                  updateDocumentInfo({ description: event.target.value })
                }
              />
            </Field>
            <Separator />
            <section className="space-y-4">
              <SectionTitle>运行环境</SectionTitle>
              <Field label="Git 项目目录" htmlFor="automation-project-root">
                <div className="flex gap-2">
                  <Input
                    id="automation-project-root"
                    value={document.settings.projectRoot ?? ""}
                    placeholder="留空则使用独立空白工作区"
                    onChange={(event) =>
                      updateDocumentSettings({
                        projectRoot: event.target.value || null,
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="选择 Git 项目目录"
                    onClick={() => {
                      void pickWorkspaceDir().then((path) => {
                        if (path) updateDocumentSettings({ projectRoot: path });
                      });
                    }}
                  >
                    <FolderOpen />
                  </Button>
                </div>
                <p className="text-muted-foreground mt-1.5 text-[10px] leading-4">
                  发布时验证 Git 工作树；每次运行从该项目创建隔离 Worktree。
                </p>
              </Field>
              <Field label="时区" htmlFor="automation-timezone">
                <Input
                  id="automation-timezone"
                  value={document.settings.timezone}
                  placeholder="Asia/Shanghai"
                  onChange={(event) =>
                    updateDocumentSettings({ timezone: event.target.value })
                  }
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="最长分钟" htmlFor="automation-duration">
                  <Input
                    id="automation-duration"
                    type="number"
                    min={1}
                    max={1440}
                    value={Math.max(
                      1,
                      Math.round(document.settings.maxDurationMs / 60_000),
                    )}
                    onChange={(event) =>
                      updateDocumentSettings({
                        maxDurationMs: Math.max(
                          1,
                          Math.min(1440, Number(event.target.value) || 1),
                        ) * 60_000,
                      })
                    }
                  />
                </Field>
                <Field label="最大并发" htmlFor="automation-concurrency">
                  <Input
                    id="automation-concurrency"
                    type="number"
                    min={1}
                    max={64}
                    value={document.settings.maxConcurrency}
                    onChange={(event) =>
                      updateDocumentSettings({
                        maxConcurrency: Math.max(
                          1,
                          Math.min(64, Number(event.target.value) || 1),
                        ),
                      })
                    }
                  />
                </Field>
              </div>
              <Field label="错过定时任务">
                <Select
                  value={document.settings.onMissedSchedule}
                  onValueChange={(value: "skip" | "runLatest") =>
                    updateDocumentSettings({ onMissedSchedule: value })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">跳过已错过的运行</SelectItem>
                    <SelectItem value="runLatest">立即补跑最近一次</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </section>
            <Separator />
            <div className="grid grid-cols-2 gap-3">
              <Metric label="节点" value={String(document.nodes.length)} />
              <Metric label="连线" value={String(document.edges.length)} />
              <Metric label="最大并发" value={String(document.settings.maxConcurrency)} />
              <Metric label="版本" value={`r${document.revision}`} />
            </div>
            <div className="bg-muted/50 text-muted-foreground flex gap-2 rounded-lg border p-3 text-xs leading-5">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                点击画布中的节点可编辑该步骤。草稿会自动保存；无人值守运行固定使用
                <code className="mx-1 font-mono">approvalPolicy=never</code>
                ，需要交互审批的步骤会明确失败而不会绕过策略。
              </span>
            </div>
          </div>
        </ScrollArea>
      </aside>
    );
  }

  const definition = getAutomationNodeDefinition(node.type);
  const category = definition?.category ?? "tool";
  const Icon =
    AUTOMATION_NODE_ICONS[node.type] ?? FALLBACK_AUTOMATION_NODE_ICON;

  return (
    <aside className="bg-popover flex h-full min-h-0 w-full flex-col text-popover-foreground">
      <div className="border-b px-4 py-3">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-md",
              AUTOMATION_CATEGORY_ICON[category],
            )}
          >
            <Icon className="size-4" strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{node.name}</span>
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                v{node.typeVersion}
              </Badge>
            </span>
            <span className="text-muted-foreground mt-0.5 block text-xs">
              {definition?.description ?? node.type}
            </span>
          </span>
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="关闭配置面板"
              onClick={onClose}
            >
              <X />
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          <Field label="节点名称" htmlFor="automation-node-name">
            <Input
              id="automation-node-name"
              maxLength={80}
              value={node.name}
              onChange={(event) => updateNode(node.id, { name: event.target.value })}
            />
          </Field>

          <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
            <span>
              <span className="block text-xs font-medium">启用节点</span>
              <span className="text-muted-foreground mt-0.5 block text-[10px]">
                停用后执行时跳过
              </span>
            </span>
            <Switch
              checked={!node.disabled}
              onCheckedChange={(checked) => updateNode(node.id, { disabled: !checked })}
            />
          </div>

          {definition && definition.fields.length > 0 && (
            <>
              <Separator />
              <section className="space-y-4">
                <SectionTitle>配置</SectionTitle>
                {definition.fields.map((field) => {
                  const value = node.config[field.key];
                  const stringValue = value == null ? "" : String(value);
                  if (field.kind === "select") {
                    return (
                      <Field key={field.key} label={field.label}>
                        <Select
                          value={stringValue}
                          onValueChange={(next) =>
                            updateNodeConfig(node.id, field.key, next)
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                          <SelectContent>
                            {field.options?.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    );
                  }
                  if (field.kind === "textarea") {
                    return (
                      <Field key={field.key} label={field.label}>
                        <Textarea
                          value={stringValue}
                          placeholder={field.placeholder}
                          className={field.key === "code" ? "min-h-40 font-mono text-xs" : "min-h-24"}
                          onChange={(event) =>
                            updateNodeConfig(node.id, field.key, event.target.value)
                          }
                        />
                      </Field>
                    );
                  }
                  return (
                    <Field key={field.key} label={field.label}>
                      <Input
                        value={stringValue}
                        placeholder={field.placeholder}
                        onChange={(event) =>
                          updateNodeConfig(node.id, field.key, event.target.value)
                        }
                      />
                    </Field>
                  );
                })}
              </section>
            </>
          )}

          {definition && definition.inputs.length > 0 && (
            <>
              <Separator />
              <section className="space-y-4">
                <SectionTitle>输入映射</SectionTitle>
                {definition.inputs.map((port) => (
                  <InputBindingField
                    key={port.id}
                    label={port.label}
                    binding={node.inputs[port.id]}
                    sourceName={(sourceId) =>
                      document.nodes.find((candidate) => candidate.id === sourceId)?.name ??
                      "未知节点"
                    }
                    onChange={(binding) => updateNodeInput(node.id, port.id, binding)}
                  />
                ))}
              </section>
            </>
          )}

          <Separator />
          <Button
            type="button"
            variant="outline"
            className="text-destructive hover:text-destructive w-full"
            onClick={() => {
              applyNodeChanges([{ id: node.id, type: "remove" }]);
              onClose?.();
            }}
          >
            <Trash2 />
            删除节点
          </Button>
        </div>
      </ScrollArea>
    </aside>
  );
}

function InputBindingField({
  label,
  binding,
  sourceName,
  onChange,
}: {
  label: string;
  binding: AutomationValueBinding | undefined;
  sourceName: (id: string) => string;
  onChange: (binding: AutomationValueBinding) => void;
}) {
  if (!binding || binding.kind !== "nodeOutput") {
    return (
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <div className="text-muted-foreground rounded-lg border border-dashed px-3 py-2.5 text-xs">
          从上游节点连线后自动绑定
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <Badge variant="secondary" className="max-w-36 truncate">
          {sourceName(binding.nodeId)}
        </Badge>
      </div>
      <Input
        aria-label={`${label} JSON Pointer`}
        value={binding.path}
        placeholder="/"
        className="font-mono text-xs"
        onChange={(event) => onChange({ ...binding, path: event.target.value })}
      />
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-muted-foreground text-[10px] font-semibold tracking-[0.14em] uppercase">
      {children}
    </h2>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/45 rounded-lg border px-3 py-2">
      <span className="text-muted-foreground block text-[10px]">{label}</span>
      <span className="mt-0.5 block text-sm font-semibold">{value}</span>
    </div>
  );
}
