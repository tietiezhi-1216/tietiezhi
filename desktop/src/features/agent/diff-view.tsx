/**
 * The diff a write/edit produced.
 *
 * This is the view the whole tool entry exists for: "which lines changed" is the
 * question a coding agent has to answer, and a JSON blob of the tool arguments
 * does not answer it.
 */

import { useMemo, useState } from "react";
import { Ellipsis, FileDiff, FilePlus2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  computeFileDiff,
  MAX_DIFF_LINES,
  type DiffLine,
  type FileDiff as FileDiffResult,
} from "./diff";
import type { FileChange } from "./types";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function DiffView({ change, className }: { change: FileChange; className?: string }) {
  if (change.kind === "file-change-skipped") {
    return (
      <div
        className={cn(
          "text-muted-foreground overflow-hidden rounded-lg border px-2 py-1.5 text-[11px]",
          className,
        )}
      >
        <span className="font-mono">{change.path}</span>
        <span>：文件过大（{formatBytes(change.bytes)}），未生成差异视图</span>
      </div>
    );
  }
  // Split so the hooks below never sit behind a conditional return.
  return <FileDiffBody change={change} className={className} />;
}

function FileDiffBody({
  change,
  className,
}: {
  change: Extract<FileChange, { kind: "file-change" }>;
  className?: string;
}) {
  const diff = useMemo(
    () => computeFileDiff(change.path, change.before, change.after),
    [change.path, change.before, change.after],
  );
  // Expanded folds are tracked by section index, which is stable because the
  // diff is memoized on the change it came from.
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set<number>());

  return (
    <div className={cn("overflow-hidden rounded-lg border", className)}>
      <DiffHeader diff={diff} />
      <div className="overflow-x-auto py-1 font-mono text-[11px] leading-[1.5]">
        {diff.sections.map((section, index) =>
          section.kind === "fold" && !opened.has(index) ? (
            <Button
              key={index}
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground h-6 w-full min-w-max justify-start rounded-none px-2 font-mono text-[11px] font-normal"
              onClick={() =>
                setOpened((current) => {
                  const next = new Set(current);
                  next.add(index);
                  return next;
                })
              }
            >
              <Ellipsis />
              {section.lines.length} 行未改动
            </Button>
          ) : (
            <div key={index}>
              {section.lines.map((line) => (
                <DiffRow
                  key={`${line.beforeLine ?? "x"}-${line.afterLine ?? "x"}-${line.change}`}
                  line={line}
                />
              ))}
            </div>
          ),
        )}
        {diff.sections.length === 0 && (
          <p className="text-muted-foreground px-2 py-1">（空文件）</p>
        )}
      </div>
      <DiffFooter diff={diff} />
    </div>
  );
}

function DiffHeader({ diff }: { diff: FileDiffResult }) {
  const Icon = diff.created ? FilePlus2 : FileDiff;
  return (
    <div className="bg-muted/40 flex items-center gap-2 border-b px-2 py-1.5">
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={diff.path}>
        {diff.path}
      </span>
      {diff.created && (
        <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]">
          新建
        </Badge>
      )}
      <span className="shrink-0 font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
        +{diff.added}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-rose-600 dark:text-rose-400">
        -{diff.removed}
      </span>
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const sign = line.change === "add" ? "+" : line.change === "remove" ? "-" : " ";
  return (
    <div
      className={cn(
        "flex w-full min-w-max",
        line.change === "add" && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
        line.change === "remove" && "bg-rose-500/10 text-rose-800 dark:text-rose-200",
      )}
    >
      <span className="text-muted-foreground/60 w-9 shrink-0 pr-1.5 text-right tabular-nums select-none">
        {line.beforeLine ?? ""}
      </span>
      <span className="text-muted-foreground/60 w-9 shrink-0 pr-1.5 text-right tabular-nums select-none">
        {line.afterLine ?? ""}
      </span>
      <span className="w-3 shrink-0 text-center select-none">{sign}</span>
      {/* A leading space keeps an empty line's tinted background visible. */}
      <span className="pr-3 whitespace-pre">{line.text === "" ? " " : line.text}</span>
    </div>
  );
}

function DiffFooter({ diff }: { diff: FileDiffResult }) {
  const notes: string[] = [];
  if (diff.added === 0 && diff.removed === 0) {
    notes.push(diff.identical ? "内容没有变化" : "仅文件末尾换行有变化");
  }
  if (diff.degraded) notes.push("改动范围过大，已改用逐行粗略对比");
  if (diff.truncated) notes.push(`差异过长，仅显示前 ${MAX_DIFF_LINES} 行`);
  if (notes.length === 0) return null;
  return (
    <p className="text-muted-foreground border-t px-2 py-1 text-[11px]">{notes.join("；")}</p>
  );
}
