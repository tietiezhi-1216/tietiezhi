import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  ChevronRight,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarResizeHandle,
} from "@/components/ui/sidebar";
import { ProductModeSwitcher } from "@/components/product-mode-switcher";
import { Separator } from "@/components/ui/separator";
import {
  dictationHotkey,
  errorMessage,
  loadSettings,
  pickWorkspaceDir,
  revealProject,
} from "@/lib/api";
import type { ConversationMeta } from "@/lib/api";
import { formatShortcut } from "@/lib/shortcut";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat";
import { useProjectStore } from "@/stores/projects";
import {
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  useUiStore,
} from "@/stores/ui";

const revealProjectLabel = navigator.userAgent.includes("Mac")
  ? "在 Finder 中显示"
  : "打开项目文件夹";
const IS_MACOS = navigator.userAgent.includes("Mac");

export function AppSidebar() {
  const openSettings = useUiStore((state) => state.openSettings);
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  const expandedProjects = useUiStore((state) => state.expandedProjects);
  const setProjectExpanded = useUiStore((state) => state.setProjectExpanded);
  const projectsSectionExpanded = useUiStore(
    (state) => state.projectsSectionExpanded,
  );
  const setProjectsSectionExpanded = useUiStore(
    (state) => state.setProjectsSectionExpanded,
  );
  const tasksSectionExpanded = useUiStore((state) => state.tasksSectionExpanded);
  const setTasksSectionExpanded = useUiStore(
    (state) => state.setTasksSectionExpanded,
  );
  const conversations = useChatStore((state) => state.conversations);
  const activeId = useChatStore((state) => state.activeId);
  const newConversation = useChatStore((state) => state.newConversation);
  const openConversation = useChatStore((state) => state.openConversation);
  const archiveConversation = useChatStore((state) => state.archiveConversation);
  const archiveProject = useChatStore((state) => state.archiveProject);
  const setConversationPinned = useChatStore(
    (state) => state.setConversationPinned,
  );
  const projects = useProjectStore((state) => state.projects);
  const addProject = useProjectStore((state) => state.add);
  const renameProject = useProjectStore((state) => state.rename);
  const markProjectUsed = useProjectStore((state) => state.markUsed);

  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectNameError, setProjectNameError] = useState("");
  const projectIds = useMemo(
    () => new Set(projects.map((project) => project.id)),
    [projects],
  );
  const pinnedTasks = conversations
    .filter((task) => task.pinnedAt > 0)
    .sort((left, right) => right.pinnedAt - left.pinnedAt);
  const standaloneTasks = conversations.filter(
    (task) =>
      !task.pinnedAt && (!task.projectId || !projectIds.has(task.projectId)),
  );

  const handleAddProject = async () => {
    try {
      const path = await pickWorkspaceDir();
      if (path) await addProject(path);
    } catch (err) {
      console.error("添加项目失败：", errorMessage(err));
    }
  };

  const handleNewProjectTask = (projectId: string) => {
    newConversation(projectId);
    setProjectExpanded(projectId, true);
    void markProjectUsed(projectId);
  };

  const beginRenameProject = (id: string, name: string) => {
    setRenamingProjectId(id);
    setProjectName(name);
    setProjectNameError("");
  };

  const handleRenameProject = async () => {
    if (renamingProjectId == null) return;
    try {
      await renameProject(renamingProjectId, projectName);
      setRenamingProjectId(null);
    } catch (err) {
      setProjectNameError(errorMessage(err));
    }
  };

  return (
    <Sidebar>
      <SidebarHeader className={IS_MACOS ? "pt-10" : undefined}>
        <ProductModeSwitcher />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => newConversation()}
              isActive={activeId == null}
            >
              <SquarePen />
              <span>新建任务</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {pinnedTasks.length > 0 && (
          <SidebarGroup className="pb-0">
            <SidebarGroupLabel>置顶</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pinnedTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    active={activeId === task.id}
                    pinned
                    onOpen={openConversation}
                    onArchive={archiveConversation}
                    onPin={setConversationPinned}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <div className="group/header relative">
            <SidebarGroupLabel asChild>
              <button
                type="button"
                aria-expanded={projectsSectionExpanded}
                aria-controls="sidebar-projects-content"
                onClick={() =>
                  setProjectsSectionExpanded(!projectsSectionExpanded)
                }
                className="hover:bg-sidebar-accent/60 hover:text-sidebar-foreground w-fit gap-1 px-2 transition-colors duration-300 ease-out"
              >
                <span>项目</span>
                <ChevronRight
                  className={cn(
                    "opacity-0 transition-[opacity,rotate,color] delay-0 duration-300 ease-out group-hover/header:opacity-100 group-hover/header:delay-150 group-focus-within/header:opacity-100 motion-reduce:transition-none",
                    projectsSectionExpanded && "rotate-90",
                  )}
                />
              </button>
            </SidebarGroupLabel>
            <SidebarGroupAction
              title="添加项目"
              aria-label="添加项目"
              onClick={() => void handleAddProject()}
              className="top-1/2 -translate-y-1/2 opacity-0 transition-[opacity,color,background-color] delay-0 duration-300 ease-out group-hover/header:opacity-100 group-hover/header:delay-150 group-focus-within/header:opacity-100 hover:text-sidebar-foreground focus-visible:opacity-100 motion-reduce:transition-none"
            >
              <Plus />
            </SidebarGroupAction>
          </div>
          <AnimatedCollapsibleContent
            id="sidebar-projects-content"
            open={projectsSectionExpanded}
          >
            <SidebarGroupContent>
              {projects.length === 0 ? (
                <button
                  onClick={() => void handleAddProject()}
                  className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors"
                >
                  <Folder className="size-4" />
                  添加一个项目文件夹
                </button>
              ) : (
                <SidebarMenu>
                  {projects.map((project) => {
                    const tasks = conversations.filter(
                      (task) => task.projectId === project.id && !task.pinnedAt,
                    );
                    const expanded = expandedProjects[project.id] ?? true;
                    return (
                      <SidebarMenuItem key={project.id}>
                        <div className="group/project-row relative">
                          <SidebarMenuButton
                            title={project.rootPath}
                            aria-expanded={expanded}
                            aria-controls={`project-${project.id}-tasks`}
                            onClick={() =>
                              setProjectExpanded(project.id, !expanded)
                            }
                            className="group/project pr-14 transition-[background-color,color,padding] duration-300 ease-out"
                          >
                            <span className="text-sidebar-foreground/70 group-hover/project:text-sidebar-foreground relative size-4 shrink-0 transition-colors duration-300">
                              <Folder
                                className={cn(
                                  "absolute inset-0 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                                  expanded
                                    ? "-rotate-6 scale-90 opacity-0"
                                    : "rotate-0 scale-100 opacity-100",
                                )}
                              />
                              <FolderOpen
                                className={cn(
                                  "absolute inset-0 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                                  expanded
                                    ? "rotate-0 scale-100 opacity-100"
                                    : "rotate-6 scale-90 opacity-0",
                                )}
                              />
                            </span>
                            <span className="truncate">{project.name}</span>
                          </SidebarMenuButton>
                          <SidebarMenuAction
                            title="在此项目中新建任务"
                            aria-label={`在 ${project.name} 中新建任务`}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleNewProjectTask(project.id);
                            }}
                            className="opacity-0 transition-[opacity,color,background-color] delay-0 duration-300 ease-out group-hover/project-row:opacity-100 group-hover/project-row:delay-150 group-focus-within/project-row:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
                          >
                            <SquarePen />
                          </SidebarMenuAction>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <SidebarMenuAction
                                aria-label={`${project.name} 项目操作`}
                                className="right-7 opacity-0 transition-[opacity,color,background-color] delay-0 duration-300 ease-out group-hover/project-row:opacity-100 group-hover/project-row:delay-150 group-focus-within/project-row:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
                              >
                                <MoreHorizontal />
                              </SidebarMenuAction>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              side="right"
                              align="start"
                              className="w-max min-w-44"
                            >
                              <DropdownMenuItem
                                className="whitespace-nowrap"
                                onSelect={() =>
                                  beginRenameProject(project.id, project.name)
                                }
                              >
                                <Pencil />
                                重命名项目
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="whitespace-nowrap"
                                onSelect={() => {
                                  void revealProject(project.id).catch(
                                    (err: unknown) =>
                                      console.error(
                                        "打开项目文件夹失败：",
                                        errorMessage(err),
                                      ),
                                  );
                                }}
                              >
                                <FolderOpen />
                                {revealProjectLabel}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="whitespace-nowrap"
                                onSelect={() => void archiveProject(project.id)}
                              >
                                <Archive />
                                归档项目任务
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <AnimatedCollapsibleContent
                          id={`project-${project.id}-tasks`}
                          open={expanded}
                        >
                          {tasks.length === 0 ? (
                            <p className="text-muted-foreground py-1 pr-2 pl-8 text-xs">
                              暂无任务
                            </p>
                          ) : (
                            <SidebarMenu>
                              {tasks.map((task) => (
                                <TaskRow
                                  key={task.id}
                                  task={task}
                                  active={activeId === task.id}
                                  nested
                                  onOpen={openConversation}
                                  onArchive={archiveConversation}
                                  onPin={setConversationPinned}
                                />
                              ))}
                            </SidebarMenu>
                          )}
                        </AnimatedCollapsibleContent>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </AnimatedCollapsibleContent>
        </SidebarGroup>

        <SidebarGroup className="pt-0">
          <div className="group/header relative">
            <SidebarGroupLabel asChild>
              <button
                type="button"
                aria-expanded={tasksSectionExpanded}
                aria-controls="sidebar-tasks-content"
                onClick={() => setTasksSectionExpanded(!tasksSectionExpanded)}
                className="hover:bg-sidebar-accent/60 hover:text-sidebar-foreground w-fit gap-1 px-2 transition-colors duration-300 ease-out"
              >
                <span>任务</span>
                <ChevronRight
                  className={cn(
                    "opacity-0 transition-[opacity,rotate,color] delay-0 duration-300 ease-out group-hover/header:opacity-100 group-hover/header:delay-150 group-focus-within/header:opacity-100 motion-reduce:transition-none",
                    tasksSectionExpanded && "rotate-90",
                  )}
                />
              </button>
            </SidebarGroupLabel>
          </div>
          <AnimatedCollapsibleContent
            id="sidebar-tasks-content"
            open={tasksSectionExpanded}
          >
            <SidebarGroupContent>
              {standaloneTasks.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1 text-xs">暂无任务</p>
              ) : (
                <SidebarMenu>
                  {standaloneTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      active={activeId === task.id}
                      onOpen={openConversation}
                      onArchive={archiveConversation}
                      onPin={setConversationPinned}
                    />
                  ))}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </AnimatedCollapsibleContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-1">
        <DictationStatus onClick={() => openSettings("dictationModel")} />
        <Separator className="my-0.5" />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => openSettings()}>
              <Settings />
              <span>设置</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <Dialog
        open={renamingProjectId != null}
        onOpenChange={(open) => {
          if (!open) setRenamingProjectId(null);
        }}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleRenameProject();
            }}
            className="contents"
          >
            <DialogHeader>
              <DialogTitle>重命名项目</DialogTitle>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="project-name">项目名称</Label>
              <Input
                id="project-name"
                autoFocus
                maxLength={80}
                value={projectName}
                onChange={(event) => {
                  setProjectName(event.target.value);
                  setProjectNameError("");
                }}
              />
              {projectNameError && (
                <p className="text-destructive text-xs">{projectNameError}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenamingProjectId(null)}>
                取消
              </Button>
              <Button type="submit" disabled={!projectName.trim()}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <SidebarResizeHandle
        minWidth={SIDEBAR_MIN_PX}
        maxWidth={SIDEBAR_MAX_PX}
        onResizeEnd={setSidebarWidth}
        onReset={() => setSidebarWidth(SIDEBAR_DEFAULT_PX)}
      />
    </Sidebar>
  );
}

function AnimatedCollapsibleContent({
  id,
  open,
  children,
}: {
  id: string;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      data-slot="animated-collapsible-content"
      data-state={open ? "open" : "closed"}
      inert={!open}
      aria-hidden={!open}
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,translate] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        open
          ? "grid-rows-[1fr] translate-y-0 opacity-100"
          : "pointer-events-none grid-rows-[0fr] -translate-y-1 opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function TaskRow({
  task,
  active,
  nested = false,
  pinned = false,
  onOpen,
  onArchive,
  onPin,
}: {
  task: ConversationMeta;
  active: boolean;
  nested?: boolean;
  pinned?: boolean;
  onOpen: (id: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onPin: (id: string, pinned: boolean) => Promise<void>;
}) {
  return (
    <SidebarMenuItem>
      <div className="group/task-row relative">
        <SidebarMenuButton
          isActive={active}
          onClick={() => void onOpen(task.id)}
          className={cn(
            "pr-16 transition-[background-color,color,padding] duration-200 ease-out",
            nested && "pl-8",
          )}
        >
          <span className="truncate">{task.title}</span>
        </SidebarMenuButton>
        <div className="pointer-events-none absolute top-0.5 right-1 flex items-center opacity-0 transition-opacity delay-0 duration-300 ease-out group-hover/task-row:pointer-events-auto group-hover/task-row:opacity-100 group-hover/task-row:delay-150 group-focus-within/task-row:pointer-events-auto group-focus-within/task-row:opacity-100 motion-reduce:transition-none">
          <Button
            variant="ghost"
            size="icon-sm"
            title={pinned ? "取消置顶" : "置顶任务"}
            aria-label={`${pinned ? "取消置顶" : "置顶"} ${task.title}`}
            onClick={(event) => {
              event.stopPropagation();
              void onPin(task.id, !pinned);
            }}
            className="size-7 transition-[color,background-color] duration-200"
          >
            {pinned ? <PinOff /> : <Pin />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="归档任务"
            aria-label={`归档 ${task.title}`}
            onClick={(event) => {
              event.stopPropagation();
              void onArchive(task.id);
            }}
            className="size-7 transition-[color,background-color] duration-200 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </SidebarMenuItem>
  );
}

function DictationStatus({ onClick }: { onClick: () => void }) {
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: loadSettings });
  const hotkeyQuery = useQuery({
    queryKey: ["dictationHotkey"],
    queryFn: dictationHotkey,
  });

  const settings = settingsQuery.data;
  const ready = Boolean(settings?.asrProviderId && settings?.asrModel);
  const model = settings?.asrModel ?? "";

  return (
    <button
      onClick={onClick}
      className="hover:bg-sidebar-accent group flex flex-col gap-1.5 rounded-md px-2 py-2 text-left transition-colors"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            ready ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
        <span className="text-xs font-medium">语音听写</span>
        <kbd className="text-muted-foreground bg-muted ml-auto rounded px-1.5 py-0.5 font-sans text-[10px] leading-none">
          {formatShortcut(hotkeyQuery.data ?? "Alt+Space")}
        </kbd>
      </div>
      <span className="text-muted-foreground truncate pl-3.5 text-[11px] leading-none">
        {ready ? `就绪 · ${model}` : "未配置识别模型"}
      </span>
    </button>
  );
}
