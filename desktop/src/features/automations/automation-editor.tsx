import { useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  Cloud,
  CloudAlert,
  LoaderCircle,
  Plus,
  Save,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { ReactFlowProvider } from "@xyflow/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AutomationValidationIssue } from "@/lib/api";
import { validateAutomation } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AutomationCanvas } from "@/features/automations/automation-canvas";
import { NodeInspector } from "@/features/automations/node-inspector";
import { NodeLibrary } from "@/features/automations/node-library";
import { useAutomationStore } from "@/stores/automations";
import type { AutomationSaveState } from "@/stores/automations";

type EditorPanel = "library" | "inspector" | null;

export function AutomationEditor() {
  const document = useAutomationStore((state) => state.document);
  const saveState = useAutomationStore((state) => state.saveState);
  const error = useAutomationStore((state) => state.error);
  const close = useAutomationStore((state) => state.close);
  const saveNow = useAutomationStore((state) => state.saveNow);
  const publish = useAutomationStore((state) => state.publish);
  const meta = useAutomationStore((state) =>
    state.automations.find((item) => item.id === state.document?.id),
  );
  const selectNode = useAutomationStore((state) => state.selectNode);
  const [panel, setPanel] = useState<EditorPanel>(null);
  const [validationOpen, setValidationOpen] = useState(false);
  const [validationLoading, setValidationLoading] = useState(false);
  const [published, setPublished] = useState(false);
  const [validationIssues, setValidationIssues] = useState<
    AutomationValidationIssue[] | null
  >(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveNow]);

  if (!document) return null;

  const checkPublish = async () => {
    setValidationOpen(true);
    setValidationLoading(true);
    setValidationIssues(null);
    setPublished(false);
    try {
      await saveNow();
      const latest = useAutomationStore.getState().document;
      if (!latest || useAutomationStore.getState().saveState === "error") return;
      const issues = await validateAutomation(latest, true);
      setValidationIssues(issues);
      if (issues.length === 0) {
        const succeeded = await publish();
        setPublished(succeeded);
        if (!succeeded) {
          setValidationIssues([
            {
              code: "publish_failed",
              message: useAutomationStore.getState().error || "发布失败",
            },
          ]);
        }
      }
    } catch (validationError) {
      setValidationIssues([
        {
          code: "validation_failed",
          message:
            validationError instanceof Error
              ? validationError.message
              : "发布检查失败",
        },
      ]);
    } finally {
      setValidationLoading(false);
    }
  };

  const openWorkflowSettings = () => {
    selectNode(null);
    setPanel("inspector");
  };

  return (
    <ReactFlowProvider>
      <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <header className="flex h-13 shrink-0 items-center gap-2 border-b px-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="返回 Automation 列表"
            onClick={() => void close()}
          >
            <ArrowLeft />
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold">{document.name}</h1>
              <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                {meta?.publishedRevision
                  ? `已启用 r${meta.publishedRevision}`
                  : "草稿"}
              </Badge>
            </div>
            <SaveStatus state={saveState} />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant={panel === "library" ? "secondary" : "outline"}
              size="sm"
              aria-label="添加节点"
              onClick={() =>
                setPanel((current) => (current === "library" ? null : "library"))
              }
            >
              <Plus />
              <span className="hidden sm:inline">添加节点</span>
            </Button>
            <Button
              type="button"
              variant={panel === "inspector" ? "secondary" : "ghost"}
              size="icon-sm"
              title="工作流设置"
              aria-label="工作流设置"
              onClick={openWorkflowSettings}
            >
              <Settings2 />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="保存草稿"
              aria-label="保存草稿"
              disabled={saveState === "saved" || saveState === "saving"}
              onClick={() => void saveNow()}
            >
              <Save />
            </Button>
            <Button
              type="button"
              size="sm"
              aria-label="发布并启用"
              disabled={validationLoading}
              onClick={() => void checkPublish()}
            >
              {validationLoading ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <ShieldCheck />
              )}
              <span className="hidden sm:inline">发布并启用</span>
            </Button>
          </div>
        </header>

        {error && (
          <Alert variant="destructive" className="m-2 mb-0 shrink-0">
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <AutomationCanvas onInspectNode={() => setPanel("inspector")} />

          {panel === "library" && (
            <div className="absolute top-3 bottom-3 left-3 z-20 w-[min(20rem,calc(100%-1.5rem))] overflow-hidden rounded-xl border bg-popover shadow-xl">
              <NodeLibrary onClose={() => setPanel(null)} />
            </div>
          )}

          {panel === "inspector" && (
            <div className="absolute top-3 right-3 bottom-3 z-20 w-[min(22rem,calc(100%-1.5rem))] overflow-hidden rounded-xl border bg-popover shadow-xl">
              <NodeInspector onClose={() => setPanel(null)} />
            </div>
          )}
        </div>
      </main>

      <Dialog open={validationOpen} onOpenChange={setValidationOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{published ? "发布完成" : "发布检查"}</DialogTitle>
          </DialogHeader>
          {validationLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
              <LoaderCircle className="size-4 animate-spin" />
              正在校验工作流结构…
            </div>
          ) : validationIssues?.length === 0 ? (
            <div className="flex gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div>
                <p className="text-sm font-medium">
                  {published ? "Automation 已发布并启用" : "结构检查通过"}
                </p>
                <p className="text-muted-foreground mt-1 text-xs leading-5">
                  {published
                    ? "后续运行使用固定发布快照；修改草稿不会影响正在执行的版本。"
                    : "草稿已满足触发器、输出和 DAG 约束。"}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {validationIssues?.map((issue, index) => (
                <div
                  key={`${issue.code}-${issue.nodeId ?? issue.edgeId ?? index}`}
                  className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div>
                    <p className="text-sm">{issue.message}</p>
                    {(issue.nodeId || issue.edgeId) && (
                      <p className="text-muted-foreground mt-1 font-mono text-[10px]">
                        {issue.nodeId
                          ? `node: ${issue.nodeId}`
                          : `edge: ${issue.edgeId}`}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button type="button" onClick={() => setValidationOpen(false)}>
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ReactFlowProvider>
  );
}

function SaveStatus({ state }: { state: AutomationSaveState }) {
  const classes = "mt-0.5 flex items-center gap-1 text-[10px]";
  if (state === "saving") {
    return (
      <span className={cn(classes, "text-muted-foreground")}>
        <LoaderCircle className="size-2.5 animate-spin" />
        保存中
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className={cn(classes, "text-destructive")}>
        <CloudAlert className="size-2.5" />
        保存失败
      </span>
    );
  }
  if (state === "dirty") {
    return (
      <span className={cn(classes, "text-muted-foreground")}>
        <Cloud className="size-2.5" />
        未保存
      </span>
    );
  }
  return (
    <span className={cn(classes, "text-muted-foreground")}>
      <CheckCircle2 className="size-2.5" />
      已保存
    </span>
  );
}
