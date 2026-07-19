use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const DEFAULT_CONVERSATION_TITLE: &str = "新会话";

/// One persisted transcript item. Legacy assistant failures used `error`;
/// current files store them as a dedicated `kind: "error"` item.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    /// "message" (default, legacy files omit it) | "toolCall" | "permission" | "error".
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub error: bool,
    /// When the message was created (ms since epoch). 0 for conversations
    /// written before messages carried timestamps, so the UI hides the age.
    #[serde(default)]
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_args: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub usage_estimated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_token_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_status: Option<u16>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub error_retryable: bool,
    #[serde(default, skip_serializing_if = "is_zero_u8")]
    pub error_retries: u8,
}

fn default_kind() -> String {
    "message".into()
}

fn is_zero_u8(value: &u8) -> bool {
    *value == 0
}

/// One task transcript stored under `app_data_dir()/tasks/{id}/task.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub messages: Vec<StoredMessage>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent_id: String,
    /// Empty means a standalone task with its own managed workspace.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_id: String,
    /// Zero means active; otherwise the time this task was archived.
    #[serde(default)]
    pub archived_at: u64,
    /// Zero means unpinned; otherwise the time this task was pinned.
    #[serde(default)]
    pub pinned_at: u64,
    /// Legacy pre-project workspace path, retained only while migrating.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workspace: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMeta {
    pub id: String,
    pub title: String,
    pub updated_at: u64,
    pub project_id: String,
    pub archived_at: u64,
    pub pinned_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConversationResult {
    pub updated_at: u64,
    pub title: String,
}

fn preserve_generated_title(incoming: &mut String, existing: &str) {
    if incoming == DEFAULT_CONVERSATION_TITLE && existing != DEFAULT_CONVERSATION_TITLE {
        *incoming = existing.into();
    }
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

pub(crate) fn validate_id(id: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| "非法的任务 ID".to_string())?;
    if parsed.hyphenated().to_string() == id.to_ascii_lowercase() {
        Ok(())
    } else {
        Err("非法的任务 ID".into())
    }
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录：{e}"))
}

fn tasks_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("tasks");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建任务目录失败：{e}"))?;
    Ok(dir)
}

fn legacy_conversations_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("conversations"))
}

pub(crate) fn task_root(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(tasks_dir(app)?.join(id))
}

pub(crate) fn task_workspace_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(task_root(app, id)?.join("workspace"))
}

fn conversation_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(task_root(app, id)?.join("task.json"))
}

fn write_conversation(path: &PathBuf, conversation: &Conversation) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "任务路径无效".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建任务目录失败：{e}"))?;
    let raw = serde_json::to_string_pretty(conversation).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, raw).map_err(|e| format!("写入任务失败：{e}"))?;
    if let Err(first) = std::fs::rename(&temp, path) {
        if cfg!(windows) && path.exists() {
            std::fs::remove_file(path).map_err(|e| format!("替换任务记录失败：{e}"))?;
            std::fs::rename(&temp, path).map_err(|e| format!("替换任务记录失败：{e}"))?;
        } else {
            return Err(format!("保存任务失败：{first}"));
        }
    }
    Ok(())
}

/// Move legacy `conversations/{id}.json` + `workspaces/{id}` into the task
/// directory. Existing picked workspaces become projects when still present.
fn migrate_legacy(app: &AppHandle) -> Result<(), String> {
    let legacy_dir = legacy_conversations_dir(app)?;
    if !legacy_dir.exists() {
        return Ok(());
    }
    let entries = std::fs::read_dir(&legacy_dir).map_err(|e| format!("读取旧对话目录失败：{e}"))?;
    for entry in entries.flatten() {
        let old_path = entry.path();
        if old_path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = old_path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if validate_id(id).is_err() {
            continue;
        }
        let new_path = conversation_path(app, id)?;
        if new_path.exists() {
            let _ = std::fs::remove_file(&old_path);
            continue;
        }

        let raw = match std::fs::read_to_string(&old_path) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let mut conversation: Conversation = match serde_json::from_str(&raw) {
            Ok(conversation) => conversation,
            Err(_) => continue,
        };
        if conversation.project_id.is_empty() && !conversation.workspace.trim().is_empty() {
            if let Ok(project) =
                super::projects::ensure_project_for_path(app, &conversation.workspace)
            {
                conversation.project_id = project.id;
                conversation.workspace.clear();
            }
        }

        let old_workspace = app_data_dir(app)?.join("workspaces").join(id);
        let new_workspace = task_workspace_path(app, id)?;
        if old_workspace.exists() && !new_workspace.exists() {
            if let Some(parent) = new_workspace.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("迁移任务目录失败：{e}"))?;
            }
            std::fs::rename(&old_workspace, &new_workspace)
                .map_err(|e| format!("迁移任务工作区失败：{e}"))?;
        }

        write_conversation(&new_path, &conversation)?;
        std::fs::remove_file(&old_path).map_err(|e| format!("清理旧对话记录失败：{e}"))?;
    }
    Ok(())
}

fn with_store<T>(
    app: &AppHandle,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = store_lock().lock().map_err(|_| "任务存储锁已损坏")?;
    migrate_legacy(app)?;
    operation()
}

fn list_conversation_metas(
    app: &AppHandle,
    archived: bool,
) -> Result<Vec<ConversationMeta>, String> {
    let entries =
        std::fs::read_dir(tasks_dir(app)?).map_err(|e| format!("读取任务目录失败：{e}"))?;
    let mut metas = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path().join("task.json");
        if !path.is_file() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(conversation) = serde_json::from_str::<Conversation>(&raw) else {
            continue;
        };
        if (conversation.archived_at != 0) != archived {
            continue;
        }
        metas.push(ConversationMeta {
            id: conversation.id,
            title: conversation.title,
            updated_at: conversation.updated_at,
            project_id: conversation.project_id,
            archived_at: conversation.archived_at,
            pinned_at: conversation.pinned_at,
        });
    }
    if archived {
        metas.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    } else {
        metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    }
    Ok(metas)
}

#[tauri::command]
pub fn list_conversations(app: AppHandle) -> Result<Vec<ConversationMeta>, String> {
    with_store(&app, || list_conversation_metas(&app, false))
}

#[tauri::command]
pub fn list_archived_conversations(app: AppHandle) -> Result<Vec<ConversationMeta>, String> {
    with_store(&app, || list_conversation_metas(&app, true))
}

#[tauri::command]
pub fn load_conversation(app: AppHandle, id: String) -> Result<Conversation, String> {
    with_store(&app, || {
        let raw = std::fs::read_to_string(conversation_path(&app, &id)?)
            .map_err(|e| format!("读取任务失败：{e}"))?;
        serde_json::from_str(&raw).map_err(|e| format!("任务文件损坏：{e}"))
    })
}

#[tauri::command]
pub fn save_conversation(
    app: AppHandle,
    mut conversation: Conversation,
) -> Result<SaveConversationResult, String> {
    with_store(&app, || {
        let path = conversation_path(&app, &conversation.id)?;
        if conversation.title.trim().is_empty() {
            conversation.title = DEFAULT_CONVERSATION_TITLE.into();
        }
        if !conversation.project_id.is_empty()
            && super::projects::find_project(&app, &conversation.project_id)?.is_none()
        {
            return Err("任务关联的项目不存在".into());
        }
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(existing) = serde_json::from_str::<Conversation>(&raw) {
                conversation.archived_at = existing.archived_at;
                conversation.pinned_at = existing.pinned_at;
                preserve_generated_title(&mut conversation.title, &existing.title);
            }
        }
        conversation.workspace.clear();
        conversation.updated_at = now_ms();
        write_conversation(&path, &conversation)?;
        Ok(SaveConversationResult {
            updated_at: conversation.updated_at,
            title: conversation.title,
        })
    })
}

pub(crate) fn set_generated_title(
    app: &AppHandle,
    id: &str,
    title: &str,
) -> Result<Option<String>, String> {
    let title = title.trim();
    if title.is_empty() || title == DEFAULT_CONVERSATION_TITLE {
        return Ok(None);
    }
    with_store(app, || {
        let path = conversation_path(app, id)?;
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("读取任务失败：{error}")),
        };
        let mut conversation: Conversation =
            serde_json::from_str(&raw).map_err(|error| format!("任务文件损坏：{error}"))?;
        if conversation.title != DEFAULT_CONVERSATION_TITLE || conversation.archived_at != 0 {
            return Ok(None);
        }
        conversation.title = title.into();
        write_conversation(&path, &conversation)?;
        Ok(Some(conversation.title))
    })
}

fn set_archived_at(app: &AppHandle, id: &str, archived_at: u64) -> Result<(), String> {
    let path = conversation_path(app, id)?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取任务失败：{e}"))?;
    let mut conversation: Conversation =
        serde_json::from_str(&raw).map_err(|e| format!("任务文件损坏：{e}"))?;
    conversation.archived_at = archived_at;
    if archived_at == 0 {
        conversation.updated_at = now_ms();
    }
    write_conversation(&path, &conversation)
}

#[tauri::command]
pub fn archive_conversation(app: AppHandle, id: String) -> Result<(), String> {
    with_store(&app, || set_archived_at(&app, &id, now_ms()))
}

#[tauri::command]
pub fn restore_conversation(app: AppHandle, id: String) -> Result<(), String> {
    with_store(&app, || set_archived_at(&app, &id, 0))
}

#[tauri::command]
pub fn set_conversation_pinned(app: AppHandle, id: String, pinned: bool) -> Result<u64, String> {
    with_store(&app, || {
        let path = conversation_path(&app, &id)?;
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取任务失败：{e}"))?;
        let mut conversation: Conversation =
            serde_json::from_str(&raw).map_err(|e| format!("任务文件损坏：{e}"))?;
        conversation.pinned_at = if pinned { now_ms() } else { 0 };
        write_conversation(&path, &conversation)?;
        Ok(conversation.pinned_at)
    })
}

#[tauri::command]
pub fn archive_project_conversations(app: AppHandle, project_id: String) -> Result<u64, String> {
    with_store(&app, || {
        let entries =
            std::fs::read_dir(tasks_dir(&app)?).map_err(|e| format!("读取任务目录失败：{e}"))?;
        let archived_at = now_ms();
        let mut count = 0;
        for entry in entries.flatten() {
            let path = entry.path().join("task.json");
            if !path.is_file() {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(mut conversation) = serde_json::from_str::<Conversation>(&raw) else {
                continue;
            };
            if conversation.project_id != project_id || conversation.archived_at != 0 {
                continue;
            }
            conversation.archived_at = archived_at;
            write_conversation(&path, &conversation)?;
            count += 1;
        }
        Ok(count)
    })
}

#[tauri::command]
pub fn delete_conversation(app: AppHandle, id: String) -> Result<(), String> {
    with_store(&app, || {
        let root = task_root(&app, &id)?;
        if !root.exists() {
            return Ok(());
        }
        let project_id = std::fs::read_to_string(root.join("task.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<Conversation>(&raw).ok())
            .map(|conversation| conversation.project_id)
            .unwrap_or_default();
        super::workspace::cleanup_legacy_task_worktree(&app, &project_id, &root.join("workspace"));
        std::fs::remove_dir_all(root).map_err(|e| format!("删除任务失败：{e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_id_accepts_uuid() {
        assert!(validate_id("3fa85f64-5717-4562-b3fc-2c963f66afa6").is_ok());
    }

    #[test]
    fn validate_id_rejects_path_escapes_and_non_uuid_values() {
        assert!(validate_id("").is_err());
        assert!(validate_id("../evil").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("not-a-uuid").is_err());
    }

    #[test]
    fn stored_message_created_at_defaults_for_legacy_data() {
        let json = r#"{"role":"user","content":"你好"}"#;
        let msg: StoredMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.created_at, 0);
        assert_eq!(msg.kind, "message");

        let json = r#"{"role":"user","content":"你好","createdAt":1784110000000}"#;
        let msg: StoredMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.created_at, 1_784_110_000_000);
    }

    #[test]
    fn stored_message_error_flag_roundtrips_and_defaults() {
        let json = r#"{"role":"assistant","content":"hi"}"#;
        let msg: StoredMessage = serde_json::from_str(json).unwrap();
        assert!(!msg.error);
        let out = serde_json::to_string(&msg).unwrap();
        assert!(!out.contains("error"));
    }

    #[test]
    fn server_managed_fields_default_for_legacy_conversations() {
        let json = r#"{"id":"3fa85f64-5717-4562-b3fc-2c963f66afa6","title":"旧任务"}"#;
        let conversation: Conversation = serde_json::from_str(json).unwrap();
        assert_eq!(conversation.archived_at, 0);
        assert_eq!(conversation.pinned_at, 0);
    }

    #[test]
    fn tool_call_messages_roundtrip() {
        let json = r#"{"kind":"toolCall","toolName":"read_file","toolCallId":"c1","toolArgs":{"path":"a.txt"},"toolOutput":"hello","createdAt":1}"#;
        let msg: StoredMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.kind, "toolCall");
        assert_eq!(msg.tool_name.as_deref(), Some("read_file"));
        let out = serde_json::to_string(&msg).unwrap();
        assert!(out.contains("\"toolName\":\"read_file\""));
        let plain: StoredMessage =
            serde_json::from_str(r#"{"role":"user","content":"hi"}"#).unwrap();
        let out = serde_json::to_string(&plain).unwrap();
        assert!(!out.contains("toolName"));
    }

    #[test]
    fn structured_error_messages_roundtrip() {
        let json = r#"{"kind":"error","content":"模型服务暂时不可用","errorDetail":"HTTP 503\nfull body","errorCode":"do_request_failed","errorStatus":503,"errorRetryable":true,"errorRetries":5,"createdAt":1}"#;
        let message: StoredMessage = serde_json::from_str(json).unwrap();
        assert_eq!(message.kind, "error");
        assert_eq!(message.error_status, Some(503));
        assert_eq!(message.error_retries, 5);
        assert!(message.error_retryable);
        let output = serde_json::to_string(&message).unwrap();
        assert!(output.contains("\"errorDetail\":\"HTTP 503\\nfull body\""));
        assert!(output.contains("\"errorRetries\":5"));
    }

    #[test]
    fn generated_title_is_not_overwritten_by_stale_default() {
        let mut incoming = DEFAULT_CONVERSATION_TITLE.to_string();
        preserve_generated_title(&mut incoming, "规划项目目录架构");
        assert_eq!(incoming, "规划项目目录架构");

        let mut explicit = "用户命名".to_string();
        preserve_generated_title(&mut explicit, "AI 标题");
        assert_eq!(explicit, "用户命名");
    }
}
