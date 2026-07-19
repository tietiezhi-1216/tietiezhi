use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: u64,
    pub last_opened_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProjectsFile {
    version: u32,
    projects: Vec<Project>,
}

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn projects_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录：{e}"))?
        .join("projects.json"))
}

fn read_unlocked(app: &AppHandle) -> Result<Vec<Project>, String> {
    let path = projects_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("读取项目列表失败：{e}"))?;
    let file: ProjectsFile =
        serde_json::from_str(&raw).map_err(|e| format!("项目列表文件损坏：{e}"))?;
    Ok(file.projects)
}

fn write_unlocked(app: &AppHandle, projects: &[Project]) -> Result<(), String> {
    let path = projects_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "项目列表路径无效".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let raw = serde_json::to_string_pretty(&ProjectsFile {
        version: 1,
        projects: projects.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, raw).map_err(|e| format!("写入项目列表失败：{e}"))?;
    if let Err(first) = std::fs::rename(&temp, &path) {
        if cfg!(windows) && path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("替换项目列表失败：{e}"))?;
            std::fs::rename(&temp, &path).map_err(|e| format!("替换项目列表失败：{e}"))?;
        } else {
            return Err(format!("保存项目列表失败：{first}"));
        }
    }
    Ok(())
}

fn canonical_dir(path: &str) -> Result<PathBuf, String> {
    let input = Path::new(path.trim());
    if !input.is_dir() {
        return Err("所选项目文件夹不存在".into());
    }
    dunce::canonicalize(input).map_err(|e| format!("无法解析项目文件夹：{e}"))
}

fn same_path(left: &str, right: &Path) -> bool {
    dunce::canonicalize(left)
        .map(|path| path == right)
        .unwrap_or(false)
}

pub(crate) fn ensure_project_for_path(app: &AppHandle, path: &str) -> Result<Project, String> {
    let canonical = canonical_dir(path)?;
    let _guard = store_lock().lock().map_err(|_| "项目列表锁已损坏")?;
    let mut projects = read_unlocked(app)?;
    if let Some(project) = projects
        .iter_mut()
        .find(|project| same_path(&project.root_path, &canonical))
    {
        project.last_opened_at = now_ms();
        let result = project.clone();
        write_unlocked(app, &projects)?;
        return Ok(result);
    }

    let now = now_ms();
    let name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("项目")
        .to_string();
    let project = Project {
        id: Uuid::new_v4().to_string(),
        name,
        root_path: canonical.to_string_lossy().into_owned(),
        created_at: now,
        last_opened_at: now,
    };
    projects.push(project.clone());
    write_unlocked(app, &projects)?;
    Ok(project)
}

pub(crate) fn find_project(app: &AppHandle, id: &str) -> Result<Option<Project>, String> {
    let _guard = store_lock().lock().map_err(|_| "项目列表锁已损坏")?;
    Ok(read_unlocked(app)?
        .into_iter()
        .find(|project| project.id == id))
}

pub(crate) fn mark_used(app: &AppHandle, id: &str) -> Result<Project, String> {
    let _guard = store_lock().lock().map_err(|_| "项目列表锁已损坏")?;
    let mut projects = read_unlocked(app)?;
    let project = projects
        .iter_mut()
        .find(|project| project.id == id)
        .ok_or_else(|| "项目不存在或已被移除".to_string())?;
    project.last_opened_at = now_ms();
    let result = project.clone();
    write_unlocked(app, &projects)?;
    Ok(result)
}

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<Project>, String> {
    let _guard = store_lock().lock().map_err(|_| "项目列表锁已损坏")?;
    let mut projects = read_unlocked(&app)?;
    projects.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    Ok(projects)
}

#[tauri::command]
pub fn add_project(app: AppHandle, path: String) -> Result<Project, String> {
    ensure_project_for_path(&app, &path)
}

#[tauri::command]
pub fn touch_project(app: AppHandle, id: String) -> Result<Project, String> {
    mark_used(&app, &id)
}

#[tauri::command]
pub fn rename_project(app: AppHandle, id: String, name: String) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("项目名称不能为空".into());
    }
    if name.chars().count() > 80 {
        return Err("项目名称不能超过 80 个字符".into());
    }

    let _guard = store_lock().lock().map_err(|_| "项目列表锁已损坏")?;
    let mut projects = read_unlocked(&app)?;
    let project = projects
        .iter_mut()
        .find(|project| project.id == id)
        .ok_or_else(|| "项目不存在或已被移除".to_string())?;
    project.name = name.to_string();
    let result = project.clone();
    write_unlocked(&app, &projects)?;
    Ok(result)
}

#[tauri::command]
pub fn reveal_project(app: AppHandle, id: String) -> Result<(), String> {
    let project = find_project(&app, &id)?.ok_or_else(|| "项目不存在或已被移除".to_string())?;
    let path = Path::new(&project.root_path);
    if !path.is_dir() {
        return Err("项目文件夹不存在".into());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = crate::process::background_command("open");
        command.arg("-R").arg(path);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = crate::process::background_command("explorer");
        command.arg(path);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = crate::process::background_command("xdg-open");
        command.arg(path);
        command
    };

    let result = command.spawn();

    result
        .map(|_| ())
        .map_err(|e| format!("打开项目文件夹失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_path_rejects_missing_paths() {
        assert!(!same_path("/definitely/missing/project", Path::new("/tmp")));
    }
}
