import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FileCode2,
  FilePlus2,
  FileX2,
  Files,
  Folder,
  GitBranch,
  Loader2,
  PanelRightClose,
  RefreshCw,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type {
  AppMessage,
  WorkspaceChangeEntry,
  WorkspaceDiffFile,
  WorkspaceDiffLine,
  WorkspaceDirectoryEntry,
  WorkspaceGitStatus,
  WorkspaceInfo,
} from "@shared/contracts";

const DEPTH_PADDING = ["pl-2", "pl-5", "pl-8", "pl-11", "pl-14", "pl-17", "pl-20"];

function parentPath(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("/");
}

function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function statusIcon(status: WorkspaceChangeEntry["status"]) {
  if (status === "added" || status === "untracked") return FilePlus2;
  if (status === "deleted") return FileX2;
  return FileCode2;
}

function diffRowClass(kind: WorkspaceDiffLine["kind"]): string {
  if (kind === "addition") return "bg-emerald-500/10 text-emerald-500";
  if (kind === "deletion") return "bg-destructive/10 text-destructive";
  if (kind === "hunk") return "bg-sky-500/8 text-sky-500";
  if (kind === "meta") return "text-muted-foreground bg-muted/30";
  return "text-foreground";
}

function DiffViewer({ diff }: { diff: WorkspaceDiffFile }) {
  if (diff.truncated) return <EmptyState text="Diff 过大，仅保留文件级统计" />;
  if (diff.binary) return <EmptyState text="二进制文件无法显示逐行 Diff" />;
  return (
    <div className="min-w-max font-mono text-[11px] leading-5">
      {diff.lines.map((line, index) => (
        <div
          key={`${line.kind}-${line.oldLine ?? ""}-${line.newLine ?? ""}-${index}`}
          className={cn("grid min-h-5 grid-cols-[2.75rem_2.75rem_1rem_minmax(0,1fr)] px-2", diffRowClass(line.kind))}
        >
          <span className="text-muted-foreground/70 text-right tabular-nums">{line.oldLine ?? ""}</span>
          <span className="text-muted-foreground/70 text-right tabular-nums">{line.newLine ?? ""}</span>
          <span className="text-center">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : ""}</span>
          <span className="whitespace-pre pr-4">{line.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function sessionDiff(path: string, before: string, after: string): WorkspaceDiffFile {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  const lines: WorkspaceDiffLine[] = [
    ...oldLines.slice(Math.max(0, prefix - 3), prefix).map((text, index) => ({ kind: "context" as const, text, oldLine: Math.max(1, prefix - 2) + index, newLine: Math.max(1, prefix - 2) + index })),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((text, index) => ({ kind: "deletion" as const, text, oldLine: prefix + index + 1 })),
    ...newLines.slice(prefix, newLines.length - suffix).map((text, index) => ({ kind: "addition" as const, text, newLine: prefix + index + 1 })),
    ...newLines.slice(newLines.length - Math.min(3, suffix)).map((text, index) => ({ kind: "context" as const, text, oldLine: oldLines.length - Math.min(3, suffix) + index + 1, newLine: newLines.length - Math.min(3, suffix) + index + 1 })),
  ];
  return { path, staged: false, binary: false, truncated: false, lines };
}

function EmptyState({ text }: { text: string }) {
  return <p className="text-muted-foreground px-4 py-10 text-center text-xs">{text}</p>;
}

export function WorkspacePanel({
  activeId,
  messages,
  workspace,
  onClose,
}: {
  activeId: string;
  messages: AppMessage[];
  workspace?: WorkspaceInfo;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<"changes" | "files">("changes");
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus>({ repository: false, changes: [] });
  const [gitLoading, setGitLoading] = useState(true);
  const [gitError, setGitError] = useState("");
  const [selectedChange, setSelectedChange] = useState<WorkspaceChangeEntry>();
  const [selectedDiff, setSelectedDiff] = useState<WorkspaceDiffFile>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [directories, setDirectories] = useState<Record<string, WorkspaceDirectoryEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(true);
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState("");

  const sessionDiffs = useMemo(
    () => messages.flatMap((message) => message.parts).filter(
      (part): part is Extract<AppMessage["parts"][number], { type: "diff" }> => part.type === "diff",
    ),
    [messages],
  );

  const refreshGit = useCallback(async () => {
    setGitLoading(true);
    setGitError("");
    try {
      setGitStatus(await window.tietiezhi.workspace.gitStatus(activeId));
    } catch (cause) {
      setGitError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGitLoading(false);
    }
  }, [activeId]);

  const loadDirectory = useCallback(async (path = ".") => {
    const entries = await window.tietiezhi.workspace.listDirectory(activeId, path === "." ? undefined : path);
    setDirectories((current) => ({ ...current, [path]: entries }));
  }, [activeId]);

  useEffect(() => {
    setSelectedChange(undefined);
    setSelectedDiff(undefined);
    setSelectedFile("");
    setFileContent("");
    setDirectories({});
    setExpanded(new Set());
    void Promise.all([refreshGit(), loadDirectory()]).catch((cause: unknown) => {
      setFileError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [activeId, loadDirectory, refreshGit]);

  useEffect(() => {
    if (sessionDiffs.length === 0) return;
    void refreshGit();
    void Promise.all([
      loadDirectory(),
      ...[...expanded].map((path) => loadDirectory(path)),
    ]);
  }, [sessionDiffs.length, loadDirectory, refreshGit]);

  useEffect(() => {
    const width = Number(window.localStorage.getItem("workspace-panel-width-v3"));
    if (Number.isFinite(width) && width >= 340 && width <= 560) {
      panelRef.current?.style.setProperty("width", `${width}px`);
    }
  }, []);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !panelRef.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = panelRef.current.getBoundingClientRect().width;
    let width = startWidth;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      width = Math.min(560, Math.max(340, startWidth + startX - moveEvent.clientX));
      panelRef.current?.style.setProperty("width", `${width}px`);
    };
    const finish = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
      window.localStorage.setItem("workspace-panel-width-v3", String(Math.round(width)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
  };

  const toggleDirectory = async (path: string) => {
    const opening = !expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(path); else next.delete(path);
      return next;
    });
    if (opening && directories[path] === undefined) await loadDirectory(path);
  };

  const openFile = async (path: string) => {
    setSelectedFile(path);
    setFileLoading(true);
    setFileError("");
    try {
      setFileContent(await window.tietiezhi.workspace.readFile(activeId, path));
    } catch (cause) {
      setFileContent("");
      setFileError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFileLoading(false);
    }
  };

  const openChange = async (change: WorkspaceChangeEntry) => {
    setSelectedChange(change);
    setSelectedDiff(undefined);
    setDiffError("");
    setDiffLoading(true);
    try {
      setSelectedDiff(await window.tietiezhi.workspace.gitDiff(activeId, change.path, change.staged && !change.unstaged));
    } catch (cause) {
      setDiffError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiffLoading(false);
    }
  };

  const renderDirectory = (path = ".", depth = 0): ReactNode => {
    const entries = (directories[path] ?? []).filter((entry) => showHidden || !entry.hidden);
    return entries.map((entry) => (
      <div key={entry.path}>
        <button
          type="button"
          onClick={() => entry.type === "directory" ? void toggleDirectory(entry.path) : void openFile(entry.path)}
          className={cn(
            "hover:bg-muted/70 flex h-8 w-full items-center gap-1.5 rounded-sm pr-2 text-left text-xs transition-colors",
            DEPTH_PADDING[Math.min(depth, DEPTH_PADDING.length - 1)],
            selectedFile === entry.path && "bg-muted text-foreground",
          )}
        >
          {entry.type === "directory" ? (
            <ChevronRight className={cn("text-muted-foreground size-3.5 transition-transform", expanded.has(entry.path) && "rotate-90")} />
          ) : <span className="w-3.5" />}
          {entry.type === "directory" ? <Folder className="text-muted-foreground size-3.5" /> : <FileCode2 className="text-muted-foreground size-3.5" />}
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </button>
        {entry.type === "directory" && expanded.has(entry.path) && renderDirectory(entry.path, depth + 1)}
      </div>
    ));
  };

  const fallbackChanges: WorkspaceChangeEntry[] = sessionDiffs.map((diff) => ({
    path: diff.path,
    status: diff.before === "" ? "added" : "modified",
    staged: false,
    unstaged: true,
    additions: null,
    deletions: null,
  }));
  const changes = gitStatus.repository ? gitStatus.changes : fallbackChanges;

  return (
    <aside
      ref={panelRef}
      aria-label="工作区文件与变更"
      className="bg-background relative flex min-h-0 w-[clamp(360px,31vw,520px)] shrink-0 flex-col border-l max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-40 max-[760px]:w-full max-[760px]:max-w-none"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整工作区面板宽度"
        onPointerDown={beginResize}
        className="group absolute inset-y-0 -left-1 z-30 w-2 touch-none cursor-col-resize before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent hover:before:bg-ring/70 max-[760px]:hidden"
      />
      <Tabs value={tab} onValueChange={(value) => setTab(value as "changes" | "files")} className="min-h-0 flex-1 gap-0">
        <div className="flex h-12 shrink-0 items-center border-b px-3">
          <TabsList variant="line" className="h-11 justify-start">
            <TabsTrigger value="changes">变更 {changes.length > 0 && <Badge variant="secondary">{changes.length}</Badge>}</TabsTrigger>
            <TabsTrigger value="files">文件</TabsTrigger>
          </TabsList>
          <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose} aria-label="关闭工作区面板">
            <PanelRightClose />
          </Button>
        </div>

        <TabsContent value="changes" className="min-h-0 overflow-hidden">
          {selectedChange ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => { setSelectedChange(undefined); setSelectedDiff(undefined); }} aria-label="返回变更列表"><ArrowLeft /></Button>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{selectedChange.path}</span>
                {selectedChange.additions != null && <span className="text-emerald-500 text-xs">+{selectedChange.additions}</span>}
                {selectedChange.deletions != null && <span className="text-destructive text-xs">−{selectedChange.deletions}</span>}
              </div>
              <ScrollArea className="min-h-0 flex-1">
                {diffLoading ? <EmptyState text="正在读取 Diff…" /> : diffError ? <EmptyState text={diffError} /> : selectedDiff ? <DiffViewer diff={selectedDiff} /> : <EmptyState text="没有可显示的 Diff" />}
              </ScrollArea>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-xs">
                <GitBranch className="text-muted-foreground size-3.5" />
                <span className="min-w-0 flex-1 truncate">{gitStatus.repository ? gitStatus.branch : "本轮变更"}</span>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => void refreshGit()} aria-label="刷新变更"><RefreshCw className={cn(gitLoading && "animate-spin")} /></Button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                {gitError ? <EmptyState text={gitError} /> : changes.length === 0 ? <EmptyState text="当前 Workspace 没有未提交变更" /> : (
                  <div className="py-1">
                    {changes.map((change) => {
                      const Icon = statusIcon(change.status);
                      return (
                        <button key={change.path} type="button" onClick={() => {
                          if (gitStatus.repository) void openChange(change);
                          else {
                            const diff = sessionDiffs.find((candidate) => candidate.path === change.path);
                            setSelectedChange(change);
                            if (diff) setSelectedDiff(sessionDiff(diff.path, diff.before, diff.after));
                          }
                        }} className="hover:bg-muted/70 flex h-10 w-full items-center gap-2 px-3 text-left transition-colors">
                          <Icon className="text-muted-foreground size-3.5 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs">{baseName(change.path)}</span>
                            {parentPath(change.path) && <span className="text-muted-foreground block truncate text-[10px]">{parentPath(change.path)}</span>}
                          </span>
                          {change.additions != null && <span className="text-emerald-500 text-[11px] tabular-nums">+{change.additions}</span>}
                          {change.deletions != null && <span className="text-destructive text-[11px] tabular-nums">−{change.deletions}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </div>
          )}
        </TabsContent>

        <TabsContent value="files" className="min-h-0 overflow-hidden">
          {selectedFile ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => { setSelectedFile(""); setFileContent(""); }} aria-label="返回文件树"><ArrowLeft /></Button>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{selectedFile}</span>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => void openFile(selectedFile)} aria-label="刷新文件"><RefreshCw className={cn(fileLoading && "animate-spin")} /></Button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                {fileError ? <EmptyState text={fileError} /> : fileLoading ? <EmptyState text="正在读取文件…" /> : <pre className="min-w-max p-3 font-mono text-[11px] leading-5 whitespace-pre">{fileContent}</pre>}
              </ScrollArea>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
                <Files className="text-muted-foreground size-3.5" />
                <span className="min-w-0 flex-1 truncate text-xs">{workspace?.name ?? "Workspace"}</span>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => setShowHidden((current) => !current)} aria-label={showHidden ? "隐藏点文件" : "显示点文件"}>{showHidden ? <Eye /> : <EyeOff />}</Button>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => void loadDirectory()} aria-label="刷新文件树"><RefreshCw /></Button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="py-1">{directories["."] === undefined ? <EmptyState text="正在读取文件…" /> : renderDirectory()}</div>
              </ScrollArea>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}
