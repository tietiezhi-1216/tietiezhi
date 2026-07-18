import { memo, useEffect, useRef, useState } from "react";
import { Check, Copy, GitBranch, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/features/chat/markdown";
import { formatRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { ChatItem } from "@/stores/chat";

/** Re-render on an interval so "X 秒前" keeps counting up on its own. */
function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Timestamp + action buttons; hidden until the message is hovered. */
function ActionRow({
  createdAt,
  align,
  visible,
  children,
}: {
  createdAt: number;
  align: "start" | "end";
  visible: boolean;
  children?: React.ReactNode;
}) {
  const now = useNow();
  const [visibilityHeld, setVisibilityHeld] = useState(visible);
  const age = formatRelativeTime(createdAt, now);
  const exactTime = createdAt > 0 ? new Date(createdAt).toLocaleString("zh-CN") : "";

  useEffect(() => {
    if (visible) {
      setVisibilityHeld(true);
      return;
    }
    const timer = window.setTimeout(() => setVisibilityHeld(false), 200);
    return () => window.clearTimeout(timer);
  }, [visible]);

  return (
    <div
      aria-hidden={!visible}
      data-state={visible ? "visible" : "hidden"}
      className={cn(
        "flex h-6 items-center gap-0.5 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
        align === "end" ? "justify-end" : "justify-start",
        visibilityHeld ? "visible" : "invisible",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-0.5 opacity-0",
      )}
    >
      {age && (
        <span className="text-muted-foreground px-1 text-[11px]" title={exactTime}>
          {age}
        </span>
      )}
      {children}
    </div>
  );
}

const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
};

const tokenFormatter = new Intl.NumberFormat("en-US");

const formatTps = (tokensPerSecond: number): string =>
  tokensPerSecond >= 100
    ? Math.round(tokensPerSecond).toString()
    : tokensPerSecond.toFixed(1);

function MetaValue({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <span className="text-muted-foreground px-1 text-[11px]" title={title}>
      {children}
    </span>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground hover:text-foreground size-6"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}

/** The plain-text variant; tool calls & permission asks render elsewhere. */
export type MessageChatItem = Extract<ChatItem, { kind: "message" }>;

interface MessageItemProps {
  item: MessageChatItem;
  hoverKey: string;
  hovered: boolean;
  showActions: boolean;
  onBranch: (itemId: number) => void;
  onEdit: (itemId: number, text: string) => void;
  onHoverChange: (hoverKey: string | null) => void;
}

/**
 * Memoized: while a reply streams, the items array is rebuilt on every flush
 * but only the streaming message's object identity changes — every other
 * message must skip re-rendering (markdown + highlight are expensive).
 */
export const MessageItem = memo(function MessageItem({
  item,
  hoverKey,
  hovered,
  showActions,
  onBranch,
  onEdit,
  onHoverChange,
}: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(item.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  if (item.role === "user") {
    if (editing) {
      return <EditBox draft={draft} setDraft={setDraft} onCancel={() => {
        setEditing(false);
        setDraft(item.content);
      }} onSubmit={() => {
        const text = draft.trim();
        if (!text) return;
        setEditing(false);
        onEdit(item.id, text);
      }} />;
    }

    return (
      <div
        className="animate-in fade-in slide-in-from-bottom-1 flex flex-col items-end gap-1 duration-300"
        onPointerEnter={() => onHoverChange(hoverKey)}
        onPointerLeave={() => onHoverChange(null)}
      >
        <div className="bg-muted max-w-[70%] rounded-xl px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap select-text">
          {item.content}
        </div>
        <ActionRow createdAt={item.createdAt} align="end" visible={hovered}>
          <ActionButton
            icon={GitBranch}
            label="从这里开分支"
            onClick={() => onBranch(item.id)}
          />
          <ActionButton
            icon={Pencil}
            label="编辑并重发（另存为分支）"
            onClick={() => {
              setDraft(item.content);
              setEditing(true);
            }}
          />
        </ActionRow>
      </div>
    );
  }

  const generationMs =
    item.durationMs != null && item.firstTokenMs != null
      ? item.durationMs - item.firstTokenMs
      : null;
  const tokensPerSecond =
    !item.usageEstimated &&
    item.completionTokens != null &&
    item.completionTokens > 0 &&
    generationMs != null &&
    generationMs > 0
      ? item.completionTokens / (generationMs / 1_000)
      : null;

  // Assistant: plain prose, no bubble.
  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 flex min-w-0 flex-col gap-1 duration-300"
      onPointerEnter={showActions ? () => onHoverChange(hoverKey) : undefined}
      onPointerLeave={showActions ? () => onHoverChange(null) : undefined}
    >
      {item.content && (
        item.error ? (
          <p className="text-destructive text-sm leading-relaxed whitespace-pre-wrap select-text">
            {item.content}
          </p>
        ) : (
          <Markdown content={item.content} />
        )
      )}
      {item.content && showActions && (
        <ActionRow
          createdAt={item.completedAt ?? item.createdAt}
          align="start"
          visible={hovered}
        >
          {item.model && (
            <MetaValue
              title={item.providerId ? `模型：${item.model} · 供应商：${item.providerId}` : `模型：${item.model}`}
            >
              {item.model}
            </MetaValue>
          )}
          {item.totalTokens != null && !item.usageEstimated && (
            <MetaValue
              title={`实际 Token：输入 ${item.promptTokens ?? 0} · 输出 ${item.completionTokens ?? 0} · 总计 ${item.totalTokens}`}
            >
              {tokenFormatter.format(item.totalTokens)} tokens
            </MetaValue>
          )}
          {tokensPerSecond != null && generationMs != null && (
            <MetaValue
              title={`实际生成速度：输出 ${tokenFormatter.format(item.completionTokens ?? 0)} Token ÷ ${formatDuration(generationMs)} = ${formatTps(tokensPerSecond)} Token/s`}
            >
              {formatTps(tokensPerSecond)} tokens/s
            </MetaValue>
          )}
          {item.firstTokenMs != null && (
            <MetaValue title={`从发送到收到第一个 Token：${item.firstTokenMs}ms`}>
              首字 {formatDuration(item.firstTokenMs)}
            </MetaValue>
          )}
          {item.durationMs != null && (
            <MetaValue title={`本次回复总耗时：${item.durationMs}ms`}>
              耗时 {formatDuration(item.durationMs)}
            </MetaValue>
          )}
          <ActionButton
            icon={copied ? Check : Copy}
            label={copied ? "已复制" : "复制"}
            onClick={copy}
          />
        </ActionRow>
      )}
    </div>
  );
});

function EditBox({
  draft,
  setDraft,
  onCancel,
  onSubmit,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="border-input bg-background w-[70%] rounded-2xl border p-2">
        <Textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="max-h-52 min-h-9 resize-none border-0 bg-transparent p-1 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          rows={2}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground mr-1 text-[11px]">改完会另存为一条分支对话</span>
        <Button variant="ghost" size="sm" className="h-7" onClick={onCancel}>
          <X /> 取消
        </Button>
        <Button size="sm" className="h-7" onClick={onSubmit} disabled={!draft.trim()}>
          <Check /> 重新发送
        </Button>
      </div>
    </div>
  );
}
