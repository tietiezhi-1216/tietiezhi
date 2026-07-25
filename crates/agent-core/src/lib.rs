//! Source-level Codex Thread runtime.
//!
//! This crate adapts the pinned App Server V2 protocol to a native
//! `ThreadManager`. It does not execute or link the upstream Codex binary.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tietiezhi_agent_context::{
    CompactWindow, ContextRecord, complete_compaction, context_window_status,
    estimate_history_tokens, model_context_window, reconstruct, world_state_rollout,
};
use tietiezhi_agent_model::{ModelError, TokenUsage, list_models};
use tietiezhi_agent_protocol::{
    ClientRequest, JSONRPCRequest, JSONRPCResponse, ModelListResponse, ServerNotification,
    ThreadApproveGuardianDeniedActionResponse, ThreadArchiveResponse, ThreadCompactStartResponse,
    ThreadDeleteResponse, ThreadForkResponse, ThreadInjectItemsResponse, ThreadItem,
    ThreadListResponse, ThreadLoadedListResponse, ThreadMetadataUpdateResponse, ThreadReadResponse,
    ThreadResumeResponse, ThreadRollbackResponse, ThreadSetNameResponse, ThreadStartResponse,
    ThreadUnarchiveResponse, ThreadUnsubscribeResponse, TurnInterruptResponse, TurnStartResponse,
    TurnSteerResponse,
};
use tietiezhi_agent_state::{
    RecoveredRolloutItem, RecoveredRolloutItemKind, RolloutAppender, StateError, StateStore,
    ThreadMetadata,
};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

const THREAD_LIST_DEFAULT_LIMIT: usize = 25;
const THREAD_LIST_MAX_LIMIT: usize = 100;
const MAX_USER_INPUT_TEXT_CHARS: usize = 1 << 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDefaults {
    pub model: String,
    pub model_provider: String,
    pub cwd: PathBuf,
    pub approval_policy: Value,
    pub approvals_reviewer: String,
    pub sandbox: Value,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub model_context_windows: HashMap<String, i64>,
    pub cli_version: String,
}

impl Default for RuntimeDefaults {
    fn default() -> Self {
        Self {
            model: "unconfigured".into(),
            model_provider: "unconfigured".into(),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            approval_policy: json!("on-request"),
            approvals_reviewer: "user".into(),
            sandbox: json!({
                "type": "workspaceWrite",
                "writableRoots": [],
                "networkAccess": false,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false
            }),
            reasoning_effort: None,
            service_tier: None,
            model_context_windows: HashMap::new(),
            cli_version: env!("CARGO_PKG_VERSION").into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct GitInfo {
    sha: Option<String>,
    branch: Option<String>,
    origin_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadRecord {
    id: String,
    session_id: String,
    forked_from_id: Option<String>,
    parent_thread_id: Option<String>,
    preview: String,
    ephemeral: bool,
    history_mode: String,
    model_provider: String,
    model: String,
    #[serde(default)]
    model_context_window: Option<i64>,
    cwd: PathBuf,
    cli_version: String,
    source: Value,
    thread_source: Option<Value>,
    git_info: Option<GitInfo>,
    name: Option<String>,
    approval_policy: Value,
    approvals_reviewer: String,
    sandbox: Value,
    reasoning_effort: Option<String>,
    #[serde(default)]
    reasoning_summary: Option<Value>,
    #[serde(default)]
    personality: Option<Value>,
    service_tier: Option<String>,
    created_at_ms: u64,
    updated_at_ms: u64,
    recency_at_ms: Option<u64>,
    /// R5 compatibility input only. R6 no longer writes Turn snapshots into
    /// SQLite canonical metadata; rollout events are authoritative.
    #[serde(default, skip_serializing)]
    turns: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnInputBatch {
    pub thread_id: String,
    pub turn_id: String,
    pub client_user_message_id: Option<String>,
    pub item_id: Option<String>,
    pub input: Vec<Value>,
    pub output_schema: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnInputDrain {
    pub batches: Vec<TurnInputBatch>,
    pub notifications: Vec<RoutedNotification>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnExecutionSnapshot {
    pub thread_id: String,
    pub turn_id: String,
    pub cwd: PathBuf,
    pub model: String,
    pub model_provider: String,
    pub approval_policy: Value,
    pub reasoning_effort: Option<String>,
    pub reasoning_summary: Option<Value>,
    pub service_tier: Option<String>,
    pub history: Vec<Value>,
    pub model_context_window: Option<i64>,
    pub active_context_tokens: i64,
    pub auto_compact_token_limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompactionExecutionSnapshot {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub model: String,
    pub model_provider: String,
    pub reasoning_effort: Option<String>,
    pub reasoning_summary: Option<Value>,
    pub service_tier: Option<String>,
    pub history: Vec<Value>,
    pub automatic: bool,
    pub model_context_window: Option<i64>,
}

#[derive(Debug, Clone)]
struct AcceptedClientMessage {
    turn_id: String,
    input: Vec<Value>,
}

#[derive(Debug, Clone, Default)]
struct TurnProjection {
    turns: Vec<Value>,
    active_turn_id: Option<String>,
    accepted_client_messages: HashMap<String, AcceptedClientMessage>,
    token_usage: TokenUsage,
    last_token_usage: TokenUsage,
    active_context_tokens: i64,
}

#[derive(Debug, Clone)]
struct LoadedThread {
    record: ThreadRecord,
    metadata: Option<ThreadMetadata>,
    status: Value,
    turns: Vec<Value>,
    active_turn_id: Option<String>,
    pending_inputs: Vec<TurnInputBatch>,
    accepted_client_messages: HashMap<String, AcceptedClientMessage>,
    unload_when_idle: bool,
    guardian_approvals: Vec<Value>,
    injected_items: Vec<Value>,
    token_usage: TokenUsage,
    last_token_usage: TokenUsage,
    active_context_tokens: i64,
    compact_window: CompactWindow,
    world_state_baseline: Option<Value>,
    active_compaction_item_id: Option<String>,
    active_compaction_automatic: bool,
}

#[derive(Debug, Default)]
struct ManagerState {
    loaded: HashMap<String, LoadedThread>,
    subscribers: HashMap<String, HashSet<String>>,
    connections: HashSet<String>,
}

#[derive(Debug)]
struct ThreadManagerInner {
    store: StateStore,
    threads_root: PathBuf,
    defaults: RuntimeDefaults,
    state: Mutex<ManagerState>,
}

#[derive(Debug, Clone)]
pub struct ThreadManager {
    inner: Arc<ThreadManagerInner>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutedNotification {
    pub recipients: Vec<String>,
    pub method: String,
    pub params: Value,
}

impl RoutedNotification {
    pub fn wire_message(&self) -> Value {
        json!({"method": self.method, "params": self.params})
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DispatchOutput {
    pub response: Value,
    pub notifications: Vec<RoutedNotification>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
            data: None,
        }
    }

    fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: -32600,
            message: message.into(),
            data: None,
        }
    }

    fn invalid_with_data(message: impl Into<String>, data: Value) -> Self {
        Self {
            code: -32602,
            message: message.into(),
            data: Some(data),
        }
    }

    fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("method not found: {method}"),
            data: None,
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: -32603,
            message: message.into(),
            data: None,
        }
    }
}

pub type RpcResult<T> = Result<T, RpcError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ThreadCursor {
    timestamp_ms: u64,
    id: String,
    sort_key: String,
    inclusive: bool,
}

impl ThreadManager {
    pub fn open(
        state_root: impl AsRef<Path>,
        threads_root: impl AsRef<Path>,
        defaults: RuntimeDefaults,
    ) -> Result<Self, StateError> {
        fs::create_dir_all(threads_root.as_ref())?;
        let manager = Self {
            inner: Arc::new(ThreadManagerInner {
                store: StateStore::open(state_root)?,
                threads_root: threads_root.as_ref().to_path_buf(),
                defaults,
                state: Mutex::new(ManagerState::default()),
            }),
        };
        manager.rebuild_missing_indexes()?;
        Ok(manager)
    }

    /// Dispatch one pinned App Server V2 client request.
    ///
    /// The input and every emitted notification are validated against the
    /// generated protocol types. The returned response keeps the caller's
    /// original JSON-RPC request id.
    pub fn dispatch(&self, connection_id: &str, request: Value) -> DispatchOutput {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let result = self.dispatch_inner(connection_id, &request);
        match result {
            Ok((result, notifications)) => {
                let response = json!({"id": id, "result": result});
                debug_assert!(serde_json::from_value::<JSONRPCResponse>(response.clone()).is_ok());
                DispatchOutput {
                    response,
                    notifications,
                }
            }
            Err(error) => {
                let mut response_error = json!({
                    "code": error.code,
                    "message": error.message
                });
                if let Some(data) = error.data {
                    response_error["data"] = data;
                }
                DispatchOutput {
                    response: json!({"id": id, "error": response_error}),
                    notifications: Vec::new(),
                }
            }
        }
    }

    fn dispatch_inner(
        &self,
        connection_id: &str,
        request: &Value,
    ) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        serde_json::from_value::<JSONRPCRequest>(request.clone())
            .map_err(|error| RpcError::invalid(format!("invalid JSON-RPC request: {error}")))?;
        serde_json::from_value::<ClientRequest>(request.clone())
            .map_err(|error| RpcError::invalid(format!("invalid App Server request: {error}")))?;
        self.state()?.connections.insert(connection_id.into());

        let method = request
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid("request method must be a string"))?;
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

        let (result, notifications) = match method {
            "model/list" => (self.model_list(&params)?, Vec::new()),
            "thread/start" => self.thread_start(connection_id, &params)?,
            "thread/resume" => self.thread_resume(connection_id, &params)?,
            "thread/fork" => self.thread_fork(connection_id, &params)?,
            "thread/read" => (self.thread_read(&params)?, Vec::new()),
            "thread/list" => (self.thread_list(&params)?, Vec::new()),
            "thread/loaded/list" => (self.thread_loaded_list(&params)?, Vec::new()),
            "thread/archive" => self.thread_archive(&params)?,
            "thread/unarchive" => self.thread_unarchive(&params)?,
            "thread/delete" => self.thread_delete(&params)?,
            "thread/name/set" => self.thread_set_name(&params)?,
            "thread/metadata/update" => (self.thread_metadata_update(&params)?, Vec::new()),
            "thread/inject_items" => (self.thread_inject_items(&params)?, Vec::new()),
            "thread/rollback" => (self.thread_rollback(&params)?, Vec::new()),
            "thread/compact/start" => self.thread_compact_start(&params)?,
            "thread/unsubscribe" => self.thread_unsubscribe(connection_id, &params)?,
            "thread/approveGuardianDeniedAction" => (
                self.thread_approve_guardian_denied_action(&params)?,
                Vec::new(),
            ),
            "turn/start" => self.turn_start(&params)?,
            "turn/steer" => self.turn_steer(&params)?,
            "turn/interrupt" => self.turn_interrupt(&params)?,
            _ => return Err(RpcError::method_not_found(method)),
        };
        self.validate_result(method, &result)?;
        for notification in &notifications {
            serde_json::from_value::<ServerNotification>(notification.wire_message()).map_err(
                |error| {
                    RpcError::internal(format!(
                        "invalid {} notification: {error}",
                        notification.method
                    ))
                },
            )?;
        }
        Ok((result, notifications))
    }

    fn validate_result(&self, method: &str, result: &Value) -> RpcResult<()> {
        macro_rules! validate {
            ($type:ty) => {
                serde_json::from_value::<$type>(result.clone())
                    .map(|_| ())
                    .map_err(|error| {
                        RpcError::internal(format!("invalid {method} response: {error}"))
                    })
            };
        }
        match method {
            "model/list" => validate!(ModelListResponse),
            "thread/start" => validate!(ThreadStartResponse),
            "thread/resume" => validate!(ThreadResumeResponse),
            "thread/fork" => validate!(ThreadForkResponse),
            "thread/read" => validate!(ThreadReadResponse),
            "thread/list" => validate!(ThreadListResponse),
            "thread/loaded/list" => validate!(ThreadLoadedListResponse),
            "thread/archive" => validate!(ThreadArchiveResponse),
            "thread/unarchive" => validate!(ThreadUnarchiveResponse),
            "thread/delete" => validate!(ThreadDeleteResponse),
            "thread/name/set" => validate!(ThreadSetNameResponse),
            "thread/metadata/update" => validate!(ThreadMetadataUpdateResponse),
            "thread/inject_items" => validate!(ThreadInjectItemsResponse),
            "thread/rollback" => validate!(ThreadRollbackResponse),
            "thread/compact/start" => validate!(ThreadCompactStartResponse),
            "thread/unsubscribe" => validate!(ThreadUnsubscribeResponse),
            "thread/approveGuardianDeniedAction" => {
                validate!(ThreadApproveGuardianDeniedActionResponse)
            }
            "turn/start" => validate!(TurnStartResponse),
            "turn/steer" => validate!(TurnSteerResponse),
            "turn/interrupt" => validate!(TurnInterruptResponse),
            _ => Err(RpcError::method_not_found(method)),
        }
    }

    fn model_list(&self, params: &Value) -> RpcResult<Value> {
        let cursor = params
            .get("cursor")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| RpcError::invalid("cursor must be a string"))
            })
            .transpose()?;
        let limit = params
            .get("limit")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or_else(|| RpcError::invalid("limit must be an unsigned 32-bit integer"))
            })
            .transpose()?;
        let include_hidden = params
            .get("includeHidden")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| RpcError::invalid("includeHidden must be a boolean"))
            })
            .transpose()?
            .unwrap_or(false);
        list_models(cursor, limit, include_hidden).map_err(|error| match error {
            ModelError::InvalidRequest { message } => RpcError::invalid_request(message),
            error => RpcError::internal(format!("failed to load model catalog: {error}")),
        })
    }

    fn thread_start(
        &self,
        connection_id: &str,
        params: &Value,
    ) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let now = now_ms();
        let id = Uuid::now_v7().to_string();
        let cwd = self.resolve_cwd(params.get("cwd"))?;
        let model =
            optional_string(params, "model").unwrap_or_else(|| self.inner.defaults.model.clone());
        let model_provider = optional_string(params, "modelProvider")
            .unwrap_or_else(|| self.inner.defaults.model_provider.clone());
        let approval_policy = params
            .get("approvalPolicy")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| self.inner.defaults.approval_policy.clone());
        let approvals_reviewer = optional_string(params, "approvalsReviewer")
            .unwrap_or_else(|| self.inner.defaults.approvals_reviewer.clone());
        let sandbox = self.resolve_sandbox(params.get("sandbox"), &cwd)?;
        let service_tier = optional_nullable_string(params, "serviceTier")
            .unwrap_or_else(|| self.inner.defaults.service_tier.clone());
        let record = ThreadRecord {
            id: id.clone(),
            session_id: id.clone(),
            forked_from_id: None,
            parent_thread_id: None,
            preview: String::new(),
            ephemeral: params
                .get("ephemeral")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            history_mode: "legacy".into(),
            model_provider,
            model_context_window: resolve_model_context_window(
                &self.inner.defaults.model_context_windows,
                &model,
            ),
            model,
            cwd,
            cli_version: self.inner.defaults.cli_version.clone(),
            source: json!("appServer"),
            thread_source: params
                .get("threadSource")
                .filter(|value| !value.is_null())
                .cloned(),
            git_info: None,
            name: None,
            approval_policy,
            approvals_reviewer,
            sandbox,
            reasoning_effort: self.inner.defaults.reasoning_effort.clone(),
            reasoning_summary: None,
            personality: None,
            service_tier,
            created_at_ms: now,
            updated_at_ms: now,
            recency_at_ms: Some(now),
            turns: Vec::new(),
        };
        let mut state = self.state()?;
        let loaded = self.create_loaded_thread(record, Vec::new(), &mut state)?;
        state
            .subscribers
            .entry(id.clone())
            .or_default()
            .insert(connection_id.into());
        let response = self.thread_open_response(&loaded.record, &loaded.status, Vec::new());
        let notification_thread = self.thread_value(&loaded.record, &loaded.status, Vec::new());
        let notification = self.notification_global(
            &state,
            "thread/started",
            json!({"thread": notification_thread}),
        );
        Ok((response, vec![notification]))
    }

    fn thread_resume(
        &self,
        connection_id: &str,
        params: &Value,
    ) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let id = required_string(params, "threadId")?;
        validate_thread_id(&id)?;
        let mut state = self.state()?;
        let mut loaded = self.load_thread_locked(&id, &mut state)?;
        self.apply_open_overrides(&mut loaded.record, params)?;
        loaded.record.updated_at_ms = now_ms();
        loaded.record.recency_at_ms = Some(loaded.record.updated_at_ms);
        self.persist_loaded(&mut loaded)?;
        state.loaded.insert(id.clone(), loaded.clone());
        state
            .subscribers
            .entry(id.clone())
            .or_default()
            .insert(connection_id.into());
        let response =
            self.thread_open_response(&loaded.record, &loaded.status, loaded.turns.clone());
        let notification = self.notification_global(
            &state,
            "thread/started",
            json!({"thread": self.thread_value(&loaded.record, &loaded.status, Vec::new())}),
        );
        Ok((response, vec![notification]))
    }

    fn thread_fork(
        &self,
        connection_id: &str,
        params: &Value,
    ) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let source_id = required_string(params, "threadId")?;
        validate_thread_id(&source_id)?;
        let mut state = self.state()?;
        let source = self.load_thread_locked(&source_id, &mut state)?;
        let mut turns = source.turns.clone();
        let last_turn_id = optional_string(params, "lastTurnId");
        if let Some(last_turn_id) = last_turn_id.as_deref() {
            let index = turns
                .iter()
                .position(|turn| turn.get("id").and_then(Value::as_str) == Some(last_turn_id))
                .ok_or_else(|| RpcError::invalid(format!("turn not found: {last_turn_id}")))?;
            if turns[index].get("status").and_then(Value::as_str) == Some("inProgress") {
                return Err(RpcError::invalid("cannot fork through an in-progress turn"));
            }
            turns.truncate(index + 1);
        } else if turns
            .iter()
            .any(|turn| turn.get("status").and_then(Value::as_str) == Some("inProgress"))
        {
            return Err(RpcError::invalid("cannot fork an in-progress turn"));
        }
        let now = now_ms();
        let id = Uuid::now_v7().to_string();
        let source_rollout_items = source
            .metadata
            .as_ref()
            .map(|metadata| {
                self.inner
                    .store
                    .recover_rollout(&metadata.rollout_path)
                    .map(|recovery| recovery.rollout_items)
                    .map_err(state_error)
            })
            .transpose()?;
        let copied_rollout_items = source_rollout_items
            .as_deref()
            .map(|items| rollout_items_through_turn(items, last_turn_id.as_deref()))
            .transpose()?;
        let inherited_items = copied_rollout_items
            .as_deref()
            .map(response_items_from_rollout)
            .unwrap_or_else(|| source.injected_items.clone());
        let inherited_projection = copied_rollout_items
            .as_deref()
            .map(project_turns)
            .transpose()?;
        let inherited_token_usage = inherited_projection
            .as_ref()
            .map(|projection| projection.token_usage.clone())
            .unwrap_or_else(|| source.token_usage.clone());
        let inherited_last_token_usage = inherited_projection
            .as_ref()
            .map(|projection| projection.last_token_usage.clone())
            .unwrap_or_else(|| source.last_token_usage.clone());
        let inherited_context = copied_rollout_items.as_deref().map(reconstruct_context);
        let mut record = source.record;
        record.id = id.clone();
        record.forked_from_id = Some(source_id);
        record.parent_thread_id = None;
        record.name = None;
        record.created_at_ms = now;
        record.updated_at_ms = now;
        record.recency_at_ms = Some(now);
        record.ephemeral = params
            .get("ephemeral")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        record.turns.clear();
        self.apply_open_overrides(&mut record, params)?;
        if let Some(source) = params.get("threadSource").filter(|value| !value.is_null()) {
            record.thread_source = Some(source.clone());
        }
        let mut loaded = self.create_loaded_thread(record, Vec::new(), &mut state)?;
        if let Some(items) = copied_rollout_items.as_deref() {
            self.append_recovered_rollout_items(&loaded, items)?;
            if !turns.is_empty()
                && !items.iter().any(|item| {
                    matches!(
                        &item.item,
                        RecoveredRolloutItemKind::EventMsg(event)
                            if matches!(
                                event.get("type").and_then(Value::as_str),
                                Some("task_started" | "turn_started")
                            )
                    )
                })
            {
                self.append_turn_snapshots(&loaded, &turns)?;
            }
        } else {
            self.append_turn_snapshots(&loaded, &turns)?;
        }
        loaded.injected_items = inherited_items;
        loaded.token_usage = inherited_token_usage;
        loaded.last_token_usage = inherited_last_token_usage;
        loaded.active_context_tokens = inherited_projection
            .as_ref()
            .map(|projection| projection.active_context_tokens)
            .unwrap_or_else(|| estimate_history_tokens(&loaded.injected_items));
        if let Some(context) = inherited_context {
            loaded.compact_window = context.window;
            loaded.world_state_baseline = context.world_state_baseline;
        }
        loaded.turns = turns;
        self.persist_loaded(&mut loaded)?;
        state.loaded.insert(id.clone(), loaded.clone());
        state
            .subscribers
            .entry(id.clone())
            .or_default()
            .insert(connection_id.into());
        let response =
            self.thread_open_response(&loaded.record, &loaded.status, loaded.turns.clone());
        let notification = self.notification_global(
            &state,
            "thread/started",
            json!({"thread": self.thread_value(&loaded.record, &loaded.status, Vec::new())}),
        );
        Ok((response, vec![notification]))
    }

    fn thread_read(&self, params: &Value) -> RpcResult<Value> {
        let id = required_string(params, "threadId")?;
        validate_thread_id(&id)?;
        let state = self.state()?;
        let loaded = state.loaded.get(&id).cloned();
        let (record, status, recovered_turns) = if let Some(loaded) = loaded {
            (loaded.record, loaded.status, loaded.turns)
        } else {
            let metadata = self.metadata(&id)?;
            (
                self.record_from_metadata(&metadata)?,
                json!({"type": "notLoaded"}),
                self.turn_projection_for_metadata(&metadata)?.turns,
            )
        };
        let turns = if params
            .get("includeTurns")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            recovered_turns
        } else {
            Vec::new()
        };
        Ok(json!({"thread": self.thread_value(&record, &status, turns)}))
    }

    fn thread_list(&self, params: &Value) -> RpcResult<Value> {
        let archived = params
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut entries = self
            .inner
            .store
            .list_threads(archived)
            .map_err(state_error)?;
        let providers = params.get("modelProviders").and_then(Value::as_array);
        let sources = params.get("sourceKinds").and_then(Value::as_array);
        let cwd_filters = cwd_filters(params.get("cwd"))?;
        let search = optional_string(params, "searchTerm").map(|value| value.to_lowercase());
        entries.retain(|metadata| {
            let record = self.record_from_metadata(metadata).ok();
            let Some(record) = record else {
                return false;
            };
            let provider_matches = providers.is_none_or(|providers| {
                providers.is_empty()
                    || providers
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|provider| provider == record.model_provider)
            });
            let source_matches = sources.is_none_or(|sources| {
                sources.is_empty()
                    || sources
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|source| source_matches_kind(&record.source, source))
            });
            let cwd_matches = cwd_filters
                .as_ref()
                .is_none_or(|filters| filters.iter().any(|cwd| cwd == &record.cwd));
            let search_matches = search.as_ref().is_none_or(|search| {
                metadata.title.to_lowercase().contains(search)
                    || metadata.preview.to_lowercase().contains(search)
            });
            provider_matches && source_matches && cwd_matches && search_matches
        });

        let sort_key = params
            .get("sortKey")
            .and_then(Value::as_str)
            .unwrap_or("created_at");
        if !matches!(sort_key, "created_at" | "updated_at" | "recency_at") {
            return Err(RpcError::invalid(format!("invalid sortKey: {sort_key}")));
        }
        let ascending = match params
            .get("sortDirection")
            .and_then(Value::as_str)
            .unwrap_or("desc")
        {
            "asc" => true,
            "desc" => false,
            value => return Err(RpcError::invalid(format!("invalid sortDirection: {value}"))),
        };
        entries.sort_by(|left, right| {
            let order = thread_sort_timestamp(left, sort_key)
                .cmp(&thread_sort_timestamp(right, sort_key))
                .then_with(|| left.id.cmp(&right.id));
            if ascending { order } else { order.reverse() }
        });
        if let Some(cursor) = optional_string(params, "cursor") {
            let cursor = decode_cursor(&cursor)?;
            if cursor.sort_key != sort_key {
                return Err(RpcError::invalid("thread cursor uses a different sortKey"));
            }
            entries.retain(|metadata| {
                let order = thread_sort_timestamp(metadata, sort_key)
                    .cmp(&cursor.timestamp_ms)
                    .then_with(|| metadata.id.cmp(&cursor.id));
                if ascending {
                    order == Ordering::Greater || (cursor.inclusive && order == Ordering::Equal)
                } else {
                    order == Ordering::Less || (cursor.inclusive && order == Ordering::Equal)
                }
            });
        }
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(THREAD_LIST_DEFAULT_LIMIT)
            .clamp(1, THREAD_LIST_MAX_LIMIT);
        let has_more = entries.len() > limit;
        entries.truncate(limit);
        let state = self.state()?;
        let data = entries
            .iter()
            .map(|metadata| {
                let record = self.record_from_metadata(metadata)?;
                let status = state
                    .loaded
                    .get(&record.id)
                    .map(|loaded| loaded.status.clone())
                    .unwrap_or_else(|| json!({"type": "notLoaded"}));
                Ok(self.thread_value(&record, &status, Vec::new()))
            })
            .collect::<RpcResult<Vec<_>>>()?;
        let next_cursor = if has_more {
            entries.last().map(|metadata| {
                encode_cursor(&ThreadCursor {
                    timestamp_ms: thread_sort_timestamp(metadata, sort_key),
                    id: metadata.id.clone(),
                    sort_key: sort_key.into(),
                    inclusive: false,
                })
            })
        } else {
            None
        };
        let backwards_cursor = entries.first().map(|metadata| {
            encode_cursor(&ThreadCursor {
                timestamp_ms: thread_sort_timestamp(metadata, sort_key),
                id: metadata.id.clone(),
                sort_key: sort_key.into(),
                inclusive: true,
            })
        });
        Ok(json!({
            "data": data,
            "nextCursor": next_cursor,
            "backwardsCursor": backwards_cursor
        }))
    }

    fn thread_loaded_list(&self, params: &Value) -> RpcResult<Value> {
        let state = self.state()?;
        let mut ids = state.loaded.keys().cloned().collect::<Vec<_>>();
        ids.sort();
        let start = optional_string(params, "cursor")
            .map(|cursor| {
                let decoded = URL_SAFE_NO_PAD
                    .decode(cursor)
                    .map_err(|_| RpcError::invalid("invalid loaded-thread cursor"))?;
                let id = String::from_utf8(decoded)
                    .map_err(|_| RpcError::invalid("invalid loaded-thread cursor"))?;
                Ok(ids.partition_point(|candidate| candidate <= &id))
            })
            .transpose()?
            .unwrap_or(0);
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(usize::MAX)
            .max(1);
        let end = start.saturating_add(limit).min(ids.len());
        let data = ids[start..end].to_vec();
        let next_cursor = (end < ids.len())
            .then(|| URL_SAFE_NO_PAD.encode(data.last().expect("nonempty page").as_bytes()));
        Ok(json!({"data": data, "nextCursor": next_cursor}))
    }

    fn thread_archive(&self, params: &Value) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let id = required_string(params, "threadId")?;
        validate_thread_id(&id)?;
        let mut state = self.state()?;
        let mut loaded_before = state.loaded.remove(&id);
        let mut notifications = Vec::new();
        if let Some(loaded) = loaded_before.as_mut()
            && let Some(turn_id) = loaded.active_turn_id.clone()
        {
            if let Err(error) =
                self.finish_turn_locked(loaded, &turn_id, "interrupted", None, "interrupted")
            {
                state.loaded.insert(id.clone(), loaded.clone());
                return Err(error);
            }
            notifications.extend(self.terminal_turn_notifications(&state, &id, loaded, &turn_id)?);
        }
        let mut metadata = loaded_before
            .as_ref()
            .and_then(|loaded| loaded.metadata.clone())
            .or_else(|| self.inner.store.thread(&id).ok().flatten())
            .ok_or_else(|| RpcError::invalid(format!("thread not found: {id}")))?;
        if metadata.archived_at_ms != 0 {
            return Err(RpcError::invalid(format!("thread already archived: {id}")));
        }
        metadata.archived_at_ms = now_ms();
        metadata.updated_at_ms = metadata.archived_at_ms;
        self.inner
            .store
            .upsert_metadata(&metadata)
            .map_err(state_error)?;
        notifications.push(self.notification_global(
            &state,
            "thread/archived",
            json!({"threadId": id}),
        ));
        if loaded_before.is_some() {
            notifications.push(self.notification_global(
                &state,
                "thread/closed",
                json!({"threadId": id}),
            ));
        }
        state.subscribers.remove(&id);
        Ok((json!({}), notifications))
    }

    fn thread_unarchive(&self, params: &Value) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let id = required_string(params, "threadId")?;
        validate_thread_id(&id)?;
        let state = self.state()?;
        let mut metadata = self
            .inner
            .store
            .thread(&id)
            .map_err(state_error)?
            .ok_or_else(|| RpcError::invalid(format!("thread not found: {id}")))?;
        if metadata.archived_at_ms == 0 {
            return Err(RpcError::invalid(format!("thread is not archived: {id}")));
        }
        metadata.archived_at_ms = 0;
        metadata.updated_at_ms = now_ms();
        self.inner
            .store
            .upsert_metadata(&metadata)
            .map_err(state_error)?;
        let record = self.record_from_metadata(&metadata)?;
        let response = json!({
            "thread": self.thread_value(&record, &json!({"type": "notLoaded"}), Vec::new())
        });
        let notification =
            self.notification_global(&state, "thread/unarchived", json!({"threadId": id}));
        Ok((response, vec![notification]))
    }

    fn thread_delete(&self, params: &Value) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let id = required_string(params, "threadId")?;
        validate_thread_id(&id)?;
        let mut state = self.state()?;
        let mut loaded_before = state.loaded.remove(&id);
        let mut notifications = Vec::new();
        if let Some(loaded) = loaded_before.as_mut()
            && let Some(turn_id) = loaded.active_turn_id.clone()
        {
            if let Err(error) =
                self.finish_turn_locked(loaded, &turn_id, "interrupted", None, "interrupted")
            {
                state.loaded.insert(id.clone(), loaded.clone());
                return Err(error);
            }
            notifications.extend(self.terminal_turn_notifications(&state, &id, loaded, &turn_id)?);
        }
        let metadata = loaded_before
            .as_ref()
            .and_then(|loaded| loaded.metadata.clone())
            .or_else(|| self.inner.store.thread(&id).ok().flatten())
            .ok_or_else(|| RpcError::invalid(format!("thread not found: {id}")))?;
        self.inner.store.delete_thread(&id).map_err(state_error)?;
        let expected_thread_root = self.inner.threads_root.join(&id);
        if metadata.rollout_path.parent() == Some(expected_thread_root.as_path()) {
            let parent = expected_thread_root.as_path();
            match fs::remove_dir_all(parent) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(RpcError::internal(format!(
                        "failed to delete thread files: {error}"
                    )));
                }
            }
        }
        notifications.push(self.notification_global(
            &state,
            "thread/deleted",
            json!({"threadId": id}),
        ));
        if loaded_before.is_some() {
            notifications.push(self.notification_global(
                &state,
                "thread/closed",
                json!({"threadId": id}),
            ));
        }
        state.subscribers.remove(&id);
        Ok((json!({}), notifications))
    }

    fn thread_set_name(&self, params: &Value) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let id = required_string(params, "threadId")?;
        validate_thread_id(&id)?;
        let name = required_string(params, "name")?;
        let name = name.trim();
        if name.is_empty() {
            return Err(RpcError::invalid("thread name must not be empty"));
        }
        let mut state = self.state()?;
        let (mut loaded, was_loaded) = self.thread_for_update_locked(&id, &state)?;
        if loaded
            .metadata
            .as_ref()
            .is_some_and(|metadata| metadata.archived_at_ms != 0)
        {
            return Err(RpcError::invalid(format!("thread is archived: {id}")));
        }
        loaded.record.name = Some(name.into());
        loaded.record.updated_at_ms = now_ms();
        self.persist_loaded(&mut loaded)?;
        if was_loaded {
            state.loaded.insert(id.clone(), loaded);
        }
        let notification = self.notification_global(
            &state,
            "thread/name/updated",
            json!({"threadId": id, "threadName": name}),
        );
        Ok((json!({}), vec![notification]))
    }

    fn thread_metadata_update(&self, params: &Value) -> RpcResult<Value> {
        let id = required_string(params, "threadId")?;
        validate_thread_id(&id)?;
        let mut state = self.state()?;
        let (mut loaded, was_loaded) = self.thread_for_update_locked(&id, &state)?;
        if let Some(patch) = params.get("gitInfo").and_then(Value::as_object) {
            let git = loaded.record.git_info.get_or_insert(GitInfo {
                sha: None,
                branch: None,
                origin_url: None,
            });
            apply_nullable_string_patch(patch, "sha", &mut git.sha)?;
            apply_nullable_string_patch(patch, "branch", &mut git.branch)?;
            apply_nullable_string_patch(patch, "originUrl", &mut git.origin_url)?;
            if git.sha.is_none() && git.branch.is_none() && git.origin_url.is_none() {
                loaded.record.git_info = None;
            }
        }
        loaded.record.updated_at_ms = now_ms();
        self.persist_loaded(&mut loaded)?;
        let thread = self.thread_value(&loaded.record, &loaded.status, Vec::new());
        if was_loaded {
            state.loaded.insert(id, loaded);
        }
        Ok(json!({"thread": thread}))
    }

    fn thread_inject_items(&self, params: &Value) -> RpcResult<Value> {
        let id = required_string(params, "threadId")?;
        validate_thread_id(&id)?;
        let items = params
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| RpcError::invalid("items must be an array"))?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(&id, &state)?;
        for item in items {
            if !item.is_object() {
                return Err(RpcError::invalid("injected response items must be objects"));
            }
        }
        if let Some(metadata) = loaded.metadata.as_ref() {
            let appender = RolloutAppender::open(&metadata.rollout_path).map_err(state_error)?;
            for item in items {
                appender
                    .append_response_item(item.clone())
                    .map_err(state_error)?;
            }
            appender.sync_data().map_err(state_error)?;
        }
        extend_model_history(&mut loaded, items.iter().cloned());
        loaded.record.updated_at_ms = now_ms();
        loaded.record.recency_at_ms = Some(loaded.record.updated_at_ms);
        self.persist_loaded(&mut loaded)?;
        state.loaded.insert(id, loaded);
        Ok(json!({}))
    }

    fn thread_rollback(&self, params: &Value) -> RpcResult<Value> {
        let id = required_string(params, "threadId")?;
        validate_thread_id(&id)?;
        let num_turns = params
            .get("numTurns")
            .and_then(Value::as_u64)
            .ok_or_else(|| RpcError::invalid("numTurns must be an integer"))?
            as usize;
        if num_turns == 0 {
            return Err(RpcError::invalid("numTurns must be at least 1"));
        }
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(&id, &state)?;
        if loaded.status.get("type").and_then(Value::as_str) == Some("active") {
            return Err(RpcError::invalid("cannot rollback an active thread"));
        }
        if num_turns > loaded.turns.len() {
            return Err(RpcError::invalid(format!(
                "cannot rollback {num_turns} turns from a thread with {} turns",
                loaded.turns.len()
            )));
        }
        loaded.turns.truncate(loaded.turns.len() - num_turns);
        let metadata = loaded
            .metadata
            .as_ref()
            .ok_or_else(|| RpcError::invalid("ephemeral threads cannot be rolled back"))?;
        let appender = RolloutAppender::open(&metadata.rollout_path).map_err(state_error)?;
        appender
            .append_event(json!({
                "type": "thread_rolled_back",
                "num_turns": num_turns
            }))
            .map_err(state_error)?;
        appender.sync_data().map_err(state_error)?;
        loaded.record.updated_at_ms = now_ms();
        self.persist_loaded(&mut loaded)?;
        let thread = self.thread_value(&loaded.record, &loaded.status, loaded.turns.clone());
        state.loaded.insert(id, loaded);
        Ok(json!({"thread": thread}))
    }

    fn thread_unsubscribe(
        &self,
        connection_id: &str,
        params: &Value,
    ) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let id = required_string(params, "threadId")?;
        validate_thread_id(&id)?;
        let mut state = self.state()?;
        if !state.loaded.contains_key(&id) {
            return Ok((json!({"status": "notLoaded"}), Vec::new()));
        }
        let Some(subscribers) = state.subscribers.get_mut(&id) else {
            return Ok((json!({"status": "notSubscribed"}), Vec::new()));
        };
        if !subscribers.remove(connection_id) {
            return Ok((json!({"status": "notSubscribed"}), Vec::new()));
        }
        let should_unload = subscribers.is_empty();
        if should_unload {
            state.subscribers.remove(&id);
            if state
                .loaded
                .get(&id)
                .is_some_and(|loaded| loaded.active_turn_id.is_some())
            {
                if let Some(loaded) = state.loaded.get_mut(&id) {
                    loaded.unload_when_idle = true;
                }
                return Ok((json!({"status": "unsubscribed"}), Vec::new()));
            }
            state.loaded.remove(&id);
            let notification =
                self.notification_global(&state, "thread/closed", json!({"threadId": id}));
            return Ok((json!({"status": "unsubscribed"}), vec![notification]));
        }
        Ok((json!({"status": "unsubscribed"}), Vec::new()))
    }

    fn thread_approve_guardian_denied_action(&self, params: &Value) -> RpcResult<Value> {
        let id = required_string(params, "threadId")?;
        validate_thread_id(&id)?;
        if params.get("event").is_none() {
            return Err(RpcError::invalid("event is required"));
        }
        let mut state = self.state()?;
        let loaded = state
            .loaded
            .get_mut(&id)
            .ok_or_else(|| RpcError::invalid(format!("thread not loaded: {id}")))?;
        loaded.guardian_approvals.push(
            params
                .get("event")
                .cloned()
                .expect("event presence checked above"),
        );
        Ok(json!({}))
    }

    fn thread_compact_start(&self, params: &Value) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let thread_id = required_string(params, "threadId")?;
        validate_thread_id(&thread_id)?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(&thread_id, &state)?;
        if let Some(active_turn_id) = &loaded.active_turn_id {
            return Err(RpcError::invalid_request(format!(
                "thread already has an active turn: {active_turn_id}"
            )));
        }

        let turn_id = Uuid::now_v7().to_string();
        let item_id = Uuid::now_v7().to_string();
        let now = now_ms();
        let started_at = milliseconds_to_seconds(now);
        let item = json!({"type": "contextCompaction", "id": item_id});
        let turn = turn_value(
            &turn_id,
            vec![item.clone()],
            "inProgress",
            None,
            Some(started_at),
            None,
            None,
            "full",
        );
        self.append_compaction_start_records(&loaded, &turn_id, &item, now)?;
        loaded.turns.push(turn.clone());
        loaded.active_turn_id = Some(turn_id.clone());
        loaded.active_compaction_item_id = Some(item_id);
        loaded.active_compaction_automatic = false;
        loaded.status = active_thread_status();
        loaded.record.updated_at_ms = now;
        loaded.record.recency_at_ms = Some(now);
        self.persist_loaded(&mut loaded)?;
        state.loaded.insert(thread_id.clone(), loaded);

        let notification_turn = turn_value(
            &turn_id,
            Vec::new(),
            "inProgress",
            None,
            Some(started_at),
            None,
            None,
            "notLoaded",
        );
        let notifications = vec![
            self.checked_notification_for(
                &state,
                &thread_id,
                "turn/started",
                json!({"threadId": thread_id, "turn": notification_turn}),
            )?,
            self.checked_notification_for(
                &state,
                &thread_id,
                "item/started",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": item,
                    "startedAtMs": now
                }),
            )?,
            self.checked_global_notification(
                &state,
                "thread/status/changed",
                json!({"threadId": thread_id, "status": active_thread_status()}),
            )?,
        ];
        Ok((json!({}), notifications))
    }

    fn turn_start(&self, params: &Value) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let thread_id = required_string(params, "threadId")?;
        validate_thread_id(&thread_id)?;
        let input = user_input(params)?;
        validate_user_input(&input)?;

        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(&thread_id, &state)?;
        let client_id = optional_string(params, "clientUserMessageId");
        if let Some(response) =
            duplicate_turn_start_response(&loaded, client_id.as_deref(), &input)?
        {
            return Ok((response, Vec::new()));
        }
        if let Some(active_turn_id) = &loaded.active_turn_id {
            return Err(RpcError::invalid_request(format!(
                "thread already has an active turn: {active_turn_id}"
            )));
        }

        self.apply_turn_overrides(&mut loaded.record, params)?;
        let turn_id = Uuid::now_v7().to_string();
        let now = now_ms();
        let started_at = milliseconds_to_seconds(now);
        let item = (!input.is_empty()).then(|| {
            json!({
                "type": "userMessage",
                "id": Uuid::now_v7().to_string(),
                "clientId": client_id,
                "content": input
            })
        });
        let turn = turn_value(
            &turn_id,
            item.iter().cloned().collect(),
            "inProgress",
            None,
            Some(started_at),
            None,
            None,
            "full",
        );
        self.append_turn_start_records(&loaded, &turn_id, item.as_ref(), &input, now)?;

        loaded.turns.push(turn.clone());
        loaded.active_turn_id = Some(turn_id.clone());
        loaded.status = active_thread_status();
        loaded.pending_inputs.push(TurnInputBatch {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            client_user_message_id: client_id.clone(),
            item_id: item
                .as_ref()
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            input: input.clone(),
            output_schema: params
                .get("outputSchema")
                .filter(|value| !value.is_null())
                .cloned(),
        });
        if !input.is_empty() {
            append_model_history(&mut loaded, response_item_from_user_input(&input));
        }
        if let Some(client_id) = client_id {
            loaded.accepted_client_messages.insert(
                client_id,
                AcceptedClientMessage {
                    turn_id: turn_id.clone(),
                    input: input.clone(),
                },
            );
        }
        loaded.record.updated_at_ms = now;
        loaded.record.recency_at_ms = Some(now);
        update_preview(&mut loaded.record, &input);
        self.persist_loaded(&mut loaded)?;
        state.loaded.insert(thread_id.clone(), loaded);

        let response_turn = turn_value(
            &turn_id,
            Vec::new(),
            "inProgress",
            None,
            None,
            None,
            None,
            "notLoaded",
        );
        let notification_turn = turn_value(
            &turn_id,
            Vec::new(),
            "inProgress",
            None,
            Some(started_at),
            None,
            None,
            "notLoaded",
        );
        let mut notifications = vec![self.checked_notification_for(
            &state,
            &thread_id,
            "turn/started",
            json!({"threadId": thread_id, "turn": notification_turn}),
        )?];
        if let Some(item) = item {
            notifications.push(self.checked_notification_for(
                &state,
                &thread_id,
                "item/started",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": item,
                    "startedAtMs": now
                }),
            )?);
            notifications.push(self.checked_notification_for(
                &state,
                &thread_id,
                "item/completed",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": item,
                    "completedAtMs": now
                }),
            )?);
        }
        notifications.push(self.checked_global_notification(
            &state,
            "thread/status/changed",
            json!({"threadId": thread_id, "status": active_thread_status()}),
        )?);
        Ok((json!({"turn": response_turn}), notifications))
    }

    fn turn_steer(&self, params: &Value) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let thread_id = required_string(params, "threadId")?;
        validate_thread_id(&thread_id)?;
        let expected_turn_id = required_string(params, "expectedTurnId")?;
        let input = user_input(params)?;
        validate_user_input(&input)?;
        if input.is_empty() {
            return Err(RpcError::invalid_request("input must not be empty"));
        }

        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(&thread_id, &state)?;
        let client_id = optional_string(params, "clientUserMessageId");
        if let Some(client_id) = client_id.as_deref()
            && let Some(accepted) = loaded.accepted_client_messages.get(client_id)
        {
            if accepted.input != input {
                return Err(RpcError::invalid_request(
                    "clientUserMessageId was already used with different input",
                ));
            }
            return Ok((json!({"turnId": accepted.turn_id}), Vec::new()));
        }
        let Some(active_turn_id) = loaded.active_turn_id.clone() else {
            return Err(RpcError::invalid_request("no active turn to steer"));
        };
        if active_turn_id != expected_turn_id {
            return Err(RpcError::invalid_request(format!(
                "expected active turn id `{expected_turn_id}` but found `{active_turn_id}`"
            )));
        }

        let item = json!({
            "type": "userMessage",
            "id": Uuid::now_v7().to_string(),
            "clientId": client_id,
            "content": input
        });
        loaded.pending_inputs.push(TurnInputBatch {
            thread_id: thread_id.clone(),
            turn_id: active_turn_id.clone(),
            client_user_message_id: client_id.clone(),
            item_id: item.get("id").and_then(Value::as_str).map(str::to_owned),
            input: input.clone(),
            output_schema: None,
        });
        if let Some(client_id) = client_id {
            loaded.accepted_client_messages.insert(
                client_id,
                AcceptedClientMessage {
                    turn_id: active_turn_id.clone(),
                    input,
                },
            );
        }
        let now = now_ms();
        loaded.record.updated_at_ms = now;
        loaded.record.recency_at_ms = Some(now);
        self.persist_loaded(&mut loaded)?;
        state.loaded.insert(thread_id.clone(), loaded);

        Ok((json!({"turnId": active_turn_id}), Vec::new()))
    }

    fn turn_interrupt(&self, params: &Value) -> RpcResult<(Value, Vec<RoutedNotification>)> {
        let thread_id = required_string(params, "threadId")?;
        validate_thread_id(&thread_id)?;
        let requested_turn_id = params
            .get("turnId")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid("turnId must be a string"))?;

        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(&thread_id, &state)?;
        let active_turn_id = loaded.active_turn_id.clone();
        let Some(active_turn_id) = active_turn_id else {
            if requested_turn_id.is_empty() {
                return Ok((json!({}), Vec::new()));
            }
            return Err(RpcError::invalid_request("no active turn to interrupt"));
        };
        if !requested_turn_id.is_empty() && requested_turn_id != active_turn_id {
            return Err(RpcError::invalid_request(format!(
                "expected active turn id {requested_turn_id} but found {active_turn_id}"
            )));
        }

        self.finish_turn_locked(
            &mut loaded,
            &active_turn_id,
            "interrupted",
            None,
            "interrupted",
        )?;
        let notifications =
            self.terminal_turn_notifications(&state, &thread_id, &loaded, &active_turn_id)?;
        self.store_or_unload_completed(&mut state, &thread_id, loaded);
        Ok((json!({}), notifications))
    }

    /// Drain input accepted for an active Turn exactly once.
    ///
    /// R7's Responses executor consumes this queue. It is intentionally not
    /// reconstructed after a crash: persisted in-progress Turns are marked
    /// interrupted on resume rather than replaying external side effects.
    pub fn take_turn_inputs(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> RpcResult<Vec<TurnInputBatch>> {
        Ok(self.drain_turn_inputs(thread_id, turn_id, true)?.batches)
    }

    /// Drain pending input and record newly steered user messages immediately
    /// before the next sampling request, matching Codex's input queue order.
    pub fn drain_turn_inputs(
        &self,
        thread_id: &str,
        turn_id: &str,
        include_steered: bool,
    ) -> RpcResult<TurnInputDrain> {
        validate_thread_id(thread_id)?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        let recorded_item_ids = loaded
            .turns
            .iter()
            .find(|turn| turn.get("id").and_then(Value::as_str) == Some(turn_id))
            .and_then(|turn| turn.get("items"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .map(str::to_owned)
            .collect::<HashSet<_>>();
        let (matching, retained): (Vec<_>, Vec<_>) =
            loaded.pending_inputs.drain(..).partition(|input| {
                input.turn_id == turn_id
                    && (include_steered
                        || input
                            .item_id
                            .as_ref()
                            .is_none_or(|item_id| recorded_item_ids.contains(item_id)))
            });
        loaded.pending_inputs = retained;
        let mut notification_items = Vec::new();
        for batch in &matching {
            let Some(item_id) = batch.item_id.as_deref() else {
                continue;
            };
            if turn_contains_item(&loaded.turns, turn_id, item_id) {
                continue;
            }
            let now = now_ms();
            let item = json!({
                "type": "userMessage",
                "id": item_id,
                "clientId": batch.client_user_message_id,
                "content": batch.input
            });
            self.append_user_input_records(&loaded, turn_id, &item, &batch.input, now)?;
            upsert_turn_item(&mut loaded.turns, turn_id, item.clone())?;
            append_model_history(&mut loaded, response_item_from_user_input(&batch.input));
            notification_items.push((item, now));
        }
        if !notification_items.is_empty() {
            loaded.record.updated_at_ms = now_ms();
            loaded.record.recency_at_ms = Some(loaded.record.updated_at_ms);
            self.persist_loaded(&mut loaded)?;
        }
        state.loaded.insert(thread_id.into(), loaded);
        let mut notifications = Vec::with_capacity(notification_items.len() * 2);
        for (item, now) in notification_items {
            notifications.push(self.checked_notification_for(
                &state,
                thread_id,
                "item/started",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": item,
                    "startedAtMs": now
                }),
            )?);
            notifications.push(self.checked_notification_for(
                &state,
                thread_id,
                "item/completed",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": item,
                    "completedAtMs": now
                }),
            )?);
        }
        Ok(TurnInputDrain {
            batches: matching,
            notifications,
        })
    }

    pub fn turn_execution_snapshot(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> RpcResult<TurnExecutionSnapshot> {
        validate_thread_id(thread_id)?;
        let state = self.state()?;
        let loaded = self.loaded_thread_locked(thread_id, &state)?;
        if loaded.active_turn_id.as_deref() != Some(turn_id) {
            return Err(RpcError::invalid_request(format!(
                "turn is not active: {turn_id}"
            )));
        }
        let model_context_window = loaded.record.model_context_window;
        Ok(TurnExecutionSnapshot {
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
            cwd: loaded.record.cwd,
            model: loaded.record.model,
            model_provider: loaded.record.model_provider,
            approval_policy: loaded.record.approval_policy,
            reasoning_effort: loaded.record.reasoning_effort,
            reasoning_summary: loaded.record.reasoning_summary,
            service_tier: loaded.record.service_tier,
            history: loaded.injected_items,
            model_context_window,
            active_context_tokens: loaded.active_context_tokens,
            auto_compact_token_limit: None,
        })
    }

    pub fn context_tokens_remaining(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> RpcResult<Option<i64>> {
        validate_thread_id(thread_id)?;
        let state = self.state()?;
        let loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        Ok(loaded
            .record
            .model_context_window
            .map(|limit| limit.saturating_sub(loaded.active_context_tokens).max(0)))
    }

    pub fn has_pending_turn_input(&self, thread_id: &str, turn_id: &str) -> RpcResult<bool> {
        validate_thread_id(thread_id)?;
        let state = self.state()?;
        let loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        Ok(loaded
            .pending_inputs
            .iter()
            .any(|input| input.turn_id == turn_id))
    }

    pub fn should_auto_compact(&self, thread_id: &str, turn_id: &str) -> RpcResult<bool> {
        validate_thread_id(thread_id)?;
        let state = self.state()?;
        let loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        if loaded.active_compaction_item_id.is_some() {
            return Ok(false);
        }
        Ok(context_window_status(
            loaded.active_context_tokens,
            loaded.record.model_context_window,
            None,
        )
        .token_limit_reached)
    }

    pub fn begin_auto_compaction(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> RpcResult<(CompactionExecutionSnapshot, Vec<RoutedNotification>)> {
        validate_thread_id(thread_id)?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        if loaded.active_compaction_item_id.is_some() {
            return Err(RpcError::invalid_request("compaction is already active"));
        }
        let item_id = Uuid::now_v7().to_string();
        let item = json!({"type": "contextCompaction", "id": item_id});
        let now = now_ms();
        upsert_turn_item(&mut loaded.turns, turn_id, item.clone())?;
        if let Some(appender) = rollout_appender(&loaded)? {
            appender
                .append_event(item_lifecycle_event(
                    "item_started",
                    thread_id,
                    turn_id,
                    &item,
                    "started_at_ms",
                    now,
                )?)
                .map_err(state_error)?;
            appender.sync_data().map_err(state_error)?;
        }
        loaded.active_compaction_item_id = Some(item_id);
        loaded.active_compaction_automatic = true;
        let snapshot = compaction_snapshot(&loaded, turn_id)?;
        state.loaded.insert(thread_id.into(), loaded);
        let notification = self.checked_notification_for(
            &state,
            thread_id,
            "item/started",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "item": item,
                "startedAtMs": now
            }),
        )?;
        Ok((snapshot, vec![notification]))
    }

    pub fn compaction_execution_snapshot(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> RpcResult<CompactionExecutionSnapshot> {
        validate_thread_id(thread_id)?;
        let state = self.state()?;
        let loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        compaction_snapshot(&loaded, turn_id)
    }

    pub fn record_compaction_response_item(
        &self,
        thread_id: &str,
        turn_id: &str,
        response_item: Value,
    ) -> RpcResult<()> {
        validate_thread_id(thread_id)?;
        let state = self.state()?;
        let loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        if loaded.active_compaction_item_id.is_none() {
            return Err(RpcError::invalid_request("compaction is not active"));
        }
        if let Some(appender) = rollout_appender(&loaded)? {
            appender
                .append_response_item(response_item)
                .map_err(state_error)?;
            appender.sync_data().map_err(state_error)?;
        }
        Ok(())
    }

    pub fn complete_compaction(
        &self,
        thread_id: &str,
        turn_id: &str,
        summary_suffix: &str,
    ) -> RpcResult<Vec<RoutedNotification>> {
        validate_thread_id(thread_id)?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        let item_id = loaded
            .active_compaction_item_id
            .clone()
            .ok_or_else(|| RpcError::invalid_request("compaction is not active"))?;
        let automatic = loaded.active_compaction_automatic;
        let result = complete_compaction(
            &loaded.injected_items,
            summary_suffix,
            &mut loaded.compact_window,
        );
        let item = json!({"type": "contextCompaction", "id": item_id});
        let now = now_ms();
        if let Some(appender) = rollout_appender(&loaded)? {
            appender
                .append_compacted(result.compacted_item)
                .map_err(state_error)?;
            appender
                .append_event(item_lifecycle_event(
                    "item_completed",
                    thread_id,
                    turn_id,
                    &item,
                    "completed_at_ms",
                    now,
                )?)
                .map_err(state_error)?;
            appender.sync_data().map_err(state_error)?;
        }
        loaded.injected_items = result.replacement_history;
        loaded.active_context_tokens = estimate_history_tokens(&loaded.injected_items);
        loaded.world_state_baseline = None;
        loaded.active_compaction_item_id = None;
        loaded.active_compaction_automatic = false;
        upsert_turn_item(&mut loaded.turns, turn_id, item.clone())?;

        let mut notifications = vec![
            self.checked_notification_for(
                &state,
                thread_id,
                "item/completed",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": item,
                    "completedAtMs": now
                }),
            )?,
            self.checked_notification_for(
                &state,
                thread_id,
                "warning",
                json!({
                    "threadId": thread_id,
                    "message": "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted."
                }),
            )?,
        ];
        if automatic {
            state.loaded.insert(thread_id.into(), loaded);
        } else {
            self.finish_turn_locked(&mut loaded, turn_id, "completed", None, "completed")?;
            notifications
                .extend(self.terminal_turn_notifications(&state, thread_id, &loaded, turn_id)?);
            self.store_or_unload_completed(&mut state, thread_id, loaded);
        }
        Ok(notifications)
    }

    pub fn record_world_state(&self, thread_id: &str, current: Value) -> RpcResult<bool> {
        validate_thread_id(thread_id)?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(thread_id, &state)?;
        let Some(item) = world_state_rollout(loaded.world_state_baseline.as_ref(), &current) else {
            return Ok(false);
        };
        if let Some(appender) = rollout_appender(&loaded)? {
            appender.append_world_state(item).map_err(state_error)?;
            appender.sync_data().map_err(state_error)?;
        }
        loaded.world_state_baseline = Some(current);
        state.loaded.insert(thread_id.into(), loaded);
        Ok(true)
    }

    /// Project an added Responses item into the V2 timeline. Tool items that
    /// belong to later milestones stay in canonical model history but do not
    /// claim a partially implemented V2 lifecycle.
    pub fn model_item_started(
        &self,
        thread_id: &str,
        turn_id: &str,
        response_item: Value,
    ) -> RpcResult<Vec<RoutedNotification>> {
        validate_thread_id(thread_id)?;
        let Some(item) = response_item_to_v2(&response_item)? else {
            return Ok(Vec::new());
        };
        let item_id = required_item_string(&item, "id", "model item")?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        if turn_contains_item(&loaded.turns, turn_id, item_id) {
            return Ok(Vec::new());
        }
        let now = now_ms();
        upsert_turn_item(&mut loaded.turns, turn_id, item.clone())?;
        if let Some(appender) = rollout_appender(&loaded)? {
            appender
                .append_event(item_lifecycle_event(
                    "item_started",
                    thread_id,
                    turn_id,
                    &item,
                    "started_at_ms",
                    now,
                )?)
                .map_err(state_error)?;
            appender.sync_data().map_err(state_error)?;
        }
        state.loaded.insert(thread_id.into(), loaded);
        Ok(vec![self.checked_notification_for(
            &state,
            thread_id,
            "item/started",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "item": item,
                "startedAtMs": now
            }),
        )?])
    }

    pub fn model_item_completed(
        &self,
        thread_id: &str,
        turn_id: &str,
        response_item: Value,
    ) -> RpcResult<Vec<RoutedNotification>> {
        validate_thread_id(thread_id)?;
        let projected = response_item_to_v2(&response_item)?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        let now = now_ms();
        let mut notifications = Vec::new();
        if let Some(item) = projected {
            let item_id = required_item_string(&item, "id", "model item")?;
            if !turn_contains_item(&loaded.turns, turn_id, item_id) {
                upsert_turn_item(&mut loaded.turns, turn_id, item.clone())?;
                notifications.push(self.checked_notification_for(
                    &state,
                    thread_id,
                    "item/started",
                    json!({
                        "threadId": thread_id,
                        "turnId": turn_id,
                        "item": item,
                        "startedAtMs": now
                    }),
                )?);
            } else {
                upsert_turn_item(&mut loaded.turns, turn_id, item.clone())?;
            }
            notifications.push(self.checked_notification_for(
                &state,
                thread_id,
                "item/completed",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": item,
                    "completedAtMs": now
                }),
            )?);
            if let Some(appender) = rollout_appender(&loaded)? {
                if notifications
                    .first()
                    .is_some_and(|notification| notification.method == "item/started")
                {
                    appender
                        .append_event(item_lifecycle_event(
                            "item_started",
                            thread_id,
                            turn_id,
                            &item,
                            "started_at_ms",
                            now,
                        )?)
                        .map_err(state_error)?;
                }
                appender
                    .append_response_item(response_item.clone())
                    .map_err(state_error)?;
                appender
                    .append_event(item_lifecycle_event(
                        "item_completed",
                        thread_id,
                        turn_id,
                        &item,
                        "completed_at_ms",
                        now,
                    )?)
                    .map_err(state_error)?;
                appender.sync_data().map_err(state_error)?;
            }
        } else if let Some(appender) = rollout_appender(&loaded)? {
            appender
                .append_response_item(response_item.clone())
                .map_err(state_error)?;
            appender.sync_data().map_err(state_error)?;
        }
        append_model_history(&mut loaded, response_item);
        state.loaded.insert(thread_id.into(), loaded);
        Ok(notifications)
    }

    pub fn local_tool_item_started(
        &self,
        thread_id: &str,
        turn_id: &str,
        item: Value,
    ) -> RpcResult<Vec<RoutedNotification>> {
        validate_thread_id(thread_id)?;
        serde_json::from_value::<ThreadItem>(item.clone())
            .map_err(|error| RpcError::invalid(format!("invalid local tool item: {error}")))?;
        let item_id = required_item_string(&item, "id", "local tool item")?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        if turn_contains_item(&loaded.turns, turn_id, item_id) {
            return Ok(Vec::new());
        }
        let now = now_ms();
        upsert_turn_item(&mut loaded.turns, turn_id, item.clone())?;
        if let Some(appender) = rollout_appender(&loaded)? {
            appender
                .append_event(item_lifecycle_event(
                    "item_started",
                    thread_id,
                    turn_id,
                    &item,
                    "started_at_ms",
                    now,
                )?)
                .map_err(state_error)?;
            appender.sync_data().map_err(state_error)?;
        }
        state.loaded.insert(thread_id.into(), loaded);
        Ok(vec![self.checked_notification_for(
            &state,
            thread_id,
            "item/started",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "item": item,
                "startedAtMs": now
            }),
        )?])
    }

    pub fn local_tool_item_completed(
        &self,
        thread_id: &str,
        turn_id: &str,
        item: Value,
    ) -> RpcResult<Vec<RoutedNotification>> {
        validate_thread_id(thread_id)?;
        serde_json::from_value::<ThreadItem>(item.clone())
            .map_err(|error| RpcError::invalid(format!("invalid local tool item: {error}")))?;
        let item_id = required_item_string(&item, "id", "local tool item")?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        let now = now_ms();
        let started = !turn_contains_item(&loaded.turns, turn_id, item_id);
        upsert_turn_item(&mut loaded.turns, turn_id, item.clone())?;
        if let Some(appender) = rollout_appender(&loaded)? {
            if started {
                appender
                    .append_event(item_lifecycle_event(
                        "item_started",
                        thread_id,
                        turn_id,
                        &item,
                        "started_at_ms",
                        now,
                    )?)
                    .map_err(state_error)?;
            }
            appender
                .append_event(item_lifecycle_event(
                    "item_completed",
                    thread_id,
                    turn_id,
                    &item,
                    "completed_at_ms",
                    now,
                )?)
                .map_err(state_error)?;
            appender.sync_data().map_err(state_error)?;
        }
        state.loaded.insert(thread_id.into(), loaded);
        let mut notifications = Vec::with_capacity(usize::from(started) + 1);
        if started {
            notifications.push(self.checked_notification_for(
                &state,
                thread_id,
                "item/started",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": item,
                    "startedAtMs": now
                }),
            )?);
        }
        notifications.push(self.checked_notification_for(
            &state,
            thread_id,
            "item/completed",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "item": item,
                "completedAtMs": now
            }),
        )?);
        Ok(notifications)
    }

    pub fn file_change_patch_updated(
        &self,
        thread_id: &str,
        turn_id: &str,
        item_id: &str,
        changes: Vec<Value>,
    ) -> RpcResult<Vec<RoutedNotification>> {
        self.update_streaming_item(thread_id, turn_id, item_id, |item| {
            if item.get("type").and_then(Value::as_str) != Some("fileChange") {
                return Err(RpcError::invalid("streaming item is not a file change"));
            }
            item["changes"] = Value::Array(changes.clone());
            Ok(())
        })?;
        self.model_delta_notification(
            thread_id,
            "item/fileChange/patchUpdated",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "changes": changes
            }),
        )
    }

    /// Compatibility implementation for the deprecated V2 notification.
    /// New executions use canonical FileChange items and `patchUpdated`.
    pub fn file_change_output_delta(
        &self,
        thread_id: &str,
        turn_id: &str,
        item_id: &str,
        delta: &str,
    ) -> RpcResult<Vec<RoutedNotification>> {
        self.model_delta_notification(
            thread_id,
            "item/fileChange/outputDelta",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "delta": delta
            }),
        )
    }

    pub fn turn_diff_updated(
        &self,
        thread_id: &str,
        turn_id: &str,
        diff: &str,
    ) -> RpcResult<Vec<RoutedNotification>> {
        validate_thread_id(thread_id)?;
        let state = self.state()?;
        let loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        Ok(vec![self.checked_notification_for(
            &state,
            thread_id,
            "turn/diff/updated",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "diff": diff
            }),
        )?])
    }

    pub fn thread_recipients(&self, thread_id: &str) -> RpcResult<Vec<String>> {
        validate_thread_id(thread_id)?;
        let state = self.state()?;
        self.loaded_thread_locked(thread_id, &state)?;
        let mut recipients = state
            .subscribers
            .get(thread_id)
            .map(|subscribers| subscribers.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        recipients.sort();
        Ok(recipients)
    }

    pub fn agent_message_delta(
        &self,
        thread_id: &str,
        turn_id: &str,
        item_id: &str,
        delta: &str,
    ) -> RpcResult<Vec<RoutedNotification>> {
        self.update_streaming_item(thread_id, turn_id, item_id, |item| {
            if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
                return Err(RpcError::invalid("streaming item is not an agent message"));
            }
            let text = item
                .get_mut("text")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_owned();
            item["text"] = json!(format!("{text}{delta}"));
            Ok(())
        })?;
        self.model_delta_notification(
            thread_id,
            "item/agentMessage/delta",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "delta": delta
            }),
        )
    }

    pub fn reasoning_summary_part_added(
        &self,
        thread_id: &str,
        turn_id: &str,
        item_id: &str,
        summary_index: i64,
    ) -> RpcResult<Vec<RoutedNotification>> {
        let index = nonnegative_index(summary_index, "summaryIndex")?;
        self.update_streaming_item(thread_id, turn_id, item_id, |item| {
            ensure_reasoning_strings(item, "summary", index)?;
            Ok(())
        })?;
        self.model_delta_notification(
            thread_id,
            "item/reasoning/summaryPartAdded",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "summaryIndex": summary_index
            }),
        )
    }

    pub fn reasoning_summary_delta(
        &self,
        thread_id: &str,
        turn_id: &str,
        item_id: &str,
        summary_index: i64,
        delta: &str,
    ) -> RpcResult<Vec<RoutedNotification>> {
        let index = nonnegative_index(summary_index, "summaryIndex")?;
        self.update_streaming_item(thread_id, turn_id, item_id, |item| {
            let strings = ensure_reasoning_strings(item, "summary", index)?;
            let current = strings[index].as_str().unwrap_or_default();
            strings[index] = json!(format!("{current}{delta}"));
            Ok(())
        })?;
        self.model_delta_notification(
            thread_id,
            "item/reasoning/summaryTextDelta",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "summaryIndex": summary_index,
                "delta": delta
            }),
        )
    }

    pub fn reasoning_summary_done(
        &self,
        thread_id: &str,
        turn_id: &str,
        item_id: &str,
        summary_index: i64,
        text: &str,
    ) -> RpcResult<()> {
        let index = nonnegative_index(summary_index, "summaryIndex")?;
        self.update_streaming_item(thread_id, turn_id, item_id, |item| {
            let strings = ensure_reasoning_strings(item, "summary", index)?;
            strings[index] = json!(text);
            Ok(())
        })
    }

    pub fn reasoning_text_delta(
        &self,
        thread_id: &str,
        turn_id: &str,
        item_id: &str,
        content_index: i64,
        delta: &str,
    ) -> RpcResult<Vec<RoutedNotification>> {
        let index = nonnegative_index(content_index, "contentIndex")?;
        self.update_streaming_item(thread_id, turn_id, item_id, |item| {
            let strings = ensure_reasoning_strings(item, "content", index)?;
            let current = strings[index].as_str().unwrap_or_default();
            strings[index] = json!(format!("{current}{delta}"));
            Ok(())
        })?;
        self.model_delta_notification(
            thread_id,
            "item/reasoning/textDelta",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "contentIndex": content_index,
                "delta": delta
            }),
        )
    }

    pub fn model_rerouted_notification(
        &self,
        thread_id: &str,
        turn_id: &str,
        from_model: &str,
        to_model: &str,
    ) -> RpcResult<Vec<RoutedNotification>> {
        self.model_delta_notification(
            thread_id,
            "model/rerouted",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "fromModel": from_model,
                "toModel": to_model,
                "reason": "highRiskCyberActivity"
            }),
        )
    }

    pub fn model_verification_notification(
        &self,
        thread_id: &str,
        turn_id: &str,
        verifications: Vec<String>,
    ) -> RpcResult<Vec<RoutedNotification>> {
        self.model_delta_notification(
            thread_id,
            "model/verification",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "verifications": verifications
            }),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn safety_buffering_notification(
        &self,
        thread_id: &str,
        turn_id: &str,
        model: &str,
        use_cases: Vec<String>,
        reasons: Vec<String>,
        show_buffering_ui: bool,
        faster_model: Option<String>,
    ) -> RpcResult<Vec<RoutedNotification>> {
        self.model_delta_notification(
            thread_id,
            "model/safetyBuffering/updated",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "model": model,
                "useCases": use_cases,
                "reasons": reasons,
                "showBufferingUi": show_buffering_ui,
                "fasterModel": faster_model
            }),
        )
    }

    pub fn error_notification(
        &self,
        thread_id: &str,
        turn_id: &str,
        error: Value,
        will_retry: bool,
    ) -> RpcResult<Vec<RoutedNotification>> {
        self.model_delta_notification(
            thread_id,
            "error",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "error": error,
                "willRetry": will_retry
            }),
        )
    }

    fn model_delta_notification(
        &self,
        thread_id: &str,
        method: &str,
        params: Value,
    ) -> RpcResult<Vec<RoutedNotification>> {
        let state = self.state()?;
        self.loaded_thread_locked(thread_id, &state)?;
        Ok(vec![self.checked_notification_for(
            &state, thread_id, method, params,
        )?])
    }

    fn update_streaming_item<F>(
        &self,
        thread_id: &str,
        turn_id: &str,
        item_id: &str,
        update: F,
    ) -> RpcResult<()>
    where
        F: FnOnce(&mut Value) -> RpcResult<()>,
    {
        validate_thread_id(thread_id)?;
        let mut state = self.state()?;
        let loaded = state
            .loaded
            .get_mut(thread_id)
            .ok_or_else(|| RpcError::invalid(format!("thread not loaded: {thread_id}")))?;
        require_active_turn(loaded, turn_id)?;
        let item = turn_item_mut(&mut loaded.turns, turn_id, item_id)?;
        update(item)
    }

    /// Complete or fail the active Turn through the same terminal state path
    /// used by interrupts and crash recovery.
    pub fn complete_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        error: Option<Value>,
    ) -> RpcResult<Vec<RoutedNotification>> {
        validate_thread_id(thread_id)?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(thread_id, &state)?;
        if loaded.active_turn_id.as_deref() != Some(turn_id) {
            return Err(RpcError::invalid_request(format!(
                "turn is not active: {turn_id}"
            )));
        }
        let status = if error.is_some() {
            "failed"
        } else {
            "completed"
        };
        self.finish_turn_locked(&mut loaded, turn_id, status, error, "completed")?;
        let notifications =
            self.terminal_turn_notifications(&state, thread_id, &loaded, turn_id)?;
        self.store_or_unload_completed(&mut state, thread_id, loaded);
        Ok(notifications)
    }

    /// Finish the active turn only when same-turn steering has not queued more
    /// user input. This closes the check/complete race inside the runtime lock.
    pub fn complete_turn_if_no_pending(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> RpcResult<Option<Vec<RoutedNotification>>> {
        validate_thread_id(thread_id)?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        if loaded
            .pending_inputs
            .iter()
            .any(|input| input.turn_id == turn_id)
        {
            return Ok(None);
        }
        self.finish_turn_locked(&mut loaded, turn_id, "completed", None, "completed")?;
        let notifications =
            self.terminal_turn_notifications(&state, thread_id, &loaded, turn_id)?;
        self.store_or_unload_completed(&mut state, thread_id, loaded);
        Ok(Some(notifications))
    }

    pub fn turn_moderation_metadata_notification(
        &self,
        thread_id: &str,
        turn_id: &str,
        metadata: Value,
    ) -> RpcResult<Vec<RoutedNotification>> {
        validate_thread_id(thread_id)?;
        let state = self.state()?;
        let loaded = self.loaded_thread_locked(thread_id, &state)?;
        if !loaded
            .turns
            .iter()
            .any(|turn| turn.get("id").and_then(Value::as_str) == Some(turn_id))
        {
            return Err(RpcError::invalid(format!("turn not found: {turn_id}")));
        }
        if let Some(appender) = rollout_appender(&loaded)? {
            appender
                .append_event(json!({
                    "type": "turn_moderation_metadata",
                    "turn_id": turn_id,
                    "metadata": metadata
                }))
                .map_err(state_error)?;
            appender.sync_data().map_err(state_error)?;
        }
        Ok(vec![self.checked_notification_for(
            &state,
            thread_id,
            "turn/moderationMetadata",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "metadata": metadata
            }),
        )?])
    }

    pub fn set_thread_status(
        &self,
        thread_id: &str,
        status: Value,
    ) -> RpcResult<Vec<RoutedNotification>> {
        validate_thread_id(thread_id)?;
        validate_thread_status(&status)?;
        let mut state = self.state()?;
        let loaded = state
            .loaded
            .get_mut(thread_id)
            .ok_or_else(|| RpcError::invalid(format!("thread not loaded: {thread_id}")))?;
        if loaded.status == status {
            return Ok(Vec::new());
        }
        loaded.status = status.clone();
        Ok(vec![self.checked_global_notification(
            &state,
            "thread/status/changed",
            json!({"threadId": thread_id, "status": status}),
        )?])
    }

    pub fn environment_notification(
        &self,
        thread_id: &str,
        environment_id: &str,
        connected: bool,
    ) -> RpcResult<Vec<RoutedNotification>> {
        self.require_loaded(thread_id)?;
        if environment_id.trim().is_empty() {
            return Err(RpcError::invalid("environmentId must not be empty"));
        }
        let method = if connected {
            "thread/environment/connected"
        } else {
            "thread/environment/disconnected"
        };
        let state = self.state()?;
        Ok(vec![self.checked_notification_for(
            &state,
            thread_id,
            method,
            json!({"threadId": thread_id, "environmentId": environment_id}),
        )?])
    }

    pub fn settings_notification(
        &self,
        thread_id: &str,
        thread_settings: Value,
    ) -> RpcResult<Vec<RoutedNotification>> {
        self.require_loaded(thread_id)?;
        let state = self.state()?;
        Ok(vec![self.checked_notification_for(
            &state,
            thread_id,
            "thread/settings/updated",
            json!({"threadId": thread_id, "threadSettings": thread_settings}),
        )?])
    }

    pub fn token_usage_notification(
        &self,
        thread_id: &str,
        turn_id: &str,
        token_usage: Value,
    ) -> RpcResult<Vec<RoutedNotification>> {
        self.require_loaded(thread_id)?;
        let state = self.state()?;
        Ok(vec![self.checked_notification_for(
            &state,
            thread_id,
            "thread/tokenUsage/updated",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "tokenUsage": token_usage
            }),
        )?])
    }

    pub fn record_token_usage(
        &self,
        thread_id: &str,
        turn_id: &str,
        last: TokenUsage,
        model_context_window: Option<i64>,
    ) -> RpcResult<Vec<RoutedNotification>> {
        validate_thread_id(thread_id)?;
        let mut state = self.state()?;
        let mut loaded = self.loaded_thread_locked(thread_id, &state)?;
        require_active_turn(&loaded, turn_id)?;
        add_token_usage(&mut loaded.token_usage, &last);
        loaded.last_token_usage = last.clone();
        loaded.active_context_tokens = last.total_tokens.max(0);
        loaded
            .compact_window
            .ensure_server_prefill(last.input_tokens);
        let token_usage = json!({
            "total": loaded.token_usage.as_v2_breakdown(),
            "last": last.as_v2_breakdown(),
            "modelContextWindow": model_context_window
        });
        if let Some(appender) = rollout_appender(&loaded)? {
            appender
                .append_event(json!({
                    "type": "token_count",
                    "info": {
                        "total_token_usage": loaded.token_usage,
                        "last_token_usage": last,
                        "model_context_window": model_context_window
                    },
                    "rate_limits": Value::Null
                }))
                .map_err(state_error)?;
            appender.sync_data().map_err(state_error)?;
        }
        state.loaded.insert(thread_id.into(), loaded);
        Ok(vec![self.checked_notification_for(
            &state,
            thread_id,
            "thread/tokenUsage/updated",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "tokenUsage": token_usage
            }),
        )?])
    }

    /// R6 uses this hook to project canonical turns into Thread responses.
    pub fn replace_turns(&self, thread_id: &str, turns: Vec<Value>) -> RpcResult<()> {
        validate_thread_id(thread_id)?;
        let mut state = self.state()?;
        let mut loaded = self.load_thread_locked(thread_id, &mut state)?;
        self.append_turn_snapshots(&loaded, &turns)?;
        loaded.turns = turns;
        loaded.record.updated_at_ms = now_ms();
        self.persist_loaded(&mut loaded)?;
        state.loaded.insert(thread_id.into(), loaded);
        Ok(())
    }

    /// R27 consumes approvals submitted through the lifecycle route.
    pub fn take_guardian_approvals(&self, thread_id: &str) -> RpcResult<Vec<Value>> {
        validate_thread_id(thread_id)?;
        let mut state = self.state()?;
        let loaded = state
            .loaded
            .get_mut(thread_id)
            .ok_or_else(|| RpcError::invalid(format!("thread not loaded: {thread_id}")))?;
        Ok(std::mem::take(&mut loaded.guardian_approvals))
    }

    pub fn injected_items(&self, thread_id: &str) -> RpcResult<Vec<Value>> {
        validate_thread_id(thread_id)?;
        let state = self.state()?;
        Ok(self.loaded_thread_locked(thread_id, &state)?.injected_items)
    }

    fn apply_turn_overrides(&self, record: &mut ThreadRecord, params: &Value) -> RpcResult<()> {
        if let Some(cwd) = params.get("cwd").filter(|value| !value.is_null()) {
            record.cwd = self.resolve_cwd(Some(cwd))?;
        }
        if let Some(policy) = params
            .get("approvalPolicy")
            .filter(|value| !value.is_null())
        {
            record.approval_policy = policy.clone();
        }
        if let Some(reviewer) = optional_string(params, "approvalsReviewer") {
            record.approvals_reviewer = reviewer;
        }
        if let Some(sandbox) = params.get("sandboxPolicy").filter(|value| !value.is_null()) {
            record.sandbox = sandbox.clone();
        }
        if let Some(model) = optional_string(params, "model") {
            record.model_context_window =
                resolve_model_context_window(&self.inner.defaults.model_context_windows, &model);
            record.model = model;
        }
        if params.get("serviceTier").is_some() {
            record.service_tier = optional_nullable_string(params, "serviceTier").unwrap_or(None);
        }
        if let Some(effort) = optional_string(params, "effort") {
            record.reasoning_effort = Some(effort);
        }
        if let Some(summary) = params.get("summary").filter(|value| !value.is_null()) {
            record.reasoning_summary = Some(summary.clone());
        }
        if let Some(personality) = params.get("personality").filter(|value| !value.is_null()) {
            record.personality = Some(personality.clone());
        }
        Ok(())
    }

    fn append_turn_start_records(
        &self,
        loaded: &LoadedThread,
        turn_id: &str,
        item: Option<&Value>,
        input: &[Value],
        now: u64,
    ) -> RpcResult<()> {
        let Some(appender) = rollout_appender(loaded)? else {
            return Ok(());
        };
        let started_at = milliseconds_to_seconds(now);
        appender
            .append_event(json!({
                "type": "task_started",
                "turn_id": turn_id,
                "started_at": started_at,
                "model_context_window": Value::Null,
                "collaboration_mode_kind": "default"
            }))
            .map_err(state_error)?;
        appender
            .append_turn_context(turn_context_value(&loaded.record, turn_id))
            .map_err(state_error)?;
        if let Some(item) = item {
            append_user_input_to_rollout(&appender, &loaded.record.id, turn_id, item, input, now)?;
        }
        appender.sync_data().map_err(state_error)
    }

    fn append_compaction_start_records(
        &self,
        loaded: &LoadedThread,
        turn_id: &str,
        item: &Value,
        now: u64,
    ) -> RpcResult<()> {
        let Some(appender) = rollout_appender(loaded)? else {
            return Ok(());
        };
        appender
            .append_event(json!({
                "type": "task_started",
                "turn_id": turn_id,
                "started_at": milliseconds_to_seconds(now),
                "model_context_window": loaded.record.model_context_window,
                "collaboration_mode_kind": "default"
            }))
            .map_err(state_error)?;
        appender
            .append_turn_context(turn_context_value(&loaded.record, turn_id))
            .map_err(state_error)?;
        appender
            .append_event(item_lifecycle_event(
                "item_started",
                &loaded.record.id,
                turn_id,
                item,
                "started_at_ms",
                now,
            )?)
            .map_err(state_error)?;
        appender.sync_data().map_err(state_error)
    }

    fn append_user_input_records(
        &self,
        loaded: &LoadedThread,
        turn_id: &str,
        item: &Value,
        input: &[Value],
        now: u64,
    ) -> RpcResult<()> {
        let Some(appender) = rollout_appender(loaded)? else {
            return Ok(());
        };
        append_user_input_to_rollout(&appender, &loaded.record.id, turn_id, item, input, now)?;
        appender.sync_data().map_err(state_error)
    }

    fn finish_turn_locked(
        &self,
        loaded: &mut LoadedThread,
        turn_id: &str,
        status: &str,
        error: Option<Value>,
        terminal_kind: &str,
    ) -> RpcResult<()> {
        let index = loaded
            .turns
            .iter()
            .position(|turn| turn.get("id").and_then(Value::as_str) == Some(turn_id))
            .ok_or_else(|| RpcError::invalid(format!("turn not found: {turn_id}")))?;
        let normalized_error = if status == "failed" {
            Some(normalize_turn_error(error)?)
        } else {
            None
        };
        let now = now_ms();
        let completed_at = milliseconds_to_seconds(now);
        let started_at = loaded.turns[index].get("startedAt").and_then(Value::as_i64);
        let duration_ms = started_at.map(|started_at| {
            let started_at_ms = started_at.saturating_mul(1_000);
            i64::try_from(now)
                .unwrap_or(i64::MAX)
                .saturating_sub(started_at_ms)
                .max(0)
        });

        loaded.turns[index]["status"] = json!(status);
        loaded.turns[index]["error"] = normalized_error.clone().unwrap_or(Value::Null);
        loaded.turns[index]["completedAt"] = json!(completed_at);
        loaded.turns[index]["durationMs"] = json!(duration_ms);
        loaded.active_turn_id = None;
        loaded.active_compaction_item_id = None;
        loaded.active_compaction_automatic = false;
        loaded
            .pending_inputs
            .retain(|input| input.turn_id != turn_id);
        loaded.status = json!({"type": "idle"});
        loaded.record.updated_at_ms = now;
        loaded.record.recency_at_ms = Some(now);

        if let Some(appender) = rollout_appender(loaded)? {
            if terminal_kind == "interrupted" {
                appender
                    .append_event(json!({
                        "type": "turn_aborted",
                        "turn_id": turn_id,
                        "reason": "interrupted",
                        "started_at": started_at,
                        "completed_at": completed_at,
                        "duration_ms": duration_ms
                    }))
                    .map_err(state_error)?;
            } else {
                if let Some(error) = &normalized_error {
                    appender
                        .append_event(json!({
                            "type": "error",
                            "message": error["message"],
                            "codex_error_info": error["codexErrorInfo"]
                        }))
                        .map_err(state_error)?;
                }
                appender
                    .append_event(json!({
                        "type": "turn_complete",
                        "turn_id": turn_id,
                        "last_agent_message": Value::Null,
                        "error": normalized_error.as_ref().map(turn_error_to_core),
                        "started_at": started_at,
                        "completed_at": completed_at,
                        "duration_ms": duration_ms,
                        "time_to_first_token_ms": Value::Null
                    }))
                    .map_err(state_error)?;
            }
            appender.sync_data().map_err(state_error)?;
        }
        self.persist_loaded(loaded)
    }

    fn terminal_turn_notifications(
        &self,
        state: &ManagerState,
        thread_id: &str,
        loaded: &LoadedThread,
        turn_id: &str,
    ) -> RpcResult<Vec<RoutedNotification>> {
        let turn = loaded
            .turns
            .iter()
            .find(|turn| turn.get("id").and_then(Value::as_str) == Some(turn_id))
            .cloned()
            .ok_or_else(|| RpcError::invalid(format!("turn not found: {turn_id}")))?;
        let mut notification_turn = turn;
        notification_turn["items"] = json!([]);
        notification_turn["itemsView"] = json!("notLoaded");
        let mut notifications = vec![
            self.checked_notification_for(
                state,
                thread_id,
                "turn/completed",
                json!({"threadId": thread_id, "turn": notification_turn}),
            )?,
            self.checked_global_notification(
                state,
                "thread/status/changed",
                json!({"threadId": thread_id, "status": {"type": "idle"}}),
            )?,
        ];
        if loaded.unload_when_idle {
            notifications.push(self.checked_global_notification(
                state,
                "thread/closed",
                json!({"threadId": thread_id}),
            )?);
        }
        Ok(notifications)
    }

    fn store_or_unload_completed(
        &self,
        state: &mut ManagerState,
        thread_id: &str,
        loaded: LoadedThread,
    ) {
        if loaded.unload_when_idle {
            state.loaded.remove(thread_id);
        } else {
            state.loaded.insert(thread_id.into(), loaded);
        }
    }

    fn turn_projection_for_metadata(&self, metadata: &ThreadMetadata) -> RpcResult<TurnProjection> {
        let recovery = self
            .inner
            .store
            .recover_rollout(&metadata.rollout_path)
            .map_err(state_error)?;
        project_turns(&recovery.rollout_items)
    }

    fn append_turn_snapshots(&self, loaded: &LoadedThread, turns: &[Value]) -> RpcResult<()> {
        let Some(appender) = rollout_appender(loaded)? else {
            return Ok(());
        };
        for turn in turns {
            let turn_id = turn
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::invalid("turn id is required"))?;
            appender
                .append_event(json!({
                    "type": "task_started",
                    "turn_id": turn_id,
                    "started_at": turn.get("startedAt").cloned().unwrap_or(Value::Null),
                    "model_context_window": Value::Null,
                    "collaboration_mode_kind": "default"
                }))
                .map_err(state_error)?;
            for item in turn
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let timestamp = loaded.record.created_at_ms;
                appender
                    .append_event(item_lifecycle_event(
                        "item_started",
                        &loaded.record.id,
                        turn_id,
                        item,
                        "started_at_ms",
                        timestamp,
                    )?)
                    .map_err(state_error)?;
                appender
                    .append_event(item_lifecycle_event(
                        "item_completed",
                        &loaded.record.id,
                        turn_id,
                        item,
                        "completed_at_ms",
                        timestamp,
                    )?)
                    .map_err(state_error)?;
            }
            match turn.get("status").and_then(Value::as_str) {
                Some("interrupted") => {
                    appender
                        .append_event(json!({
                            "type": "turn_aborted",
                            "turn_id": turn_id,
                            "reason": "interrupted",
                            "started_at": turn["startedAt"],
                            "completed_at": turn["completedAt"],
                            "duration_ms": turn["durationMs"]
                        }))
                        .map_err(state_error)?;
                }
                Some("inProgress") => {
                    return Err(RpcError::invalid("cannot copy an in-progress turn"));
                }
                _ => {
                    appender
                        .append_event(json!({
                            "type": "turn_complete",
                            "turn_id": turn_id,
                            "last_agent_message": Value::Null,
                            "error": turn.get("error").filter(|value| !value.is_null()).map(turn_error_to_core),
                            "started_at": turn["startedAt"],
                            "completed_at": turn["completedAt"],
                            "duration_ms": turn["durationMs"],
                            "time_to_first_token_ms": Value::Null
                        }))
                        .map_err(state_error)?;
                }
            }
        }
        appender.sync_data().map_err(state_error)
    }

    fn append_recovered_rollout_items(
        &self,
        loaded: &LoadedThread,
        items: &[RecoveredRolloutItem],
    ) -> RpcResult<()> {
        let Some(appender) = rollout_appender(loaded)? else {
            return Ok(());
        };
        for recovered in items {
            match &recovered.item {
                RecoveredRolloutItemKind::SessionMeta(_) => {}
                RecoveredRolloutItemKind::TurnContext(context) => {
                    appender
                        .append_turn_context(context.clone())
                        .map_err(state_error)?;
                }
                RecoveredRolloutItemKind::ResponseItem(item) => {
                    appender
                        .append_response_item(item.clone())
                        .map_err(state_error)?;
                }
                RecoveredRolloutItemKind::Compacted(item) => {
                    appender
                        .append_compacted(item.clone())
                        .map_err(state_error)?;
                }
                RecoveredRolloutItemKind::WorldState(item) => {
                    appender
                        .append_world_state(item.clone())
                        .map_err(state_error)?;
                }
                RecoveredRolloutItemKind::EventMsg(event) => {
                    appender.append_event(event.clone()).map_err(state_error)?;
                }
            }
        }
        appender.sync_data().map_err(state_error)
    }

    fn create_loaded_thread(
        &self,
        mut record: ThreadRecord,
        injected_items: Vec<Value>,
        state: &mut ManagerState,
    ) -> RpcResult<LoadedThread> {
        let legacy_turns = std::mem::take(&mut record.turns);
        let compact_window = CompactWindow::new();
        let metadata = if record.ephemeral {
            None
        } else {
            let rollout_path = self
                .inner
                .threads_root
                .join(&record.id)
                .join("rollout.jsonl");
            let appender = self
                .inner
                .store
                .rollout_appender(&rollout_path)
                .map_err(state_error)?;
            appender
                .ensure_canonical_session_meta(
                    &record.id,
                    canonical_session_meta(&record, &compact_window),
                )
                .map_err(state_error)?;
            for item in &injected_items {
                appender
                    .append_response_item(item.clone())
                    .map_err(state_error)?;
            }
            appender.sync_data().map_err(state_error)?;
            let metadata = metadata_from_record(&record, rollout_path)?;
            self.inner
                .store
                .upsert_metadata(&metadata)
                .map_err(state_error)?;
            Some(metadata)
        };
        let active_context_tokens = estimate_history_tokens(&injected_items);
        let loaded = LoadedThread {
            record: record.clone(),
            metadata,
            status: json!({"type": "idle"}),
            turns: legacy_turns,
            active_turn_id: None,
            pending_inputs: Vec::new(),
            accepted_client_messages: HashMap::new(),
            unload_when_idle: false,
            guardian_approvals: Vec::new(),
            injected_items,
            token_usage: TokenUsage::default(),
            last_token_usage: TokenUsage::default(),
            active_context_tokens,
            compact_window,
            world_state_baseline: None,
            active_compaction_item_id: None,
            active_compaction_automatic: false,
        };
        state.loaded.insert(record.id.clone(), loaded.clone());
        Ok(loaded)
    }

    fn load_thread_locked(&self, id: &str, state: &mut ManagerState) -> RpcResult<LoadedThread> {
        if let Some(loaded) = state.loaded.get(id) {
            return Ok(loaded.clone());
        }
        let metadata = self.metadata(id)?;
        if metadata.archived_at_ms != 0 {
            return Err(RpcError::invalid(format!("thread is archived: {id}")));
        }
        let mut record = self.record_from_metadata(&metadata)?;
        let recovery = self
            .inner
            .store
            .recover_rollout(&metadata.rollout_path)
            .map_err(state_error)?;
        let mut projection = project_turns(&recovery.rollout_items)?;
        if projection.turns.is_empty() && !record.turns.is_empty() {
            projection.turns = std::mem::take(&mut record.turns);
        }
        let context = reconstruct_context(&recovery.rollout_items);
        let injected_items = context.history;
        let mut loaded = LoadedThread {
            record,
            metadata: Some(metadata),
            status: json!({"type": "idle"}),
            turns: projection.turns,
            active_turn_id: projection.active_turn_id,
            pending_inputs: Vec::new(),
            accepted_client_messages: projection.accepted_client_messages,
            unload_when_idle: false,
            guardian_approvals: Vec::new(),
            injected_items,
            token_usage: projection.token_usage,
            last_token_usage: projection.last_token_usage,
            active_context_tokens: projection.active_context_tokens,
            compact_window: context.window,
            world_state_baseline: context.world_state_baseline,
            active_compaction_item_id: None,
            active_compaction_automatic: false,
        };
        // A process restart cannot safely resume an in-flight model/tool
        // operation. Codex exposes such persisted turns as interrupted instead
        // of replaying them and risking duplicate side effects.
        if let Some(turn_id) = loaded.active_turn_id.clone() {
            self.finish_turn_locked(&mut loaded, &turn_id, "interrupted", None, "interrupted")?;
        }
        state.loaded.insert(id.into(), loaded.clone());
        Ok(loaded)
    }

    fn loaded_thread_locked(&self, id: &str, state: &ManagerState) -> RpcResult<LoadedThread> {
        state
            .loaded
            .get(id)
            .cloned()
            .ok_or_else(|| RpcError::invalid(format!("thread not loaded: {id}")))
    }

    fn thread_for_update_locked(
        &self,
        id: &str,
        state: &ManagerState,
    ) -> RpcResult<(LoadedThread, bool)> {
        if let Some(loaded) = state.loaded.get(id) {
            return Ok((loaded.clone(), true));
        }
        let metadata = self.metadata(id)?;
        let record = self.record_from_metadata(&metadata)?;
        Ok((
            LoadedThread {
                record,
                metadata: Some(metadata),
                status: json!({"type": "notLoaded"}),
                turns: Vec::new(),
                active_turn_id: None,
                pending_inputs: Vec::new(),
                accepted_client_messages: HashMap::new(),
                unload_when_idle: false,
                guardian_approvals: Vec::new(),
                injected_items: Vec::new(),
                token_usage: TokenUsage::default(),
                last_token_usage: TokenUsage::default(),
                active_context_tokens: 0,
                compact_window: CompactWindow::new(),
                world_state_baseline: None,
                active_compaction_item_id: None,
                active_compaction_automatic: false,
            },
            false,
        ))
    }

    fn persist_loaded(&self, loaded: &mut LoadedThread) -> RpcResult<()> {
        if loaded.record.ephemeral {
            return Ok(());
        }
        let metadata = loaded
            .metadata
            .as_mut()
            .ok_or_else(|| RpcError::internal("persistent thread is missing metadata"))?;
        metadata.updated_at_ms = loaded.record.updated_at_ms;
        metadata.title = loaded.record.name.clone().unwrap_or_default();
        metadata.preview = loaded.record.preview.clone();
        metadata.canonical = Some(serde_json::to_value(&loaded.record).map_err(json_error)?);
        self.inner
            .store
            .upsert_metadata(metadata)
            .map_err(state_error)
    }

    fn rebuild_missing_indexes(&self) -> Result<(), StateError> {
        for entry in fs::read_dir(&self.inner.threads_root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let rollout_path = entry.path().join("rollout.jsonl");
            if !rollout_path.is_file() {
                continue;
            }
            let recovery = self.inner.store.recover_rollout(&rollout_path)?;
            let Some(meta) = recovery.session_meta.as_ref() else {
                continue;
            };
            // Legacy R4 session metadata is reconciled by the conversation
            // migration layer. Only canonical Codex metadata is owned here.
            if meta.get("session_id").is_none() || meta.get("cli_version").is_none() {
                continue;
            }
            let Some(id) = meta.get("id").and_then(Value::as_str) else {
                continue;
            };
            if self.inner.store.thread(id)?.is_some() {
                continue;
            }
            let record = self.record_from_session_meta(
                id,
                meta,
                recovery.session_created_at_ms.unwrap_or_else(now_ms),
            )?;
            let metadata = metadata_from_record(&record, rollout_path)
                .map_err(|error| StateError::Invalid(error.message))?;
            self.inner.store.upsert_metadata(&metadata)?;
        }
        Ok(())
    }

    fn record_from_session_meta(
        &self,
        id: &str,
        meta: &Value,
        created_at_ms: u64,
    ) -> Result<ThreadRecord, StateError> {
        validate_thread_id(id).map_err(|error| StateError::Invalid(error.message))?;
        let cwd = meta
            .get("cwd")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| self.inner.defaults.cwd.clone());
        let git_info = meta
            .get("git")
            .and_then(Value::as_object)
            .map(|git| GitInfo {
                sha: git
                    .get("commit_hash")
                    .or_else(|| git.get("sha"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                branch: git.get("branch").and_then(Value::as_str).map(str::to_owned),
                origin_url: git
                    .get("repository_url")
                    .or_else(|| git.get("origin_url"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        Ok(ThreadRecord {
            id: id.into(),
            session_id: meta
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .into(),
            forked_from_id: snake_optional_string(meta, "forked_from_id"),
            parent_thread_id: snake_optional_string(meta, "parent_thread_id"),
            preview: String::new(),
            ephemeral: false,
            history_mode: meta
                .get("history_mode")
                .and_then(Value::as_str)
                .unwrap_or("legacy")
                .into(),
            model_provider: meta
                .get("model_provider")
                .and_then(Value::as_str)
                .unwrap_or(&self.inner.defaults.model_provider)
                .into(),
            model: self.inner.defaults.model.clone(),
            model_context_window: resolve_model_context_window(
                &self.inner.defaults.model_context_windows,
                &self.inner.defaults.model,
            ),
            cwd,
            cli_version: meta
                .get("cli_version")
                .and_then(Value::as_str)
                .unwrap_or(&self.inner.defaults.cli_version)
                .into(),
            source: meta
                .get("source")
                .cloned()
                .unwrap_or_else(|| json!("appServer")),
            thread_source: meta
                .get("thread_source")
                .filter(|value| !value.is_null())
                .cloned(),
            git_info,
            name: None,
            approval_policy: self.inner.defaults.approval_policy.clone(),
            approvals_reviewer: self.inner.defaults.approvals_reviewer.clone(),
            sandbox: self.inner.defaults.sandbox.clone(),
            reasoning_effort: self.inner.defaults.reasoning_effort.clone(),
            reasoning_summary: None,
            personality: None,
            service_tier: self.inner.defaults.service_tier.clone(),
            created_at_ms,
            updated_at_ms: created_at_ms,
            recency_at_ms: Some(created_at_ms),
            turns: Vec::new(),
        })
    }

    fn metadata(&self, id: &str) -> RpcResult<ThreadMetadata> {
        self.inner
            .store
            .thread(id)
            .map_err(state_error)?
            .ok_or_else(|| RpcError::invalid(format!("thread not found: {id}")))
    }

    fn record_from_metadata(&self, metadata: &ThreadMetadata) -> RpcResult<ThreadRecord> {
        if let Some(canonical) = &metadata.canonical {
            let mut record: ThreadRecord =
                serde_json::from_value(canonical.clone()).map_err(json_error)?;
            record.name = (!metadata.title.is_empty()).then(|| metadata.title.clone());
            record.preview = metadata.preview.clone();
            record.updated_at_ms = metadata.updated_at_ms;
            return Ok(record);
        }
        let cwd = metadata
            .rollout_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.inner.defaults.cwd.clone());
        Ok(ThreadRecord {
            id: metadata.id.clone(),
            session_id: metadata.id.clone(),
            forked_from_id: None,
            parent_thread_id: None,
            preview: metadata.preview.clone(),
            ephemeral: false,
            history_mode: "legacy".into(),
            model_provider: self.inner.defaults.model_provider.clone(),
            model: self.inner.defaults.model.clone(),
            model_context_window: resolve_model_context_window(
                &self.inner.defaults.model_context_windows,
                &self.inner.defaults.model,
            ),
            cwd,
            cli_version: self.inner.defaults.cli_version.clone(),
            source: json!("appServer"),
            thread_source: None,
            git_info: None,
            name: (!metadata.title.is_empty()).then(|| metadata.title.clone()),
            approval_policy: self.inner.defaults.approval_policy.clone(),
            approvals_reviewer: self.inner.defaults.approvals_reviewer.clone(),
            sandbox: self.inner.defaults.sandbox.clone(),
            reasoning_effort: self.inner.defaults.reasoning_effort.clone(),
            reasoning_summary: None,
            personality: None,
            service_tier: self.inner.defaults.service_tier.clone(),
            created_at_ms: metadata.created_at_ms,
            updated_at_ms: metadata.updated_at_ms,
            recency_at_ms: Some(metadata.updated_at_ms),
            turns: Vec::new(),
        })
    }

    fn apply_open_overrides(&self, record: &mut ThreadRecord, params: &Value) -> RpcResult<()> {
        if let Some(model) = optional_string(params, "model") {
            record.model = model;
        }
        if let Some(provider) = optional_string(params, "modelProvider") {
            record.model_provider = provider;
        }
        if params.get("serviceTier").is_some() {
            record.service_tier = optional_nullable_string(params, "serviceTier").unwrap_or(None);
        }
        if let Some(cwd) = params.get("cwd").filter(|value| !value.is_null()) {
            record.cwd = self.resolve_cwd(Some(cwd))?;
        }
        if let Some(policy) = params
            .get("approvalPolicy")
            .filter(|value| !value.is_null())
        {
            record.approval_policy = policy.clone();
        }
        if let Some(reviewer) = optional_string(params, "approvalsReviewer") {
            record.approvals_reviewer = reviewer;
        }
        if let Some(sandbox) = params.get("sandbox").filter(|value| !value.is_null()) {
            record.sandbox = self.resolve_sandbox(Some(sandbox), &record.cwd)?;
        }
        Ok(())
    }

    fn resolve_cwd(&self, value: Option<&Value>) -> RpcResult<PathBuf> {
        let cwd = match value {
            None | Some(Value::Null) => self.inner.defaults.cwd.clone(),
            Some(Value::String(path)) => PathBuf::from(path),
            Some(_) => return Err(RpcError::invalid("cwd must be a string")),
        };
        if !cwd.is_absolute() {
            return Err(RpcError::invalid("cwd must be absolute"));
        }
        Ok(cwd)
    }

    fn resolve_sandbox(&self, value: Option<&Value>, cwd: &Path) -> RpcResult<Value> {
        let Some(value) = value.filter(|value| !value.is_null()) else {
            let mut sandbox = self.inner.defaults.sandbox.clone();
            if sandbox.get("type").and_then(Value::as_str) == Some("workspaceWrite")
                && sandbox
                    .get("writableRoots")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
            {
                sandbox["writableRoots"] = json!([cwd]);
            }
            return Ok(sandbox);
        };
        match value.as_str() {
            Some("read-only") => Ok(json!({"type": "readOnly", "networkAccess": false})),
            Some("workspace-write") => Ok(json!({
                "type": "workspaceWrite",
                "writableRoots": [cwd],
                "networkAccess": false,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false
            })),
            Some("danger-full-access") => Ok(json!({"type": "dangerFullAccess"})),
            Some(other) => Err(RpcError::invalid(format!("invalid sandbox mode: {other}"))),
            None => Err(RpcError::invalid("sandbox must be a string")),
        }
    }

    fn thread_open_response(
        &self,
        record: &ThreadRecord,
        status: &Value,
        turns: Vec<Value>,
    ) -> Value {
        json!({
            "thread": self.thread_value(record, status, turns),
            "model": record.model,
            "modelProvider": record.model_provider,
            "serviceTier": record.service_tier,
            "cwd": record.cwd,
            "instructionSources": [],
            "approvalPolicy": record.approval_policy,
            "approvalsReviewer": record.approvals_reviewer,
            "sandbox": record.sandbox,
            "reasoningEffort": record.reasoning_effort
        })
    }

    fn thread_value(&self, record: &ThreadRecord, status: &Value, turns: Vec<Value>) -> Value {
        json!({
            "id": record.id,
            "sessionId": record.session_id,
            "forkedFromId": record.forked_from_id,
            "parentThreadId": record.parent_thread_id,
            "preview": record.preview,
            "ephemeral": record.ephemeral,
            "modelProvider": record.model_provider,
            "createdAt": milliseconds_to_seconds(record.created_at_ms),
            "updatedAt": milliseconds_to_seconds(record.updated_at_ms),
            "recencyAt": record.recency_at_ms.map(milliseconds_to_seconds),
            "status": status,
            "path": (!record.ephemeral).then(|| {
                self.inner.threads_root.join(&record.id).join("rollout.jsonl")
            }),
            "cwd": record.cwd,
            "cliVersion": record.cli_version,
            "source": record.source,
            "threadSource": record.thread_source,
            "agentNickname": Value::Null,
            "agentRole": Value::Null,
            "gitInfo": record.git_info,
            "name": record.name,
            "turns": turns
        })
    }

    fn notification_for(
        &self,
        state: &ManagerState,
        thread_id: &str,
        method: &str,
        params: Value,
    ) -> RoutedNotification {
        let mut recipients = state
            .subscribers
            .get(thread_id)
            .map(|subscribers| subscribers.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        recipients.sort();
        RoutedNotification {
            recipients,
            method: method.into(),
            params,
        }
    }

    fn notification_global(
        &self,
        state: &ManagerState,
        method: &str,
        params: Value,
    ) -> RoutedNotification {
        RoutedNotification {
            recipients: sorted_connections(&state.connections),
            method: method.into(),
            params,
        }
    }

    fn checked_notification_for(
        &self,
        state: &ManagerState,
        thread_id: &str,
        method: &str,
        params: Value,
    ) -> RpcResult<RoutedNotification> {
        let notification = self.notification_for(state, thread_id, method, params);
        serde_json::from_value::<ServerNotification>(notification.wire_message()).map_err(
            |error| {
                RpcError::invalid(format!(
                    "invalid {} notification payload: {error}",
                    notification.method
                ))
            },
        )?;
        Ok(notification)
    }

    fn checked_global_notification(
        &self,
        state: &ManagerState,
        method: &str,
        params: Value,
    ) -> RpcResult<RoutedNotification> {
        let notification = self.notification_global(state, method, params);
        serde_json::from_value::<ServerNotification>(notification.wire_message()).map_err(
            |error| {
                RpcError::invalid(format!(
                    "invalid {} notification payload: {error}",
                    notification.method
                ))
            },
        )?;
        Ok(notification)
    }

    fn require_loaded(&self, thread_id: &str) -> RpcResult<()> {
        validate_thread_id(thread_id)?;
        let state = self.state()?;
        if state.loaded.contains_key(thread_id) {
            Ok(())
        } else {
            Err(RpcError::invalid(format!("thread not loaded: {thread_id}")))
        }
    }

    fn state(&self) -> RpcResult<MutexGuard<'_, ManagerState>> {
        self.inner
            .state
            .lock()
            .map_err(|_| RpcError::internal("thread manager lock is poisoned"))
    }
}

fn user_input(params: &Value) -> RpcResult<Vec<Value>> {
    params
        .get("input")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| RpcError::invalid("input must be an array"))
}

fn validate_user_input(input: &[Value]) -> RpcResult<()> {
    let actual_chars = input
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .map(str::chars)
        .map(Iterator::count)
        .sum::<usize>();
    if actual_chars > MAX_USER_INPUT_TEXT_CHARS {
        return Err(RpcError::invalid_with_data(
            format!("Input exceeds the maximum length of {MAX_USER_INPUT_TEXT_CHARS} characters."),
            json!({
                "input_error_code": "input_too_large",
                "max_chars": MAX_USER_INPUT_TEXT_CHARS,
                "actual_chars": actual_chars
            }),
        ));
    }
    if input.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("image")
            && item
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(is_remote_url)
    }) {
        return Err(RpcError::invalid_request(
            "remote image URLs are not supported; use an inline data URL instead",
        ));
    }
    Ok(())
}

fn is_remote_url(value: &str) -> bool {
    value.split_once(':').is_some_and(|(scheme, _)| {
        scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
    })
}

fn duplicate_turn_start_response(
    loaded: &LoadedThread,
    client_id: Option<&str>,
    input: &[Value],
) -> RpcResult<Option<Value>> {
    let Some(client_id) = client_id else {
        return Ok(None);
    };
    let Some(accepted) = loaded.accepted_client_messages.get(client_id) else {
        return Ok(None);
    };
    if accepted.input != input {
        return Err(RpcError::invalid_request(
            "clientUserMessageId was already used with different input",
        ));
    }
    let mut turn = loaded
        .turns
        .iter()
        .find(|turn| turn.get("id").and_then(Value::as_str) == Some(&accepted.turn_id))
        .cloned()
        .ok_or_else(|| RpcError::internal("accepted message references a missing turn"))?;
    turn["items"] = json!([]);
    turn["itemsView"] = json!("notLoaded");
    Ok(Some(json!({"turn": turn})))
}

fn active_thread_status() -> Value {
    json!({"type": "active", "activeFlags": []})
}

fn resolve_model_context_window(configured: &HashMap<String, i64>, model: &str) -> Option<i64> {
    model_context_window(model).or_else(|| {
        configured
            .get(&model.to_ascii_lowercase())
            .copied()
            .filter(|value| *value > 0)
    })
}

fn append_model_history(loaded: &mut LoadedThread, item: Value) {
    let added_tokens = estimate_history_tokens(std::slice::from_ref(&item));
    loaded.injected_items.push(item);
    if loaded.last_token_usage.total_tokens > 0
        && loaded.active_context_tokens >= loaded.last_token_usage.total_tokens
    {
        loaded.active_context_tokens = loaded.active_context_tokens.saturating_add(added_tokens);
    } else {
        loaded.active_context_tokens = estimate_history_tokens(&loaded.injected_items);
    }
}

fn extend_model_history(loaded: &mut LoadedThread, items: impl IntoIterator<Item = Value>) {
    for item in items {
        append_model_history(loaded, item);
    }
}

fn compaction_snapshot(
    loaded: &LoadedThread,
    turn_id: &str,
) -> RpcResult<CompactionExecutionSnapshot> {
    let item_id = loaded
        .active_compaction_item_id
        .clone()
        .ok_or_else(|| RpcError::invalid_request("compaction is not active"))?;
    Ok(CompactionExecutionSnapshot {
        thread_id: loaded.record.id.clone(),
        turn_id: turn_id.into(),
        item_id,
        model: loaded.record.model.clone(),
        model_provider: loaded.record.model_provider.clone(),
        reasoning_effort: loaded.record.reasoning_effort.clone(),
        reasoning_summary: loaded.record.reasoning_summary.clone(),
        service_tier: loaded.record.service_tier.clone(),
        history: loaded.injected_items.clone(),
        automatic: loaded.active_compaction_automatic,
        model_context_window: loaded.record.model_context_window,
    })
}

#[allow(clippy::too_many_arguments)]
fn turn_value(
    id: &str,
    items: Vec<Value>,
    status: &str,
    error: Option<Value>,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    duration_ms: Option<i64>,
    items_view: &str,
) -> Value {
    json!({
        "id": id,
        "items": items,
        "itemsView": items_view,
        "status": status,
        "error": error,
        "startedAt": started_at,
        "completedAt": completed_at,
        "durationMs": duration_ms
    })
}

fn update_preview(record: &mut ThreadRecord, input: &[Value]) {
    if !record.preview.is_empty() {
        return;
    }
    let preview = input
        .iter()
        .find_map(|item| match item.get("type").and_then(Value::as_str) {
            Some("text") => item
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned),
            Some("image" | "localImage") => Some("[Image]".into()),
            Some("audio" | "localAudio") => Some("[Audio]".into()),
            Some("skill") => Some("[Skill]".into()),
            Some("mention") => Some("[Mention]".into()),
            _ => None,
        });
    if let Some(preview) = preview {
        record.preview = preview;
    }
}

fn rollout_appender(loaded: &LoadedThread) -> RpcResult<Option<RolloutAppender>> {
    loaded
        .metadata
        .as_ref()
        .map(|metadata| RolloutAppender::open(&metadata.rollout_path).map_err(state_error))
        .transpose()
}

fn turn_context_value(record: &ThreadRecord, turn_id: &str) -> Value {
    json!({
        "turn_id": turn_id,
        "cwd": record.cwd,
        "approval_policy": record.approval_policy,
        "approvals_reviewer": record.approvals_reviewer,
        "sandbox_policy": record.sandbox,
        "model": record.model,
        "personality": record.personality,
        "effort": record.reasoning_effort,
        "summary": "auto"
    })
}

fn append_user_input_to_rollout(
    appender: &RolloutAppender,
    thread_id: &str,
    turn_id: &str,
    item: &Value,
    input: &[Value],
    now: u64,
) -> RpcResult<()> {
    appender
        .append_response_item(response_item_from_user_input(input))
        .map_err(state_error)?;
    appender
        .append_event(item_lifecycle_event(
            "item_started",
            thread_id,
            turn_id,
            item,
            "started_at_ms",
            now,
        )?)
        .map_err(state_error)?;
    appender
        .append_event(item_lifecycle_event(
            "item_completed",
            thread_id,
            turn_id,
            item,
            "completed_at_ms",
            now,
        )?)
        .map_err(state_error)?;
    Ok(())
}

fn item_lifecycle_event(
    event_type: &str,
    thread_id: &str,
    turn_id: &str,
    item: &Value,
    timestamp_key: &str,
    timestamp: u64,
) -> RpcResult<Value> {
    let mut event = Map::from_iter([
        ("type".into(), json!(event_type)),
        ("thread_id".into(), json!(thread_id)),
        ("turn_id".into(), json!(turn_id)),
        ("item".into(), v2_item_to_core(item)?),
    ]);
    event.insert(timestamp_key.into(), json!(timestamp));
    Ok(Value::Object(event))
}

fn v2_item_to_core(item: &Value) -> RpcResult<Value> {
    match item.get("type").and_then(Value::as_str) {
        Some("userMessage") => Ok(json!({
            "type": "UserMessage",
            "id": required_item_string(item, "id", "userMessage item")?,
            "client_id": item.get("clientId").cloned().unwrap_or(Value::Null),
            "content": item
                .get("content")
                .and_then(Value::as_array)
                .ok_or_else(|| RpcError::invalid("userMessage content is required"))?
                .iter()
                .map(v2_input_to_core)
                .collect::<RpcResult<Vec<_>>>()?
        })),
        Some("agentMessage") => Ok(json!({
            "type": "AgentMessage",
            "id": required_item_string(item, "id", "agentMessage item")?,
            "text": item.get("text").cloned().unwrap_or_else(|| json!("")),
            "phase": item.get("phase").cloned().unwrap_or(Value::Null),
            "memory_citation": item.get("memoryCitation").cloned().unwrap_or(Value::Null)
        })),
        Some("reasoning") => Ok(json!({
            "type": "Reasoning",
            "id": required_item_string(item, "id", "reasoning item")?,
            "summary": item.get("summary").cloned().unwrap_or_else(|| json!([])),
            "content": item.get("content").cloned().unwrap_or_else(|| json!([]))
        })),
        Some("contextCompaction") => Ok(json!({
            "type": "ContextCompaction",
            "id": required_item_string(item, "id", "contextCompaction item")?
        })),
        Some("sleep") => Ok(json!({
            "type": "Extension",
            "kind": "clock.sleep",
            "id": required_item_string(item, "id", "sleep item")?,
            "durationMs": item.get("durationMs").cloned().unwrap_or(Value::Null)
        })),
        Some("imageView") => Ok(json!({
            "type": "ImageView",
            "id": required_item_string(item, "id", "imageView item")?,
            "path": item.get("path").cloned().unwrap_or(Value::Null)
        })),
        Some("webSearch") => Ok(json!({
            "type": "WebSearch",
            "id": required_item_string(item, "id", "webSearch item")?,
            "query": item.get("query").cloned().unwrap_or_else(|| json!("")),
            "action": web_search_action_to_core(item.get("action")),
            "results": item.get("results").cloned().unwrap_or(Value::Null)
        })),
        Some("fileChange") => Ok(json!({
            "type": "FileChange",
            "id": required_item_string(item, "id", "fileChange item")?,
            "changes": item.get("changes").cloned().unwrap_or_else(|| json!([])),
            "status": item.get("status").cloned().unwrap_or_else(|| json!("inProgress"))
        })),
        Some(other) => Err(RpcError::internal(format!(
            "unsupported ThreadItem conversion to core: {other}"
        ))),
        None => Err(RpcError::invalid("ThreadItem type is required")),
    }
}

fn core_item_to_v2(item: &Value) -> RpcResult<Value> {
    match item.get("type").and_then(Value::as_str) {
        Some("UserMessage") => Ok(json!({
            "type": "userMessage",
            "id": required_item_string(item, "id", "UserMessage item")?,
            "clientId": item.get("client_id").cloned().unwrap_or(Value::Null),
            "content": item
                .get("content")
                .and_then(Value::as_array)
                .ok_or_else(|| RpcError::internal("persisted UserMessage content is missing"))?
                .iter()
                .map(core_input_to_v2)
                .collect::<RpcResult<Vec<_>>>()?
        })),
        Some("AgentMessage") => Ok(json!({
            "type": "agentMessage",
            "id": required_item_string(item, "id", "AgentMessage item")?,
            "text": item.get("text").cloned().unwrap_or_else(|| json!("")),
            "phase": item.get("phase").cloned().unwrap_or(Value::Null),
            "memoryCitation": item.get("memory_citation").cloned().unwrap_or(Value::Null)
        })),
        Some("Reasoning") => Ok(json!({
            "type": "reasoning",
            "id": required_item_string(item, "id", "Reasoning item")?,
            "summary": item.get("summary").cloned().unwrap_or_else(|| json!([])),
            "content": item.get("content").cloned().unwrap_or_else(|| json!([]))
        })),
        Some("ContextCompaction") => Ok(json!({
            "type": "contextCompaction",
            "id": required_item_string(item, "id", "ContextCompaction item")?
        })),
        Some("Extension") if item.get("kind").and_then(Value::as_str) == Some("clock.sleep") => {
            Ok(json!({
                "type": "sleep",
                "id": required_item_string(item, "id", "clock.sleep item")?,
                "durationMs": item.get("durationMs").cloned().unwrap_or(Value::Null)
            }))
        }
        Some("ImageView") => Ok(json!({
            "type": "imageView",
            "id": required_item_string(item, "id", "ImageView item")?,
            "path": item.get("path").cloned().unwrap_or(Value::Null)
        })),
        Some("WebSearch") => Ok(json!({
            "type": "webSearch",
            "id": required_item_string(item, "id", "WebSearch item")?,
            "query": item.get("query").cloned().unwrap_or_else(|| json!("")),
            "action": web_search_action_to_v2(item.get("action")),
            "results": item.get("results").cloned().unwrap_or(Value::Null)
        })),
        Some("FileChange") => Ok(json!({
            "type": "fileChange",
            "id": required_item_string(item, "id", "FileChange item")?,
            "changes": item.get("changes").cloned().unwrap_or_else(|| json!([])),
            "status": item.get("status").cloned().unwrap_or_else(|| json!("inProgress"))
        })),
        Some(other) => Err(RpcError::internal(format!(
            "unsupported core TurnItem conversion: {other}"
        ))),
        None => Err(RpcError::internal("persisted TurnItem type is missing")),
    }
}

fn required_item_string<'a>(value: &'a Value, key: &str, kind: &str) -> RpcResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid(format!("{kind} {key} is required")))
}

fn v2_input_to_core(input: &Value) -> RpcResult<Value> {
    let object = input
        .as_object()
        .ok_or_else(|| RpcError::invalid("user input must be an object"))?;
    match object.get("type").and_then(Value::as_str) {
        Some("text") => Ok(json!({
            "type": "text",
            "text": object.get("text").cloned().unwrap_or(Value::Null),
            "text_elements": object.get("textElements").cloned().unwrap_or_else(|| json!([]))
        })),
        Some("image") => Ok(json!({
            "type": "image",
            "image_url": object.get("url").cloned().unwrap_or(Value::Null),
            "detail": object.get("detail").cloned().unwrap_or(Value::Null)
        })),
        Some("localImage") => Ok(json!({
            "type": "local_image",
            "path": object.get("path").cloned().unwrap_or(Value::Null),
            "detail": object.get("detail").cloned().unwrap_or(Value::Null)
        })),
        Some("audio") => Ok(json!({
            "type": "audio",
            "audio_url": object.get("url").cloned().unwrap_or(Value::Null)
        })),
        Some("localAudio") => Ok(json!({
            "type": "local_audio",
            "path": object.get("path").cloned().unwrap_or(Value::Null)
        })),
        Some("skill") => Ok(json!({
            "type": "skill",
            "name": object.get("name").cloned().unwrap_or(Value::Null),
            "path": object.get("path").cloned().unwrap_or(Value::Null)
        })),
        Some("mention") => Ok(json!({
            "type": "mention",
            "name": object.get("name").cloned().unwrap_or(Value::Null),
            "path": object.get("path").cloned().unwrap_or(Value::Null)
        })),
        Some(other) => Err(RpcError::invalid(format!(
            "unsupported user input type: {other}"
        ))),
        None => Err(RpcError::invalid("user input type is required")),
    }
}

fn core_input_to_v2(input: &Value) -> RpcResult<Value> {
    let object = input
        .as_object()
        .ok_or_else(|| RpcError::internal("persisted user input must be an object"))?;
    match object.get("type").and_then(Value::as_str) {
        Some("text") => Ok(json!({
            "type": "text",
            "text": object.get("text").cloned().unwrap_or(Value::Null),
            "textElements": object.get("text_elements").cloned().unwrap_or_else(|| json!([]))
        })),
        Some("image") => Ok(json!({
            "type": "image",
            "url": object.get("image_url").cloned().unwrap_or(Value::Null),
            "detail": object.get("detail").cloned().unwrap_or(Value::Null)
        })),
        Some("local_image") => Ok(json!({
            "type": "localImage",
            "path": object.get("path").cloned().unwrap_or(Value::Null),
            "detail": object.get("detail").cloned().unwrap_or(Value::Null)
        })),
        Some("audio") => Ok(json!({
            "type": "audio",
            "url": object.get("audio_url").cloned().unwrap_or(Value::Null)
        })),
        Some("local_audio") => Ok(json!({
            "type": "localAudio",
            "path": object.get("path").cloned().unwrap_or(Value::Null)
        })),
        Some("skill") => Ok(json!({
            "type": "skill",
            "name": object.get("name").cloned().unwrap_or(Value::Null),
            "path": object.get("path").cloned().unwrap_or(Value::Null)
        })),
        Some("mention") => Ok(json!({
            "type": "mention",
            "name": object.get("name").cloned().unwrap_or(Value::Null),
            "path": object.get("path").cloned().unwrap_or(Value::Null)
        })),
        Some(other) => Err(RpcError::internal(format!(
            "unsupported persisted user input type: {other}"
        ))),
        None => Err(RpcError::internal("persisted user input type is missing")),
    }
}

fn response_item_from_user_input(input: &[Value]) -> Value {
    let mut content = Vec::new();
    let mut image_index = 0_usize;
    let mut audio_index = 0_usize;
    for item in input {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    content.push(json!({"type": "input_text", "text": text}));
                }
            }
            Some("image") => {
                image_index = image_index.saturating_add(1);
                if let Some(url) = item.get("url").and_then(Value::as_str) {
                    content.push(json!({
                        "type": "input_image",
                        "image_url": url,
                        "detail": input_image_detail(item)
                    }));
                }
            }
            Some("localImage") => {
                image_index = image_index.saturating_add(1);
                if let Some(path) = item.get("path").and_then(Value::as_str) {
                    let path = Path::new(path);
                    match fs::read(path) {
                        Ok(bytes) => {
                            content.push(json!({
                                "type": "input_text",
                                "text": format!(
                                    "<image name=[Image #{}] path=\"{}\">",
                                    image_index,
                                    path.display()
                                )
                            }));
                            content.push(json!({
                                "type": "input_image",
                                "image_url": format!(
                                    "data:application/octet-stream;base64,{}",
                                    base64::engine::general_purpose::STANDARD.encode(bytes)
                                ),
                                "detail": input_image_detail(item)
                            }));
                            content.push(json!({"type": "input_text", "text": "</image>"}));
                        }
                        Err(error) => content.push(json!({
                            "type": "input_text",
                            "text": format!(
                                "Codex could not read the local image at `{}`: {error}",
                                path.display()
                            )
                        })),
                    }
                }
            }
            Some("audio") => {
                audio_index = audio_index.saturating_add(1);
                if let Some(url) = item.get("url").and_then(Value::as_str) {
                    content.push(json!({"type": "input_audio", "audio_url": url}));
                }
            }
            Some("localAudio") => {
                audio_index = audio_index.saturating_add(1);
                if let Some(path) = item.get("path").and_then(Value::as_str) {
                    append_local_audio_content(&mut content, Path::new(path), audio_index);
                }
            }
            Some("skill" | "mention") | None | Some(_) => {}
        }
    }
    json!({"type": "message", "role": "user", "content": content})
}

fn input_image_detail(item: &Value) -> &str {
    item.get("detail").and_then(Value::as_str).unwrap_or("high")
}

fn append_local_audio_content(content: &mut Vec<Value>, path: &Path, label: usize) {
    let Some(mime) = audio_mime(path) else {
        content.push(json!({
            "type": "input_text",
            "text": format!(
                "Codex cannot attach audio at `{}`: unsupported audio format; use wav, mp3, m4a, webm, or ogg.",
                path.display()
            )
        }));
        return;
    };
    match fs::read(path) {
        Ok(bytes) => {
            content.push(json!({
                "type": "input_text",
                "text": format!(
                    "<audio name=[Audio #{}] path=\"{}\">",
                    label,
                    path.display()
                )
            }));
            content.push(json!({
                "type": "input_audio",
                "audio_url": format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            }));
            content.push(json!({"type": "input_text", "text": "</audio>"}));
        }
        Err(error) => content.push(json!({
            "type": "input_text",
            "text": format!(
                "Codex could not read the local audio at `{}`: {error}",
                path.display()
            )
        })),
    }
}

fn audio_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "wav" => Some("audio/wav"),
        "mp3" => Some("audio/mpeg"),
        "m4a" => Some("audio/mp4"),
        "webm" => Some("audio/webm"),
        "ogg" => Some("audio/ogg"),
        _ => None,
    }
}

fn normalize_turn_error(error: Option<Value>) -> RpcResult<Value> {
    let mut error = error.unwrap_or_else(|| {
        json!({
            "message": "turn failed",
            "codexErrorInfo": "other"
        })
    });
    let object = error
        .as_object_mut()
        .ok_or_else(|| RpcError::invalid("turn error must be an object"))?;
    if object
        .get("message")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(RpcError::invalid("turn error message is required"));
    }
    object.entry("codexErrorInfo").or_insert(Value::Null);
    Ok(error)
}

fn turn_error_to_core(error: &Value) -> Value {
    json!({
        "message": error.get("message").cloned().unwrap_or(Value::Null),
        "codex_error_info": error
            .get("codexErrorInfo")
            .cloned()
            .unwrap_or(Value::Null)
    })
}

fn project_turns(items: &[RecoveredRolloutItem]) -> RpcResult<TurnProjection> {
    let mut projection = TurnProjection::default();
    for recovered in items {
        if let RecoveredRolloutItemKind::ResponseItem(item) = &recovered.item {
            projection.active_context_tokens = projection
                .active_context_tokens
                .saturating_add(estimate_history_tokens(std::slice::from_ref(item)));
            continue;
        }
        if let RecoveredRolloutItemKind::Compacted(item) = &recovered.item {
            let history = item
                .get("replacement_history")
                .or_else(|| item.get("replacementHistory"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            projection.active_context_tokens = estimate_history_tokens(&history);
            continue;
        }
        let RecoveredRolloutItemKind::EventMsg(event) = &recovered.item else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("task_started" | "turn_started") => {
                let Some(turn_id) = event.get("turn_id").and_then(Value::as_str) else {
                    continue;
                };
                if let Some(active_turn_id) = projection.active_turn_id.take()
                    && let Some(previous) = find_turn_mut(&mut projection.turns, &active_turn_id)
                {
                    previous["status"] = json!("interrupted");
                }
                let turn = turn_value(
                    turn_id,
                    Vec::new(),
                    "inProgress",
                    None,
                    event.get("started_at").and_then(Value::as_i64),
                    None,
                    None,
                    "full",
                );
                projection
                    .turns
                    .retain(|turn| turn.get("id").and_then(Value::as_str) != Some(turn_id));
                projection.turns.push(turn);
                projection.active_turn_id = Some(turn_id.into());
            }
            Some("item_started" | "item_completed") => {
                let Some(turn_id) = event.get("turn_id").and_then(Value::as_str) else {
                    continue;
                };
                let Some(core_item) = event.get("item") else {
                    continue;
                };
                let item = core_item_to_v2(core_item)?;
                serde_json::from_value::<ThreadItem>(item.clone()).map_err(|error| {
                    RpcError::internal(format!("invalid persisted ThreadItem: {error}"))
                })?;
                upsert_turn_item(&mut projection.turns, turn_id, item.clone())?;
                if item.get("type").and_then(Value::as_str) == Some("userMessage")
                    && let Some(client_id) = item.get("clientId").and_then(Value::as_str)
                {
                    projection.accepted_client_messages.insert(
                        client_id.into(),
                        AcceptedClientMessage {
                            turn_id: turn_id.into(),
                            input: item
                                .get("content")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default(),
                        },
                    );
                }
            }
            Some("error") => {
                if let Some(turn_id) = projection.active_turn_id.clone()
                    && let Some(turn) = find_turn_mut(&mut projection.turns, &turn_id)
                {
                    turn["status"] = json!("failed");
                    turn["error"] = json!({
                        "message": event
                            .get("message")
                            .cloned()
                            .unwrap_or_else(|| json!("turn failed")),
                        "codexErrorInfo": event
                            .get("codex_error_info")
                            .cloned()
                            .unwrap_or(Value::Null)
                    });
                }
            }
            Some("token_count") => {
                if let Some(total) = event.pointer("/info/total_token_usage")
                    && let Ok(total) = serde_json::from_value::<TokenUsage>(total.clone())
                {
                    projection.token_usage = total;
                }
                if let Some(last) = event.pointer("/info/last_token_usage")
                    && let Ok(last) = serde_json::from_value::<TokenUsage>(last.clone())
                {
                    projection.active_context_tokens = last.total_tokens.max(0);
                    projection.last_token_usage = last;
                }
            }
            Some("turn_complete") => {
                let Some(turn_id) = event.get("turn_id").and_then(Value::as_str) else {
                    continue;
                };
                if let Some(turn) = find_turn_mut(&mut projection.turns, turn_id) {
                    let core_error = event.get("error").filter(|value| !value.is_null());
                    if let Some(error) = core_error {
                        turn["status"] = json!("failed");
                        turn["error"] = json!({
                            "message": error
                                .get("message")
                                .cloned()
                                .unwrap_or_else(|| json!("turn failed")),
                            "codexErrorInfo": error
                                .get("codex_error_info")
                                .cloned()
                                .unwrap_or(Value::Null)
                        });
                    } else if turn.get("status").and_then(Value::as_str) != Some("failed") {
                        turn["status"] = json!("completed");
                    }
                    turn["completedAt"] = event.get("completed_at").cloned().unwrap_or(Value::Null);
                    turn["durationMs"] = event.get("duration_ms").cloned().unwrap_or(Value::Null);
                }
                if projection.active_turn_id.as_deref() == Some(turn_id) {
                    projection.active_turn_id = None;
                }
            }
            Some("turn_aborted") => {
                let turn_id = event
                    .get("turn_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| projection.active_turn_id.clone());
                if let Some(turn_id) = turn_id {
                    if let Some(turn) = find_turn_mut(&mut projection.turns, &turn_id) {
                        turn["status"] = json!("interrupted");
                        turn["error"] = Value::Null;
                        turn["completedAt"] =
                            event.get("completed_at").cloned().unwrap_or(Value::Null);
                        turn["durationMs"] =
                            event.get("duration_ms").cloned().unwrap_or(Value::Null);
                    }
                    if projection.active_turn_id.as_deref() == Some(&turn_id) {
                        projection.active_turn_id = None;
                    }
                }
            }
            Some("thread_rolled_back") => {
                let count = event.get("num_turns").and_then(Value::as_u64).unwrap_or(0) as usize;
                projection
                    .turns
                    .truncate(projection.turns.len().saturating_sub(count));
                projection.active_turn_id = projection
                    .turns
                    .last()
                    .filter(|turn| turn.get("status").and_then(Value::as_str) == Some("inProgress"))
                    .and_then(|turn| turn.get("id").and_then(Value::as_str))
                    .map(str::to_owned);
            }
            _ => {}
        }
    }
    Ok(projection)
}

fn rollout_items_through_turn(
    items: &[RecoveredRolloutItem],
    last_turn_id: Option<&str>,
) -> RpcResult<Vec<RecoveredRolloutItem>> {
    let cutoff = last_turn_id
        .map(|last_turn_id| {
            items
                .iter()
                .find(|recovered| {
                    matches!(
                        &recovered.item,
                        RecoveredRolloutItemKind::EventMsg(event)
                            if matches!(
                                event.get("type").and_then(Value::as_str),
                                Some("turn_complete" | "turn_aborted")
                            )
                            && event.get("turn_id").and_then(Value::as_str) == Some(last_turn_id)
                    )
                })
                .map(|recovered| recovered.ordinal)
                .ok_or_else(|| {
                    RpcError::internal(format!(
                        "completed turn is missing its terminal rollout event: {last_turn_id}"
                    ))
                })
        })
        .transpose()?;
    Ok(items
        .iter()
        .filter(|recovered| {
            !matches!(recovered.item, RecoveredRolloutItemKind::SessionMeta(_))
                && cutoff.is_none_or(|cutoff| recovered.ordinal <= cutoff)
        })
        .cloned()
        .collect())
}

fn response_items_from_rollout(items: &[RecoveredRolloutItem]) -> Vec<Value> {
    reconstruct_context(items).history
}

fn reconstruct_context(
    items: &[RecoveredRolloutItem],
) -> tietiezhi_agent_context::ContextReconstruction {
    reconstruct(items.iter().filter_map(|recovered| match &recovered.item {
        RecoveredRolloutItemKind::SessionMeta(item) => {
            Some(ContextRecord::SessionMeta(item.clone()))
        }
        RecoveredRolloutItemKind::ResponseItem(item) => {
            Some(ContextRecord::ResponseItem(item.clone()))
        }
        RecoveredRolloutItemKind::Compacted(item) => Some(ContextRecord::Compacted(item.clone())),
        RecoveredRolloutItemKind::WorldState(item) => Some(ContextRecord::WorldState(item.clone())),
        RecoveredRolloutItemKind::TurnContext(_) | RecoveredRolloutItemKind::EventMsg(_) => None,
    }))
}

fn response_item_to_v2(item: &Value) -> RpcResult<Option<Value>> {
    match item.get("type").and_then(Value::as_str) {
        Some("message") if item.get("role").and_then(Value::as_str) == Some("assistant") => {
            let text = item
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|content| {
                    matches!(
                        content.get("type").and_then(Value::as_str),
                        Some("output_text" | "text")
                    )
                })
                .filter_map(|content| content.get("text").and_then(Value::as_str))
                .collect::<String>();
            Ok(Some(json!({
                "type": "agentMessage",
                "id": required_item_string(item, "id", "assistant response item")?,
                "text": text,
                "phase": item.get("phase").cloned().unwrap_or(Value::Null),
                "memoryCitation": Value::Null
            })))
        }
        Some("reasoning") => {
            let summary = response_text_parts(item.get("summary"), "summary_text");
            let content = response_text_parts(item.get("content"), "reasoning_text");
            Ok(Some(json!({
                "type": "reasoning",
                "id": required_item_string(item, "id", "reasoning response item")?,
                "summary": summary,
                "content": content
            })))
        }
        Some("web_search_call") => {
            let action = web_search_action_to_v2(item.get("action"));
            let query = web_search_action_detail(action.as_ref());
            Ok(Some(json!({
                "type": "webSearch",
                "id": required_item_string(item, "id", "web search response item")?,
                "query": query,
                "action": action,
                "results": item.get("results").cloned().unwrap_or(Value::Null)
            })))
        }
        Some(_) => Ok(None),
        None => Err(RpcError::invalid("ResponseItem type is required")),
    }
}

fn web_search_action_to_v2(action: Option<&Value>) -> Option<Value> {
    let action = action?;
    let action_type = match action.get("type").and_then(Value::as_str) {
        Some("search") => "search",
        Some("open_page" | "openPage") => "openPage",
        Some("find_in_page" | "findInPage") => "findInPage",
        Some(_) => "other",
        None => return None,
    };
    let mut converted = action.clone();
    converted["type"] = json!(action_type);
    Some(converted)
}

fn web_search_action_to_core(action: Option<&Value>) -> Value {
    let Some(action) = action else {
        return Value::Null;
    };
    let action_type = match action.get("type").and_then(Value::as_str) {
        Some("search") => "search",
        Some("open_page" | "openPage") => "open_page",
        Some("find_in_page" | "findInPage") => "find_in_page",
        Some(_) => "other",
        None => return Value::Null,
    };
    let mut converted = action.clone();
    converted["type"] = json!(action_type);
    converted
}

fn web_search_action_detail(action: Option<&Value>) -> String {
    let Some(action) = action else {
        return String::new();
    };
    match action.get("type").and_then(Value::as_str) {
        Some("search") => action
            .get("query")
            .and_then(Value::as_str)
            .filter(|query| !query.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let queries = action
                    .get("queries")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>();
                let first = queries.first().copied().unwrap_or_default();
                if queries.len() > 1 && !first.is_empty() {
                    format!("{first} ...")
                } else {
                    first.into()
                }
            }),
        Some("openPage") => action
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        Some("findInPage") => {
            match (
                action.get("pattern").and_then(Value::as_str),
                action.get("url").and_then(Value::as_str),
            ) {
                (Some(pattern), Some(url)) => format!("'{pattern}' in {url}"),
                (Some(pattern), None) => format!("'{pattern}'"),
                (None, Some(url)) => url.into(),
                (None, None) => String::new(),
            }
        }
        _ => String::new(),
    }
}

fn response_text_parts(value: Option<&Value>, expected_type: &str) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some(expected_type))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

fn add_token_usage(total: &mut TokenUsage, last: &TokenUsage) {
    total.input_tokens += last.input_tokens;
    total.cached_input_tokens += last.cached_input_tokens;
    total.cache_write_input_tokens += last.cache_write_input_tokens;
    total.output_tokens += last.output_tokens;
    total.reasoning_output_tokens += last.reasoning_output_tokens;
    total.total_tokens += last.total_tokens;
}

fn require_active_turn(loaded: &LoadedThread, turn_id: &str) -> RpcResult<()> {
    if loaded.active_turn_id.as_deref() == Some(turn_id) {
        Ok(())
    } else {
        Err(RpcError::invalid_request(format!(
            "turn is not active: {turn_id}"
        )))
    }
}

fn turn_contains_item(turns: &[Value], turn_id: &str, item_id: &str) -> bool {
    turns
        .iter()
        .find(|turn| turn.get("id").and_then(Value::as_str) == Some(turn_id))
        .and_then(|turn| turn.get("items"))
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(item_id))
        })
}

fn turn_item_mut<'a>(
    turns: &'a mut [Value],
    turn_id: &str,
    item_id: &str,
) -> RpcResult<&'a mut Value> {
    find_turn_mut(turns, turn_id)
        .and_then(|turn| turn.get_mut("items"))
        .and_then(Value::as_array_mut)
        .and_then(|items| {
            items
                .iter_mut()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(item_id))
        })
        .ok_or_else(|| RpcError::invalid(format!("item not found: {item_id}")))
}

fn nonnegative_index(value: i64, name: &str) -> RpcResult<usize> {
    usize::try_from(value).map_err(|_| RpcError::invalid(format!("{name} must be nonnegative")))
}

fn ensure_reasoning_strings<'a>(
    item: &'a mut Value,
    key: &str,
    index: usize,
) -> RpcResult<&'a mut Vec<Value>> {
    if item.get("type").and_then(Value::as_str) != Some("reasoning") {
        return Err(RpcError::invalid("streaming item is not reasoning"));
    }
    let values = item
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| RpcError::internal(format!("reasoning {key} must be an array")))?;
    while values.len() <= index {
        values.push(json!(""));
    }
    if values.iter().any(|value| !value.is_string()) {
        return Err(RpcError::internal(format!(
            "reasoning {key} must contain strings"
        )));
    }
    Ok(values)
}

fn upsert_turn_item(turns: &mut [Value], turn_id: &str, item: Value) -> RpcResult<()> {
    let turn = find_turn_mut(turns, turn_id)
        .ok_or_else(|| RpcError::internal(format!("item references unknown turn: {turn_id}")))?;
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::internal("ThreadItem id is required"))?;
    let items = turn
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| RpcError::internal("Turn items must be an array"))?;
    if let Some(existing) = items
        .iter_mut()
        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(item_id))
    {
        *existing = item;
    } else {
        items.push(item);
    }
    Ok(())
}

fn find_turn_mut<'a>(turns: &'a mut [Value], turn_id: &str) -> Option<&'a mut Value> {
    turns
        .iter_mut()
        .find(|turn| turn.get("id").and_then(Value::as_str) == Some(turn_id))
}

fn sorted_connections(connections: &HashSet<String>) -> Vec<String> {
    let mut recipients = connections.iter().cloned().collect::<Vec<_>>();
    recipients.sort();
    recipients
}

fn metadata_from_record(record: &ThreadRecord, rollout_path: PathBuf) -> RpcResult<ThreadMetadata> {
    Ok(ThreadMetadata {
        id: record.id.clone(),
        rollout_path,
        created_at_ms: record.created_at_ms,
        updated_at_ms: record.updated_at_ms,
        title: record.name.clone().unwrap_or_default(),
        project_id: String::new(),
        task_mode: "code".into(),
        archived_at_ms: 0,
        pinned_at_ms: 0,
        agent_id: String::new(),
        preview: record.preview.clone(),
        revision: 0,
        last_complete_ordinal: 0,
        recovery_status: "clean".into(),
        canonical: Some(serde_json::to_value(record).map_err(json_error)?),
    })
}

fn canonical_session_meta(record: &ThreadRecord, compact_window: &CompactWindow) -> Value {
    let timestamp = i64::try_from(record.created_at_ms / 1_000)
        .ok()
        .and_then(|seconds| OffsetDateTime::from_unix_timestamp(seconds).ok())
        .and_then(|value| value.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into());
    let mut meta = Map::from_iter([
        ("session_id".into(), json!(record.session_id)),
        ("id".into(), json!(record.id)),
        ("timestamp".into(), json!(timestamp)),
        ("cwd".into(), json!(record.cwd)),
        ("originator".into(), json!("tietiezhi-app-server")),
        ("cli_version".into(), json!(record.cli_version)),
        ("source".into(), record.source.clone()),
        ("model_provider".into(), json!(record.model_provider)),
        ("history_mode".into(), json!(record.history_mode)),
        (
            "context_window".into(),
            json!({"window_id": compact_window.window_id.to_string()}),
        ),
    ]);
    if let Some(value) = &record.forked_from_id {
        meta.insert("forked_from_id".into(), json!(value));
    }
    if let Some(value) = &record.parent_thread_id {
        meta.insert("parent_thread_id".into(), json!(value));
    }
    if let Some(value) = &record.thread_source {
        meta.insert("thread_source".into(), value.clone());
    }
    if let Some(git) = &record.git_info {
        meta.insert(
            "git".into(),
            json!({
                "commit_hash": git.sha,
                "branch": git.branch,
                "repository_url": git.origin_url
            }),
        );
    }
    Value::Object(meta)
}

fn snake_optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn required_string(params: &Value, key: &str) -> RpcResult<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| RpcError::invalid(format!("{key} must be a non-empty string")))
}

fn optional_string(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn optional_nullable_string(params: &Value, key: &str) -> Option<Option<String>> {
    params
        .get(key)
        .map(|value| value.as_str().map(str::to_owned))
}

fn validate_thread_id(id: &str) -> RpcResult<()> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|error| RpcError::invalid(format!("invalid thread id: {error}")))
}

fn validate_thread_status(status: &Value) -> RpcResult<()> {
    let kind = status
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::invalid("thread status type is required"))?;
    match kind {
        "notLoaded" | "idle" | "systemError" => Ok(()),
        "active" => {
            let flags = status
                .get("activeFlags")
                .and_then(Value::as_array)
                .ok_or_else(|| RpcError::invalid("active status requires activeFlags"))?;
            if flags.iter().all(|flag| {
                matches!(
                    flag.as_str(),
                    Some("waitingOnApproval" | "waitingOnUserInput")
                )
            }) {
                Ok(())
            } else {
                Err(RpcError::invalid("invalid active thread flag"))
            }
        }
        _ => Err(RpcError::invalid(format!("invalid thread status: {kind}"))),
    }
}

fn apply_nullable_string_patch(
    patch: &Map<String, Value>,
    key: &str,
    target: &mut Option<String>,
) -> RpcResult<()> {
    let Some(value) = patch.get(key) else {
        return Ok(());
    };
    if value.is_null() {
        *target = None;
        return Ok(());
    }
    let value = value
        .as_str()
        .ok_or_else(|| RpcError::invalid(format!("{key} must be a string or null")))?
        .trim();
    if value.is_empty() {
        return Err(RpcError::invalid(format!("{key} must not be empty")));
    }
    *target = Some(value.into());
    Ok(())
}

fn cwd_filters(value: Option<&Value>) -> RpcResult<Option<Vec<PathBuf>>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(path)) => Ok(Some(vec![PathBuf::from(path)])),
        Some(Value::Array(paths)) => paths
            .iter()
            .map(|path| {
                path.as_str()
                    .map(PathBuf::from)
                    .ok_or_else(|| RpcError::invalid("cwd filters must be strings"))
            })
            .collect::<RpcResult<Vec<_>>>()
            .map(Some),
        Some(_) => Err(RpcError::invalid("cwd must be a string, array, or null")),
    }
}

fn source_matches_kind(source: &Value, kind: &str) -> bool {
    matches!(
        (source.as_str(), kind),
        (Some("cli"), "cli")
            | (Some("vscode"), "vscode")
            | (Some("exec"), "exec")
            | (Some("appServer"), "appServer")
            | (Some("unknown"), "unknown")
    )
}

fn thread_sort_timestamp(metadata: &ThreadMetadata, sort_key: &str) -> u64 {
    match sort_key {
        "updated_at" | "recency_at" => metadata.updated_at_ms,
        _ => metadata.created_at_ms,
    }
}

fn encode_cursor(cursor: &ThreadCursor) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).expect("cursor serializes"))
}

fn decode_cursor(cursor: &str) -> RpcResult<ThreadCursor> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| RpcError::invalid("invalid thread cursor"))?;
    serde_json::from_slice(&bytes).map_err(|_| RpcError::invalid("invalid thread cursor"))
}

fn milliseconds_to_seconds(milliseconds: u64) -> i64 {
    i64::try_from(milliseconds / 1_000).unwrap_or(i64::MAX)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn state_error(error: StateError) -> RpcError {
    RpcError::internal(error.to_string())
}

fn json_error(error: serde_json::Error) -> RpcError {
    RpcError::internal(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn manager() -> (TempDir, ThreadManager) {
        let temp = TempDir::new().unwrap();
        let cwd = temp.path().join("workspace");
        fs::create_dir(&cwd).unwrap();
        let manager = ThreadManager::open(
            temp.path().join("state"),
            temp.path().join("threads"),
            RuntimeDefaults {
                model: "gpt-test".into(),
                model_provider: "test-provider".into(),
                cwd,
                ..RuntimeDefaults::default()
            },
        )
        .unwrap();
        (temp, manager)
    }

    fn request(id: i64, method: &str, params: Value) -> Value {
        json!({"id": id, "method": method, "params": params})
    }

    fn result(output: &DispatchOutput) -> &Value {
        output.response.get("result").unwrap()
    }

    fn start(manager: &ThreadManager, connection: &str) -> DispatchOutput {
        manager.dispatch(connection, request(1, "thread/start", json!({})))
    }

    #[test]
    fn thread_start_uses_uuid_v7_and_protocol_exact_response() {
        let (_temp, manager) = manager();
        let output = start(&manager, "desktop");
        let thread = &result(&output)["thread"];
        let id = thread["id"].as_str().unwrap();
        assert_eq!(Uuid::parse_str(id).unwrap().get_version_num(), 7);
        assert_eq!(thread["sessionId"], id);
        assert_eq!(thread["status"]["type"], "idle");
        assert_eq!(result(&output)["model"], "gpt-test");
        assert_eq!(output.notifications.len(), 1);
        assert_eq!(output.notifications[0].method, "thread/started");
        assert_eq!(output.notifications[0].recipients, ["desktop"]);
        assert!(serde_json::from_value::<ThreadStartResponse>(result(&output).clone()).is_ok());
        assert!(
            serde_json::from_value::<ServerNotification>(output.notifications[0].wire_message())
                .is_ok()
        );
    }

    #[test]
    fn persistent_thread_resumes_after_manager_restart() {
        let (temp, manager) = manager();
        let started = start(&manager, "one");
        let id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        drop(manager);
        let cwd = temp.path().join("workspace");
        let manager = ThreadManager::open(
            temp.path().join("state"),
            temp.path().join("threads"),
            RuntimeDefaults {
                model: "fallback".into(),
                model_provider: "fallback".into(),
                cwd,
                ..RuntimeDefaults::default()
            },
        )
        .unwrap();
        let resumed = manager.dispatch(
            "two",
            request(
                2,
                "thread/resume",
                json!({"threadId": id, "model": "override"}),
            ),
        );
        assert_eq!(result(&resumed)["model"], "override");
        assert_eq!(result(&resumed)["modelProvider"], "test-provider");
        assert_eq!(resumed.notifications[0].recipients, ["two"]);
    }

    #[test]
    fn ephemeral_thread_is_loaded_but_not_indexed() {
        let (_temp, manager) = manager();
        let started = manager.dispatch(
            "desktop",
            request(1, "thread/start", json!({"ephemeral": true})),
        );
        let id = result(&started)["thread"]["id"].as_str().unwrap();
        assert_eq!(result(&started)["thread"]["path"], Value::Null);
        let listed = manager.dispatch("desktop", request(2, "thread/list", json!({})));
        assert!(result(&listed)["data"].as_array().unwrap().is_empty());
        let loaded = manager.dispatch("desktop", request(3, "thread/loaded/list", json!({})));
        assert_eq!(result(&loaded)["data"], json!([id]));
        manager.dispatch(
            "desktop",
            request(
                4,
                "thread/inject_items",
                json!({
                    "threadId": id,
                    "items": [{"type": "message", "role": "user", "content": []}]
                }),
            ),
        );
        assert_eq!(manager.injected_items(id).unwrap().len(), 1);
    }

    #[test]
    fn fork_preserves_session_and_hides_copied_turns_in_notification() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let source_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        manager
            .replace_turns(
                &source_id,
                vec![json!({
                    "id": Uuid::now_v7().to_string(),
                    "items": [],
                    "itemsView": "full",
                    "status": "completed",
                    "error": null,
                    "startedAt": 1,
                    "completedAt": 2,
                    "durationMs": 1000
                })],
            )
            .unwrap();
        let forked = manager.dispatch(
            "desktop",
            request(2, "thread/fork", json!({"threadId": source_id})),
        );
        assert_eq!(
            result(&forked)["thread"]["sessionId"],
            result(&started)["thread"]["sessionId"]
        );
        assert_eq!(
            result(&forked)["thread"]["turns"].as_array().unwrap().len(),
            1
        );
        assert!(
            forked.notifications[0].params["thread"]["turns"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn fork_preserves_canonical_rollout_item_order() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let source_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let turn = manager.dispatch(
            "desktop",
            request(
                2,
                "turn/start",
                json!({
                    "threadId": source_id,
                    "input": [{"type": "text", "text": "fork history", "textElements": []}]
                }),
            ),
        );
        let turn_id = result(&turn)["turn"]["id"].as_str().unwrap().to_string();
        manager.complete_turn(&source_id, &turn_id, None).unwrap();
        let forked = manager.dispatch(
            "desktop",
            request(3, "thread/fork", json!({"threadId": source_id})),
        );
        let fork_id = result(&forked)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let metadata = manager.inner.store.thread(&fork_id).unwrap().unwrap();
        let recovery = manager
            .inner
            .store
            .recover_rollout(metadata.rollout_path)
            .unwrap();
        assert_eq!(
            recovery
                .rollout_items
                .iter()
                .map(|item| match &item.item {
                    RecoveredRolloutItemKind::SessionMeta(_) => "session_meta",
                    RecoveredRolloutItemKind::TurnContext(_) => "turn_context",
                    RecoveredRolloutItemKind::ResponseItem(_) => "response_item",
                    RecoveredRolloutItemKind::Compacted(_) => "compacted",
                    RecoveredRolloutItemKind::WorldState(_) => "world_state",
                    RecoveredRolloutItemKind::EventMsg(event) => event["type"].as_str().unwrap(),
                })
                .collect::<Vec<_>>(),
            [
                "session_meta",
                "task_started",
                "turn_context",
                "response_item",
                "item_started",
                "item_completed",
                "turn_complete"
            ]
        );
        assert_eq!(
            recovery.session_meta.unwrap()["id"],
            fork_id,
            "source session_meta must never be copied"
        );
    }

    #[test]
    fn archive_unarchive_delete_emit_lifecycle_notifications() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let archived = manager.dispatch(
            "desktop",
            request(2, "thread/archive", json!({"threadId": id})),
        );
        assert_eq!(
            archived
                .notifications
                .iter()
                .map(|notification| notification.method.as_str())
                .collect::<Vec<_>>(),
            ["thread/archived", "thread/closed"]
        );
        let unarchived = manager.dispatch(
            "desktop",
            request(3, "thread/unarchive", json!({"threadId": id})),
        );
        assert_eq!(unarchived.notifications[0].method, "thread/unarchived");
        let deleted = manager.dispatch(
            "desktop",
            request(4, "thread/delete", json!({"threadId": id})),
        );
        assert_eq!(deleted.notifications[0].method, "thread/deleted");
        let read = manager.dispatch(
            "desktop",
            request(5, "thread/read", json!({"threadId": id})),
        );
        assert_eq!(read.response["error"]["code"], -32602);
    }

    #[test]
    fn list_filters_sorts_and_paginates_with_opaque_cursor() {
        let (_temp, manager) = manager();
        for name in ["Alpha", "Beta", "Gamma"] {
            let started = start(&manager, "desktop");
            let id = result(&started)["thread"]["id"].as_str().unwrap();
            manager.dispatch(
                "desktop",
                request(2, "thread/name/set", json!({"threadId": id, "name": name})),
            );
        }
        let first = manager.dispatch(
            "desktop",
            request(
                10,
                "thread/list",
                json!({"limit": 2, "sortKey": "created_at", "sortDirection": "asc"}),
            ),
        );
        assert_eq!(result(&first)["data"].as_array().unwrap().len(), 2);
        let cursor = result(&first)["nextCursor"].as_str().unwrap();
        let second = manager.dispatch(
            "desktop",
            request(
                11,
                "thread/list",
                json!({"limit": 2, "sortKey": "created_at", "sortDirection": "asc", "cursor": cursor}),
            ),
        );
        assert_eq!(result(&second)["data"].as_array().unwrap().len(), 1);
        let searched = manager.dispatch(
            "desktop",
            request(12, "thread/list", json!({"searchTerm": "beta"})),
        );
        assert_eq!(result(&searched)["data"].as_array().unwrap().len(), 1);
        assert_eq!(result(&searched)["data"][0]["name"], "Beta");
    }

    #[test]
    fn inject_items_are_appended_as_canonical_rollout_records() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let id = result(&started)["thread"]["id"].as_str().unwrap();
        let injected = manager.dispatch(
            "desktop",
            request(
                2,
                "thread/inject_items",
                json!({
                    "threadId": id,
                    "items": [{"type": "message", "role": "user", "content": []}]
                }),
            ),
        );
        assert_eq!(result(&injected), &json!({}));
        let metadata = manager.inner.store.thread(id).unwrap().unwrap();
        let recovery = manager
            .inner
            .store
            .recover_rollout(metadata.rollout_path)
            .unwrap();
        assert_eq!(recovery.response_items.len(), 1);
        manager.dispatch(
            "desktop",
            request(3, "thread/unsubscribe", json!({"threadId": id})),
        );
        manager.dispatch(
            "desktop",
            request(4, "thread/resume", json!({"threadId": id})),
        );
        assert_eq!(manager.injected_items(id).unwrap().len(), 1);
    }

    #[test]
    fn subscriptions_route_status_and_unload_on_last_unsubscribe() {
        let (_temp, manager) = manager();
        let started = start(&manager, "one");
        let id = result(&started)["thread"]["id"].as_str().unwrap();
        manager.dispatch("two", request(2, "thread/resume", json!({"threadId": id})));
        let notifications = manager
            .set_thread_status(
                id,
                json!({"type": "active", "activeFlags": ["waitingOnApproval"]}),
            )
            .unwrap();
        assert_eq!(notifications[0].recipients, ["one", "two"]);
        let first = manager.dispatch(
            "one",
            request(3, "thread/unsubscribe", json!({"threadId": id})),
        );
        assert_eq!(result(&first)["status"], "unsubscribed");
        assert!(first.notifications.is_empty());
        let second = manager.dispatch(
            "two",
            request(4, "thread/unsubscribe", json!({"threadId": id})),
        );
        assert_eq!(second.notifications[0].method, "thread/closed");
        let loaded = manager.dispatch("two", request(5, "thread/loaded/list", json!({})));
        assert!(result(&loaded)["data"].as_array().unwrap().is_empty());
    }

    #[test]
    fn state_index_rebuilds_from_canonical_session_meta() {
        let (temp, manager) = manager();
        let started = start(&manager, "desktop");
        let id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let metadata = manager.inner.store.thread(&id).unwrap().unwrap();
        let recovery = manager
            .inner
            .store
            .recover_rollout(metadata.rollout_path)
            .unwrap();
        let session_meta = recovery.session_meta.unwrap();
        assert_eq!(session_meta["id"], id);
        assert_eq!(session_meta["session_id"], id);
        assert_eq!(session_meta["source"], "appServer");
        assert!(session_meta.get("threadId").is_none());
        drop(manager);

        let database = temp.path().join("state").join("state.sqlite3");
        let _ = fs::remove_file(database.with_extension("sqlite3-wal"));
        let _ = fs::remove_file(database.with_extension("sqlite3-shm"));
        fs::write(&database, b"not a sqlite database").unwrap();
        let rebuilt = ThreadManager::open(
            temp.path().join("state"),
            temp.path().join("threads"),
            RuntimeDefaults {
                model: "gpt-test".into(),
                model_provider: "test-provider".into(),
                cwd: temp.path().join("workspace"),
                ..RuntimeDefaults::default()
            },
        )
        .unwrap();
        let listed = rebuilt.dispatch("desktop", request(2, "thread/list", json!({})));
        assert_eq!(result(&listed)["data"][0]["id"], id);
    }

    #[test]
    fn unloaded_metadata_updates_do_not_load_thread_and_live_ops_require_resume() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        manager.dispatch(
            "desktop",
            request(2, "thread/unsubscribe", json!({"threadId": id})),
        );
        manager.dispatch("observer", request(3, "thread/list", json!({})));
        let named = manager.dispatch(
            "desktop",
            request(
                4,
                "thread/name/set",
                json!({"threadId": id, "name": "  persisted name  "}),
            ),
        );
        assert_eq!(
            named.notifications[0].params["threadName"],
            "persisted name"
        );
        assert_eq!(named.notifications[0].recipients, ["desktop", "observer"]);
        let updated = manager.dispatch(
            "desktop",
            request(
                5,
                "thread/metadata/update",
                json!({
                    "threadId": id,
                    "gitInfo": {
                        "sha": "abc",
                        "branch": "main",
                        "originUrl": "https://example.invalid/repo"
                    }
                }),
            ),
        );
        assert_eq!(result(&updated)["thread"]["gitInfo"]["sha"], "abc");
        assert_eq!(result(&updated)["thread"]["status"]["type"], "notLoaded");
        let loaded = manager.dispatch("desktop", request(6, "thread/loaded/list", json!({})));
        assert!(result(&loaded)["data"].as_array().unwrap().is_empty());
        let inject = manager.dispatch(
            "desktop",
            request(
                7,
                "thread/inject_items",
                json!({"threadId": id, "items": []}),
            ),
        );
        assert_eq!(inject.response["error"]["code"], -32602);
    }

    #[test]
    fn rollback_and_r5_notification_publishers_validate_wire_payloads() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let turn = |id: &str| {
            json!({
                "id": id,
                "items": [],
                "itemsView": "full",
                "status": "completed",
                "error": null,
                "startedAt": 1,
                "completedAt": 2,
                "durationMs": 1000
            })
        };
        manager
            .replace_turns(&id, vec![turn("turn-1"), turn("turn-2")])
            .unwrap();
        let rollback = manager.dispatch(
            "desktop",
            request(2, "thread/rollback", json!({"threadId": id, "numTurns": 1})),
        );
        assert_eq!(
            result(&rollback)["thread"]["turns"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let metadata = manager.inner.store.thread(&id).unwrap().unwrap();
        let recovery = manager
            .inner
            .store
            .recover_rollout(metadata.rollout_path)
            .unwrap();
        assert_eq!(
            recovery.trailing_events.last().unwrap()["type"],
            "thread_rolled_back"
        );
        let guardian = manager.dispatch(
            "desktop",
            request(
                3,
                "thread/approveGuardianDeniedAction",
                json!({"threadId": id, "event": {"action": "allow"}}),
            ),
        );
        assert_eq!(result(&guardian), &json!({}));
        assert_eq!(
            manager.take_guardian_approvals(&id).unwrap(),
            [json!({"action": "allow"})]
        );
        let environment = manager
            .environment_notification(&id, "local", true)
            .unwrap();
        assert_eq!(environment[0].method, "thread/environment/connected");
        let settings = manager
            .settings_notification(
                &id,
                json!({
                    "cwd": manager.inner.defaults.cwd,
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": "user",
                    "sandboxPolicy": {
                        "type": "workspaceWrite",
                        "writableRoots": [manager.inner.defaults.cwd],
                        "networkAccess": false,
                        "excludeTmpdirEnvVar": false,
                        "excludeSlashTmp": false
                    },
                    "model": "gpt-test",
                    "modelProvider": "test-provider",
                    "serviceTier": null,
                    "effort": null,
                    "summary": null,
                    "collaborationMode": {
                        "mode": "default",
                        "settings": {"model": "gpt-test"}
                    },
                    "personality": null,
                    "activePermissionProfile": null
                }),
            )
            .unwrap();
        assert_eq!(settings[0].method, "thread/settings/updated");
        let usage = json!({
            "total": {
                "totalTokens": 10,
                "inputTokens": 6,
                "cachedInputTokens": 2,
                "outputTokens": 4,
                "reasoningOutputTokens": 1
            },
            "last": {
                "totalTokens": 10,
                "inputTokens": 6,
                "cachedInputTokens": 2,
                "outputTokens": 4,
                "reasoningOutputTokens": 1
            },
            "modelContextWindow": 1000
        });
        let token_usage = manager
            .token_usage_notification(&id, "turn-1", usage)
            .unwrap();
        assert_eq!(token_usage[0].method, "thread/tokenUsage/updated");
        assert!(
            manager
                .settings_notification(&id, json!({"model": "missing required fields"}))
                .is_err()
        );
    }

    #[test]
    fn turn_start_persists_canonical_items_and_is_idempotent() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let thread_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let params = json!({
            "threadId": thread_id,
            "clientUserMessageId": "client-message-1",
            "input": [{
                "type": "text",
                "text": "implement the turn",
                "textElements": []
            }],
            "outputSchema": {"type": "object"}
        });
        let output = manager.dispatch("desktop", request(2, "turn/start", params.clone()));
        let turn_id = result(&output)["turn"]["id"].as_str().unwrap().to_string();
        assert_eq!(Uuid::parse_str(&turn_id).unwrap().get_version_num(), 7);
        assert_eq!(result(&output)["turn"]["status"], "inProgress");
        assert_eq!(result(&output)["turn"]["items"], json!([]));
        assert_eq!(result(&output)["turn"]["itemsView"], "notLoaded");
        assert_eq!(
            output
                .notifications
                .iter()
                .map(|notification| notification.method.as_str())
                .collect::<Vec<_>>(),
            [
                "turn/started",
                "item/started",
                "item/completed",
                "thread/status/changed"
            ]
        );
        assert!(output.notifications.iter().all(|notification| {
            serde_json::from_value::<ServerNotification>(notification.wire_message()).is_ok()
        }));
        assert!(serde_json::from_value::<TurnStartResponse>(result(&output).clone()).is_ok());

        let pending = manager.take_turn_inputs(&thread_id, &turn_id).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].client_user_message_id.as_deref(),
            Some("client-message-1")
        );
        assert_eq!(pending[0].output_schema, Some(json!({"type": "object"})));
        assert!(
            manager
                .take_turn_inputs(&thread_id, &turn_id)
                .unwrap()
                .is_empty()
        );

        let metadata = manager.inner.store.thread(&thread_id).unwrap().unwrap();
        let recovery = manager
            .inner
            .store
            .recover_rollout(metadata.rollout_path)
            .unwrap();
        assert!(recovery.rollout_items.iter().any(|item| matches!(
            &item.item,
            RecoveredRolloutItemKind::TurnContext(context)
                if context["turn_id"] == turn_id
        )));
        let persisted_item = recovery
            .trailing_events
            .iter()
            .find(|event| event["type"] == "item_started")
            .unwrap();
        assert_eq!(persisted_item["item"]["type"], "UserMessage");
        assert_eq!(persisted_item["item"]["client_id"], "client-message-1");
        assert_eq!(
            persisted_item["item"]["content"][0]["text_elements"],
            json!([])
        );

        let duplicate = manager.dispatch("desktop", request(3, "turn/start", params.clone()));
        assert_eq!(result(&duplicate)["turn"]["id"], turn_id);
        assert!(duplicate.notifications.is_empty());
        let conflict = manager.dispatch(
            "desktop",
            request(
                4,
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "clientUserMessageId": "client-message-1",
                    "input": [{"type": "text", "text": "different", "textElements": []}]
                }),
            ),
        );
        assert_eq!(conflict.response["error"]["code"], -32600);
    }

    #[test]
    fn turn_steer_requires_active_match_and_deduplicates_input() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let thread_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let turn = manager.dispatch(
            "desktop",
            request(
                2,
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": "first", "textElements": []}]
                }),
            ),
        );
        let turn_id = result(&turn)["turn"]["id"].as_str().unwrap().to_string();
        let steer_params = json!({
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "clientUserMessageId": "steer-1",
            "input": [{"type": "text", "text": "change direction", "textElements": []}]
        });
        let steered = manager.dispatch("desktop", request(3, "turn/steer", steer_params.clone()));
        assert_eq!(result(&steered)["turnId"], turn_id);
        assert!(steered.notifications.is_empty());
        assert!(serde_json::from_value::<TurnSteerResponse>(result(&steered).clone()).is_ok());
        let initial = manager
            .drain_turn_inputs(&thread_id, &turn_id, false)
            .unwrap();
        assert_eq!(initial.batches.len(), 1);
        assert!(initial.notifications.is_empty());
        let drained = manager
            .drain_turn_inputs(&thread_id, &turn_id, true)
            .unwrap();
        assert_eq!(drained.batches.len(), 1);
        assert_eq!(drained.notifications.len(), 2);
        assert_eq!(
            drained.batches[0].client_user_message_id.as_deref(),
            Some("steer-1")
        );

        let duplicate = manager.dispatch("desktop", request(4, "turn/steer", steer_params.clone()));
        assert_eq!(result(&duplicate)["turnId"], turn_id);
        assert!(duplicate.notifications.is_empty());
        let mismatch = manager.dispatch(
            "desktop",
            request(
                5,
                "turn/steer",
                json!({
                    "threadId": thread_id,
                    "expectedTurnId": Uuid::now_v7().to_string(),
                    "input": [{"type": "text", "text": "wrong turn", "textElements": []}]
                }),
            ),
        );
        assert_eq!(mismatch.response["error"]["code"], -32600);
        let wrong_interrupt = manager.dispatch(
            "desktop",
            request(
                6,
                "turn/interrupt",
                json!({"threadId": thread_id, "turnId": Uuid::now_v7().to_string()}),
            ),
        );
        assert_eq!(wrong_interrupt.response["error"]["code"], -32600);

        let interrupted = manager.dispatch(
            "desktop",
            request(
                7,
                "turn/interrupt",
                json!({"threadId": thread_id, "turnId": turn_id}),
            ),
        );
        assert!(
            serde_json::from_value::<TurnInterruptResponse>(result(&interrupted).clone()).is_ok()
        );
        assert_eq!(
            interrupted.notifications[0].params["turn"]["status"],
            "interrupted"
        );
        let after = manager.dispatch(
            "desktop",
            request(
                8,
                "thread/read",
                json!({"threadId": thread_id, "includeTurns": true}),
            ),
        );
        assert_eq!(
            result(&after)["thread"]["turns"][0]["items"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn turn_completion_failure_and_moderation_share_terminal_path() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let thread_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let turn = manager.dispatch(
            "desktop",
            request(2, "turn/start", json!({"threadId": thread_id, "input": []})),
        );
        let turn_id = result(&turn)["turn"]["id"].as_str().unwrap().to_string();
        let moderation = manager
            .turn_moderation_metadata_notification(&thread_id, &turn_id, json!({"blocked": false}))
            .unwrap();
        assert_eq!(moderation[0].method, "turn/moderationMetadata");
        assert!(serde_json::from_value::<ServerNotification>(moderation[0].wire_message()).is_ok());
        let completed = manager
            .complete_turn(
                &thread_id,
                &turn_id,
                Some(json!({"message": "model failed", "codexErrorInfo": null})),
            )
            .unwrap();
        assert_eq!(completed[0].method, "turn/completed");
        assert_eq!(completed[0].params["turn"]["status"], "failed");
        assert_eq!(
            completed[0].params["turn"]["error"]["message"],
            "model failed"
        );
        assert_eq!(completed[0].params["turn"]["itemsView"], "notLoaded");
        assert_eq!(completed[1].method, "thread/status/changed");

        let metadata = manager.inner.store.thread(&thread_id).unwrap().unwrap();
        let recovery = manager
            .inner
            .store
            .recover_rollout(metadata.rollout_path)
            .unwrap();
        assert!(
            recovery
                .trailing_events
                .iter()
                .any(|event| event["type"] == "turn_moderation_metadata")
        );
        assert!(
            recovery
                .trailing_events
                .iter()
                .any(|event| event["type"] == "turn_complete"
                    && event["error"]["message"] == "model failed")
        );
    }

    #[test]
    fn active_turn_is_interrupted_once_after_restart_and_never_replayed() {
        let (temp, manager) = manager();
        let started = start(&manager, "desktop");
        let thread_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let turn = manager.dispatch(
            "desktop",
            request(
                2,
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": "crash me", "textElements": []}]
                }),
            ),
        );
        let turn_id = result(&turn)["turn"]["id"].as_str().unwrap().to_string();
        drop(manager);

        let reopen = || {
            ThreadManager::open(
                temp.path().join("state"),
                temp.path().join("threads"),
                RuntimeDefaults {
                    model: "gpt-test".into(),
                    model_provider: "test-provider".into(),
                    cwd: temp.path().join("workspace"),
                    ..RuntimeDefaults::default()
                },
            )
            .unwrap()
        };
        let recovered = reopen();
        let resumed = recovered.dispatch(
            "desktop",
            request(3, "thread/resume", json!({"threadId": thread_id})),
        );
        assert_eq!(
            result(&resumed)["thread"]["turns"][0]["status"],
            "interrupted"
        );
        assert!(recovered.take_turn_inputs(&thread_id, &turn_id).is_err());
        drop(recovered);

        let recovered_again = reopen();
        recovered_again.dispatch(
            "desktop",
            request(4, "thread/resume", json!({"threadId": thread_id})),
        );
        let metadata = recovered_again
            .inner
            .store
            .thread(&thread_id)
            .unwrap()
            .unwrap();
        let recovery = recovered_again
            .inner
            .store
            .recover_rollout(metadata.rollout_path)
            .unwrap();
        assert_eq!(
            recovery
                .trailing_events
                .iter()
                .filter(|event| event["type"] == "turn_aborted")
                .count(),
            1
        );
    }

    #[test]
    fn archiving_active_thread_interrupts_turn_before_closing_it() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let thread_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        manager.dispatch(
            "desktop",
            request(
                2,
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": "running", "textElements": []}]
                }),
            ),
        );
        let archived = manager.dispatch(
            "desktop",
            request(3, "thread/archive", json!({"threadId": thread_id})),
        );
        assert_eq!(
            archived
                .notifications
                .iter()
                .map(|notification| notification.method.as_str())
                .collect::<Vec<_>>(),
            [
                "turn/completed",
                "thread/status/changed",
                "thread/archived",
                "thread/closed"
            ]
        );
        assert_eq!(
            archived.notifications[0].params["turn"]["status"],
            "interrupted"
        );
    }

    #[test]
    fn turn_input_limits_and_remote_images_match_codex_errors() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let thread_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let oversized = manager.dispatch(
            "desktop",
            request(
                2,
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{
                        "type": "text",
                        "text": "x".repeat(MAX_USER_INPUT_TEXT_CHARS + 1),
                        "textElements": []
                    }]
                }),
            ),
        );
        assert_eq!(oversized.response["error"]["code"], -32602);
        assert_eq!(
            oversized.response["error"]["data"]["input_error_code"],
            "input_too_large"
        );
        assert_eq!(
            oversized.response["error"]["data"]["max_chars"],
            MAX_USER_INPUT_TEXT_CHARS
        );
        let remote = manager.dispatch(
            "desktop",
            request(
                3,
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{"type": "image", "url": "https://example.invalid/a.png"}]
                }),
            ),
        );
        assert_eq!(remote.response["error"]["code"], -32600);
        assert!(
            remote.response["error"]["message"]
                .as_str()
                .unwrap()
                .contains("remote image URLs are not supported")
        );

        let empty = manager.dispatch(
            "desktop",
            request(4, "turn/start", json!({"threadId": thread_id, "input": []})),
        );
        let turn_id = result(&empty)["turn"]["id"].as_str().unwrap().to_string();
        let empty_steer = manager.dispatch(
            "desktop",
            request(
                5,
                "turn/steer",
                json!({"threadId": thread_id, "expectedTurnId": turn_id, "input": []}),
            ),
        );
        assert_eq!(empty_steer.response["error"]["code"], -32600);
    }

    #[test]
    fn model_list_uses_pinned_catalog_and_codex_cursor_rules() {
        let (_temp, manager) = manager();
        let first = manager.dispatch(
            "desktop",
            request(1, "model/list", json!({"limit": 2, "includeHidden": false})),
        );
        assert_eq!(result(&first)["data"][0]["id"], "gpt-5.6-sol");
        assert_eq!(result(&first)["data"][0]["isDefault"], true);
        assert_eq!(result(&first)["nextCursor"], "2");
        let hidden = manager.dispatch(
            "desktop",
            request(
                2,
                "model/list",
                json!({"cursor": "4", "includeHidden": true}),
            ),
        );
        assert_eq!(result(&hidden)["data"][0]["id"], "gpt-5.4");
        let invalid = manager.dispatch(
            "desktop",
            request(3, "model/list", json!({"cursor": "not-a-number"})),
        );
        assert_eq!(invalid.response["error"]["code"], -32600);
    }

    #[test]
    fn responses_items_deltas_usage_and_model_metadata_follow_v2() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let thread_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let turn = manager.dispatch(
            "desktop",
            request(
                2,
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{"type":"text","text":"hello","textElements":[]}]
                }),
            ),
        );
        let turn_id = result(&turn)["turn"]["id"].as_str().unwrap().to_owned();
        let snapshot = manager
            .turn_execution_snapshot(&thread_id, &turn_id)
            .unwrap();
        assert_eq!(snapshot.model, "gpt-test");
        assert_eq!(snapshot.history.len(), 1);
        assert_eq!(snapshot.history[0]["role"], "user");

        let reasoning = json!({
            "type":"reasoning",
            "id":"reasoning_1",
            "summary":[],
            "content":[]
        });
        assert_eq!(
            manager
                .model_item_started(&thread_id, &turn_id, reasoning.clone())
                .unwrap()[0]
                .method,
            "item/started"
        );
        assert_eq!(
            manager
                .reasoning_summary_part_added(&thread_id, &turn_id, "reasoning_1", 0)
                .unwrap()[0]
                .method,
            "item/reasoning/summaryPartAdded"
        );
        manager
            .reasoning_summary_delta(&thread_id, &turn_id, "reasoning_1", 0, "summary")
            .unwrap();
        manager
            .reasoning_text_delta(&thread_id, &turn_id, "reasoning_1", 0, "private")
            .unwrap();
        let completed_reasoning = json!({
            "type":"reasoning",
            "id":"reasoning_1",
            "summary":[{"type":"summary_text","text":"summary"}],
            "content":[{"type":"reasoning_text","text":"private"}]
        });
        manager
            .model_item_completed(&thread_id, &turn_id, completed_reasoning)
            .unwrap();

        let message = json!({
            "type":"message",
            "id":"message_1",
            "role":"assistant",
            "content":[]
        });
        manager
            .model_item_started(&thread_id, &turn_id, message)
            .unwrap();
        let delta = manager
            .agent_message_delta(&thread_id, &turn_id, "message_1", "answer")
            .unwrap();
        assert_eq!(delta[0].method, "item/agentMessage/delta");
        let completed_message = json!({
            "type":"message",
            "id":"message_1",
            "role":"assistant",
            "content":[{"type":"output_text","text":"answer"}]
        });
        let completed = manager
            .model_item_completed(&thread_id, &turn_id, completed_message)
            .unwrap();
        assert_eq!(completed[0].method, "item/completed");

        let sleep_item = json!({
            "type":"sleep",
            "id":"call_sleep",
            "durationMs":10
        });
        assert_eq!(
            manager
                .local_tool_item_started(&thread_id, &turn_id, sleep_item.clone())
                .unwrap()[0]
                .params["item"]["type"],
            "sleep"
        );
        assert_eq!(
            manager
                .local_tool_item_completed(&thread_id, &turn_id, sleep_item)
                .unwrap()[0]
                .method,
            "item/completed"
        );
        let web_search = json!({
            "type":"web_search_call",
            "id":"web_1",
            "status":"completed",
            "action":{
                "type":"find_in_page",
                "url":"https://example.test/docs",
                "pattern":"needle"
            }
        });
        let search_completed = manager
            .model_item_completed(&thread_id, &turn_id, web_search)
            .unwrap();
        assert_eq!(search_completed[0].params["item"]["type"], "webSearch");
        assert_eq!(
            search_completed[0].params["item"]["query"],
            "'needle' in https://example.test/docs"
        );
        assert_eq!(
            search_completed[0].params["item"]["action"]["type"],
            "findInPage"
        );
        assert_eq!(
            manager
                .context_tokens_remaining(&thread_id, &turn_id)
                .unwrap(),
            None
        );

        assert_eq!(
            manager
                .model_rerouted_notification(&thread_id, &turn_id, "gpt-test", "gpt-rerouted")
                .unwrap()[0]
                .method,
            "model/rerouted"
        );
        assert_eq!(
            manager
                .model_verification_notification(
                    &thread_id,
                    &turn_id,
                    vec!["trustedAccessForCyber".into()]
                )
                .unwrap()[0]
                .method,
            "model/verification"
        );
        assert_eq!(
            manager
                .safety_buffering_notification(
                    &thread_id,
                    &turn_id,
                    "gpt-test",
                    vec!["cyber".into()],
                    vec!["policy".into()],
                    true,
                    Some("gpt-fast".into())
                )
                .unwrap()[0]
                .method,
            "model/safetyBuffering/updated"
        );
        let usage = TokenUsage {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_write_input_tokens: 1,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 13,
        };
        let first_usage = manager
            .record_token_usage(&thread_id, &turn_id, usage.clone(), None)
            .unwrap();
        assert_eq!(first_usage[0].method, "thread/tokenUsage/updated");
        assert_eq!(
            first_usage[0].params["tokenUsage"]["total"]["totalTokens"],
            13
        );
        let second_usage = manager
            .record_token_usage(&thread_id, &turn_id, usage, None)
            .unwrap();
        assert_eq!(
            second_usage[0].params["tokenUsage"]["total"]["totalTokens"],
            26
        );
        manager.complete_turn(&thread_id, &turn_id, None).unwrap();
        let read = manager.dispatch(
            "desktop",
            request(
                3,
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":true}),
            ),
        );
        let items = result(&read)["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap();
        assert_eq!(items[1]["type"], "reasoning");
        assert_eq!(items[1]["summary"][0], "summary");
        assert_eq!(items[2]["type"], "agentMessage");
        assert_eq!(items[2]["text"], "answer");
        assert_eq!(manager.injected_items(&thread_id).unwrap().len(), 4);
        let metadata = manager.inner.store.thread(&thread_id).unwrap().unwrap();
        let recovery = manager
            .inner
            .store
            .recover_rollout(metadata.rollout_path)
            .unwrap();
        assert_eq!(
            project_turns(&recovery.rollout_items)
                .unwrap()
                .token_usage
                .total_tokens,
            26
        );
    }

    #[test]
    fn recovered_context_combines_server_usage_with_later_local_items() {
        let local = json!({
            "type":"message",
            "role":"user",
            "content":[{"type":"input_text","text":"later local input"}]
        });
        let local_tokens = estimate_history_tokens(std::slice::from_ref(&local));
        let projection = project_turns(&[
            RecoveredRolloutItem {
                timestamp_ms: 1,
                ordinal: 1,
                item: RecoveredRolloutItemKind::ResponseItem(json!({
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"sampled"}]
                })),
            },
            RecoveredRolloutItem {
                timestamp_ms: 2,
                ordinal: 2,
                item: RecoveredRolloutItemKind::EventMsg(json!({
                    "type":"token_count",
                    "info":{
                        "total_token_usage":{
                            "input_tokens":80,
                            "cached_input_tokens":0,
                            "cache_write_input_tokens":0,
                            "output_tokens":20,
                            "reasoning_output_tokens":0,
                            "total_tokens":100
                        },
                        "last_token_usage":{
                            "input_tokens":80,
                            "cached_input_tokens":0,
                            "cache_write_input_tokens":0,
                            "output_tokens":20,
                            "reasoning_output_tokens":0,
                            "total_tokens":100
                        }
                    }
                })),
            },
            RecoveredRolloutItem {
                timestamp_ms: 3,
                ordinal: 3,
                item: RecoveredRolloutItemKind::ResponseItem(local),
            },
        ])
        .unwrap();
        assert_eq!(projection.active_context_tokens, 100 + local_tokens);
        assert_eq!(projection.last_token_usage.total_tokens, 100);
    }

    #[test]
    fn manual_compaction_uses_canonical_item_and_replacement_history() {
        let (temp, manager) = manager();
        let started = start(&manager, "desktop");
        let thread_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        manager
            .dispatch(
                "desktop",
                request(
                    2,
                    "thread/inject_items",
                    json!({
                        "threadId": thread_id,
                        "items": [{
                            "type":"message",
                            "role":"user",
                            "content":[{"type":"input_text","text":"keep this requirement"}]
                        }]
                    }),
                ),
            )
            .response
            .get("result")
            .unwrap();
        let compact = manager.dispatch(
            "desktop",
            request(3, "thread/compact/start", json!({"threadId": thread_id})),
        );
        assert_eq!(result(&compact), &json!({}));
        assert_eq!(
            compact
                .notifications
                .iter()
                .map(|notification| notification.method.as_str())
                .collect::<Vec<_>>(),
            ["turn/started", "item/started", "thread/status/changed"]
        );
        assert_eq!(
            compact.notifications[1].params["item"]["type"],
            "contextCompaction"
        );
        let turn_id = compact.notifications[0].params["turn"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let snapshot = manager
            .compaction_execution_snapshot(&thread_id, &turn_id)
            .unwrap();
        assert!(!snapshot.automatic);
        assert_eq!(snapshot.history.len(), 1);
        manager
            .record_compaction_response_item(
                &thread_id,
                &turn_id,
                json!({
                    "type":"message",
                    "id":"compact_response",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"handoff"}]
                }),
            )
            .unwrap();
        let completed = manager
            .complete_compaction(&thread_id, &turn_id, "handoff")
            .unwrap();
        assert_eq!(
            completed
                .iter()
                .map(|notification| notification.method.as_str())
                .collect::<Vec<_>>(),
            [
                "item/completed",
                "warning",
                "turn/completed",
                "thread/status/changed"
            ]
        );
        let history = manager.injected_items(&thread_id).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["content"][0]["text"], "keep this requirement");
        assert!(
            history[1]["content"][0]["text"]
                .as_str()
                .unwrap()
                .ends_with("\nhandoff")
        );
        let metadata = manager.inner.store.thread(&thread_id).unwrap().unwrap();
        let recovery = manager
            .inner
            .store
            .recover_rollout(metadata.rollout_path)
            .unwrap();
        assert!(
            recovery
                .rollout_items
                .iter()
                .any(|item| matches!(item.item, RecoveredRolloutItemKind::Compacted(_)))
        );
        drop(manager);
        let reopened = ThreadManager::open(
            temp.path().join("state"),
            temp.path().join("threads"),
            RuntimeDefaults {
                model: "gpt-test".into(),
                model_provider: "test-provider".into(),
                cwd: temp.path().join("workspace"),
                ..RuntimeDefaults::default()
            },
        )
        .unwrap();
        reopened.dispatch(
            "desktop",
            request(4, "thread/resume", json!({"threadId":thread_id})),
        );
        assert_eq!(reopened.injected_items(&thread_id).unwrap(), history);
    }

    #[test]
    fn auto_compaction_stays_inside_the_active_turn() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let thread_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let turn = manager.dispatch(
            "desktop",
            request(
                2,
                "turn/start",
                json!({
                    "threadId":thread_id,
                    "input":[{"type":"text","text":"continue","textElements":[]}]
                }),
            ),
        );
        let turn_id = result(&turn)["turn"]["id"].as_str().unwrap().to_owned();
        let (snapshot, started_notifications) =
            manager.begin_auto_compaction(&thread_id, &turn_id).unwrap();
        assert!(snapshot.automatic);
        assert_eq!(started_notifications[0].method, "item/started");
        let completed = manager
            .complete_compaction(&thread_id, &turn_id, "auto summary")
            .unwrap();
        assert_eq!(
            completed
                .iter()
                .map(|notification| notification.method.as_str())
                .collect::<Vec<_>>(),
            ["item/completed", "warning"]
        );
        assert!(
            manager
                .turn_execution_snapshot(&thread_id, &turn_id)
                .is_ok()
        );
        manager.complete_turn(&thread_id, &turn_id, None).unwrap();
    }

    #[test]
    fn world_state_full_and_patch_baseline_survive_restart() {
        let (temp, manager) = manager();
        let started = start(&manager, "desktop");
        let thread_id = result(&started)["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let first = json!({"environment":{"cwd":"/one"},"agents":{"text":"rules"}});
        let second = json!({"environment":{"cwd":"/two"}});
        assert!(manager.record_world_state(&thread_id, first).unwrap());
        assert!(
            manager
                .record_world_state(&thread_id, second.clone())
                .unwrap()
        );
        assert!(
            !manager
                .record_world_state(&thread_id, second.clone())
                .unwrap()
        );
        drop(manager);
        let reopened = ThreadManager::open(
            temp.path().join("state"),
            temp.path().join("threads"),
            RuntimeDefaults {
                model: "gpt-test".into(),
                model_provider: "test-provider".into(),
                cwd: temp.path().join("workspace"),
                ..RuntimeDefaults::default()
            },
        )
        .unwrap();
        reopened.dispatch(
            "desktop",
            request(2, "thread/resume", json!({"threadId":thread_id})),
        );
        assert!(!reopened.record_world_state(&thread_id, second).unwrap());
    }

    #[test]
    fn invalid_params_return_json_rpc_errors_without_notifications() {
        let (_temp, manager) = manager();
        let output = manager.dispatch(
            "desktop",
            request(1, "thread/resume", json!({"threadId": "../escape"})),
        );
        assert_eq!(output.response["error"]["code"], -32602);
        assert!(output.notifications.is_empty());
    }

    #[test]
    fn file_change_lifecycle_patch_delta_and_turn_diff_match_v2() {
        let (_temp, manager) = manager();
        let started = start(&manager, "desktop");
        let thread_id = result(&started)["thread"]["id"].as_str().unwrap();
        let turn = manager.dispatch(
            "desktop",
            request(
                2,
                "turn/start",
                json!({
                    "threadId":thread_id,
                    "input":[{"type":"text","text":"edit","textElements":[]}]
                }),
            ),
        );
        let turn_id = result(&turn)["turn"]["id"].as_str().unwrap();
        let item = json!({
            "type":"fileChange",
            "id":"patch_1",
            "changes":[],
            "status":"inProgress"
        });
        manager
            .local_tool_item_started(thread_id, turn_id, item)
            .unwrap();
        let change = json!({
            "path":"src/lib.rs",
            "kind":{"type":"update","move_path":null},
            "diff":"@@ -1 +1 @@\n-old\n+new\n"
        });
        let patch = manager
            .file_change_patch_updated(thread_id, turn_id, "patch_1", vec![change])
            .unwrap();
        assert_eq!(patch[0].method, "item/fileChange/patchUpdated");
        let legacy = manager
            .file_change_output_delta(thread_id, turn_id, "patch_1", "M src/lib.rs\n")
            .unwrap();
        assert_eq!(legacy[0].method, "item/fileChange/outputDelta");
        let diff = manager
            .turn_diff_updated(thread_id, turn_id, "diff --git a/src/lib.rs b/src/lib.rs")
            .unwrap();
        assert_eq!(diff[0].method, "turn/diff/updated");
        assert_eq!(manager.thread_recipients(thread_id).unwrap(), ["desktop"]);
        let completed = manager
            .local_tool_item_completed(
                thread_id,
                turn_id,
                json!({
                    "type":"fileChange",
                    "id":"patch_1",
                    "changes":[{
                        "path":"src/lib.rs",
                        "kind":{"type":"update","move_path":null},
                        "diff":"@@ -1 +1 @@\n-old\n+new\n"
                    }],
                    "status":"completed"
                }),
            )
            .unwrap();
        assert_eq!(completed[0].method, "item/completed");
        manager.complete_turn(thread_id, turn_id, None).unwrap();
        let read = manager.dispatch(
            "desktop",
            request(
                3,
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":true}),
            ),
        );
        let items = result(&read)["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap();
        let file_change = items
            .iter()
            .find(|item| item["type"] == "fileChange")
            .unwrap_or_else(|| panic!("missing file change in {items:?}"));
        assert_eq!(file_change["status"], "completed");
    }
}
