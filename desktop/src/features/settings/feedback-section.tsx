import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Bug, ClipboardCopy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { message } from "@/components/app-message";
import { SettingsSection } from "@/features/settings/settings-section";
import { errorMessage, readNativeErrorLog } from "@/lib/api";
import {
  buildIssueBody,
  ISSUE_REPO_URL,
  openGitHubIssueReport,
  recentAppErrors,
  subscribeAppErrors,
} from "@/lib/error-report";

export function FeedbackSection() {
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [nativeLogPresent, setNativeLogPresent] = useState(false);
  const errors = useSyncExternalStore(subscribeAppErrors, recentAppErrors);
  const preview = useMemo(() => errors.slice(0, 5), [errors]);

  useEffect(() => {
    void readNativeErrorLog()
      .then((log) => setNativeLogPresent(Boolean(log.trim())))
      .catch(() => setNativeLogPresent(false));
  }, []);

  const openIssue = async () => {
    setBusy(true);
    try {
      await openGitHubIssueReport(description);
      message.success(
        "已在浏览器打开 GitHub Issue",
        "内容已自动填好，确认无敏感信息后提交即可。",
      );
    } catch (err) {
      message.error("生成反馈失败", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(await buildIssueBody(description));
      message.success("诊断信息已复制", "可粘贴到 GitHub Issue 或发给开发者。");
    } catch (err) {
      message.error("复制失败", errorMessage(err));
    }
  };

  return (
    <SettingsSection>
      <div className="flex flex-col gap-1">
        <Label className="flex items-center gap-1.5">
          <Bug className="size-4" /> 问题反馈
        </Label>
        <p className="text-muted-foreground text-xs leading-relaxed">
          遇到报错、黑屏或卡顿时，可以把最近捕获的错误连同环境信息一键提交到
          GitHub 仓库，便于我们定位问题。提交前请检查内容中是否包含敏感信息。
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="feedback-description">问题描述（选填）</Label>
        <Textarea
          id="feedback-description"
          value={description}
          maxLength={500}
          rows={4}
          placeholder="例如：让它分析游戏目录后窗口整体黑屏，只能重启应用……"
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void openIssue()}>
          <ExternalLink /> 打开 GitHub 提交 Issue
        </Button>
        <Button variant="outline" onClick={() => void copyReport()}>
          <ClipboardCopy /> 复制诊断信息
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        将跳转到 {ISSUE_REPO_URL}/issues，需要 GitHub 账号；应用不会自动上传任何内容。
      </p>

      <Separator />

      <div className="flex flex-col gap-2">
        <Label>
          最近捕获的错误
          <span className="text-muted-foreground ml-1 font-normal">
            {errors.length > 0 ? `${errors.length} 条` : "暂无"}
          </span>
        </Label>
        {nativeLogPresent && (
          <p className="text-muted-foreground text-xs">
            检测到原生崩溃日志，提交时会自动附带其末尾内容。
          </p>
        )}
        {preview.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {preview.map((record) => (
              <li
                key={`${record.at}-${record.source}`}
                className="bg-muted/40 rounded-md border px-2.5 py-1.5"
              >
                <p className="text-muted-foreground text-[11px]">
                  {new Date(record.at).toLocaleString()} · {record.source}
                  {record.count > 1 ? ` · ×${record.count}` : ""}
                </p>
                <p className="truncate font-mono text-xs">{record.message}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
