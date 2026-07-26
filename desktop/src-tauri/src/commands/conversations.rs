use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tietiezhi_agent_core::{LegacyThreadImport, ThreadManager};
use tietiezhi_agent_state::{atomic_write, RolloutRecovery, StateStore, ThreadMetadata};

use super::workspace::TaskMode;
use crate::agent::events::{ChatEvent, ScopedChatEvent};

pub const DEFAULT_CONVERSATION_TITLE: &str = "新会话";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAttachment {
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub size: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub data_url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text_content: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// One persisted transcript item. Legacy assistant failures used `error`;
/// current files store them as a dedicated `kind: "error"` item.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    /// "message" (default, legacy files omit it) | "toolCall" | "permission" | "error".
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub content: String,
    /// Reasoning / chain-of-thought from reasoning models, shown collapsed above
    /// the answer. Display-only; never replayed to the model.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reasoning: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<StoredAttachment>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub error: bool,
    /// When the message was created (ms since epoch). 0 for conversations
    /// written before messages carried timestamps, so the UI hides the age.
    #[serde(default)]
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_args: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tool_timed_out: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tool_truncated: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_permission_decision"
    )]
    pub decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_scope: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u64>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_automatic: Option<bool>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub context_during_turn: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens_before: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens_after: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

fn deserialize_permission_decision<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let decision = Option::<String>::deserialize(deserializer)?;
    Ok(decision.map(|value| match value.as_str() {
        "allow" => "accept".to_string(),
        "allowAlways" => "acceptForSession".to_string(),
        "deny" => "decline".to_string(),
        _ => value,
    }))
}

fn default_kind() -> String {
    "message".into()
}

fn is_zero_u8(value: &u8) -> bool {
    *value == 0
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

/// One task transcript stored under `app_data_dir()/tasks/{id}/task.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub messages: Vec<StoredMessage>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent_id: String,
    /// Empty means a standalone task with its own managed workspace.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_id: String,
    /// Work and Code share this transcript but resolve different writable roots.
    #[serde(default)]
    pub task_mode: TaskMode,
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
    pub created_at: u64,
    pub updated_at: u64,
    pub project_id: String,
    pub task_mode: TaskMode,
    pub archived_at: u64,
    pub pinned_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SuggestionTaskDigest {
    pub id: String,
    pub title: String,
    pub updated_at: u64,
    pub opening_request: String,
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SuggestionHistory {
    pub total_tasks: usize,
    pub recent_tasks: Vec<SuggestionTaskDigest>,
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

fn rollout_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(task_root(app, id)?.join("rollout.jsonl"))
}

fn state_store(app: &AppHandle) -> Result<StateStore, String> {
    StateStore::open(app_data_dir(app)?.join("agent-runtime"))
        .map_err(|error| format!("初始化任务状态库失败：{error}"))
}

fn write_conversation(path: &Path, conversation: &Conversation) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(conversation).map_err(|e| e.to_string())?;
    atomic_write(path, raw.as_bytes()).map_err(|error| format!("原子写入任务失败：{error}"))
}

fn conversation_created_at(conversation: &Conversation) -> u64 {
    if conversation.created_at > 0 {
        return conversation.created_at;
    }
    conversation
        .messages
        .iter()
        .filter_map(|message| (message.created_at > 0).then_some(message.created_at))
        .min()
        .unwrap_or(conversation.updated_at)
}

fn conversation_preview(conversation: &Conversation) -> String {
    conversation
        .messages
        .iter()
        .find(|message| {
            message.kind == "message"
                && message.role == "user"
                && !message.content.trim().is_empty()
        })
        .map(|message| compact_excerpt(&message.content, 180))
        .unwrap_or_default()
}

fn metadata_for(
    conversation: &Conversation,
    path: PathBuf,
    revision: u64,
    last_complete_ordinal: u64,
    recovery_status: &str,
) -> ThreadMetadata {
    ThreadMetadata {
        id: conversation.id.clone(),
        rollout_path: path,
        created_at_ms: conversation_created_at(conversation),
        updated_at_ms: conversation.updated_at,
        title: conversation.title.clone(),
        project_id: conversation.project_id.clone(),
        task_mode: conversation.task_mode.as_str().into(),
        archived_at_ms: conversation.archived_at,
        pinned_at_ms: conversation.pinned_at,
        agent_id: conversation.agent_id.clone(),
        preview: conversation_preview(conversation),
        revision,
        last_complete_ordinal,
        recovery_status: recovery_status.into(),
        canonical: None,
    }
}

fn persist_conversation(
    app: &AppHandle,
    store: &StateStore,
    conversation: &Conversation,
) -> Result<(), String> {
    if let Some(mut metadata) = store
        .thread(&conversation.id)
        .map_err(|error| format!("读取任务索引失败：{error}"))?
        .filter(|metadata| metadata.canonical.is_some())
    {
        metadata.created_at_ms = conversation_created_at(conversation);
        metadata.updated_at_ms = conversation.updated_at;
        metadata.title = conversation.title.clone();
        metadata.project_id = conversation.project_id.clone();
        metadata.task_mode = conversation.task_mode.as_str().into();
        metadata.archived_at_ms = conversation.archived_at;
        metadata.pinned_at_ms = conversation.pinned_at;
        metadata.agent_id = conversation.agent_id.clone();
        metadata.preview = conversation_preview(conversation);
        store
            .upsert_metadata(&metadata)
            .map_err(|error| format!("更新 Codex 任务索引失败：{error}"))?;
        return write_conversation(&conversation_path(app, &conversation.id)?, conversation);
    }

    let path = rollout_path(app, &conversation.id)?;
    let payload = serde_json::to_value(conversation)
        .map_err(|error| format!("序列化任务 checkpoint 失败：{error}"))?;
    let mut metadata = metadata_for(conversation, path, 0, 0, "clean");
    metadata.canonical = store
        .thread(&conversation.id)
        .map_err(|error| format!("读取任务索引失败：{error}"))?
        .and_then(|existing| existing.canonical);
    store
        .upsert_checkpoint(metadata, &payload)
        .map_err(|error| format!("写入任务 rollout 失败：{error}"))?;
    write_conversation(&conversation_path(app, &conversation.id)?, conversation)
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

fn task_mode_from_store(value: &str) -> Result<TaskMode, String> {
    match value {
        "work" => Ok(TaskMode::Work),
        "code" => Ok(TaskMode::Code),
        _ => Err(format!("任务索引包含非法模式：{value}")),
    }
}

fn read_task_json(path: &Path) -> Option<Conversation> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn conversation_from_recovery(
    recovery: &RolloutRecovery,
    expected_id: &str,
) -> Option<Conversation> {
    let checkpoint = recovery
        .checkpoint
        .as_ref()
        .filter(|checkpoint| checkpoint.thread_id == expected_id)?;
    let conversation: Conversation = serde_json::from_value(checkpoint.payload.clone()).ok()?;
    (conversation.id == expected_id).then_some(conversation)
}

fn set_event_identity(message: &mut StoredMessage, event: &ScopedChatEvent, reasoning: bool) {
    message.thread_id = Some(event.thread_id.clone());
    message.turn_id = Some(event.turn_id.clone());
    if reasoning {
        message.reasoning_item_id = Some(event.item_id.clone());
    } else {
        message.item_id = Some(event.item_id.clone());
    }
}

fn assistant_message_index(
    conversation: &Conversation,
    event: &ScopedChatEvent,
    reasoning: bool,
) -> Option<usize> {
    conversation
        .messages
        .iter()
        .position(|message| {
            let identity = if reasoning {
                message.reasoning_item_id.as_deref()
            } else {
                message.item_id.as_deref()
            };
            message.kind == "message"
                && message.role == "assistant"
                && identity == Some(event.item_id.as_str())
        })
        .or_else(|| {
            conversation.messages.iter().rposition(|message| {
                message.kind == "message"
                    && message.role == "assistant"
                    && message.turn_id.as_deref() == Some(event.turn_id.as_str())
                    && if reasoning {
                        message.reasoning_item_id.is_none()
                    } else {
                        message.item_id.is_none()
                    }
            })
        })
}

fn ensure_assistant_message(
    conversation: &mut Conversation,
    event: &ScopedChatEvent,
    reasoning: bool,
) -> usize {
    if let Some(index) = assistant_message_index(conversation, event, reasoning) {
        return index;
    }
    let mut message = StoredMessage {
        kind: "message".into(),
        role: "assistant".into(),
        created_at: event.emitted_at_ms,
        ..StoredMessage::default()
    };
    set_event_identity(&mut message, event, reasoning);
    conversation.messages.push(message);
    conversation.messages.len() - 1
}

fn apply_rollout_event(conversation: &mut Conversation, event: &ScopedChatEvent) {
    if event.thread_id != conversation.id {
        return;
    }
    conversation.updated_at = conversation.updated_at.max(event.emitted_at_ms);
    match &event.payload {
        ChatEvent::Started { .. }
        | ChatEvent::Retrying { .. }
        | ChatEvent::ContextCompactionStarted { .. }
        | ChatEvent::ContextUsage { .. } => {}
        ChatEvent::Delta { content } => {
            let index = ensure_assistant_message(conversation, event, false);
            let message = &mut conversation.messages[index];
            set_event_identity(message, event, false);
            message.content.push_str(content);
        }
        ChatEvent::Reasoning { content } => {
            let index = ensure_assistant_message(conversation, event, true);
            let message = &mut conversation.messages[index];
            set_event_identity(message, event, true);
            message.reasoning.push_str(content);
        }
        ChatEvent::Usage {
            prompt_tokens,
            completion_tokens,
            total_tokens,
            cached_tokens,
        } => {
            let index = ensure_assistant_message(conversation, event, false);
            let message = &mut conversation.messages[index];
            message.prompt_tokens = Some(*prompt_tokens);
            message.completion_tokens = Some(*completion_tokens);
            message.total_tokens = Some(*total_tokens);
            message.cached_tokens = Some(*cached_tokens);
            message.usage_estimated = false;
        }
        ChatEvent::ToolCallStart { id, name, args, .. } => {
            if conversation.messages.iter().any(|message| {
                message.kind == "toolCall"
                    && (message.item_id.as_deref() == Some(event.item_id.as_str())
                        || message.tool_call_id.as_deref() == Some(id.as_str()))
            }) {
                return;
            }
            let mut message = StoredMessage {
                kind: "toolCall".into(),
                created_at: event.emitted_at_ms,
                tool_name: Some(name.clone()),
                tool_call_id: Some(id.clone()),
                tool_args: Some(args.clone()),
                tool_status: Some("running".into()),
                ..StoredMessage::default()
            };
            set_event_identity(&mut message, event, false);
            conversation.messages.push(message);
        }
        ChatEvent::ToolProgress {
            id,
            output,
            elapsed_ms,
            truncated,
        } => {
            if let Some(message) = conversation.messages.iter_mut().find(|message| {
                message.kind == "toolCall"
                    && (message.item_id.as_deref() == Some(event.item_id.as_str())
                        || message.tool_call_id.as_deref() == Some(id.as_str()))
            }) {
                set_event_identity(message, event, false);
                message.tool_output = Some(output.clone());
                message.tool_duration_ms = Some(*elapsed_ms);
                message.tool_truncated = *truncated;
            }
        }
        ChatEvent::ToolResult {
            id,
            output,
            is_error,
            duration_ms,
            exit_code,
            timed_out,
            cancelled,
            truncated,
        } => {
            if let Some(message) = conversation.messages.iter_mut().find(|message| {
                message.kind == "toolCall"
                    && (message.item_id.as_deref() == Some(event.item_id.as_str())
                        || message.tool_call_id.as_deref() == Some(id.as_str()))
            }) {
                set_event_identity(message, event, false);
                message.tool_output = Some(output.clone());
                message.tool_status = Some(
                    if *cancelled {
                        "cancelled"
                    } else if *is_error {
                        "error"
                    } else {
                        "success"
                    }
                    .into(),
                );
                message.tool_duration_ms = Some(*duration_ms);
                message.tool_exit_code = *exit_code;
                message.tool_timed_out = *timed_out;
                message.tool_truncated = *truncated;
                message.error = *is_error;
            }
        }
        ChatEvent::PermissionRequest {
            id,
            tool,
            description,
            scope,
            args,
        } => {
            if conversation.messages.iter().any(|message| {
                message.kind == "permission"
                    && message.permission_request_id.as_deref() == Some(id.as_str())
            }) {
                return;
            }
            let mut message = StoredMessage {
                kind: "permission".into(),
                content: description.clone(),
                created_at: event.emitted_at_ms,
                tool_name: Some(tool.clone()),
                permission_request_id: Some(id.clone()),
                tool_args: Some(args.clone()),
                permission_scope: Some(scope.clone()),
                ..StoredMessage::default()
            };
            set_event_identity(&mut message, event, false);
            conversation.messages.push(message);
        }
        ChatEvent::ContextCompacted {
            automatic,
            during_turn,
            summary,
            estimated_tokens_before,
            estimated_tokens_after,
            context_window,
        } => {
            if conversation.messages.iter().any(|message| {
                message.kind == "context"
                    && message.item_id.as_deref() == Some(event.item_id.as_str())
            }) {
                return;
            }
            let mut message = StoredMessage {
                kind: "context".into(),
                created_at: event.emitted_at_ms,
                context_action: Some("compaction".into()),
                context_summary: Some(summary.clone()),
                context_automatic: Some(*automatic),
                context_during_turn: *during_turn,
                context_tokens_before: Some(*estimated_tokens_before),
                context_tokens_after: Some(*estimated_tokens_after),
                context_window: Some(*context_window),
                ..StoredMessage::default()
            };
            set_event_identity(&mut message, event, false);
            conversation.messages.push(message);
        }
        ChatEvent::Done { cancelled } => {
            if *cancelled {
                for message in &mut conversation.messages {
                    if message.kind == "toolCall"
                        && message.tool_status.as_deref() == Some("running")
                    {
                        message.tool_status = Some("cancelled".into());
                    }
                }
            }
        }
        ChatEvent::Error {
            message,
            detail,
            code,
            status,
            retryable,
            retries,
        } => {
            for tool in &mut conversation.messages {
                if tool.kind == "toolCall" && tool.tool_status.as_deref() == Some("running") {
                    tool.tool_status = Some("error".into());
                    tool.error = true;
                }
            }
            if conversation.messages.iter().any(|message| {
                message.kind == "error"
                    && message.item_id.as_deref() == Some(event.item_id.as_str())
            }) {
                return;
            }
            let mut stored = StoredMessage {
                kind: "error".into(),
                content: message.clone(),
                created_at: event.emitted_at_ms,
                error: true,
                error_detail: Some(detail.clone()),
                error_code: code.clone(),
                error_status: *status,
                error_retryable: *retryable,
                error_retries: *retries,
                ..StoredMessage::default()
            };
            set_event_identity(&mut stored, event, false);
            conversation.messages.push(stored);
        }
    }
}

fn replay_trailing_events(conversation: &mut Conversation, recovery: &RolloutRecovery) {
    for value in &recovery.trailing_events {
        if let Ok(event) = serde_json::from_value::<ScopedChatEvent>(value.clone()) {
            apply_rollout_event(conversation, &event);
        }
    }
}

fn load_runtime_conversation(
    app: &AppHandle,
    store: &StateStore,
    id: &str,
    repair: bool,
) -> Result<Conversation, String> {
    validate_id(id)?;
    let task_path = conversation_path(app, id)?;
    let expected_rollout_path = rollout_path(app, id)?;
    let indexed = store
        .thread(id)
        .map_err(|error| format!("读取任务索引失败：{error}"))?;
    let path = indexed
        .as_ref()
        .filter(|thread| thread.rollout_path == expected_rollout_path)
        .map(|thread| thread.rollout_path.clone())
        .unwrap_or(expected_rollout_path);
    let recovery = store
        .recover_rollout(&path)
        .map_err(|error| format!("恢复任务 rollout 失败：{error}"))?;
    if let Some(metadata) = indexed
        .as_ref()
        .filter(|metadata| metadata.canonical.is_some())
    {
        let disk = read_task_json(&task_path).filter(|conversation| conversation.id == id);
        let mut conversation = disk.unwrap_or_else(|| Conversation {
            id: id.into(),
            title: if metadata.title.trim().is_empty() {
                DEFAULT_CONVERSATION_TITLE.into()
            } else {
                metadata.title.clone()
            },
            created_at: metadata.created_at_ms,
            updated_at: metadata.updated_at_ms,
            messages: Vec::new(),
            agent_id: metadata.agent_id.clone(),
            project_id: metadata.project_id.clone(),
            task_mode: TaskMode::default(),
            archived_at: metadata.archived_at_ms,
            pinned_at: metadata.pinned_at_ms,
            workspace: String::new(),
        });
        if !metadata.title.trim().is_empty() {
            conversation.title = metadata.title.clone();
        }
        conversation.created_at = metadata.created_at_ms;
        conversation.updated_at = metadata.updated_at_ms;
        conversation.agent_id = metadata.agent_id.clone();
        conversation.project_id = metadata.project_id.clone();
        conversation.task_mode = task_mode_from_store(&metadata.task_mode)?;
        conversation.archived_at = metadata.archived_at_ms;
        conversation.pinned_at = metadata.pinned_at_ms;
        conversation.workspace.clear();
        if repair && !task_path.is_file() {
            write_conversation(&task_path, &conversation)?;
        }
        return Ok(conversation);
    }

    let mut rollout_conversation = conversation_from_recovery(&recovery, id);
    if let Some(conversation) = &mut rollout_conversation {
        replay_trailing_events(conversation, &recovery);
    }
    let disk_conversation = read_task_json(&task_path).filter(|conversation| conversation.id == id);
    let disk_is_newer = match (&disk_conversation, &rollout_conversation) {
        (Some(disk), Some(rollout)) => disk.updated_at > rollout.updated_at,
        (Some(_), None) => true,
        _ => false,
    };
    let mut conversation = if disk_is_newer {
        disk_conversation
    } else {
        rollout_conversation.or(disk_conversation)
    }
    .ok_or_else(|| "任务记录不存在或已损坏".to_string())?;
    if conversation.updated_at == 0 {
        conversation.updated_at = now_ms();
    }
    if conversation.created_at == 0 {
        conversation.created_at = conversation_created_at(&conversation);
    }

    if repair {
        let needs_checkpoint = disk_is_newer
            || recovery.checkpoint.is_none()
            || !recovery.trailing_events.is_empty()
            || recovery.truncated_bytes > 0;
        if needs_checkpoint {
            persist_conversation(app, store, &conversation)?;
        } else {
            let checkpoint = recovery
                .checkpoint
                .as_ref()
                .expect("checkpoint checked above");
            store
                .upsert_metadata(&metadata_for(
                    &conversation,
                    path,
                    checkpoint.revision,
                    recovery.last_ordinal,
                    "clean",
                ))
                .map_err(|error| format!("修复任务索引失败：{error}"))?;
            if read_task_json(&task_path)
                .is_none_or(|disk| disk.updated_at < conversation.updated_at)
            {
                write_conversation(&task_path, &conversation)?;
            }
        }
    }
    Ok(conversation)
}

fn reconcile_runtime_store(app: &AppHandle, store: &StateStore) -> Result<(), String> {
    let task_directory = tasks_dir(app)?;
    for entry in
        std::fs::read_dir(&task_directory).map_err(|error| format!("读取任务目录失败：{error}"))?
    {
        let Ok(entry) = entry else {
            continue;
        };
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if validate_id(&id).is_err() || !entry.path().is_dir() {
            continue;
        }
        let indexed = store
            .thread(&id)
            .map_err(|error| format!("读取任务索引失败：{error}"))?;
        let expected_rollout_path = entry.path().join("rollout.jsonl");
        let indexed_rollout_exists = indexed.as_ref().is_some_and(|thread| {
            thread.rollout_path == expected_rollout_path && thread.rollout_path.is_file()
        });
        if indexed.is_some() && indexed_rollout_exists {
            continue;
        }
        if entry.path().join("task.json").is_file() || entry.path().join("rollout.jsonl").is_file()
        {
            if let Err(error) = load_runtime_conversation(app, store, &id, true) {
                if error.contains("不存在或已损坏") {
                    continue;
                }
                return Err(error);
            }
        }
    }

    for thread in store
        .list_threads(false)
        .and_then(|mut active| {
            active.extend(store.list_threads(true)?);
            Ok(active)
        })
        .map_err(|error| format!("检查任务索引失败：{error}"))?
    {
        let task_path = conversation_path(app, &thread.id)?;
        if !task_path.exists() && !thread.rollout_path.exists() {
            store
                .delete_thread(&thread.id)
                .map_err(|error| format!("清理失效任务索引失败：{error}"))?;
        }
    }
    Ok(())
}

/// Upgrade every legacy task checkpoint to the canonical Thread/Turn/Item
/// runtime without changing its UUID or workspace ownership.
pub(crate) fn migrate_tasks_to_codex(
    app: &AppHandle,
    manager: &ThreadManager,
) -> Result<usize, String> {
    migrate_legacy(app)?;
    let store = state_store(app)?;
    reconcile_runtime_store(app, &store)?;
    let mut metadata = store
        .list_threads(false)
        .map_err(|error| format!("读取活动任务索引失败：{error}"))?;
    metadata.extend(
        store
            .list_threads(true)
            .map_err(|error| format!("读取归档任务索引失败：{error}"))?,
    );
    let mut migrated = 0;
    for entry in metadata {
        if entry.canonical.is_some() {
            continue;
        }
        let conversation = load_runtime_conversation(app, &store, &entry.id, true)?;
        let cwd = super::workspace::resolve_task_workspace(
            app,
            (!conversation.project_id.is_empty()).then_some(conversation.project_id.as_str()),
            Some(&conversation.id),
            conversation.task_mode,
        )
        .or_else(|_| task_workspace_path(app, &conversation.id))?;
        let messages = conversation
            .messages
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("序列化旧任务历史失败：{error}"))?;
        if manager
            .import_legacy_thread(LegacyThreadImport {
                id: conversation.id,
                title: conversation.title,
                cwd,
                created_at_ms: conversation.created_at,
                updated_at_ms: conversation.updated_at,
                model: conversation
                    .messages
                    .iter()
                    .rev()
                    .filter_map(|message| message.model.as_ref())
                    .find(|model| !model.trim().is_empty())
                    .cloned(),
                model_provider: conversation
                    .messages
                    .iter()
                    .rev()
                    .filter_map(|message| message.provider_id.as_ref())
                    .find(|provider_id| !provider_id.trim().is_empty())
                    .cloned(),
                task_mode: conversation.task_mode.as_str().into(),
                messages,
            })
            .map_err(|error| format!("迁移任务到 Codex Runtime 失败：{}", error.message))?
        {
            migrated += 1;
        }
    }
    Ok(migrated)
}

pub(crate) fn prepare_codex_thread_delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let _guard = store_lock().lock().map_err(|_| "任务存储锁已损坏")?;
    let store = state_store(app)?;
    let root = task_root(app, id)?;
    if !root.exists() {
        return Ok(());
    }
    let project_id = load_runtime_conversation(app, &store, id, false)
        .ok()
        .map(|conversation| conversation.project_id)
        .unwrap_or_default();
    super::workspace::cleanup_task_workspaces(app, &project_id, &root);
    Ok(())
}

fn with_store<T>(
    app: &AppHandle,
    operation: impl FnOnce(&StateStore) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = store_lock().lock().map_err(|_| "任务存储锁已损坏")?;
    migrate_legacy(app)?;
    let store = state_store(app)?;
    reconcile_runtime_store(app, &store)?;
    operation(&store)
}

fn list_conversation_metas(
    store: &StateStore,
    archived: bool,
) -> Result<Vec<ConversationMeta>, String> {
    store
        .list_threads(archived)
        .map_err(|error| format!("读取任务索引失败：{error}"))?
        .into_iter()
        .map(|thread| {
            Ok(ConversationMeta {
                id: thread.id,
                title: thread.title,
                created_at: thread.created_at_ms,
                updated_at: thread.updated_at_ms,
                project_id: thread.project_id,
                task_mode: task_mode_from_store(&thread.task_mode)?,
                archived_at: thread.archived_at_ms,
                pinned_at: thread.pinned_at_ms,
            })
        })
        .collect()
}

pub(crate) fn suggestion_history(
    app: &AppHandle,
    project_id: Option<&str>,
    task_mode: TaskMode,
    limit: usize,
) -> Result<SuggestionHistory, String> {
    with_store(app, |store| {
        let expected_project_id = project_id.unwrap_or("");
        let mut indexed = store
            .list_threads(false)
            .map_err(|error| format!("读取任务索引失败：{error}"))?;
        indexed.extend(
            store
                .list_threads(true)
                .map_err(|error| format!("读取归档任务索引失败：{error}"))?,
        );
        let mut tasks = Vec::new();
        for thread in indexed {
            if thread.project_id != expected_project_id || thread.task_mode != task_mode.as_str() {
                continue;
            }
            let Ok(conversation) = load_runtime_conversation(app, store, &thread.id, true) else {
                continue;
            };
            let opening_request = conversation
                .messages
                .iter()
                .find(|message| {
                    message.kind == "message"
                        && message.role == "user"
                        && !message.content.trim().is_empty()
                })
                .map(|message| compact_excerpt(&message.content, 180))
                .unwrap_or_default();
            let tools: BTreeSet<String> = conversation
                .messages
                .iter()
                .filter_map(|message| message.tool_name.clone())
                .take(8)
                .collect();
            tasks.push(SuggestionTaskDigest {
                id: conversation.id,
                title: conversation.title,
                updated_at: conversation.updated_at,
                opening_request,
                tools: tools.into_iter().collect(),
            });
        }
        tasks.sort_by_key(|task| std::cmp::Reverse(task.updated_at));
        let total_tasks = tasks.len();
        tasks.truncate(limit);
        Ok(SuggestionHistory {
            total_tasks,
            recent_tasks: tasks,
        })
    })
}

fn compact_excerpt(value: &str, limit: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let redacted = sensitive_value_pattern().replace_all(&compact, "[已隐藏]");
    redacted.chars().take(limit).collect()
}

fn sensitive_value_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(?:sk|pk)-[a-z0-9_-]{8,}|(?:api[_ -]?key|access[_ -]?token|token|password|passwd|secret)\s*[:=]\s*[^\s,;]+",
        )
        .expect("sensitive value pattern must be valid")
    })
}

#[tauri::command]
pub fn list_conversations(app: AppHandle) -> Result<Vec<ConversationMeta>, String> {
    with_store(&app, |store| list_conversation_metas(store, false))
}

#[tauri::command]
pub fn list_archived_conversations(app: AppHandle) -> Result<Vec<ConversationMeta>, String> {
    with_store(&app, |store| list_conversation_metas(store, true))
}

#[tauri::command]
pub fn load_conversation(app: AppHandle, id: String) -> Result<Conversation, String> {
    with_store(&app, |store| {
        load_runtime_conversation(&app, store, &id, true)
    })
}

pub(crate) fn task_context(
    app: &AppHandle,
    id: &str,
) -> Result<(Option<String>, TaskMode), String> {
    validate_id(id)?;
    with_store(app, |store| {
        let metadata = store
            .thread(id)
            .map_err(|error| format!("读取任务索引失败：{error}"))?
            .ok_or_else(|| "任务记录不存在或已损坏".to_string())?;
        Ok((
            (!metadata.project_id.trim().is_empty()).then_some(metadata.project_id),
            task_mode_from_store(&metadata.task_mode)?,
        ))
    })
}

#[tauri::command]
pub fn save_conversation(
    app: AppHandle,
    mut conversation: Conversation,
) -> Result<SaveConversationResult, String> {
    with_store(&app, |store| {
        validate_id(&conversation.id)?;
        if conversation.title.trim().is_empty() {
            conversation.title = DEFAULT_CONVERSATION_TITLE.into();
        }
        if !conversation.project_id.is_empty()
            && super::projects::find_project(&app, &conversation.project_id)?.is_none()
        {
            return Err("任务关联的项目不存在".into());
        }
        match load_runtime_conversation(&app, store, &conversation.id, true) {
            Ok(existing) => {
                conversation.created_at = conversation_created_at(&existing);
                conversation.archived_at = existing.archived_at;
                conversation.pinned_at = existing.pinned_at;
                preserve_generated_title(&mut conversation.title, &existing.title);
            }
            Err(error) if error.contains("不存在或已损坏") => {
                conversation.created_at = conversation
                    .messages
                    .iter()
                    .filter_map(|message| (message.created_at > 0).then_some(message.created_at))
                    .min()
                    .unwrap_or_else(now_ms);
            }
            Err(error) => return Err(error),
        }
        conversation.workspace.clear();
        conversation.updated_at = now_ms();
        persist_conversation(&app, store, &conversation)?;
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
    with_store(app, |store| {
        let mut conversation = match load_runtime_conversation(app, store, id, true) {
            Ok(conversation) => conversation,
            Err(error) if error.contains("不存在") => return Ok(None),
            Err(error) => return Err(error),
        };
        if conversation.title != DEFAULT_CONVERSATION_TITLE || conversation.archived_at != 0 {
            return Ok(None);
        }
        conversation.title = title.into();
        persist_conversation(app, store, &conversation)?;
        Ok(Some(conversation.title))
    })
}

fn set_archived_at(
    app: &AppHandle,
    store: &StateStore,
    id: &str,
    archived_at: u64,
) -> Result<(), String> {
    let mut conversation = load_runtime_conversation(app, store, id, true)?;
    conversation.archived_at = archived_at;
    if archived_at == 0 {
        conversation.updated_at = now_ms();
    }
    persist_conversation(app, store, &conversation)
}

#[tauri::command]
pub fn archive_conversation(app: AppHandle, id: String) -> Result<(), String> {
    with_store(&app, |store| set_archived_at(&app, store, &id, now_ms()))
}

#[tauri::command]
pub fn restore_conversation(app: AppHandle, id: String) -> Result<(), String> {
    with_store(&app, |store| set_archived_at(&app, store, &id, 0))
}

#[tauri::command]
pub fn set_conversation_pinned(app: AppHandle, id: String, pinned: bool) -> Result<u64, String> {
    with_store(&app, |store| {
        let mut conversation = load_runtime_conversation(&app, store, &id, true)?;
        conversation.pinned_at = if pinned { now_ms() } else { 0 };
        persist_conversation(&app, store, &conversation)?;
        Ok(conversation.pinned_at)
    })
}

#[tauri::command]
pub fn archive_project_conversations(app: AppHandle, project_id: String) -> Result<u64, String> {
    with_store(&app, |store| {
        let archived_at = now_ms();
        let mut count = 0;
        let active = store
            .list_threads(false)
            .map_err(|error| format!("读取任务索引失败：{error}"))?;
        for thread in active {
            if thread.project_id != project_id {
                continue;
            }
            let Ok(mut conversation) = load_runtime_conversation(&app, store, &thread.id, true)
            else {
                continue;
            };
            conversation.archived_at = archived_at;
            persist_conversation(&app, store, &conversation)?;
            count += 1;
        }
        Ok(count)
    })
}

#[tauri::command]
pub fn delete_conversation(app: AppHandle, id: String) -> Result<(), String> {
    with_store(&app, |store| {
        if store
            .thread(&id)
            .map_err(|error| format!("读取任务索引失败：{error}"))?
            .is_some_and(|thread| thread.canonical.is_some())
        {
            return Err("该任务由 Codex Runtime 管理，请使用 thread/delete".into());
        }
        let root = task_root(&app, &id)?;
        if !root.exists() {
            store
                .delete_thread(&id)
                .map_err(|error| format!("删除任务索引失败：{error}"))?;
            return Ok(());
        }
        let project_id = load_runtime_conversation(&app, store, &id, true)
            .ok()
            .map(|conversation| conversation.project_id)
            .unwrap_or_default();
        super::workspace::cleanup_task_workspaces(&app, &project_id, &root);
        std::fs::remove_dir_all(root).map_err(|e| format!("删除任务失败：{e}"))?;
        store
            .delete_thread(&id)
            .map_err(|error| format!("删除任务索引失败：{error}"))
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
        assert_eq!(msg.thread_id, None);
        assert_eq!(msg.turn_id, None);
        assert_eq!(msg.item_id, None);

        let json = r#"{"role":"user","content":"你好","createdAt":1784110000000}"#;
        let msg: StoredMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.created_at, 1_784_110_000_000);
    }

    #[test]
    fn rollout_events_restore_partial_assistant_and_unfinished_tool() {
        let mut conversation: Conversation = serde_json::from_str(
            r#"{"id":"3fa85f64-5717-4562-b3fc-2c963f66afa6","title":"恢复","messages":[]}"#,
        )
        .unwrap();
        let reasoning = tietiezhi_agent_events::EventEnvelope {
            thread_id: conversation.id.clone(),
            turn_id: "turn-1".into(),
            item_id: "reasoning-1".into(),
            sequence: 1,
            emitted_at_ms: 100,
            payload: ChatEvent::Reasoning {
                content: "分析".into(),
            },
        };
        let delta = tietiezhi_agent_events::EventEnvelope {
            thread_id: conversation.id.clone(),
            turn_id: "turn-1".into(),
            item_id: "message-1".into(),
            sequence: 2,
            emitted_at_ms: 101,
            payload: ChatEvent::Delta {
                content: "结果".into(),
            },
        };
        let tool = tietiezhi_agent_events::EventEnvelope {
            thread_id: conversation.id.clone(),
            turn_id: "turn-1".into(),
            item_id: "call-1".into(),
            sequence: 3,
            emitted_at_ms: 102,
            payload: ChatEvent::ToolCallStart {
                id: "call-1".into(),
                name: "bash".into(),
                args: serde_json::json!({"command":"sleep 30"}),
                timeout_ms: None,
            },
        };

        apply_rollout_event(&mut conversation, &reasoning);
        apply_rollout_event(&mut conversation, &delta);
        apply_rollout_event(&mut conversation, &tool);

        assert_eq!(conversation.messages.len(), 2);
        let assistant = &conversation.messages[0];
        assert_eq!(assistant.reasoning, "分析");
        assert_eq!(assistant.content, "结果");
        assert_eq!(assistant.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(assistant.reasoning_item_id.as_deref(), Some("reasoning-1"));
        assert_eq!(assistant.item_id.as_deref(), Some("message-1"));
        let tool = &conversation.messages[1];
        assert_eq!(tool.tool_status.as_deref(), Some("running"));
        assert_eq!(tool.item_id.as_deref(), Some("call-1"));
        assert_eq!(conversation.updated_at, 102);
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
    fn legacy_image_attachments_gain_asset_defaults() {
        let json = r#"{"role":"user","content":"看图","attachments":[{"id":"a1","name":"old.png","mimeType":"image/png","dataUrl":"data:image/png;base64,AA=="}]}"#;
        let message: StoredMessage = serde_json::from_str(json).unwrap();
        let asset = &message.attachments[0];
        assert!(asset.kind.is_empty());
        assert!(asset.path.is_empty());
        assert_eq!(asset.data_url, "data:image/png;base64,AA==");
        assert!(!asset.truncated);
    }

    #[test]
    fn server_managed_fields_default_for_legacy_conversations() {
        let json = r#"{"id":"3fa85f64-5717-4562-b3fc-2c963f66afa6","title":"旧任务"}"#;
        let conversation: Conversation = serde_json::from_str(json).unwrap();
        assert_eq!(conversation.archived_at, 0);
        assert_eq!(conversation.pinned_at, 0);
        assert_eq!(conversation.task_mode, TaskMode::Code);
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
    fn legacy_permission_decisions_migrate_to_codex_semantics() {
        let cases = [
            ("allow", "accept"),
            ("allowAlways", "acceptForSession"),
            ("deny", "decline"),
        ];
        for (legacy, expected) in cases {
            let json = format!(r#"{{"kind":"permission","decision":"{legacy}","content":"test"}}"#);
            let message: StoredMessage = serde_json::from_str(&json).unwrap();
            assert_eq!(message.decision.as_deref(), Some(expected));
            assert_eq!(message.permission_scope, None);
        }
    }

    #[test]
    fn permission_scope_and_new_decisions_roundtrip() {
        let json = r#"{"kind":"permission","decision":"cancel","permissionScope":"命令：cargo test","content":"test"}"#;
        let message: StoredMessage = serde_json::from_str(json).unwrap();
        assert_eq!(message.decision.as_deref(), Some("cancel"));
        assert_eq!(
            message.permission_scope.as_deref(),
            Some("命令：cargo test")
        );
        let output = serde_json::to_string(&message).unwrap();
        assert!(output.contains("\"decision\":\"cancel\""));
        assert!(output.contains("\"permissionScope\":\"命令：cargo test\""));
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

    #[test]
    fn suggestion_excerpt_redacts_likely_secrets() {
        let excerpt = compact_excerpt(
            "请检查 API_KEY=top-secret-value 和 sk-1234567890abcdef 是否泄漏",
            180,
        );
        assert_eq!(excerpt, "请检查 [已隐藏] 和 [已隐藏] 是否泄漏");
    }
}
