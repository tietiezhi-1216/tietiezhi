import { Gauge, Shrink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ChatItem } from "@/stores/chat";

type ContextItem = Extract<ChatItem, { kind: "context" }>;

const tokenFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const formatTokens = (tokens: number): string =>
  tokens >= 1_000
    ? `${tokenFormatter.format(tokens / 1_000)}K`
    : tokenFormatter.format(tokens);

export function ContextNotice({ item }: { item: ContextItem }) {
  const percentage =
    item.contextWindow > 0
      ? Math.min(100, Math.round((item.tokensAfter / item.contextWindow) * 100))
      : 0;
  const title =
    item.action === "compaction"
      ? item.duringTurn
        ? "已整理执行上下文"
        : item.automatic
          ? "已自动压缩上下文"
          : "已压缩上下文"
      : "上下文使用情况";

  return (
    <div className="text-muted-foreground mx-auto flex w-fit max-w-full items-center gap-2 rounded-full border bg-muted/35 px-3 py-1.5 text-xs">
      {item.action === "compaction" ? (
        <Shrink className="size-3.5 shrink-0" />
      ) : (
        <Gauge className="size-3.5 shrink-0" />
      )}
      <span className="font-medium">{title}</span>
      <span className="text-border">·</span>
      {item.action === "compaction" ? (
        <span className="tabular-nums">
          {formatTokens(item.tokensBefore)} → {formatTokens(item.tokensAfter)}
        </span>
      ) : (
        <>
          <span className="tabular-nums">
            {formatTokens(item.tokensAfter)} / {formatTokens(item.contextWindow)}（{percentage}%）
          </span>
          <span className="text-border">·</span>
          <span>80% 自动压缩</span>
        </>
      )}
      {item.summary && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 rounded-full px-1.5 text-[11px]"
            >
              查看摘要
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="center"
            className="max-h-80 w-[min(36rem,calc(100vw-2rem))] overflow-y-auto"
          >
            <p className="mb-2 text-xs font-medium">锚定摘要</p>
            <pre className="text-muted-foreground font-sans text-xs leading-relaxed whitespace-pre-wrap">
              {item.summary}
            </pre>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
