use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use bm25::{Document, Language, SearchEngine, SearchEngineBuilder};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use tietiezhi_agent_approval::{CommandExecutionApprovalDecision, FileChangeApprovalDecision};
use tietiezhi_agent_exec::{
    ExecEvent, ExecManager, ExecRequest, ExecResult, OutputChunk, SessionId, TerminalSize,
};
use tietiezhi_agent_patch::{PatchPlan, TurnDiffTracker};

use crate::{
    ToolError, ToolFuture, ToolHandler, ToolInvocation, ToolName, ToolOutput, ToolPayload,
    ToolSpec, wire_specs,
};

const MAX_SLEEP_DURATION_MS: u64 = 12 * 60 * 60 * 1000;
const TOOL_SEARCH_DEFAULT_LIMIT: usize = 8;
const APPLY_PATCH_LARK_GRAMMAR: &str = r#"start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
"#;

pub type ContextRemainingProvider = Arc<dyn Fn(&str, &str) -> Option<i64> + Send + Sync + 'static>;
pub type FileChangeApprovalFuture =
    Pin<Box<dyn Future<Output = Result<FileChangeApprovalDecision, ToolError>> + Send + 'static>>;
pub type FileChangeApprover =
    Arc<dyn Fn(FileChangeApprovalRequest) -> FileChangeApprovalFuture + Send + Sync + 'static>;
pub type CommandApprovalFuture = Pin<
    Box<dyn Future<Output = Result<CommandExecutionApprovalDecision, ToolError>> + Send + 'static>,
>;
pub type CommandApprover =
    Arc<dyn Fn(CommandApprovalRequest) -> CommandApprovalFuture + Send + Sync + 'static>;
pub type CommandObserver =
    Arc<dyn Fn(CommandRuntimeEvent) -> Result<(), ToolError> + Send + Sync + 'static>;

#[derive(Debug, Clone)]
pub struct FileChangeApprovalRequest {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub reason: Option<String>,
    pub grant_root: Option<String>,
    pub cancellation: tokio_util::sync::CancellationToken,
}

#[derive(Debug, Clone)]
pub struct CommandApprovalRequest {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub command: String,
    pub cwd: String,
    pub reason: Option<String>,
    pub cancellation: tokio_util::sync::CancellationToken,
}

#[derive(Debug, Clone)]
pub enum CommandRuntimeEvent {
    Output {
        thread_id: String,
        turn_id: String,
        item_id: String,
        delta: String,
    },
    TerminalInteraction {
        thread_id: String,
        turn_id: String,
        item_id: String,
        process_id: String,
        stdin: String,
    },
    Exited {
        thread_id: String,
        turn_id: String,
        item_id: String,
        command: String,
        cwd: String,
        process_id: String,
        result: ExecResult,
    },
}

pub fn current_time_handler() -> Arc<dyn ToolHandler> {
    Arc::new(CurrentTimeHandler)
}

pub fn sleep_handler() -> Arc<dyn ToolHandler> {
    Arc::new(SleepHandler)
}

pub fn context_remaining_handler(provider: ContextRemainingProvider) -> Arc<dyn ToolHandler> {
    Arc::new(ContextRemainingHandler { provider })
}

pub fn view_image_handler(cwd: PathBuf, allow_original: bool) -> Arc<dyn ToolHandler> {
    Arc::new(ViewImageHandler {
        cwd,
        allow_original,
    })
}

pub fn web_search_handler() -> Arc<dyn ToolHandler> {
    Arc::new(HostedWebSearchHandler)
}

pub fn tool_search_handler(
    deferred_specs: Vec<ToolSpec>,
    source_descriptions: Vec<(String, Option<String>)>,
) -> Arc<dyn ToolHandler> {
    Arc::new(ToolSearchHandler::new(deferred_specs, source_descriptions))
}

pub fn apply_patch_handler(
    cwd: PathBuf,
    requires_approval: bool,
    approver: Option<FileChangeApprover>,
) -> Result<Arc<dyn ToolHandler>, ToolError> {
    let tracker = TurnDiffTracker::new(&cwd)
        .map_err(|error| ToolError::Handler(format!("initialize turn diff: {error}")))?;
    Ok(Arc::new(ApplyPatchHandler {
        cwd,
        requires_approval,
        approver,
        tracker: Mutex::new(tracker),
    }))
}

pub fn unified_exec_handlers(
    manager: ExecManager,
    cwd: PathBuf,
    requires_approval: bool,
    approver: Option<CommandApprover>,
    observer: CommandObserver,
) -> Vec<Arc<dyn ToolHandler>> {
    let sessions = Arc::new(Mutex::new(HashMap::new()));
    vec![
        Arc::new(ExecCommandHandler {
            manager: manager.clone(),
            cwd,
            requires_approval,
            approver,
            observer: observer.clone(),
            sessions: sessions.clone(),
        }),
        Arc::new(WriteStdinHandler {
            manager,
            observer,
            sessions,
        }),
    ]
}

#[derive(Debug, Clone)]
struct CommandSession {
    thread_id: String,
    turn_id: String,
    item_id: String,
    command: String,
    cwd: String,
    cursor: usize,
}

struct ExecCommandHandler {
    manager: ExecManager,
    cwd: PathBuf,
    requires_approval: bool,
    approver: Option<CommandApprover>,
    observer: CommandObserver,
    sessions: Arc<Mutex<HashMap<String, CommandSession>>>,
}

#[derive(Deserialize)]
struct ExecCommandArgs {
    cmd: String,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default)]
    tty: bool,
    #[serde(default = "default_exec_yield_time_ms")]
    yield_time_ms: u64,
    #[serde(default)]
    max_output_tokens: Option<usize>,
    #[serde(default)]
    shell: Option<String>,
    #[serde(default)]
    login: bool,
}

impl ToolHandler for ExecCommandHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("exec_command")
    }

    fn spec(&self) -> ToolSpec {
        let mut spec = ToolSpec::function(
            self.tool_name(),
            "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
            json!({
                "type":"object",
                "properties":{
                    "cmd":{"type":"string","description":"Shell command to execute."},
                    "workdir":{"type":"string","description":"Working directory. Defaults to the turn cwd."},
                    "tty":{"type":"boolean","description":"Run attached to a PTY."},
                    "yield_time_ms":{"type":"integer","minimum":1,"description":"Wait before yielding output."},
                    "max_output_tokens":{"type":"integer","minimum":1,"description":"Maximum output tokens returned by this call."},
                    "shell":{"type":"string","description":"Shell binary to launch."},
                    "login":{"type":"boolean","description":"Use login shell semantics."}
                },
                "required":["cmd"],
                "additionalProperties":false
            }),
        );
        spec.output_schema = Some(exec_tool_output_schema());
        spec
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn waits_for_runtime_cancellation(&self) -> bool {
        true
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        let manager = self.manager.clone();
        let base_cwd = self.cwd.clone();
        let requires_approval = self.requires_approval;
        let approver = self.approver.clone();
        let observer = self.observer.clone();
        let sessions = self.sessions.clone();
        Box::pin(async move {
            let ToolPayload::Function { arguments } = &invocation.call.payload else {
                return Err(ToolError::InvalidCall(
                    "exec_command requires function arguments".into(),
                ));
            };
            let args: ExecCommandArgs = serde_json::from_str(arguments)
                .map_err(|error| ToolError::InvalidCall(error.to_string()))?;
            if args.cmd.trim().is_empty() {
                return Err(ToolError::InvalidCall("cmd must not be empty".into()));
            }
            if args.max_output_tokens == Some(0) {
                return Err(ToolError::InvalidCall(
                    "max_output_tokens must be greater than zero".into(),
                ));
            }
            let cwd = resolve_exec_cwd(&base_cwd, args.workdir.as_deref())?;
            let cwd_display = cwd.to_string_lossy().into_owned();
            if requires_approval {
                let Some(approver) = approver else {
                    return Ok(command_failure_output(
                        &invocation.call.call_id,
                        &args.cmd,
                        &cwd_display,
                        "command approval channel is unavailable",
                    ));
                };
                let decision = approver(CommandApprovalRequest {
                    thread_id: invocation.thread_id.clone(),
                    turn_id: invocation.turn_id.clone(),
                    item_id: invocation.call.call_id.clone(),
                    command: args.cmd.clone(),
                    cwd: cwd_display.clone(),
                    reason: Some("execute command".into()),
                    cancellation: invocation.cancellation.clone(),
                })
                .await?;
                if matches!(
                    decision,
                    CommandExecutionApprovalDecision::Decline
                        | CommandExecutionApprovalDecision::Cancel
                ) {
                    if decision == CommandExecutionApprovalDecision::Cancel {
                        invocation.cancellation.cancel();
                    }
                    return Ok(command_status_output(
                        &invocation.call.call_id,
                        &args.cmd,
                        &cwd_display,
                        "declined",
                        false,
                        "Command declined by user.",
                    ));
                }
            }

            let process_id = manager.allocate_session_id();
            let session_id = SessionId::new(
                exec_owner(&invocation.thread_id, &invocation.turn_id),
                &process_id,
            );
            let command = shell_argv(&args.cmd, args.shell.as_deref(), args.login);
            let request = ExecRequest {
                command,
                cwd: cwd.clone(),
                env: HashMap::new(),
                tty: args.tty,
                stream_stdin: true,
                size: TerminalSize::default(),
                output_bytes_cap: Some(tietiezhi_agent_exec::DEFAULT_OUTPUT_BYTES_CAP),
                timeout: None,
                cancellation: Some(invocation.cancellation.clone()),
            };
            let events = match manager.spawn(session_id.clone(), request).await {
                Ok(events) => events,
                Err(error) => {
                    return Ok(command_failure_output(
                        &invocation.call.call_id,
                        &args.cmd,
                        &cwd_display,
                        &error.to_string(),
                    ));
                }
            };
            let command_session = CommandSession {
                thread_id: invocation.thread_id.clone(),
                turn_id: invocation.turn_id.clone(),
                item_id: invocation.call.call_id.clone(),
                command: args.cmd.clone(),
                cwd: cwd_display.clone(),
                cursor: 0,
            };
            sessions
                .lock()
                .map_err(|_| ToolError::Handler("exec session state lock poisoned".into()))?
                .insert(process_id.clone(), command_session.clone());
            monitor_command(events, process_id.clone(), command_session, observer);

            let yield_time = Duration::from_millis(clamp_yield_time(args.yield_time_ms));
            let polled = manager
                .poll(&session_id, 0, yield_time)
                .await
                .map_err(|error| ToolError::Handler(error.to_string()))?;
            let completed = polled.result.is_some();
            if let Ok(mut sessions) = sessions.lock()
                && let Some(session) = sessions.get_mut(&process_id)
            {
                session.cursor = polled.next_cursor;
            }
            let output = exec_poll_output(
                &invocation.call.call_id,
                &process_id,
                polled.chunks,
                polled.result,
                args.max_output_tokens,
            );
            if completed {
                if let Ok(mut sessions) = sessions.lock() {
                    sessions.remove(&process_id);
                }
                let _ = manager.remove(&session_id);
            }
            Ok(output)
        })
    }
}

struct WriteStdinHandler {
    manager: ExecManager,
    observer: CommandObserver,
    sessions: Arc<Mutex<HashMap<String, CommandSession>>>,
}

#[derive(Deserialize)]
struct WriteStdinArgs {
    session_id: u64,
    #[serde(default)]
    chars: String,
    #[serde(default = "default_write_stdin_yield_time_ms")]
    yield_time_ms: u64,
    #[serde(default)]
    max_output_tokens: Option<usize>,
}

impl ToolHandler for WriteStdinHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("write_stdin")
    }

    fn spec(&self) -> ToolSpec {
        let mut spec = ToolSpec::function(
            self.tool_name(),
            "Writes characters to an existing unified exec session and returns recent output.",
            json!({
                "type":"object",
                "properties":{
                    "session_id":{"type":"integer","minimum":1,"description":"Session identifier returned by exec_command."},
                    "chars":{"type":"string","description":"Characters to write. Empty input polls only."},
                    "yield_time_ms":{"type":"integer","minimum":1,"description":"Wait before yielding output."},
                    "max_output_tokens":{"type":"integer","minimum":1,"description":"Maximum output tokens returned by this call."}
                },
                "required":["session_id"],
                "additionalProperties":false
            }),
        );
        spec.output_schema = Some(exec_tool_output_schema());
        spec
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn waits_for_runtime_cancellation(&self) -> bool {
        true
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        let manager = self.manager.clone();
        let observer = self.observer.clone();
        let sessions = self.sessions.clone();
        Box::pin(async move {
            let ToolPayload::Function { arguments } = &invocation.call.payload else {
                return Err(ToolError::InvalidCall(
                    "write_stdin requires function arguments".into(),
                ));
            };
            let args: WriteStdinArgs = serde_json::from_str(arguments)
                .map_err(|error| ToolError::InvalidCall(error.to_string()))?;
            if args.max_output_tokens == Some(0) {
                return Err(ToolError::InvalidCall(
                    "max_output_tokens must be greater than zero".into(),
                ));
            }
            let process_id = args.session_id.to_string();
            let session = sessions
                .lock()
                .map_err(|_| ToolError::Handler("exec session state lock poisoned".into()))?
                .get(&process_id)
                .cloned()
                .ok_or_else(|| ToolError::Handler(format!("unknown exec session {process_id}")))?;
            let id = SessionId::new(
                exec_owner(&session.thread_id, &session.turn_id),
                &process_id,
            );
            if !args.chars.is_empty() {
                manager
                    .write(&id, args.chars.as_bytes(), false)
                    .await
                    .map_err(|error| ToolError::Handler(error.to_string()))?;
            }
            if !args.chars.is_empty()
                || manager
                    .wait(&id, Some(Duration::ZERO))
                    .await
                    .map_err(|error| ToolError::Handler(error.to_string()))?
                    .is_none()
            {
                observer(CommandRuntimeEvent::TerminalInteraction {
                    thread_id: session.thread_id.clone(),
                    turn_id: session.turn_id.clone(),
                    item_id: session.item_id.clone(),
                    process_id: process_id.clone(),
                    stdin: args.chars.clone(),
                })?;
            }
            let yield_ms = if args.chars.is_empty() {
                args.yield_time_ms.clamp(5_000, 30_000)
            } else {
                clamp_yield_time(args.yield_time_ms)
            };
            let polled = manager
                .poll(&id, session.cursor, Duration::from_millis(yield_ms))
                .await
                .map_err(|error| ToolError::Handler(error.to_string()))?;
            let completed = polled.result.is_some();
            if let Ok(mut sessions) = sessions.lock()
                && let Some(session) = sessions.get_mut(&process_id)
            {
                session.cursor = polled.next_cursor;
            }
            let output = exec_poll_output(
                &session.item_id,
                &process_id,
                polled.chunks,
                polled.result,
                args.max_output_tokens,
            );
            if completed {
                if let Ok(mut sessions) = sessions.lock() {
                    sessions.remove(&process_id);
                }
                let _ = manager.remove(&id);
            }
            Ok(output)
        })
    }
}

fn monitor_command(
    mut events: tokio::sync::broadcast::Receiver<ExecEvent>,
    process_id: String,
    session: CommandSession,
    observer: CommandObserver,
) {
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ExecEvent::Output(chunk)) => {
                    if !chunk.bytes.is_empty() {
                        let _ = observer(CommandRuntimeEvent::Output {
                            thread_id: session.thread_id.clone(),
                            turn_id: session.turn_id.clone(),
                            item_id: session.item_id.clone(),
                            delta: String::from_utf8_lossy(&chunk.bytes).into_owned(),
                        });
                    }
                }
                Ok(ExecEvent::Exited(result)) => {
                    let _ = observer(CommandRuntimeEvent::Exited {
                        thread_id: session.thread_id.clone(),
                        turn_id: session.turn_id.clone(),
                        item_id: session.item_id.clone(),
                        command: session.command.clone(),
                        cwd: session.cwd.clone(),
                        process_id: process_id.clone(),
                        result,
                    });
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn command_failure_output(item_id: &str, command: &str, cwd: &str, message: &str) -> ToolOutput {
    command_status_output(item_id, command, cwd, "failed", false, message)
}

fn command_status_output(
    item_id: &str,
    command: &str,
    cwd: &str,
    status: &str,
    success: bool,
    message: &str,
) -> ToolOutput {
    let output = if success {
        ToolOutput::success(Value::String(message.into()))
    } else {
        ToolOutput::failure(Value::String(message.into()))
    };
    output.with_metadata(json!({
        "kind":"commandExecution",
        "deferItemCompletion":false,
        "item":{
            "type":"commandExecution",
            "id":item_id,
            "command":command,
            "cwd":cwd,
            "processId":null,
            "status":status,
            "commandActions":[],
            "aggregatedOutput":message,
            "exitCode":null,
            "durationMs":null,
            "source":"agent"
        }
    }))
}

fn exec_poll_output(
    item_id: &str,
    process_id: &str,
    chunks: Vec<OutputChunk>,
    result: Option<ExecResult>,
    max_output_tokens: Option<usize>,
) -> ToolOutput {
    let (output, token_count) = truncate_command_output(&chunks, max_output_tokens);
    let wall_time_seconds = result
        .as_ref()
        .map_or(0.0, |result| result.wall_time_ms as f64 / 1_000.0);
    let mut content = json!({
        "chunk_id":format!("{item_id}:{}", chunks.last().map_or(0, |chunk| chunk.cursor)),
        "wall_time_seconds":wall_time_seconds,
        "original_token_count":token_count,
        "output":output
    });
    let success = result.as_ref().is_none_or(|result| result.exit_code == 0);
    if let Some(result) = result {
        content["exit_code"] = json!(result.exit_code);
    } else {
        content["session_id"] = json!(process_id.parse::<u64>().unwrap_or_default());
    }
    let output = if success {
        ToolOutput::success(content)
    } else {
        ToolOutput::failure(content)
    };
    output.with_metadata(json!({
        "kind":"commandExecution",
        "deferItemCompletion":true
    }))
}

fn truncate_command_output(chunks: &[OutputChunk], max_tokens: Option<usize>) -> (String, usize) {
    let mut output = String::new();
    for chunk in chunks {
        let text = String::from_utf8_lossy(&chunk.bytes);
        output.push_str(&text);
    }
    let Some(max_tokens) = max_tokens else {
        let token_count = output.chars().count().div_ceil(4);
        return (output, token_count);
    };
    let token_count = output.chars().count().div_ceil(4);
    let max_chars = max_tokens.saturating_mul(4);
    if output.chars().count() <= max_chars {
        return (output, token_count);
    }
    let head = max_chars / 2;
    let tail = max_chars.saturating_sub(head);
    let prefix = output.chars().take(head).collect::<String>();
    let suffix = output
        .chars()
        .rev()
        .take(tail)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    (
        format!("{prefix}\n… output truncated …\n{suffix}"),
        token_count,
    )
}

fn resolve_exec_cwd(base: &std::path::Path, workdir: Option<&str>) -> Result<PathBuf, ToolError> {
    let cwd = workdir
        .filter(|workdir| !workdir.trim().is_empty())
        .map(PathBuf::from)
        .map_or_else(
            || base.to_path_buf(),
            |path| {
                if path.is_absolute() {
                    path
                } else {
                    base.join(path)
                }
            },
        );
    if !cwd.is_dir() {
        return Err(ToolError::InvalidCall(format!(
            "working directory does not exist: {}",
            cwd.display()
        )));
    }
    Ok(cwd)
}

fn shell_argv(command: &str, shell: Option<&str>, login: bool) -> Vec<String> {
    #[cfg(windows)]
    {
        let _ = login;
        let shell = shell.unwrap_or("powershell.exe");
        let mut argv = vec![shell.to_string()];
        if shell.to_ascii_lowercase().contains("powershell")
            || shell.to_ascii_lowercase().contains("pwsh")
        {
            argv.extend(["-NoProfile".into(), "-Command".into(), command.into()]);
        } else {
            argv.extend(["/C".into(), command.into()]);
        }
        argv
    }
    #[cfg(not(windows))]
    {
        let shell = shell
            .map(str::to_owned)
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/sh".into());
        vec![
            shell,
            if login { "-lc" } else { "-c" }.into(),
            command.into(),
        ]
    }
}

fn exec_owner(thread_id: &str, turn_id: &str) -> String {
    format!("{thread_id}/{turn_id}")
}

fn clamp_yield_time(value: u64) -> u64 {
    let value = if cfg!(windows) {
        value.max(2_000)
    } else {
        value
    };
    value.clamp(250, 30_000)
}

fn default_exec_yield_time_ms() -> u64 {
    10_000
}

fn default_write_stdin_yield_time_ms() -> u64 {
    250
}

fn exec_tool_output_schema() -> Value {
    json!({
        "type":"object",
        "properties":{
            "chunk_id":{"type":"string"},
            "wall_time_seconds":{"type":"number"},
            "exit_code":{"type":"integer"},
            "session_id":{"type":"integer"},
            "original_token_count":{"type":"integer"},
            "output":{"type":"string"}
        },
        "required":["wall_time_seconds","output"],
        "additionalProperties":false
    })
}

struct ApplyPatchHandler {
    cwd: PathBuf,
    requires_approval: bool,
    approver: Option<FileChangeApprover>,
    tracker: Mutex<TurnDiffTracker>,
}

impl ToolHandler for ApplyPatchHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("apply_patch")
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec::hosted(
            self.tool_name(),
            json!({
                "type":"custom",
                "name":"apply_patch",
                "description":"The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
                "format":{
                    "type":"grammar",
                    "syntax":"lark",
                    "definition":APPLY_PATCH_LARK_GRAMMAR
                }
            }),
        )
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        let cwd = self.cwd.clone();
        let requires_approval = self.requires_approval;
        let approver = self.approver.clone();
        let tracker = &self.tracker;
        Box::pin(async move {
            let ToolPayload::Custom { input } = &invocation.call.payload else {
                return Err(ToolError::InvalidCall(
                    "apply_patch requires freeform patch input".into(),
                ));
            };
            let plan = match PatchPlan::preview(&cwd, input) {
                Ok(plan) => plan,
                Err(error) => {
                    return Ok(file_change_output(
                        &invocation.call.call_id,
                        Vec::new(),
                        "failed",
                        None,
                        false,
                        error.to_string(),
                    ));
                }
            };
            let changes = plan.changes().to_vec();
            if requires_approval {
                let Some(approver) = approver else {
                    return Ok(file_change_output(
                        &invocation.call.call_id,
                        changes,
                        "failed",
                        None,
                        false,
                        "file change approval channel is unavailable".into(),
                    ));
                };
                let decision = approver(FileChangeApprovalRequest {
                    thread_id: invocation.thread_id.clone(),
                    turn_id: invocation.turn_id.clone(),
                    item_id: invocation.call.call_id.clone(),
                    reason: Some("apply patch to workspace files".into()),
                    grant_root: None,
                    cancellation: invocation.cancellation.clone(),
                })
                .await?;
                if matches!(
                    decision,
                    FileChangeApprovalDecision::Decline | FileChangeApprovalDecision::Cancel
                ) {
                    if decision == FileChangeApprovalDecision::Cancel {
                        invocation.cancellation.cancel();
                    }
                    return Ok(file_change_output(
                        &invocation.call.call_id,
                        changes,
                        "declined",
                        None,
                        false,
                        "Patch declined by user.".into(),
                    ));
                }
            }
            let applied = match plan.apply() {
                Ok(applied) => applied,
                Err(error) => {
                    return Ok(file_change_output(
                        &invocation.call.call_id,
                        changes,
                        "failed",
                        None,
                        false,
                        error.to_string(),
                    ));
                }
            };
            let turn_diff = tracker
                .lock()
                .map_err(|_| ToolError::Handler("turn diff state lock poisoned".into()))?
                .record(&plan);
            Ok(file_change_output(
                &invocation.call.call_id,
                applied.changes,
                "completed",
                Some(turn_diff),
                true,
                applied.summary,
            ))
        })
    }
}

fn file_change_output(
    item_id: &str,
    changes: Vec<tietiezhi_agent_patch::FileUpdateChange>,
    status: &str,
    turn_diff: Option<String>,
    success: bool,
    content: String,
) -> ToolOutput {
    let output = if success {
        ToolOutput::success(Value::String(content))
    } else {
        ToolOutput::failure(Value::String(content))
    };
    output.with_metadata(json!({
        "kind":"fileChange",
        "item":{
            "type":"fileChange",
            "id":item_id,
            "changes":changes,
            "status":status
        },
        "turnDiff":turn_diff
    }))
}

struct CurrentTimeHandler;

impl ToolHandler for CurrentTimeHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::namespaced("clock", "curr_time")
    }

    fn spec(&self) -> ToolSpec {
        let mut spec = ToolSpec::function(
            self.tool_name(),
            "Return the current time in UTC.",
            empty_object_schema(),
        );
        spec.namespace_description = Some("Tools for reading and waiting on time.".into());
        spec.output_schema = Some(json!({
            "type":"object",
            "properties":{"current_time":{
                "type":"string",
                "description":"Current UTC time formatted as YYYY-MM-DD HH:MM:SS UTC."
            }},
            "required":["current_time"],
            "additionalProperties":false
        }));
        spec
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            require_function_payload(&invocation, "curr_time")?;
            let current_time = Utc::now()
                .to_rfc3339_opts(SecondsFormat::Secs, true)
                .replace('T', " ");
            Ok(ToolOutput::success(Value::String(format!(
                "It is {}.",
                current_time.replace('Z', " UTC")
            ))))
        })
    }
}

struct ContextRemainingHandler {
    provider: ContextRemainingProvider,
}

impl ToolHandler for ContextRemainingHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("get_context_remaining")
    }

    fn spec(&self) -> ToolSpec {
        let mut spec = ToolSpec::function(
            self.tool_name(),
            "Get the remaining tokens in the current context window.",
            empty_object_schema(),
        );
        spec.output_schema = Some(json!({
            "type":"object",
            "properties":{"tokens_left":{
                "anyOf":[{"type":"integer"},{"type":"null"}],
                "description":"Remaining tokens in the current context window, or null when unavailable."
            }},
            "required":["tokens_left"],
            "additionalProperties":false
        }));
        spec
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        let provider = Arc::clone(&self.provider);
        Box::pin(async move {
            require_function_payload(&invocation, "get_context_remaining")?;
            let tokens_left = provider(&invocation.thread_id, &invocation.turn_id);
            let text = match tokens_left {
                Some(tokens_left) => {
                    format!("You have {tokens_left} tokens left in this context window.")
                }
                None => "You have unknown tokens left in this context window.".into(),
            };
            Ok(ToolOutput::success(Value::String(text)))
        })
    }
}

struct SleepHandler;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SleepArgs {
    duration_ms: u64,
}

impl ToolHandler for SleepHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::namespaced("clock", "sleep")
    }

    fn spec(&self) -> ToolSpec {
        let mut spec = ToolSpec::function(
            self.tool_name(),
            "Pause execution for a specified duration. The sleep ends early when new input arrives for the active turn. Returns the elapsed wall-clock time.",
            json!({
                "type":"object",
                "properties":{
                    "duration_ms":{
                        "type":"number",
                        "description":format!("How long to sleep in milliseconds. Must be between 1 and {MAX_SLEEP_DURATION_MS}.")
                    }
                },
                "required":["duration_ms"],
                "additionalProperties":false
            }),
        );
        spec.namespace_description = Some("Tools for reading and waiting on time.".into());
        spec
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            let args: SleepArgs = parse_function_args(&invocation, "sleep")?;
            if !(1..=MAX_SLEEP_DURATION_MS).contains(&args.duration_ms) {
                return Err(ToolError::Handler(format!(
                    "duration_ms must be between 1 and {MAX_SLEEP_DURATION_MS}"
                )));
            }
            let started = Instant::now();
            let interrupted = tokio::select! {
                () = tokio::time::sleep(Duration::from_millis(args.duration_ms)) => false,
                () = invocation.cancellation.cancelled() => true,
                () = invocation.input_activity.cancelled() => true,
            };
            let message = if interrupted {
                "Sleep interrupted by new input."
            } else {
                "Sleep completed."
            };
            Ok(ToolOutput::success(Value::String(format!(
                "Wall time: {:.4} seconds\n{message}",
                started.elapsed().as_secs_f64()
            ))))
        })
    }
}

struct ViewImageHandler {
    cwd: PathBuf,
    allow_original: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewImageArgs {
    path: String,
    detail: Option<String>,
}

impl ToolHandler for ViewImageHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("view_image")
    }

    fn spec(&self) -> ToolSpec {
        let mut properties = serde_json::Map::from_iter([(
            "path".into(),
            json!({"type":"string","description":"Local filesystem path to an image file."}),
        )]);
        if self.allow_original {
            properties.insert(
                "detail".into(),
                json!({
                    "type":"string",
                    "enum":["high","original"],
                    "description":"Image detail level. Defaults to high."
                }),
            );
        }
        let mut spec = ToolSpec::function(
            self.tool_name(),
            "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
            json!({
                "type":"object",
                "properties":properties,
                "required":["path"],
                "additionalProperties":false
            }),
        );
        spec.output_schema = Some(json!({
            "type":"object",
            "properties":{
                "image_url":{
                    "type":"string",
                    "description":"Data URL for the loaded image."
                },
                "detail":{
                    "type":"string",
                    "enum":["high","original"],
                    "description":"Image detail hint returned by view_image. Returns `high` for default resized behavior or `original` when original resolution is preserved."
                }
            },
            "required":["image_url","detail"],
            "additionalProperties":false
        }));
        spec
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        let cwd = self.cwd.clone();
        let allow_original = self.allow_original;
        Box::pin(async move {
            let args: ViewImageArgs = parse_function_args(&invocation, "view_image")?;
            let detail = match args.detail.as_deref() {
                None | Some("high") => "high",
                Some("original") if allow_original => "original",
                Some("original") => {
                    return Err(ToolError::Handler(
                        "original image detail is unavailable for this model".into(),
                    ));
                }
                Some(other) => {
                    return Err(ToolError::Handler(format!(
                        "view_image.detail only supports high or original, got {other}"
                    )));
                }
            };
            let path = PathBuf::from(args.path);
            let path = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };
            let metadata = tokio::fs::metadata(&path)
                .await
                .map_err(|error| ToolError::Handler(format!("unable to locate image: {error}")))?;
            if !metadata.is_file() {
                return Err(ToolError::Handler("image path is not a file".into()));
            }
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|error| ToolError::Handler(format!("unable to read image: {error}")))?;
            let image_url = format!(
                "data:application/octet-stream;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            );
            Ok(ToolOutput::success(json!([{
                "type":"input_image",
                "image_url":image_url,
                "detail":detail
            }])))
        })
    }
}

struct HostedWebSearchHandler;

impl ToolHandler for HostedWebSearchHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("web_search")
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec::hosted(self.tool_name(), json!({"type":"web_search"}))
    }

    fn matches_payload(&self, _payload: &ToolPayload) -> bool {
        false
    }

    fn handle(&self, _invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async {
            Err(ToolError::Handler(
                "web_search is executed by the model provider".into(),
            ))
        })
    }
}

struct ToolSearchHandler {
    specs: Vec<ToolSpec>,
    spec: ToolSpec,
    engine: SearchEngine<usize>,
}

impl ToolSearchHandler {
    fn new(specs: Vec<ToolSpec>, source_descriptions: Vec<(String, Option<String>)>) -> Self {
        let documents = specs
            .iter()
            .enumerate()
            .map(|(index, spec)| {
                Document::new(
                    index,
                    format!(
                        "{} {} {}",
                        spec.name.display_name(),
                        spec.description,
                        spec.input_schema
                    ),
                )
            })
            .collect::<Vec<_>>();
        let engine = SearchEngineBuilder::with_documents(Language::English, documents).build();
        let mut unique_sources = BTreeMap::new();
        for (name, description) in source_descriptions {
            unique_sources
                .entry(name)
                .and_modify(|existing: &mut Option<String>| {
                    if existing.is_none() {
                        *existing = description.clone();
                    }
                })
                .or_insert(description);
        }
        let sources = if unique_sources.is_empty() {
            "None currently enabled.".into()
        } else {
            unique_sources
                .into_iter()
                .map(|(name, description)| match description {
                    Some(description) => format!("- {name}: {description}"),
                    None => format!("- {name}"),
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let description = format!(
            "# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nYou have access to tools from the following sources:\n{sources}\nSome of the tools may not have been provided to you upfront, and you should use this tool (`tool_search`) to search for the required tools. For MCP tool discovery, always use `tool_search` instead of `list_mcp_resources` or `list_mcp_resource_templates`."
        );
        let spec = ToolSpec::hosted(
            ToolName::plain("tool_search"),
            json!({
                "type":"tool_search",
                "execution":"client",
                "description":description,
                "parameters":{
                    "type":"object",
                    "properties":{
                        "query":{"type":"string","description":"Search query for deferred tools."},
                        "limit":{"type":"number","description":format!("Maximum number of tools to return. Defaults to {TOOL_SEARCH_DEFAULT_LIMIT}.")}
                    },
                    "required":["query"],
                    "additionalProperties":false
                }
            }),
        );
        Self {
            specs,
            spec,
            engine,
        }
    }
}

impl ToolHandler for ToolSearchHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("tool_search")
    }

    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn matches_payload(&self, payload: &ToolPayload) -> bool {
        matches!(payload, ToolPayload::ToolSearch { .. })
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            let ToolPayload::ToolSearch { arguments } = &invocation.call.payload else {
                return Err(ToolError::InvalidCall(
                    "tool_search requires a search payload".into(),
                ));
            };
            let query = arguments
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|query| !query.is_empty())
                .ok_or_else(|| ToolError::Handler("query must not be empty".into()))?;
            let limit = arguments
                .get("limit")
                .and_then(Value::as_u64)
                .map(|limit| limit as usize)
                .unwrap_or(TOOL_SEARCH_DEFAULT_LIMIT);
            if limit == 0 {
                return Err(ToolError::Handler("limit must be greater than zero".into()));
            }
            let selected = self
                .engine
                .search(query, limit)
                .into_iter()
                .filter_map(|result| self.specs.get(result.document.id))
                .cloned()
                .collect::<Vec<_>>();
            Ok(ToolOutput::success(Value::Array(wire_specs(selected))))
        })
    }
}

fn empty_object_schema() -> Value {
    json!({
        "type":"object",
        "properties":{},
        "additionalProperties":false
    })
}

fn require_function_payload(invocation: &ToolInvocation, tool_name: &str) -> Result<(), ToolError> {
    if matches!(invocation.call.payload, ToolPayload::Function { .. }) {
        Ok(())
    } else {
        Err(ToolError::InvalidCall(format!(
            "{tool_name} requires a function payload"
        )))
    }
}

fn parse_function_args<T: for<'de> Deserialize<'de>>(
    invocation: &ToolInvocation,
    tool_name: &str,
) -> Result<T, ToolError> {
    let ToolPayload::Function { arguments } = &invocation.call.payload else {
        return Err(ToolError::InvalidCall(format!(
            "{tool_name} requires function arguments"
        )));
    };
    serde_json::from_str(arguments)
        .map_err(|error| ToolError::Handler(format!("invalid {tool_name} arguments: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ToolCall, ToolCallRuntime, ToolRegistry, ToolRouter};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    fn invocation(name: ToolName, arguments: Value) -> ToolInvocation {
        ToolInvocation {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            call: ToolCall {
                tool_name: name,
                call_id: "call".into(),
                payload: ToolPayload::Function {
                    arguments: arguments.to_string(),
                },
            },
            cancellation: CancellationToken::new(),
            input_activity: CancellationToken::new(),
        }
    }

    fn patch_invocation(patch: impl Into<String>) -> ToolInvocation {
        ToolInvocation {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            call: ToolCall {
                tool_name: ToolName::plain("apply_patch"),
                call_id: "patch-call".into(),
                payload: ToolPayload::Custom {
                    input: patch.into(),
                },
            },
            cancellation: CancellationToken::new(),
            input_activity: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn current_time_and_context_remaining_match_codex_fragments() {
        let time = current_time_handler()
            .handle(invocation(
                ToolName::namespaced("clock", "curr_time"),
                json!({}),
            ))
            .await
            .unwrap();
        assert!(time.content.as_str().unwrap().starts_with("It is "));
        assert!(time.content.as_str().unwrap().ends_with(" UTC."));
        let context = context_remaining_handler(Arc::new(|_, _| Some(42)))
            .handle(invocation(
                ToolName::plain("get_context_remaining"),
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(
            context.content,
            "You have 42 tokens left in this context window."
        );
    }

    #[tokio::test]
    async fn sleep_is_bounded_and_cancellable() {
        let input_activity = CancellationToken::new();
        input_activity.cancel();
        let mut invocation = invocation(
            ToolName::namespaced("clock", "sleep"),
            json!({"duration_ms":1000}),
        );
        invocation.input_activity = input_activity;
        let output = sleep_handler().handle(invocation).await.unwrap();
        assert!(
            output
                .content
                .as_str()
                .unwrap()
                .contains("interrupted by new input")
        );
    }

    #[tokio::test]
    async fn view_image_returns_structured_image_content() {
        let temp = TempDir::new().unwrap();
        tokio::fs::write(temp.path().join("image.bin"), b"image")
            .await
            .unwrap();
        let output = view_image_handler(temp.path().to_path_buf(), true)
            .handle(invocation(
                ToolName::plain("view_image"),
                json!({"path":"image.bin","detail":"original"}),
            ))
            .await
            .unwrap();
        assert_eq!(output.content[0]["type"], "input_image");
        assert_eq!(output.content[0]["detail"], "original");
    }

    #[tokio::test]
    async fn tool_search_uses_bm25_and_returns_deferred_wire_specs() {
        let deferred = vec![
            ToolSpec::function(
                ToolName::plain("calendar_create"),
                "Create calendar event",
                empty_object_schema(),
            ),
            ToolSpec::function(
                ToolName::plain("box_upload"),
                "Upload file to Box",
                empty_object_schema(),
            ),
        ];
        let handler = tool_search_handler(deferred, vec![("apps".into(), None)]);
        let output = handler
            .handle(ToolInvocation {
                thread_id: "thread".into(),
                turn_id: "turn".into(),
                call: ToolCall {
                    tool_name: ToolName::plain("tool_search"),
                    call_id: "search".into(),
                    payload: ToolPayload::ToolSearch {
                        arguments: json!({"query":"calendar event","limit":1}),
                    },
                },
                cancellation: CancellationToken::new(),
                input_activity: CancellationToken::new(),
            })
            .await
            .unwrap();
        assert_eq!(output.content[0]["name"], "calendar_create");
    }

    #[tokio::test]
    async fn apply_patch_uses_freeform_wire_and_returns_file_change_metadata() {
        let temp = TempDir::new().unwrap();
        let handler = apply_patch_handler(temp.path().to_path_buf(), false, None).unwrap();
        assert_eq!(handler.spec().wire_override.unwrap()["type"], "custom");
        let output = handler
            .handle(patch_invocation(
                "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch",
            ))
            .await
            .unwrap();
        assert!(output.success);
        assert_eq!(
            tokio::fs::read_to_string(temp.path().join("hello.txt"))
                .await
                .unwrap(),
            "hello\n"
        );
        let metadata = output.metadata.unwrap();
        assert_eq!(metadata["item"]["type"], "fileChange");
        assert_eq!(metadata["item"]["status"], "completed");
        assert!(metadata["turnDiff"].as_str().unwrap().contains("hello"));
    }

    #[tokio::test]
    async fn apply_patch_decline_does_not_write() {
        let temp = TempDir::new().unwrap();
        let approver: FileChangeApprover =
            Arc::new(|_| Box::pin(async { Ok(FileChangeApprovalDecision::Decline) }));
        let handler = apply_patch_handler(temp.path().to_path_buf(), true, Some(approver)).unwrap();
        let output = handler
            .handle(patch_invocation(
                "*** Begin Patch\n*** Add File: denied.txt\n+no\n*** End Patch",
            ))
            .await
            .unwrap();
        assert!(!output.success);
        assert!(!temp.path().join("denied.txt").exists());
        assert_eq!(output.metadata.unwrap()["item"]["status"], "declined");
    }

    #[tokio::test]
    async fn unified_exec_runs_and_emits_command_lifecycle() {
        let temp = TempDir::new().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = events.clone();
        let handlers = unified_exec_handlers(
            ExecManager::default(),
            temp.path().to_path_buf(),
            false,
            None,
            Arc::new(move |event| {
                observed.lock().unwrap().push(event);
                Ok(())
            }),
        );
        let output = handlers[0]
            .handle(invocation(
                ToolName::plain("exec_command"),
                if cfg!(windows) {
                    json!({"cmd":"Write-Output hello","yield_time_ms":2000})
                } else {
                    json!({"cmd":"printf hello","yield_time_ms":2000})
                },
            ))
            .await
            .unwrap();
        assert!(output.success);
        assert_eq!(output.content["exit_code"], 0);
        assert!(output.content["output"].as_str().unwrap().contains("hello"));
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|event| matches!(event, CommandRuntimeEvent::Exited { .. }))
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn unified_exec_background_session_accepts_stdin() {
        let temp = TempDir::new().unwrap();
        let handlers = unified_exec_handlers(
            ExecManager::default(),
            temp.path().to_path_buf(),
            false,
            None,
            Arc::new(|_| Ok(())),
        );
        let output = handlers[0]
            .handle(invocation(
                ToolName::plain("exec_command"),
                if cfg!(windows) {
                    json!({"cmd":"$line=Read-Host; Write-Output $line","yield_time_ms":250})
                } else {
                    json!({"cmd":"read line; printf '%s' \"$line\"","yield_time_ms":250})
                },
            ))
            .await
            .unwrap();
        let session_id = output.content["session_id"].as_u64().unwrap();
        let output = handlers[1]
            .handle(invocation(
                ToolName::plain("write_stdin"),
                json!({"session_id":session_id,"chars":"hello\n","yield_time_ms":2000}),
            ))
            .await
            .unwrap();
        assert_eq!(output.content["exit_code"], 0);
        assert!(output.content["output"].as_str().unwrap().contains("hello"));
    }

    #[tokio::test]
    async fn unified_exec_decline_never_spawns() {
        let temp = TempDir::new().unwrap();
        let approver: CommandApprover =
            Arc::new(|_| Box::pin(async { Ok(CommandExecutionApprovalDecision::Decline) }));
        let handlers = unified_exec_handlers(
            ExecManager::default(),
            temp.path().to_path_buf(),
            true,
            Some(approver),
            Arc::new(|_| Ok(())),
        );
        let output = handlers[0]
            .handle(invocation(
                ToolName::plain("exec_command"),
                json!({"cmd":"this-command-must-not-run"}),
            ))
            .await
            .unwrap();
        assert!(!output.success);
        assert_eq!(output.metadata.unwrap()["item"]["status"], "declined");
    }

    #[test]
    fn registry_coalesces_clock_namespace_and_hosted_search() {
        let registry = ToolRegistry::new(
            [
                current_time_handler(),
                sleep_handler(),
                web_search_handler(),
            ],
            Vec::new(),
        )
        .unwrap();
        let wire = registry.model_visible_wire_specs();
        assert!(wire.iter().any(|tool| tool["type"] == "web_search"));
        let clock = wire
            .iter()
            .find(|tool| tool["type"] == "namespace")
            .unwrap();
        assert_eq!(clock["name"], "clock");
        assert_eq!(clock["tools"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn builtins_execute_through_the_shared_runtime() {
        let calls = Arc::new(AtomicUsize::new(0));
        let context_calls = Arc::clone(&calls);
        let registry = ToolRegistry::new(
            [
                current_time_handler(),
                context_remaining_handler(Arc::new(move |_, _| {
                    context_calls.fetch_add(1, Ordering::SeqCst);
                    Some(9)
                })),
            ],
            Vec::new(),
        )
        .unwrap();
        let runtime = ToolCallRuntime::new(Arc::new(ToolRouter::new(registry)));
        let response = runtime
            .handle_model_call(
                "thread",
                "turn",
                ToolCall {
                    tool_name: ToolName::plain("get_context_remaining"),
                    call_id: "call".into(),
                    payload: ToolPayload::Function {
                        arguments: "{}".into(),
                    },
                },
                CancellationToken::new(),
            )
            .await;
        assert_eq!(response["type"], "function_call_output");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
