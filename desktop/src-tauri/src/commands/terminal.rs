use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, State};
use tietiezhi_agent_exec::{ExecRequest, OutputStream, SessionId, TerminalSize};
use uuid::Uuid;

use super::workspace::TaskMode;
use crate::AppState;

const MAX_SESSIONS_PER_TASK: usize = 8;
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct TerminalRecord {
    id: String,
    task_id: String,
    title: String,
    cwd: PathBuf,
    created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionView {
    id: String,
    task_id: String,
    title: String,
    cwd: String,
    created_at_ms: u64,
    running: bool,
    exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputChunk {
    cursor: usize,
    stream: OutputStream,
    data: String,
    cap_reached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadResult {
    chunks: Vec<TerminalOutputChunk>,
    next_cursor: usize,
    running: bool,
    exit_code: Option<i32>,
    timed_out: bool,
}

#[tauri::command]
pub async fn terminal_list(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<Vec<TerminalSessionView>, String> {
    super::conversations::validate_id(&task_id)?;
    let records = state
        .terminal_sessions
        .lock()
        .map_err(|_| "终端会话状态锁已损坏".to_string())?
        .values()
        .filter(|record| record.task_id == task_id)
        .cloned()
        .collect::<Vec<_>>();
    let mut sessions = Vec::with_capacity(records.len());
    for record in records {
        let id = terminal_session_id(&record);
        let result = state
            .codex_exec
            .poll(&id, usize::MAX, Duration::ZERO)
            .await
            .ok()
            .and_then(|poll| poll.result);
        sessions.push(TerminalSessionView {
            id: record.id,
            task_id: record.task_id,
            title: record.title,
            cwd: record.cwd.to_string_lossy().into_owned(),
            created_at_ms: record.created_at_ms,
            running: result.is_none(),
            exit_code: result.map(|result| result.exit_code),
        });
    }
    sessions.sort_by_key(|session| session.created_at_ms);
    Ok(sessions)
}

#[tauri::command]
pub async fn terminal_start(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<TerminalSessionView, String> {
    super::conversations::validate_id(&task_id)?;
    let conversation = super::conversations::load_conversation(app.clone(), task_id.clone())?;
    let current_count = state
        .terminal_sessions
        .lock()
        .map_err(|_| "终端会话状态锁已损坏".to_string())?
        .values()
        .filter(|record| record.task_id == task_id)
        .count();
    if current_count >= MAX_SESSIONS_PER_TASK {
        return Err(format!("每个任务最多创建 {MAX_SESSIONS_PER_TASK} 个终端"));
    }
    let project_id =
        (!conversation.project_id.trim().is_empty()).then_some(conversation.project_id.as_str());
    let cwd =
        super::workspace::resolve_task_workspace(&app, project_id, Some(&task_id), TaskMode::Code)?;
    let id = Uuid::now_v7().to_string();
    let title = format!("Terminal {}", current_count + 1);
    let record = TerminalRecord {
        id: id.clone(),
        task_id: task_id.clone(),
        title: title.clone(),
        cwd: cwd.clone(),
        created_at_ms: now_ms(),
    };
    state
        .codex_exec
        .spawn(
            terminal_session_id(&record),
            ExecRequest {
                command: login_shell_command(),
                cwd: cwd.clone(),
                env: HashMap::new(),
                tty: true,
                stream_stdin: true,
                size: TerminalSize {
                    rows: rows.unwrap_or(24).clamp(2, 500),
                    cols: cols.unwrap_or(100).clamp(2, 500),
                },
                output_bytes_cap: Some(MAX_OUTPUT_BYTES),
                timeout: None,
                cancellation: None,
                sandbox_policy: None,
            },
        )
        .await
        .map_err(|error| format!("启动终端失败：{error}"))?;
    state
        .terminal_sessions
        .lock()
        .map_err(|_| "终端会话状态锁已损坏".to_string())?
        .insert(terminal_key(&task_id, &id), record.clone());
    Ok(TerminalSessionView {
        id,
        task_id,
        title,
        cwd: cwd.to_string_lossy().into_owned(),
        created_at_ms: record.created_at_ms,
        running: true,
        exit_code: None,
    })
}

#[tauri::command]
pub async fn terminal_read(
    state: State<'_, AppState>,
    task_id: String,
    session_id: String,
    cursor: usize,
    wait_ms: Option<u64>,
) -> Result<TerminalReadResult, String> {
    let record = terminal_record(&state, &task_id, &session_id)?;
    let poll = state
        .codex_exec
        .poll(
            &terminal_session_id(&record),
            cursor,
            Duration::from_millis(wait_ms.unwrap_or(0).min(30_000)),
        )
        .await
        .map_err(|error| format!("读取终端输出失败：{error}"))?;
    let result = poll.result;
    Ok(TerminalReadResult {
        chunks: poll
            .chunks
            .into_iter()
            .map(|chunk| TerminalOutputChunk {
                cursor: chunk.cursor,
                stream: chunk.stream,
                data: String::from_utf8_lossy(&chunk.bytes).into_owned(),
                cap_reached: chunk.cap_reached,
            })
            .collect(),
        next_cursor: poll.next_cursor,
        running: result.is_none(),
        exit_code: result.as_ref().map(|result| result.exit_code),
        timed_out: result.is_some_and(|result| result.timed_out),
    })
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>,
    task_id: String,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let record = terminal_record(&state, &task_id, &session_id)?;
    state
        .codex_exec
        .write(&terminal_session_id(&record), data.as_bytes(), false)
        .await
        .map_err(|error| format!("写入终端失败：{error}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    task_id: String,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let record = terminal_record(&state, &task_id, &session_id)?;
    state
        .codex_exec
        .resize(
            &terminal_session_id(&record),
            TerminalSize {
                rows: rows.clamp(2, 500),
                cols: cols.clamp(2, 500),
            },
        )
        .map_err(|error| format!("调整终端尺寸失败：{error}"))
}

#[tauri::command]
pub fn terminal_terminate(
    state: State<'_, AppState>,
    task_id: String,
    session_id: String,
) -> Result<(), String> {
    let record = terminal_record(&state, &task_id, &session_id)?;
    state
        .codex_exec
        .terminate(&terminal_session_id(&record))
        .map_err(|error| format!("停止终端失败：{error}"))
}

#[tauri::command]
pub fn terminal_close(
    state: State<'_, AppState>,
    task_id: String,
    session_id: String,
) -> Result<(), String> {
    let record = terminal_record(&state, &task_id, &session_id)?;
    let id = terminal_session_id(&record);
    let _ = state.codex_exec.terminate(&id);
    let _ = state.codex_exec.remove(&id);
    state
        .terminal_sessions
        .lock()
        .map_err(|_| "终端会话状态锁已损坏".to_string())?
        .remove(&terminal_key(&task_id, &session_id));
    Ok(())
}

pub(crate) fn terminate_task_terminals(state: &AppState, task_id: &str) {
    let owner = terminal_owner(task_id);
    let _ = state.codex_exec.terminate_owner(&owner);
    if let Ok(mut records) = state.terminal_sessions.lock() {
        records.retain(|_, record| record.task_id != task_id);
    }
}

fn terminal_record(
    state: &AppState,
    task_id: &str,
    session_id: &str,
) -> Result<TerminalRecord, String> {
    super::conversations::validate_id(task_id)?;
    Uuid::parse_str(session_id).map_err(|_| "非法的终端会话 ID".to_string())?;
    state
        .terminal_sessions
        .lock()
        .map_err(|_| "终端会话状态锁已损坏".to_string())?
        .get(&terminal_key(task_id, session_id))
        .cloned()
        .ok_or_else(|| "终端会话不存在".into())
}

fn terminal_session_id(record: &TerminalRecord) -> SessionId {
    SessionId::new(terminal_owner(&record.task_id), record.id.clone())
}

fn terminal_owner(task_id: &str) -> String {
    format!("thread-terminal/{task_id}")
}

fn terminal_key(task_id: &str, session_id: &str) -> String {
    format!("{task_id}\0{session_id}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(windows)]
fn login_shell_command() -> Vec<String> {
    if let Some(shell) = std::env::var_os("COMSPEC") {
        vec![shell.to_string_lossy().into_owned()]
    } else {
        vec!["powershell.exe".into(), "-NoLogo".into()]
    }
}

#[cfg(not(windows))]
fn login_shell_command() -> Vec<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|path| PathBuf::from(path).is_file())
        .unwrap_or_else(|| "/bin/zsh".into());
    vec![shell, "-l".into()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_and_keys_are_thread_scoped() {
        let task = Uuid::now_v7().to_string();
        let session = Uuid::now_v7().to_string();
        assert_eq!(terminal_owner(&task), format!("thread-terminal/{task}"));
        assert_ne!(
            terminal_key(&task, &session),
            terminal_key(&Uuid::now_v7().to_string(), &session)
        );
    }

    #[test]
    fn login_shell_is_explicit() {
        let command = login_shell_command();
        assert!(!command.is_empty());
        assert!(!command[0].trim().is_empty());
    }
}
