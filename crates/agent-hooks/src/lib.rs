//! Codex-compatible command Hook discovery, execution, and output parsing.
//!
//! This is a source-level implementation aligned with OpenAI Codex
//! `rust-v0.145.0`; it never invokes or embeds the upstream executable.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;
use uuid::Uuid;

const DEFAULT_TIMEOUT_SECONDS: u64 = 10;
const MAX_TIMEOUT_SECONDS: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookEventName {
    PreToolUse,
    PermissionRequest,
    PostToolUse,
    PreCompact,
    PostCompact,
    SessionStart,
    SessionEnd,
    UserPromptSubmit,
    SubagentStart,
    SubagentStop,
    Stop,
}

impl HookEventName {
    pub fn config_name(self) -> &'static str {
        match self {
            Self::PreToolUse => "PreToolUse",
            Self::PermissionRequest => "PermissionRequest",
            Self::PostToolUse => "PostToolUse",
            Self::PreCompact => "PreCompact",
            Self::PostCompact => "PostCompact",
            Self::SessionStart => "SessionStart",
            Self::SessionEnd => "SessionEnd",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::SubagentStart => "SubagentStart",
            Self::SubagentStop => "SubagentStop",
            Self::Stop => "Stop",
        }
    }

    fn scope(self) -> HookScope {
        match self {
            Self::SessionStart | Self::SessionEnd => HookScope::Thread,
            _ => HookScope::Turn,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookScope {
    Thread,
    Turn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookSource {
    System,
    User,
    Project,
    Mdm,
    SessionFlags,
    Plugin,
    CloudRequirements,
    CloudManagedConfig,
    LegacyManagedConfigFile,
    LegacyManagedConfigMdm,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookHandlerType {
    Command,
    Prompt,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookExecutionMode {
    Sync,
    Async,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookRunStatus {
    Running,
    Completed,
    Failed,
    Blocked,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookOutputEntry {
    pub kind: HookOutputEntryKind,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookOutputEntryKind {
    Warning,
    Stop,
    Feedback,
    Context,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRunSummary {
    pub id: String,
    pub event_name: HookEventName,
    pub handler_type: HookHandlerType,
    pub execution_mode: HookExecutionMode,
    pub scope: HookScope,
    pub source_path: PathBuf,
    pub source: HookSource,
    pub display_order: i64,
    pub status: HookRunStatus,
    pub status_message: Option<String>,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub entries: Vec<HookOutputEntry>,
}

#[derive(Debug, Clone)]
pub struct HookRequest {
    pub event_name: HookEventName,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub cwd: PathBuf,
    pub matcher: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, Default)]
pub struct HookDispatch {
    pub runs: Vec<HookRun>,
    pub additional_context: Vec<HookContext>,
    pub blocked_reason: Option<String>,
    pub updated_input: Option<Value>,
    pub permission_decision: Option<PermissionDecision>,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HookRun {
    pub started: HookRunSummary,
    pub completed: HookRunSummary,
    pub additional_context: Option<String>,
    pub blocked_reason: Option<String>,
    pub updated_input: Option<Value>,
    pub permission_decision: Option<PermissionDecision>,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HookContext {
    pub run_id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision {
    Allow,
    Deny(String),
}

#[derive(Debug, Clone)]
pub struct HookPaths {
    pub system: Option<PathBuf>,
    pub user: Option<PathBuf>,
    pub trust_state: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HooksListResponse {
    pub data: Vec<HooksListEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HooksListEntry {
    pub cwd: PathBuf,
    pub hooks: Vec<HookMetadata>,
    pub warnings: Vec<String>,
    pub errors: Vec<HookErrorInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookErrorInfo {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookTrustStatus {
    Managed,
    Untrusted,
    Trusted,
    Modified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookMetadata {
    pub key: String,
    pub event_name: HookEventName,
    pub handler_type: HookHandlerType,
    pub matcher: Option<String>,
    pub command: Option<String>,
    pub timeout_sec: u64,
    pub status_message: Option<String>,
    pub additional_context_limit: Option<usize>,
    pub source_path: PathBuf,
    pub source: HookSource,
    pub plugin_id: Option<String>,
    pub display_order: i64,
    pub enabled: bool,
    pub is_managed: bool,
    pub current_hash: String,
    pub trust_status: HookTrustStatus,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HooksFile {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub hooks: HookEvents,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookEvents {
    #[serde(rename = "PreToolUse", default)]
    pub pre_tool_use: Vec<MatcherGroup>,
    #[serde(rename = "PermissionRequest", default)]
    pub permission_request: Vec<MatcherGroup>,
    #[serde(rename = "PostToolUse", default)]
    pub post_tool_use: Vec<MatcherGroup>,
    #[serde(rename = "PreCompact", default)]
    pub pre_compact: Vec<MatcherGroup>,
    #[serde(rename = "PostCompact", default)]
    pub post_compact: Vec<MatcherGroup>,
    #[serde(rename = "SessionStart", default)]
    pub session_start: Vec<MatcherGroup>,
    #[serde(rename = "SessionEnd", default)]
    pub session_end: Vec<MatcherGroup>,
    #[serde(rename = "UserPromptSubmit", default)]
    pub user_prompt_submit: Vec<MatcherGroup>,
    #[serde(rename = "SubagentStart", default)]
    pub subagent_start: Vec<MatcherGroup>,
    #[serde(rename = "SubagentStop", default)]
    pub subagent_stop: Vec<MatcherGroup>,
    #[serde(rename = "Stop", default)]
    pub stop: Vec<MatcherGroup>,
}

impl HookEvents {
    fn groups(&self, event: HookEventName) -> &[MatcherGroup] {
        match event {
            HookEventName::PreToolUse => &self.pre_tool_use,
            HookEventName::PermissionRequest => &self.permission_request,
            HookEventName::PostToolUse => &self.post_tool_use,
            HookEventName::PreCompact => &self.pre_compact,
            HookEventName::PostCompact => &self.post_compact,
            HookEventName::SessionStart => &self.session_start,
            HookEventName::SessionEnd => &self.session_end,
            HookEventName::UserPromptSubmit => &self.user_prompt_submit,
            HookEventName::SubagentStart => &self.subagent_start,
            HookEventName::SubagentStop => &self.subagent_stop,
            HookEventName::Stop => &self.stop,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MatcherGroup {
    #[serde(default)]
    pub matcher: Option<String>,
    #[serde(default)]
    pub hooks: Vec<HookHandlerConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum HookHandlerConfig {
    #[serde(rename = "command")]
    Command {
        command: String,
        #[serde(default, rename = "commandWindows", alias = "command_windows")]
        command_windows: Option<String>,
        #[serde(default, rename = "timeout")]
        timeout_seconds: Option<u64>,
        #[serde(default, rename = "async")]
        asynchronous: bool,
        #[serde(default, rename = "statusMessage")]
        status_message: Option<String>,
        #[serde(default, rename = "additionalContextLimit")]
        additional_context_limit: Option<usize>,
    },
    #[serde(rename = "prompt")]
    Prompt {},
    #[serde(rename = "agent")]
    Agent {},
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustState {
    #[serde(default)]
    trusted_hashes: BTreeSet<String>,
    #[serde(default)]
    disabled_handlers: BTreeSet<String>,
    #[serde(default)]
    allow_managed_hooks_only: bool,
}

#[derive(Debug, Clone)]
struct ConfigSource {
    path: PathBuf,
    source: HookSource,
    trusted: bool,
    file: HooksFile,
}

#[derive(Clone)]
pub struct HookEngine {
    inner: Arc<HookEngineInner>,
}

struct HookEngineInner {
    paths: HookPaths,
    session_started: Mutex<BTreeSet<String>>,
    extra_sources: Mutex<Vec<(PathBuf, HookSource, bool)>>,
    allow_managed_hooks_only: Mutex<bool>,
}

impl HookEngine {
    pub fn new(paths: HookPaths) -> Self {
        Self {
            inner: Arc::new(HookEngineInner {
                paths,
                session_started: Mutex::new(BTreeSet::new()),
                extra_sources: Mutex::new(Vec::new()),
                allow_managed_hooks_only: Mutex::new(false),
            }),
        }
    }

    pub fn mark_session_start(&self, thread_id: &str) -> bool {
        self.inner
            .session_started
            .lock()
            .map(|mut started| started.insert(thread_id.to_owned()))
            .unwrap_or(false)
    }

    pub fn end_session(&self, thread_id: &str) {
        if let Ok(mut started) = self.inner.session_started.lock() {
            started.remove(thread_id);
        }
    }

    pub fn set_extra_sources(&self, sources: Vec<(PathBuf, HookSource, bool)>) {
        if let Ok(mut current) = self.inner.extra_sources.lock() {
            *current = sources;
        }
    }

    pub fn set_allow_managed_hooks_only(&self, enabled: bool) {
        if let Ok(mut current) = self.inner.allow_managed_hooks_only.lock() {
            *current = enabled;
        }
    }

    /// Resolves the effective Hook catalog for each working directory using
    /// the same source precedence and trust state as execution.
    pub fn list(&self, cwds: &[PathBuf]) -> HooksListResponse {
        let cwds = if cwds.is_empty() {
            vec![std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))]
        } else {
            cwds.to_vec()
        };
        let mut data = Vec::with_capacity(cwds.len());
        for cwd in cwds {
            let absolute_cwd = absolute_path(&cwd);
            match self.discover(&absolute_cwd) {
                Ok(sources) => data.push(HooksListEntry {
                    cwd: absolute_cwd,
                    hooks: self.source_metadata(sources),
                    warnings: Vec::new(),
                    errors: Vec::new(),
                }),
                Err(message) => data.push(HooksListEntry {
                    cwd: absolute_cwd.clone(),
                    hooks: Vec::new(),
                    warnings: Vec::new(),
                    errors: vec![HookErrorInfo {
                        path: absolute_cwd,
                        message,
                    }],
                }),
            }
        }
        HooksListResponse { data }
    }

    fn source_metadata(&self, sources: Vec<ConfigSource>) -> Vec<HookMetadata> {
        let state = self.load_trust_state();
        let mut metadata = Vec::new();
        let mut display_order = 0_i64;
        for source in sources {
            let current_hash = config_hash(&source.path).unwrap_or_default();
            let is_managed = managed_source(source.source);
            let trust_status = if is_managed {
                HookTrustStatus::Managed
            } else if source.trusted {
                HookTrustStatus::Trusted
            } else {
                HookTrustStatus::Untrusted
            };
            for event_name in ALL_HOOK_EVENTS {
                for (group_index, group) in source.file.hooks.groups(event_name).iter().enumerate()
                {
                    for (handler_index, handler) in group.hooks.iter().enumerate() {
                        let key = format!(
                            "{}:{}:{group_index}:{handler_index}",
                            source.path.display(),
                            event_name.config_name()
                        );
                        let (
                            handler_type,
                            command,
                            timeout_sec,
                            status_message,
                            additional_context_limit,
                        ) = match handler {
                            HookHandlerConfig::Command {
                                command,
                                timeout_seconds,
                                status_message,
                                additional_context_limit,
                                ..
                            } => (
                                HookHandlerType::Command,
                                Some(command.clone()),
                                timeout_seconds
                                    .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
                                    .min(MAX_TIMEOUT_SECONDS),
                                status_message.clone(),
                                *additional_context_limit,
                            ),
                            HookHandlerConfig::Prompt {} => (
                                HookHandlerType::Prompt,
                                None,
                                DEFAULT_TIMEOUT_SECONDS,
                                None,
                                None,
                            ),
                            HookHandlerConfig::Agent {} => (
                                HookHandlerType::Agent,
                                None,
                                DEFAULT_TIMEOUT_SECONDS,
                                None,
                                None,
                            ),
                        };
                        let enabled = source.trusted && !state.disabled_handlers.contains(&key);
                        metadata.push(HookMetadata {
                            key,
                            event_name,
                            handler_type,
                            matcher: group.matcher.clone(),
                            command,
                            timeout_sec,
                            status_message,
                            additional_context_limit,
                            source_path: absolute_path(&source.path),
                            source: source.source,
                            plugin_id: None,
                            display_order,
                            enabled,
                            is_managed,
                            current_hash: current_hash.clone(),
                            trust_status,
                        });
                        display_order += 1;
                    }
                }
            }
        }
        metadata
    }

    pub fn trust_project_config(&self, path: &Path) -> Result<String, String> {
        let hash = config_hash(path)?;
        let mut state = self.load_trust_state();
        state.trusted_hashes.insert(hash.clone());
        atomic_write_json(&self.inner.paths.trust_state, &state)?;
        Ok(hash)
    }

    pub async fn dispatch(&self, request: HookRequest) -> HookDispatch {
        let mut dispatch = HookDispatch::default();
        let sources = match self.discover(&request.cwd) {
            Ok(sources) => sources,
            Err(error) => {
                dispatch.stop_reason = Some(error);
                return dispatch;
            }
        };
        let mut display_order = 0_i64;
        for source in sources {
            if !source.trusted {
                continue;
            }
            for (group_index, group) in source
                .file
                .hooks
                .groups(request.event_name)
                .iter()
                .enumerate()
            {
                if !matches_hook(group.matcher.as_deref(), request.matcher.as_deref()) {
                    continue;
                }
                for (handler_index, handler) in group.hooks.iter().enumerate() {
                    let key = format!(
                        "{}:{}:{group_index}:{handler_index}",
                        source.path.display(),
                        request.event_name.config_name()
                    );
                    if self.load_trust_state().disabled_handlers.contains(&key) {
                        continue;
                    }
                    let run = run_handler(&source, handler, &request, display_order).await;
                    display_order += 1;
                    merge_outcome(&mut dispatch, &run);
                    let should_stop = matches!(
                        run.completed.status,
                        HookRunStatus::Blocked | HookRunStatus::Stopped
                    );
                    dispatch.runs.push(run);
                    if should_stop {
                        return dispatch;
                    }
                }
            }
        }
        dispatch
    }

    fn discover(&self, cwd: &Path) -> Result<Vec<ConfigSource>, String> {
        let state = self.load_trust_state();
        let mut sources = Vec::new();
        if let Some(path) = &self.inner.paths.system {
            push_source(&mut sources, path, HookSource::System, true)?;
        }
        let managed_only = state.allow_managed_hooks_only
            || self
                .inner
                .allow_managed_hooks_only
                .lock()
                .map(|enabled| *enabled)
                .unwrap_or(true);
        if !managed_only {
            if let Some(path) = &self.inner.paths.user {
                push_source(&mut sources, path, HookSource::User, true)?;
            }
            for path in project_hook_paths(cwd) {
                let trusted = config_hash(&path)
                    .ok()
                    .is_some_and(|hash| state.trusted_hashes.contains(&hash));
                push_source(&mut sources, &path, HookSource::Project, trusted)?;
            }
            if let Ok(extra) = self.inner.extra_sources.lock() {
                for (path, source, trusted) in extra.iter() {
                    push_source(&mut sources, path, *source, *trusted)?;
                }
            }
        }
        Ok(sources)
    }

    fn load_trust_state(&self) -> TrustState {
        fs::read(&self.inner.paths.trust_state)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }
}

const ALL_HOOK_EVENTS: [HookEventName; 11] = [
    HookEventName::PreToolUse,
    HookEventName::PermissionRequest,
    HookEventName::PostToolUse,
    HookEventName::PreCompact,
    HookEventName::PostCompact,
    HookEventName::SessionStart,
    HookEventName::SessionEnd,
    HookEventName::UserPromptSubmit,
    HookEventName::SubagentStart,
    HookEventName::SubagentStop,
    HookEventName::Stop,
];

fn managed_source(source: HookSource) -> bool {
    matches!(
        source,
        HookSource::System
            | HookSource::Mdm
            | HookSource::CloudRequirements
            | HookSource::CloudManagedConfig
            | HookSource::LegacyManagedConfigFile
            | HookSource::LegacyManagedConfigMdm
    )
}

fn absolute_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        }
    })
}

fn push_source(
    sources: &mut Vec<ConfigSource>,
    path: &Path,
    source: HookSource,
    trusted: bool,
) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("read hook config {}: {error}", path.display()))?;
    let file: HooksFile = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse hook config {}: {error}", path.display()))?;
    sources.push(ConfigSource {
        path: path.to_path_buf(),
        source,
        trusted,
        file,
    });
    Ok(())
}

fn project_hook_paths(cwd: &Path) -> Vec<PathBuf> {
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut ancestors = cwd.ancestors().map(Path::to_path_buf).collect::<Vec<_>>();
    let stop = ancestors
        .iter()
        .position(|path| path.join(".git").exists())
        .unwrap_or(0);
    ancestors.truncate(stop + 1);
    ancestors.reverse();
    ancestors
        .into_iter()
        .map(|path| path.join(".codex").join("hooks.json"))
        .filter(|path| path.is_file())
        .collect()
}

fn config_hash(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("read hook config {}: {error}", path.display()))?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn matches_hook(pattern: Option<&str>, target: Option<&str>) -> bool {
    let Some(pattern) = pattern.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let target = target.unwrap_or_default();
    Regex::new(pattern)
        .map(|regex| regex.is_match(target))
        .unwrap_or(false)
}

async fn run_handler(
    source: &ConfigSource,
    handler: &HookHandlerConfig,
    request: &HookRequest,
    display_order: i64,
) -> HookRun {
    let started_at = now_ms();
    let (handler_type, execution_mode, status_message) = match handler {
        HookHandlerConfig::Command {
            asynchronous,
            status_message,
            ..
        } => (
            HookHandlerType::Command,
            if *asynchronous {
                HookExecutionMode::Async
            } else {
                HookExecutionMode::Sync
            },
            status_message.clone(),
        ),
        HookHandlerConfig::Prompt {} => (HookHandlerType::Prompt, HookExecutionMode::Sync, None),
        HookHandlerConfig::Agent {} => (HookHandlerType::Agent, HookExecutionMode::Sync, None),
    };
    let mut started = HookRunSummary {
        id: Uuid::now_v7().to_string(),
        event_name: request.event_name,
        handler_type,
        execution_mode,
        scope: request.event_name.scope(),
        source_path: source.path.clone(),
        source: source.source,
        display_order,
        status: HookRunStatus::Running,
        status_message,
        started_at,
        completed_at: None,
        duration_ms: None,
        entries: Vec::new(),
    };
    let mut outcome = ParsedOutput::default();
    let status = match handler {
        HookHandlerConfig::Command {
            command,
            command_windows,
            timeout_seconds,
            additional_context_limit,
            ..
        } => {
            let command = if cfg!(windows) {
                command_windows.as_ref().unwrap_or(command)
            } else {
                command
            };
            match execute_command(
                command,
                &request.cwd,
                request_payload(request),
                Duration::from_secs(
                    timeout_seconds
                        .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
                        .clamp(1, MAX_TIMEOUT_SECONDS),
                ),
            )
            .await
            {
                Ok(output) => {
                    outcome = parse_output(request.event_name, &output.stdout);
                    cap_context(&mut outcome, *additional_context_limit);
                    if !output.stderr.trim().is_empty() {
                        outcome.entries.push(HookOutputEntry {
                            kind: HookOutputEntryKind::Warning,
                            text: output.stderr,
                        });
                    }
                    if !output.success {
                        outcome.entries.push(HookOutputEntry {
                            kind: HookOutputEntryKind::Error,
                            text: format!("hook exited with status {}", output.exit_code),
                        });
                        HookRunStatus::Failed
                    } else if outcome.blocked_reason.is_some() {
                        HookRunStatus::Blocked
                    } else if outcome.stop_reason.is_some() || !outcome.continue_processing {
                        HookRunStatus::Stopped
                    } else if outcome.invalid_output {
                        HookRunStatus::Failed
                    } else {
                        HookRunStatus::Completed
                    }
                }
                Err(error) => {
                    outcome.entries.push(HookOutputEntry {
                        kind: HookOutputEntryKind::Error,
                        text: error,
                    });
                    HookRunStatus::Failed
                }
            }
        }
        HookHandlerConfig::Prompt {} | HookHandlerConfig::Agent {} => {
            outcome.entries.push(HookOutputEntry {
                kind: HookOutputEntryKind::Error,
                text: "prompt and agent hooks require the R26 collaboration model runner".into(),
            });
            HookRunStatus::Failed
        }
    };
    let completed_at = now_ms();
    let mut completed = started.clone();
    completed.status = status;
    completed.completed_at = Some(completed_at);
    completed.duration_ms = Some((completed_at - started_at).max(0));
    completed.entries = outcome.entries;
    started.entries.clear();
    HookRun {
        started,
        completed,
        additional_context: outcome.additional_context,
        blocked_reason: outcome.blocked_reason,
        updated_input: outcome.updated_input,
        permission_decision: outcome.permission_decision,
        stop_reason: outcome.stop_reason,
    }
}

struct CommandOutput {
    success: bool,
    exit_code: i32,
    stdout: String,
    stderr: String,
}

async fn execute_command(
    script: &str,
    cwd: &Path,
    payload: Value,
    duration: Duration,
) -> Result<CommandOutput, String> {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ]);
        command
    } else {
        let mut command = Command::new("/bin/sh");
        command.args(["-lc", script]);
        command
    };
    command
        .current_dir(cwd)
        .env(
            "CODEX_HOOK_EVENT",
            payload["hook_event_name"].as_str().unwrap_or_default(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("start hook command: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let bytes = serde_json::to_vec(&payload)
            .map_err(|error| format!("serialize hook request: {error}"))?;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|error| format!("write hook request: {error}"))?;
    }
    let output = timeout(duration, child.wait_with_output())
        .await
        .map_err(|_| format!("hook timed out after {}s", duration.as_secs()))?
        .map_err(|error| format!("wait for hook command: {error}"))?;
    let stdout = bounded_utf8(output.stdout);
    let stderr = bounded_utf8(output.stderr);
    Ok(CommandOutput {
        success: output.status.success(),
        exit_code: output.status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

fn bounded_utf8(mut bytes: Vec<u8>) -> String {
    if bytes.len() > MAX_OUTPUT_BYTES {
        bytes.truncate(MAX_OUTPUT_BYTES);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn request_payload(request: &HookRequest) -> Value {
    let mut object = match request.payload.clone() {
        Value::Object(object) => object,
        value => Map::from_iter([("payload".into(), value)]),
    };
    object.insert("session_id".into(), json!(request.thread_id));
    object.insert("thread_id".into(), json!(request.thread_id));
    object.insert("turn_id".into(), json!(request.turn_id));
    object.insert("cwd".into(), json!(request.cwd));
    object.insert(
        "hook_event_name".into(),
        json!(request.event_name.config_name()),
    );
    Value::Object(object)
}

#[derive(Debug, Default)]
struct ParsedOutput {
    continue_processing: bool,
    stop_reason: Option<String>,
    blocked_reason: Option<String>,
    additional_context: Option<String>,
    updated_input: Option<Value>,
    permission_decision: Option<PermissionDecision>,
    invalid_output: bool,
    entries: Vec<HookOutputEntry>,
}

fn parse_output(event: HookEventName, stdout: &str) -> ParsedOutput {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return ParsedOutput {
            continue_processing: true,
            ..ParsedOutput::default()
        };
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return ParsedOutput {
            continue_processing: true,
            invalid_output: true,
            entries: vec![HookOutputEntry {
                kind: HookOutputEntryKind::Error,
                text: "hook stdout is not a JSON object".into(),
            }],
            ..ParsedOutput::default()
        };
    };
    let Some(object) = value.as_object() else {
        return ParsedOutput {
            continue_processing: true,
            invalid_output: true,
            entries: vec![HookOutputEntry {
                kind: HookOutputEntryKind::Error,
                text: "hook stdout must be a JSON object".into(),
            }],
            ..ParsedOutput::default()
        };
    };
    let continue_processing = object
        .get("continue")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let stop_reason = object
        .get("stopReason")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let system_message = object
        .get("systemMessage")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let specific = object.get("hookSpecificOutput").and_then(Value::as_object);
    let additional_context = specific
        .and_then(|specific| specific.get("additionalContext"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let legacy_block = object.get("decision").and_then(Value::as_str) == Some("block");
    let specific_decision = specific
        .and_then(|specific| {
            specific
                .get("permissionDecision")
                .or_else(|| specific.get("decision"))
        })
        .and_then(Value::as_str);
    let permission_object = specific
        .and_then(|specific| specific.get("decision"))
        .and_then(Value::as_object);
    let permission_behavior = permission_object
        .and_then(|decision| decision.get("behavior"))
        .and_then(Value::as_str);
    let reason = permission_object
        .and_then(|decision| decision.get("message"))
        .or_else(|| specific.and_then(|specific| specific.get("permissionDecisionReason")))
        .or_else(|| object.get("reason"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let blocked_reason = match event {
        HookEventName::PreToolUse
        | HookEventName::PostToolUse
        | HookEventName::UserPromptSubmit
        | HookEventName::Stop
        | HookEventName::SubagentStop
            if legacy_block || specific_decision == Some("deny") =>
        {
            reason
                .clone()
                .or_else(|| Some("hook blocked the operation".into()))
        }
        _ => None,
    };
    let permission_decision = if event == HookEventName::PermissionRequest {
        match permission_behavior.or(specific_decision) {
            Some("allow") => Some(PermissionDecision::Allow),
            Some("deny") => Some(PermissionDecision::Deny(
                reason
                    .clone()
                    .unwrap_or_else(|| "permission denied by hook".into()),
            )),
            _ => None,
        }
    } else {
        None
    };
    let updated_input = if event == HookEventName::PreToolUse && specific_decision == Some("allow")
    {
        specific
            .and_then(|specific| specific.get("updatedInput"))
            .cloned()
    } else {
        None
    };
    let mut entries = Vec::new();
    if let Some(message) = system_message {
        entries.push(HookOutputEntry {
            kind: HookOutputEntryKind::Feedback,
            text: message,
        });
    }
    if let Some(context) = &additional_context {
        entries.push(HookOutputEntry {
            kind: HookOutputEntryKind::Context,
            text: context.clone(),
        });
    }
    if let Some(reason) = &blocked_reason {
        entries.push(HookOutputEntry {
            kind: HookOutputEntryKind::Stop,
            text: reason.clone(),
        });
    }
    ParsedOutput {
        continue_processing,
        stop_reason,
        blocked_reason,
        additional_context,
        updated_input,
        permission_decision,
        invalid_output: false,
        entries,
    }
}

fn cap_context(output: &mut ParsedOutput, limit: Option<usize>) {
    let limit = limit.unwrap_or(10_000);
    let Some(context) = output.additional_context.as_mut() else {
        return;
    };
    if limit == 0 || context.chars().count() <= limit {
        return;
    }
    *context = context.chars().take(limit).collect::<String>();
    output.entries.push(HookOutputEntry {
        kind: HookOutputEntryKind::Warning,
        text: format!("additional context was truncated to {limit} characters"),
    });
}

fn merge_outcome(dispatch: &mut HookDispatch, run: &HookRun) {
    if let Some(context) = &run.additional_context {
        dispatch.additional_context.push(HookContext {
            run_id: run.completed.id.clone(),
            text: context.clone(),
        });
    }
    if let Some(reason) = &run.blocked_reason {
        dispatch.blocked_reason = Some(reason.clone());
    }
    if let Some(input) = &run.updated_input {
        dispatch.updated_input = Some(input.clone());
    }
    if let Some(decision) = &run.permission_decision {
        dispatch.permission_decision = Some(decision.clone());
    }
    if run.completed.status == HookRunStatus::Stopped {
        dispatch.stop_reason = run
            .stop_reason
            .clone()
            .or_else(|| Some("hook stopped the operation".into()));
    }
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid state path: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| format!("create hook state directory: {error}"))?;
    let temporary = parent.join(format!(".hooks-state-{}.tmp", Uuid::now_v7()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("serialize hook state: {error}"))?;
    fs::write(&temporary, bytes).map_err(|error| format!("write hook state: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("replace hook state: {error}"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(root: &Path) -> HookEngine {
        HookEngine::new(HookPaths {
            system: None,
            user: Some(root.join("hooks.json")),
            trust_state: root.join("hooks-state.json"),
        })
    }

    /// Hook scripts run under `/bin/sh` on Unix and PowerShell on Windows, so
    /// every fixture supplies both spellings.
    struct Script {
        posix: String,
        windows: String,
    }

    /// Drain stdin, then write `output` to stdout with no trailing newline.
    fn emit(output: &str) -> Script {
        Script {
            posix: format!("cat >/dev/null; printf '%s' '{output}'"),
            windows: format!(
                "$null = [Console]::In.ReadToEnd(); [Console]::Out.Write('{}')",
                output.replace('\'', "''")
            ),
        }
    }

    fn write_hook(root: &Path, script: Script, event: &str) {
        write_hook_with_timeout(root, script, event, 5);
    }

    fn write_hook_with_timeout(root: &Path, script: Script, event: &str, timeout: u64) {
        let file = json!({
            "hooks": {
                event: [{
                    "matcher": ".*",
                    "hooks": [{
                        "type": "command",
                        "command": script.posix,
                        "commandWindows": script.windows,
                        "timeout": timeout
                    }]
                }]
            }
        });
        fs::write(root.join("hooks.json"), serde_json::to_vec(&file).unwrap()).unwrap();
    }

    fn request(root: &Path, event_name: HookEventName) -> HookRequest {
        HookRequest {
            event_name,
            thread_id: Uuid::now_v7().to_string(),
            turn_id: Some(Uuid::now_v7().to_string()),
            cwd: root.to_path_buf(),
            matcher: Some("exec_command".into()),
            payload: json!({"tool_name":"exec_command"}),
        }
    }

    #[tokio::test]
    async fn command_hook_emits_context_and_wire_summary() {
        let root = tempfile::tempdir().unwrap();
        write_hook(
            root.path(),
            emit(r#"{"hookSpecificOutput":{"additionalContext":"remember this"}}"#),
            "PreToolUse",
        );
        let result = engine(root.path())
            .dispatch(request(root.path(), HookEventName::PreToolUse))
            .await;
        assert_eq!(result.runs.len(), 1);
        assert_eq!(
            result
                .additional_context
                .first()
                .map(|context| context.text.as_str()),
            Some("remember this"),
            "{result:#?}"
        );
        let wire = serde_json::to_value(&result.runs[0].completed).unwrap();
        assert_eq!(wire["eventName"], "preToolUse");
        assert_eq!(wire["status"], "completed");
    }

    #[tokio::test]
    async fn block_and_updated_input_are_parsed() {
        let root = tempfile::tempdir().unwrap();
        write_hook(
            root.path(),
            emit(
                r#"{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked"}}"#,
            ),
            "PreToolUse",
        );
        let result = engine(root.path())
            .dispatch(request(root.path(), HookEventName::PreToolUse))
            .await;
        assert_eq!(result.blocked_reason.as_deref(), Some("blocked"));
        assert_eq!(result.runs[0].completed.status, HookRunStatus::Blocked);
    }

    #[tokio::test]
    async fn permission_request_uses_structured_behavior() {
        let root = tempfile::tempdir().unwrap();
        write_hook(
            root.path(),
            emit(
                r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"policy denied"}}}"#,
            ),
            "PermissionRequest",
        );
        let result = engine(root.path())
            .dispatch(request(root.path(), HookEventName::PermissionRequest))
            .await;
        assert_eq!(
            result.permission_decision,
            Some(PermissionDecision::Deny("policy denied".into()))
        );
    }

    #[tokio::test]
    async fn timeout_and_invalid_output_fail_continue() {
        let root = tempfile::tempdir().unwrap();
        write_hook_with_timeout(
            root.path(),
            Script {
                posix: "sleep 2".into(),
                windows: "Start-Sleep -Seconds 2".into(),
            },
            "PreToolUse",
            1,
        );
        let result = engine(root.path())
            .dispatch(request(root.path(), HookEventName::PreToolUse))
            .await;
        assert_eq!(result.runs[0].completed.status, HookRunStatus::Failed);
        assert!(result.blocked_reason.is_none());

        // Valid exit, unparsable stdout: the run fails without blocking.
        write_hook(root.path(), emit("nope"), "PreToolUse");
        let result = engine(root.path())
            .dispatch(request(root.path(), HookEventName::PreToolUse))
            .await;
        assert_eq!(result.runs[0].completed.status, HookRunStatus::Failed);
        assert!(result.blocked_reason.is_none());
    }

    #[tokio::test]
    async fn project_hooks_require_exact_hash_trust() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::create_dir(root.path().join(".codex")).unwrap();
        let path = root.path().join(".codex/hooks.json");
        let script = emit("{}");
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "hooks": {
                    "SessionStart": [{
                        "hooks": [{
                            "type": "command",
                            "command": script.posix,
                            "commandWindows": script.windows
                        }]
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let runtime = HookEngine::new(HookPaths {
            system: None,
            user: None,
            trust_state: root.path().join("state.json"),
        });
        let before = runtime
            .dispatch(request(root.path(), HookEventName::SessionStart))
            .await;
        assert!(before.runs.is_empty());
        runtime.trust_project_config(&path).unwrap();
        let after = runtime
            .dispatch(request(root.path(), HookEventName::SessionStart))
            .await;
        assert_eq!(after.runs.len(), 1);
    }

    #[test]
    fn hooks_list_preserves_untrusted_entries_and_v2_shape() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::create_dir(root.path().join(".codex")).unwrap();
        let path = root.path().join(".codex/hooks.json");
        fs::write(
            &path,
            br#"{"hooks":{"PreToolUse":[{"matcher":"exec_command","hooks":[{"type":"command","command":"printf ok","timeout":12,"statusMessage":"checking"}]}]}}"#,
        )
        .unwrap();
        let runtime = HookEngine::new(HookPaths {
            system: None,
            user: None,
            trust_state: root.path().join("state.json"),
        });
        let before = runtime.list(&[root.path().into()]);
        assert_eq!(before.data.len(), 1);
        assert_eq!(before.data[0].hooks.len(), 1);
        assert_eq!(
            before.data[0].hooks[0].trust_status,
            HookTrustStatus::Untrusted
        );
        assert!(!before.data[0].hooks[0].enabled);
        runtime.trust_project_config(&path).unwrap();
        let after = runtime.list(&[root.path().into()]);
        assert_eq!(
            after.data[0].hooks[0].trust_status,
            HookTrustStatus::Trusted
        );
        assert!(after.data[0].hooks[0].enabled);
        let wire = serde_json::to_value(after).unwrap();
        assert_eq!(wire["data"][0]["hooks"][0]["eventName"], "preToolUse");
        assert_eq!(wire["data"][0]["hooks"][0]["timeoutSec"], 12);
    }
}
