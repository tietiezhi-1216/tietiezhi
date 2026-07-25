import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  RefreshCw,
  Send,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/features/settings/settings-section";
import {
  codexDoctorReport,
  codexExportTelemetry,
  codexRuntimeMetrics,
  codexV2Request,
  type CodexDoctorStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const STATUS = {
  ok: {
    label: "正常",
    icon: CheckCircle2,
    className: "text-emerald-600 dark:text-emerald-400",
  },
  warning: {
    label: "需关注",
    icon: TriangleAlert,
    className: "text-amber-600 dark:text-amber-400",
  },
  fail: {
    label: "异常",
    icon: CircleAlert,
    className: "text-destructive",
  },
} satisfies Record<
  CodexDoctorStatus,
  { label: string; icon: typeof CheckCircle2; className: string }
>;

export function RuntimeDiagnosticsSection() {
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const doctor = useQuery({
    queryKey: ["codex-doctor"],
    queryFn: codexDoctorReport,
    retry: false,
  });
  const metrics = useQuery({
    queryKey: ["codex-runtime-metrics"],
    queryFn: codexRuntimeMetrics,
    retry: false,
  });
  const refresh = () => {
    void doctor.refetch();
    void metrics.refetch();
  };
  const feedbackMutation = useMutation({
    mutationFn: async () => {
      const output = await codexV2Request("desktop", {
        id: `feedback-${Date.now()}`,
        method: "feedback/upload",
        params: {
          classification: "bug",
          reason: reason.trim() || null,
          threadId: null,
          includeLogs: true,
          extraLogFiles: null,
          tags: { surface: "settings-diagnostics" },
        },
      });
      if (output.response.error) throw new Error(output.response.error.message);
      return output.response.result;
    },
    onSuccess: () => setFeedback("诊断和脱敏日志已进入反馈提交队列。"),
    onError: (error) =>
      setFeedback(error instanceof Error ? error.message : String(error)),
  });
  const exportMutation = useMutation({
    mutationFn: codexExportTelemetry,
    onSuccess: (exported) =>
      setFeedback(
        exported
          ? "OTLP 日志与指标已刷新。"
          : "未配置 OTLP 端点，诊断仍保留在本地。",
      ),
    onError: (error) =>
      setFeedback(error instanceof Error ? error.message : String(error)),
  });
  const totals = useMemo(() => {
    const counters = metrics.data?.counters ?? {};
    return {
      requests:
        (counters["app_server.request.completed"] ?? 0) +
        (counters["app_server.request.failed"] ?? 0),
      failed: counters["app_server.request.failed"] ?? 0,
      queued: counters["feedback.queued"] ?? 0,
    };
  }, [metrics.data]);
  const status = doctor.data?.overallStatus ?? "warning";
  const statusView = STATUS[status];
  const StatusIcon = statusView.icon;

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        title="Codex Runtime Doctor"
        description="检查状态数据库、任务目录、磁盘、模型端点和沙箱准备状态。报告在返回界面前会移除凭据。"
      >
        <div className="flex items-center justify-between gap-3">
          <div className={cn("flex items-center gap-2 text-sm font-medium", statusView.className)}>
            <StatusIcon className="size-4" />
            {doctor.isLoading ? "检查中" : statusView.label}
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className={cn("size-3.5", doctor.isFetching && "animate-spin")} />
            重新检查
          </Button>
        </div>
        {doctor.error && (
          <p className="text-destructive text-xs">{String(doctor.error)}</p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {(doctor.data?.checks ?? []).map((check) => {
            const view = STATUS[check.status];
            const Icon = view.icon;
            return (
              <div key={check.id} className="bg-muted/35 rounded-lg border px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <Icon className={cn("mt-0.5 size-3.5 shrink-0", view.className)} />
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{check.summary}</p>
                    <p className="text-muted-foreground mt-1 truncate font-mono text-[10px]">
                      {check.id} · {check.durationMs} ms
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title="运行指标"
        description="进程内指标不会包含提示词、文件内容、密钥或完整工具输出。"
      >
        <div className="grid grid-cols-3 gap-2">
          {[
            ["请求", totals.requests],
            ["失败", totals.failed],
            ["待提交反馈", totals.queued],
          ].map(([label, value]) => (
            <div key={label} className="bg-muted/35 rounded-lg border p-3">
              <p className="text-muted-foreground text-[11px]">{label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={exportMutation.isPending}
          onClick={() => exportMutation.mutate()}
        >
          <Activity className="size-3.5" />
          刷新 OTLP
        </Button>
      </SettingsSection>

      <SettingsSection
        title="提交诊断反馈"
        description="包含最近的脱敏结构化日志、Doctor 报告和运行环境摘要；未配置上传端点时会安全保存在本地 Outbox。"
      >
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="简要描述遇到的问题（可选）"
          className="border-input bg-background placeholder:text-muted-foreground min-h-24 w-full resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-xs">{feedback}</span>
          <Button
            size="sm"
            disabled={feedbackMutation.isPending}
            onClick={() => feedbackMutation.mutate()}
          >
            <Send className="size-3.5" />
            提交反馈
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
