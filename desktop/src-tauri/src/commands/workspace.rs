use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tietiezhi_agent_git::{
    ExecutionEnvironment, WorkspaceDescriptor, WorkspaceGitCommit, WorkspaceGitDiff,
    WorkspaceHandoff, WorkspaceRuntime, WorkspaceSnapshot,
};
use walkdir::WalkDir;

/// Work and Code are behavior/tool profiles over the same task workspace.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskMode {
    Work,
    #[default]
    Code,
}

impl TaskMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Code => "code",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    pub path: String,
    pub size: u64,
    pub modified_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspaceModeStatus {
    pub mode: TaskMode,
    pub initialized: bool,
    pub root_path: String,
    pub is_git: bool,
    pub file_count: usize,
    pub file_count_capped: bool,
    pub changed_files: Vec<String>,
    pub deliverables: Vec<WorkspaceFileEntry>,
    pub transferable_files: Vec<WorkspaceFileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspaceOverview {
    pub work: TaskWorkspaceModeStatus,
    pub code: TaskWorkspaceModeStatus,
    pub environment: ExecutionEnvironment,
    pub initialized: bool,
    pub root_path: String,
    pub project_root: Option<String>,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub snapshots: Vec<WorkspaceSnapshot>,
    pub handoffs: Vec<WorkspaceHandoff>,
}

#[tauri::command]
pub async fn pick_workspace_dir(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.map(|path| path.to_string()));
    });
    rx.await.map_err(|_| "选择目录失败".to_string())
}

/// Resolve the single writable environment owned by a task. TaskMode only
/// changes model/tool behavior and never selects another filesystem root.
pub(crate) fn resolve_task_workspace(
    app: &AppHandle,
    project_id: Option<&str>,
    task_id: Option<&str>,
    _task_mode: TaskMode,
) -> Result<PathBuf, String> {
    let task_id = task_id.ok_or_else(|| "任务尚未创建".to_string())?;
    super::conversations::validate_id(task_id)?;
    let runtime = workspace_runtime(app)?;
    if let Some(descriptor) = adopt_legacy_workspace(app, &runtime, task_id, project_id)? {
        return canonical_or_original(descriptor.active_root);
    }
    let project_root = project_root_for_id(app, project_id)?;
    let descriptor = runtime
        .resolve(
            task_id,
            project_root.as_deref(),
            &shared_workspace_path(app, task_id)?,
            None,
        )
        .map_err(workspace_error)?;
    if let Some(project_id) = project_id.map(str::trim).filter(|id| !id.is_empty()) {
        let _ = super::projects::mark_used(app, project_id);
    }
    canonical_or_original(descriptor.active_root)
}

#[tauri::command]
pub async fn task_workspace_overview(
    app: AppHandle,
    task_id: String,
) -> Result<TaskWorkspaceOverview, String> {
    tauri::async_runtime::spawn_blocking(move || task_workspace_overview_sync(&app, &task_id))
        .await
        .map_err(|error| format!("读取工作区状态失败：{error}"))?
}

#[tauri::command]
pub async fn set_task_workspace_environment(
    app: AppHandle,
    task_id: String,
    environment: ExecutionEnvironment,
) -> Result<TaskWorkspaceOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::conversations::validate_id(&task_id)?;
        let project_id = conversation_project_id(&app, &task_id)?;
        let project_root = project_root_for_id(&app, project_id.as_deref())?;
        if project_root.is_none() && environment == ExecutionEnvironment::Worktree {
            return Err("未绑定项目的任务只能使用 Local 环境".into());
        }
        let runtime = workspace_runtime(&app)?;
        let _ = adopt_legacy_workspace(&app, &runtime, &task_id, project_id.as_deref())?;
        match project_root {
            Some(project_root) => {
                runtime
                    .set_environment(
                        &task_id,
                        &project_root,
                        &shared_workspace_path(&app, &task_id)?,
                        environment,
                    )
                    .map_err(workspace_error)?;
            }
            None => {
                runtime
                    .resolve(
                        &task_id,
                        None,
                        &shared_workspace_path(&app, &task_id)?,
                        Some(ExecutionEnvironment::Local),
                    )
                    .map_err(workspace_error)?;
            }
        }
        task_workspace_overview_sync(&app, &task_id)
    })
    .await
    .map_err(|error| format!("切换执行环境失败：{error}"))?
}

#[tauri::command]
pub async fn create_task_workspace_snapshot(
    app: AppHandle,
    task_id: String,
    label: String,
) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_workspace_descriptor(&app, &task_id)?;
        workspace_runtime(&app)?
            .snapshot(&task_id, label.trim())
            .map_err(workspace_error)
    })
    .await
    .map_err(|error| format!("创建工作区快照失败：{error}"))?
}

#[tauri::command]
pub async fn restore_task_workspace_snapshot(
    app: AppHandle,
    task_id: String,
    snapshot_id: String,
) -> Result<TaskWorkspaceOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_workspace_descriptor(&app, &task_id)?;
        workspace_runtime(&app)?
            .restore(&task_id, &snapshot_id)
            .map_err(workspace_error)?;
        task_workspace_overview_sync(&app, &task_id)
    })
    .await
    .map_err(|error| format!("恢复工作区快照失败：{error}"))?
}

#[tauri::command]
pub async fn handoff_task_workspace(
    app: AppHandle,
    task_id: String,
    branch: Option<String>,
    label: String,
) -> Result<WorkspaceHandoff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_workspace_descriptor(&app, &task_id)?;
        workspace_runtime(&app)?
            .handoff(
                &task_id,
                branch.as_deref(),
                if label.trim().is_empty() {
                    "Codex handoff"
                } else {
                    label.trim()
                },
            )
            .map_err(workspace_error)
    })
    .await
    .map_err(|error| format!("创建工作区交接失败：{error}"))?
}

#[tauri::command]
pub async fn task_workspace_git_diff(
    app: AppHandle,
    task_id: String,
) -> Result<WorkspaceGitDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_workspace_descriptor(&app, &task_id)?;
        workspace_runtime(&app)?
            .diff(&task_id)
            .map_err(workspace_error)
    })
    .await
    .map_err(|error| format!("读取 Git Diff 失败：{error}"))?
}

#[tauri::command]
pub async fn stage_task_workspace_paths(
    app: AppHandle,
    task_id: String,
    paths: Vec<String>,
) -> Result<WorkspaceGitDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_workspace_descriptor(&app, &task_id)?;
        workspace_runtime(&app)?
            .stage_paths(&task_id, &paths)
            .map_err(workspace_error)
    })
    .await
    .map_err(|error| format!("暂存 Git 文件失败：{error}"))?
}

#[tauri::command]
pub async fn unstage_task_workspace_paths(
    app: AppHandle,
    task_id: String,
    paths: Vec<String>,
) -> Result<WorkspaceGitDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_workspace_descriptor(&app, &task_id)?;
        workspace_runtime(&app)?
            .unstage_paths(&task_id, &paths)
            .map_err(workspace_error)
    })
    .await
    .map_err(|error| format!("取消暂存 Git 文件失败：{error}"))?
}

#[tauri::command]
pub async fn discard_task_workspace_paths(
    app: AppHandle,
    task_id: String,
    paths: Vec<String>,
) -> Result<WorkspaceGitDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_workspace_descriptor(&app, &task_id)?;
        workspace_runtime(&app)?
            .discard_paths(&task_id, &paths)
            .map_err(workspace_error)
    })
    .await
    .map_err(|error| format!("回退 Git 文件失败：{error}"))?
}

#[tauri::command]
pub async fn commit_task_workspace(
    app: AppHandle,
    task_id: String,
    message: String,
) -> Result<WorkspaceGitCommit, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_workspace_descriptor(&app, &task_id)?;
        workspace_runtime(&app)?
            .commit(&task_id, &message)
            .map_err(workspace_error)
    })
    .await
    .map_err(|error| format!("提交 Git 变更失败：{error}"))?
}

#[tauri::command]
pub async fn push_task_workspace(
    app: AppHandle,
    task_id: String,
    remote: String,
    branch: String,
) -> Result<WorkspaceGitDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_workspace_descriptor(&app, &task_id)?;
        workspace_runtime(&app)?
            .push(&task_id, &remote, &branch)
            .map_err(workspace_error)
    })
    .await
    .map_err(|error| format!("推送 Git 分支失败：{error}"))?
}

#[tauri::command]
pub async fn task_workspace_pull_request_url(
    app: AppHandle,
    task_id: String,
    remote: String,
    branch: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_workspace_descriptor(&app, &task_id)?;
        workspace_runtime(&app)?
            .pull_request_url(&task_id, &remote, &branch)
            .map_err(workspace_error)
    })
    .await
    .map_err(|error| format!("生成 Pull Request 链接失败：{error}"))?
}

/// Pre-R29 compatibility. Both modes now address the same file, so no copy is
/// performed after the path has been validated.
#[tauri::command]
pub async fn transfer_task_workspace_file(
    app: AppHandle,
    task_id: String,
    from_mode: TaskMode,
    to_mode: TaskMode,
    path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if from_mode == to_mode {
            return Err("来源和目标工作方式不能相同".into());
        }
        let descriptor = ensure_workspace_descriptor(&app, &task_id)?;
        let relative = checked_relative_path(&path)?;
        let file = descriptor.active_root.join(&relative);
        let canonical_file =
            dunce::canonicalize(&file).map_err(|_| format!("找不到工作区文件：{path}"))?;
        let canonical_root = dunce::canonicalize(&descriptor.active_root)
            .map_err(|error| format!("无法解析工作区：{error}"))?;
        if !canonical_file.starts_with(canonical_root)
            || !canonical_file.is_file()
            || file.is_symlink()
        {
            return Err("只能交接共享工作区内的普通文件".into());
        }
        Ok(display_relative_path(&relative))
    })
    .await
    .map_err(|error| format!("读取共享工作区文件失败：{error}"))?
}

fn task_workspace_overview_sync(
    app: &AppHandle,
    task_id: &str,
) -> Result<TaskWorkspaceOverview, String> {
    super::conversations::validate_id(task_id)?;
    let project_id = conversation_project_id(app, task_id)?;
    let project_root = project_root_for_id(app, project_id.as_deref())?;
    let runtime = workspace_runtime(app)?;
    let descriptor = adopt_legacy_workspace(app, &runtime, task_id, project_id.as_deref())?
        .or(runtime.read(task_id).map_err(workspace_error)?);

    let predicted_environment = if project_root.as_deref().is_some_and(is_git_directory) {
        ExecutionEnvironment::Worktree
    } else {
        ExecutionEnvironment::Local
    };
    let predicted_root = if predicted_environment == ExecutionEnvironment::Local {
        project_root
            .clone()
            .unwrap_or(shared_workspace_path(app, task_id)?)
    } else {
        shared_workspace_path(app, task_id)?
    };

    let Some(descriptor) = descriptor else {
        let work = empty_mode_status(TaskMode::Work, &predicted_root);
        let code = empty_mode_status(TaskMode::Code, &predicted_root);
        return Ok(TaskWorkspaceOverview {
            work,
            code,
            environment: predicted_environment,
            initialized: false,
            root_path: predicted_root.to_string_lossy().into_owned(),
            project_root: project_root.map(|path| path.to_string_lossy().into_owned()),
            head: None,
            branch: None,
            detached: false,
            snapshots: Vec::new(),
            handoffs: Vec::new(),
        });
    };

    let changed_files = runtime.changed_files(task_id).unwrap_or_default();
    let work = summarize_workspace(&descriptor, TaskMode::Work, &changed_files)?;
    let code = summarize_workspace(&descriptor, TaskMode::Code, &changed_files)?;
    Ok(TaskWorkspaceOverview {
        work,
        code,
        environment: descriptor.environment,
        initialized: descriptor.initialized,
        root_path: descriptor.active_root.to_string_lossy().into_owned(),
        project_root: descriptor
            .project_root
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        head: descriptor.head,
        branch: descriptor.branch,
        detached: descriptor.detached,
        snapshots: descriptor.snapshots,
        handoffs: descriptor.handoffs,
    })
}

fn summarize_workspace(
    descriptor: &WorkspaceDescriptor,
    mode: TaskMode,
    changed_files: &[String],
) -> Result<TaskWorkspaceModeStatus, String> {
    const MAX_SCANNED_FILES: usize = 5_000;
    const MAX_LISTED_FILES: usize = 24;

    let root = &descriptor.active_root;
    let is_git = descriptor.repository_root.is_some() || is_git_directory(root);
    let changed: HashSet<&str> = changed_files.iter().map(String::as_str).collect();
    let mut files = Vec::new();
    let mut file_count = 0;
    let mut file_count_capped = false;
    let entries = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.file_name() != ".git");
    for entry in entries {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() || entry.path().is_symlink() {
            continue;
        }
        if file_count >= MAX_SCANNED_FILES {
            file_count_capped = true;
            break;
        }
        file_count += 1;
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        files.push(WorkspaceFileEntry {
            path: display_relative_path(relative),
            size: metadata.len(),
            modified_at: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0),
        });
    }
    files.sort_by_key(|file| std::cmp::Reverse(file.modified_at));
    let deliverables = files
        .iter()
        .filter(|file| {
            is_deliverable(&file.path) && (!is_git || changed.contains(file.path.as_str()))
        })
        .take(MAX_LISTED_FILES)
        .cloned()
        .collect::<Vec<_>>();
    let transferable_files = if mode == TaskMode::Work {
        let source = if deliverables.is_empty() {
            &files
        } else {
            &deliverables
        };
        source.iter().take(MAX_LISTED_FILES).cloned().collect()
    } else {
        files
            .iter()
            .filter(|file| changed.contains(file.path.as_str()))
            .take(MAX_LISTED_FILES)
            .cloned()
            .collect()
    };
    Ok(TaskWorkspaceModeStatus {
        mode,
        initialized: descriptor.initialized,
        root_path: root.to_string_lossy().into_owned(),
        is_git,
        file_count,
        file_count_capped,
        changed_files: changed_files.to_vec(),
        deliverables,
        transferable_files,
    })
}

fn empty_mode_status(mode: TaskMode, root: &Path) -> TaskWorkspaceModeStatus {
    TaskWorkspaceModeStatus {
        mode,
        initialized: false,
        root_path: root.to_string_lossy().into_owned(),
        is_git: false,
        file_count: 0,
        file_count_capped: false,
        changed_files: Vec::new(),
        deliverables: Vec::new(),
        transferable_files: Vec::new(),
    }
}

fn ensure_workspace_descriptor(
    app: &AppHandle,
    task_id: &str,
) -> Result<WorkspaceDescriptor, String> {
    super::conversations::validate_id(task_id)?;
    let project_id = conversation_project_id(app, task_id)?;
    resolve_task_workspace(app, project_id.as_deref(), Some(task_id), TaskMode::Code)?;
    workspace_runtime(app)?
        .read(task_id)
        .map_err(workspace_error)?
        .ok_or_else(|| "任务工作区尚未创建".into())
}

fn conversation_project_id(app: &AppHandle, task_id: &str) -> Result<Option<String>, String> {
    let conversation = super::conversations::load_conversation(app.clone(), task_id.to_string())?;
    Ok((!conversation.project_id.trim().is_empty()).then_some(conversation.project_id))
}

fn workspace_runtime(app: &AppHandle) -> Result<WorkspaceRuntime, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位数据目录：{error}"))?
        .join("agent-runtime")
        .join("git-workspaces");
    WorkspaceRuntime::open(root).map_err(workspace_error)
}

fn shared_workspace_path(app: &AppHandle, task_id: &str) -> Result<PathBuf, String> {
    super::conversations::task_workspace_path(app, task_id)
}

fn legacy_mode_workspace_path(
    app: &AppHandle,
    task_id: &str,
    task_mode: TaskMode,
) -> Result<PathBuf, String> {
    Ok(super::conversations::task_root(app, task_id)?
        .join("workspaces")
        .join(task_mode.as_str()))
}

fn project_root_for_id(
    app: &AppHandle,
    project_id: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(project_id) = project_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let project = super::projects::find_project(app, project_id)?
        .ok_or_else(|| "找不到任务绑定的项目".to_string())?;
    resolve_project_directory(Path::new(&project.root_path)).map(Some)
}

fn adopt_legacy_workspace(
    app: &AppHandle,
    runtime: &WorkspaceRuntime,
    task_id: &str,
    project_id: Option<&str>,
) -> Result<Option<WorkspaceDescriptor>, String> {
    if let Some(existing) = runtime.read(task_id).map_err(workspace_error)? {
        return Ok(Some(existing));
    }
    let project_root = project_root_for_id(app, project_id)?;
    for candidate in [
        shared_workspace_path(app, task_id)?,
        legacy_mode_workspace_path(app, task_id, TaskMode::Code)?,
        legacy_mode_workspace_path(app, task_id, TaskMode::Work)?,
    ] {
        if !candidate.is_dir() {
            continue;
        }
        let active_root = match project_root.as_deref() {
            Some(project_root) => resolve_existing_project_workspace(project_root, &candidate)?,
            None => canonical_or_original(candidate)?,
        };
        return runtime
            .adopt(task_id, project_root.as_deref(), &active_root)
            .map(Some)
            .map_err(workspace_error);
    }
    Ok(None)
}

fn resolve_existing_project_workspace(
    project_root: &Path,
    workspace: &Path,
) -> Result<PathBuf, String> {
    if workspace.join(".git").exists() {
        if let Some((_, relative_project)) = git_project(project_root) {
            let active = workspace.join(relative_project);
            if active.is_dir() {
                return canonical_or_original(active);
            }
        }
    }
    canonical_or_original(workspace.to_path_buf())
}

fn resolve_project_directory(root: &Path) -> Result<PathBuf, String> {
    if !root.is_dir() {
        return Err("项目文件夹不存在".into());
    }
    dunce::canonicalize(root).map_err(|error| format!("无法解析项目目录：{error}"))
}

fn is_git_directory(root: &Path) -> bool {
    git_output(root, &["rev-parse", "--is-inside-work-tree"])
        .is_ok_and(|value| value.trim() == "true")
}

fn git_project(project_root: &Path) -> Option<(PathBuf, PathBuf)> {
    let output = git_output(project_root, &["rev-parse", "--show-toplevel"]).ok()?;
    let git_root = dunce::canonicalize(output.trim()).ok()?;
    let relative_project = project_root.strip_prefix(&git_root).ok()?.to_path_buf();
    Some((git_root, relative_project))
}

fn git_output(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = crate::process::background_command("git");
    let output = command
        .args(["-C"])
        .arg(root)
        .args(args)
        .output()
        .map_err(|error| format!("无法执行 Git：{error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if message.is_empty() {
            "所选项目不是可用的 Git 仓库".into()
        } else {
            format!("Git 操作失败：{message}")
        })
    }
}

fn checked_relative_path(path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path.trim());
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err("非法的工作区文件路径".into());
    }
    Ok(relative.to_path_buf())
}

fn display_relative_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_deliverable(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "md" | "txt"
            | "pdf"
            | "docx"
            | "xlsx"
            | "pptx"
            | "csv"
            | "html"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "svg"
            | "json"
    )
}

fn canonical_or_original(path: PathBuf) -> Result<PathBuf, String> {
    dunce::canonicalize(&path).map_err(|error| format!("无法解析任务工作区：{error}"))
}

fn workspace_error(error: impl std::fmt::Display) -> String {
    format!("工作区操作失败：{error}")
}

/// Save a final snapshot through agent-git before task deletion. Legacy
/// mode-specific worktrees are also unregistered during migration.
pub(crate) fn cleanup_task_workspaces(app: &AppHandle, project_id: &str, task_root: &Path) {
    if let Some(task_id) = task_root.file_name().and_then(|value| value.to_str()) {
        let state = app.state::<crate::AppState>();
        super::terminal::terminate_task_terminals(&state, task_id);
        if let Ok(runtime) = workspace_runtime(app) {
            let _ = runtime.cleanup(task_id);
        }
    }
    if project_id.is_empty() {
        return;
    }
    let Ok(Some(project)) = super::projects::find_project(app, project_id) else {
        return;
    };
    let project_root = PathBuf::from(project.root_path);
    let git_root = git_project(&project_root)
        .map(|(root, _)| root)
        .unwrap_or(project_root);
    for path in [
        task_root.join("workspace"),
        task_root.join("workspaces").join("work"),
        task_root.join("workspaces").join("code"),
    ] {
        if path.join(".git").exists() {
            remove_git_worktree(&git_root, &path);
        }
    }
    let mut prune = crate::process::background_command("git");
    prune.args(["-C"]).arg(git_root).args(["worktree", "prune"]);
    let _ = prune.status();
}

fn remove_git_worktree(git_root: &Path, workspace: &Path) {
    let mut remove = crate::process::background_command("git");
    remove
        .args(["-C"])
        .arg(git_root)
        .args(["worktree", "remove", "--force"])
        .arg(workspace);
    let _ = remove.status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_modes_are_profiles_not_storage_roots() {
        assert_eq!(TaskMode::Work.as_str(), "work");
        assert_eq!(TaskMode::Code.as_str(), "code");
        assert_eq!(TaskMode::default(), TaskMode::Code);
    }

    #[test]
    fn workspace_paths_and_deliverables_are_strict() {
        assert_eq!(
            checked_relative_path("reports/result.md").unwrap(),
            PathBuf::from("reports/result.md")
        );
        assert!(checked_relative_path("../secret").is_err());
        assert!(checked_relative_path("/tmp/secret").is_err());
        assert!(is_deliverable("reports/result.md"));
        assert!(is_deliverable("data/RESULT.XLSX"));
        assert!(!is_deliverable("src/main.rs"));
    }

    #[test]
    fn missing_project_directory_is_rejected() {
        let root = std::env::temp_dir().join(format!("tietiezhi-missing-{}", uuid::Uuid::new_v4()));
        assert_eq!(
            resolve_project_directory(&root).unwrap_err(),
            "项目文件夹不存在"
        );
    }
}
