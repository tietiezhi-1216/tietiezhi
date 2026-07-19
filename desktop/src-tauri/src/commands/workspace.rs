use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Let the user pick a folder for a project or skill import.
/// Returns `None` when the dialog is dismissed.
#[tauri::command]
pub async fn pick_workspace_dir(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let folder = rx.await.map_err(|_| "选择目录失败".to_string())?;
    Ok(folder.map(|p| p.to_string()))
}

pub(crate) fn resolve_task_workspace(
    app: &AppHandle,
    project_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<PathBuf, String> {
    let task_id = task_id.ok_or_else(|| "任务尚未创建".to_string())?;
    let Some(project_id) = project_id.map(str::trim).filter(|id| !id.is_empty()) else {
        let workspace = super::conversations::task_workspace_path(app, task_id)?;
        std::fs::create_dir_all(&workspace).map_err(|e| format!("创建任务工作区失败：{e}"))?;
        return Ok(workspace);
    };

    let project = super::projects::find_project(app, project_id)?
        .ok_or_else(|| "项目不存在或已被移除".to_string())?;
    let project_root = resolve_project_directory(Path::new(&project.root_path))?;
    let _ = super::projects::mark_used(app, project_id);
    Ok(project_root)
}

fn resolve_project_directory(root: &Path) -> Result<PathBuf, String> {
    if !root.is_dir() {
        return Err("项目文件夹不存在".into());
    }
    dunce::canonicalize(root).map_err(|e| format!("无法解析项目目录：{e}"))
}

/// Remove worktrees created by versions that isolated every project task.
/// New project tasks run directly in the selected project directory.
pub(crate) fn cleanup_legacy_task_worktree(app: &AppHandle, project_id: &str, workspace: &Path) {
    if project_id.is_empty() || !workspace.exists() || !workspace.join(".git").exists() {
        return;
    }
    let Ok(Some(project)) = super::projects::find_project(app, project_id) else {
        return;
    };
    let root = PathBuf::from(project.root_path);
    let mut remove = crate::process::background_command("git");
    remove
        .args(["-C"])
        .arg(&root)
        .args(["worktree", "remove", "--force"])
        .arg(workspace);
    let _ = remove.status();

    let mut prune = crate::process::background_command("git");
    prune.args(["-C"]).arg(root).args(["worktree", "prune"]);
    let _ = prune.status();
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn project_directory_does_not_require_git() {
        let root = std::env::temp_dir().join(format!("tietiezhi-project-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested")).unwrap();

        let resolved = resolve_project_directory(&root).unwrap();

        assert_eq!(resolved, dunce::canonicalize(&root).unwrap());
        assert!(!root.join(".git").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_project_directory_is_rejected() {
        let root = std::env::temp_dir().join(format!("tietiezhi-missing-{}", Uuid::new_v4()));

        assert_eq!(
            resolve_project_directory(&root).unwrap_err(),
            "项目文件夹不存在"
        );
    }
}
