use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::model::{
    AutomationDocument, AutomationMeta, AutomationNode, AutomationPosition, AutomationRun,
    AutomationRunStatus, AutomationSettings, MissedSchedulePolicy,
};
use super::validate;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AutomationIndex {
    version: u32,
    automations: Vec<AutomationMeta>,
}

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位数据目录：{error}"))?
        .join("automations"))
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root(app)?.join("index.json"))
}

fn draft_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(root(app)?.join(id).join("draft.json"))
}

fn published_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(root(app)?.join(id).join("published.json"))
}

fn runs_root(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(root(app)?.join(id).join("runs"))
}

fn run_path(app: &AppHandle, automation_id: &str, run_id: &str) -> Result<PathBuf, String> {
    validate_id(run_id)?;
    Ok(runs_root(app, automation_id)?.join(format!("{run_id}.json")))
}

fn validate_id(id: &str) -> Result<(), String> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "Automation ID 无效".to_string())
}

fn read_index(app: &AppHandle) -> Result<AutomationIndex, String> {
    let path = index_path(app)?;
    if !path.exists() {
        return Ok(AutomationIndex {
            version: 1,
            automations: Vec::new(),
        });
    }
    let raw =
        std::fs::read_to_string(path).map_err(|error| format!("读取自动化列表失败：{error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("自动化列表文件损坏：{error}"))
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "自动化存储路径无效".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("创建自动化目录失败：{error}"))?;
    let raw = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, raw).map_err(|error| format!("写入自动化临时文件失败：{error}"))?;
    if let Err(first_error) = std::fs::rename(&temp, path) {
        if cfg!(windows) && path.exists() {
            std::fs::remove_file(path).map_err(|error| format!("替换自动化文件失败：{error}"))?;
            std::fs::rename(&temp, path).map_err(|error| format!("替换自动化文件失败：{error}"))?;
        } else {
            return Err(format!("保存自动化失败：{first_error}"));
        }
    }
    Ok(())
}

fn write_index(app: &AppHandle, index: &AutomationIndex) -> Result<(), String> {
    write_json_atomic(&index_path(app)?, index)
}

fn meta_from_document(
    document: &AutomationDocument,
    existing: Option<&AutomationMeta>,
) -> AutomationMeta {
    let trigger_type = document
        .nodes
        .iter()
        .find(|node| matches!(node.kind.as_str(), "manualTrigger" | "scheduleTrigger"))
        .map(|node| node.kind.clone())
        .unwrap_or_default();
    AutomationMeta {
        id: document.id.clone(),
        name: document.name.clone(),
        description: document.description.clone(),
        revision: document.revision,
        node_count: document.nodes.len(),
        trigger_type,
        created_at: document.created_at,
        updated_at: document.updated_at,
        archived_at: existing.map(|item| item.archived_at).unwrap_or_default(),
        published_revision: existing
            .map(|item| item.published_revision)
            .unwrap_or_default(),
        paused: existing.map(|item| item.paused).unwrap_or(true),
        last_run_at: existing.map(|item| item.last_run_at).unwrap_or_default(),
        next_run_at: existing.map(|item| item.next_run_at).unwrap_or_default(),
        last_run_status: existing
            .map(|item| item.last_run_status.clone())
            .unwrap_or_default(),
    }
}

pub fn list(app: &AppHandle, include_archived: bool) -> Result<Vec<AutomationMeta>, String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    let mut items = read_index(app)?.automations;
    if !include_archived {
        items.retain(|item| item.archived_at == 0);
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    Ok(items)
}

pub fn load(app: &AppHandle, id: &str) -> Result<AutomationDocument, String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    load_document_unlocked(&draft_path(app, id)?)
}

fn load_document_unlocked(path: &Path) -> Result<AutomationDocument, String> {
    if !path.is_file() {
        return Err("Automation 不存在或已被删除".into());
    }
    let raw =
        std::fs::read_to_string(path).map_err(|error| format!("读取 Automation 失败：{error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("Automation 草稿损坏：{error}"))
}

pub fn create(app: &AppHandle, name: &str) -> Result<AutomationDocument, String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    let name = normalized_name(name)?;
    let timestamp = now_ms();
    let id = Uuid::new_v4().to_string();
    let document = AutomationDocument {
        schema_version: 1,
        id: id.clone(),
        name,
        description: String::new(),
        revision: 0,
        nodes: vec![AutomationNode {
            id: Uuid::new_v4().to_string(),
            kind: "manualTrigger".into(),
            type_version: 1,
            name: "手动触发".into(),
            position: AutomationPosition { x: 96.0, y: 180.0 },
            disabled: false,
            config: json!({}),
            inputs: Default::default(),
        }],
        edges: Vec::new(),
        settings: AutomationSettings {
            timezone: "Asia/Shanghai".into(),
            max_duration_ms: 300_000,
            max_concurrency: 4,
            on_missed_schedule: MissedSchedulePolicy::Skip,
            project_root: None,
        },
        created_at: timestamp,
        updated_at: timestamp,
    };
    write_json_atomic(&draft_path(app, &id)?, &document)?;

    let mut index = read_index(app)?;
    index.version = 1;
    index.automations.push(meta_from_document(&document, None));
    if let Err(error) = write_index(app, &index) {
        let _ = std::fs::remove_dir_all(root(app)?.join(&id));
        return Err(error);
    }
    Ok(document)
}

pub fn save(
    app: &AppHandle,
    mut document: AutomationDocument,
) -> Result<AutomationDocument, String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    validate_id(&document.id)?;
    let name = normalized_name(&document.name)?;
    let path = draft_path(app, &document.id)?;
    if !path.is_file() {
        return Err("Automation 不存在或已被删除".into());
    }
    document.name = name;
    let issues = validate::validate(&document, false);
    if let Some(first) = issues.first() {
        return Err(first.message.clone());
    }

    let mut index = read_index(app)?;
    let existing = index
        .automations
        .iter()
        .find(|item| item.id == document.id)
        .cloned()
        .ok_or_else(|| "自动化索引与草稿不一致".to_string())?;
    document.created_at = existing.created_at;
    document.updated_at = now_ms();
    write_json_atomic(&path, &document)?;
    if let Some(slot) = index
        .automations
        .iter_mut()
        .find(|item| item.id == document.id)
    {
        *slot = meta_from_document(&document, Some(&existing));
    }
    write_index(app, &index)?;
    Ok(document)
}

pub fn archive(app: &AppHandle, id: &str, archived: bool) -> Result<AutomationMeta, String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    validate_id(id)?;
    let mut index = read_index(app)?;
    let item = index
        .automations
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| "Automation 不存在或已被删除".to_string())?;
    item.archived_at = if archived { now_ms() } else { 0 };
    let result = item.clone();
    write_index(app, &index)?;
    Ok(result)
}

pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    validate_id(id)?;
    let mut index = read_index(app)?;
    if !index.automations.iter().any(|item| item.id == id) {
        return Err("Automation 不存在或已被删除".into());
    }
    index.automations.retain(|item| item.id != id);
    write_index(app, &index)?;
    let directory = root(app)?.join(id);
    if directory.exists() {
        std::fs::remove_dir_all(directory)
            .map_err(|error| format!("删除 Automation 文件失败：{error}"))?;
    }
    Ok(())
}

pub fn publish(app: &AppHandle, id: &str, next_run_at: u64) -> Result<AutomationMeta, String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    let mut document = load_document_unlocked(&draft_path(app, id)?)?;
    let issues = validate::validate(&document, true);
    if let Some(issue) = issues.first() {
        return Err(issue.message.clone());
    }
    let mut index = read_index(app)?;
    let item = index
        .automations
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| "Automation 不存在或已被删除".to_string())?;
    document.revision = document.revision.saturating_add(1).max(1);
    document.updated_at = now_ms();
    write_json_atomic(&draft_path(app, id)?, &document)?;
    write_json_atomic(&published_path(app, id)?, &document)?;
    let existing = item.clone();
    *item = meta_from_document(&document, Some(&existing));
    item.published_revision = document.revision;
    item.paused = false;
    item.next_run_at = next_run_at;
    let result = item.clone();
    write_index(app, &index)?;
    Ok(result)
}

pub fn set_paused(
    app: &AppHandle,
    id: &str,
    paused: bool,
    next_run_at: u64,
) -> Result<AutomationMeta, String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    validate_id(id)?;
    let mut index = read_index(app)?;
    let item = index
        .automations
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| "Automation 不存在或已被删除".to_string())?;
    if item.published_revision == 0 {
        return Err("Automation 尚未发布".into());
    }
    item.paused = paused;
    item.next_run_at = if paused { 0 } else { next_run_at };
    let result = item.clone();
    write_index(app, &index)?;
    Ok(result)
}

pub fn load_published(app: &AppHandle, id: &str) -> Result<AutomationDocument, String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    let path = published_path(app, id)?;
    if !path.is_file() {
        return Err("Automation 尚未发布".into());
    }
    load_document_unlocked(&path)
}

pub fn save_run(app: &AppHandle, run: &AutomationRun) -> Result<(), String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    if !read_index(app)?
        .automations
        .iter()
        .any(|item| item.id == run.automation_id)
    {
        return Err("Automation 不存在或已被删除".into());
    }
    write_json_atomic(&run_path(app, &run.automation_id, &run.id)?, run)
}

pub fn load_run(
    app: &AppHandle,
    automation_id: &str,
    run_id: &str,
) -> Result<AutomationRun, String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    read_run_unlocked(&run_path(app, automation_id, run_id)?)
}

fn read_run_unlocked(path: &Path) -> Result<AutomationRun, String> {
    let raw =
        std::fs::read_to_string(path).map_err(|error| format!("读取运行记录失败：{error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("运行记录损坏：{error}"))
}

pub fn list_runs(
    app: &AppHandle,
    automation_id: Option<&str>,
    limit: usize,
) -> Result<Vec<AutomationRun>, String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    let index = read_index(app)?;
    if let Some(id) = automation_id {
        validate_id(id)?;
    }
    let ids = index
        .automations
        .iter()
        .filter(|item| automation_id.is_none_or(|id| item.id == id))
        .map(|item| item.id.as_str())
        .collect::<Vec<_>>();
    let mut runs = Vec::new();
    for id in ids {
        let directory = runs_root(app, id)?;
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("读取运行记录目录失败：{error}")),
        };
        for entry in entries {
            let entry = entry.map_err(|error| format!("读取运行记录失败：{error}"))?;
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            if let Ok(run) = read_run_unlocked(&entry.path()) {
                runs.push(run);
            }
        }
    }
    runs.sort_by_key(|run| std::cmp::Reverse(run.started_at));
    runs.truncate(limit.clamp(1, 500));
    Ok(runs)
}

pub fn finish_run(
    app: &AppHandle,
    automation_id: &str,
    run_id: &str,
    status: AutomationRunStatus,
    output: Option<String>,
    error: Option<String>,
) -> Result<AutomationRun, String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    let path = run_path(app, automation_id, run_id)?;
    let mut run = read_run_unlocked(&path)?;
    run.status = status;
    run.finished_at = now_ms();
    run.output = output;
    run.error = error;
    write_json_atomic(&path, &run)?;
    let mut index = read_index(app)?;
    if let Some(item) = index
        .automations
        .iter_mut()
        .find(|item| item.id == automation_id)
    {
        item.last_run_at = run.finished_at;
        item.last_run_status = serde_json::to_value(status)
            .unwrap_or(Value::String("failed".into()))
            .as_str()
            .unwrap_or("failed")
            .to_owned();
    }
    write_index(app, &index)?;
    Ok(run)
}

pub fn update_next_run(
    app: &AppHandle,
    automation_id: &str,
    next_run_at: u64,
) -> Result<(), String> {
    let _guard = store_lock().lock().map_err(|_| "自动化存储锁已损坏")?;
    let mut index = read_index(app)?;
    let item = index
        .automations
        .iter_mut()
        .find(|item| item.id == automation_id)
        .ok_or_else(|| "Automation 不存在或已被删除".to_string())?;
    item.next_run_at = next_run_at;
    write_index(app, &index)
}

pub fn run_workspace_path(
    app: &AppHandle,
    automation_id: &str,
    run_id: &str,
) -> Result<PathBuf, String> {
    validate_id(automation_id)?;
    validate_id(run_id)?;
    Ok(root(app)?
        .join(automation_id)
        .join("runs")
        .join(run_id)
        .join("workspace"))
}

fn normalized_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Ok("未命名自动化".into());
    }
    if name.chars().count() > 80 {
        return Err("名称不能超过 80 个字符".into());
    }
    Ok(name.into())
}
