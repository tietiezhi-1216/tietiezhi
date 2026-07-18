import { memo, useState } from "react";
import { Check, CircleAlert, Copy, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ChatItem } from "@/stores/chat";

type ErrorItem = Extract<ChatItem, { kind: "error" }>;

export const ErrorNotice = memo(function ErrorNotice({
  item,
  retryDisabled,
  onRetry,
}: {
  item: ErrorItem;
  retryDisabled: boolean;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyDetail = () => {
    void navigator.clipboard.writeText(item.detail).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    });
  };

  return (
    <div className="border-destructive/25 bg-destructive/5 flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2">
      <CircleAlert className="text-destructive size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium select-text">{item.summary}</p>
        {item.retries > 0 && (
          <p className="text-muted-foreground text-[11px]">已重试 {item.retries} 次</p>
        )}
      </div>
      {item.retryable && (
        <Button
          variant="ghost"
          size="xs"
          disabled={retryDisabled}
          onClick={onRetry}
        >
          <RefreshCw />
          重试
        </Button>
      )}
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="xs">
            查看详情
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>错误详情</DialogTitle>
            <DialogDescription>{item.summary}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-1.5">
            {item.status != null && <Badge variant="outline">HTTP {item.status}</Badge>}
            {item.code && <Badge variant="outline">{item.code}</Badge>}
            {item.retries > 0 && (
              <Badge variant="outline">已重试 {item.retries} 次</Badge>
            )}
          </div>
          <pre className="bg-muted/60 max-h-[50vh] overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-text">
            {item.detail}
          </pre>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={copyDetail}>
              {copied ? <Check /> : <Copy />}
              {copied ? "已复制" : "复制详情"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});
