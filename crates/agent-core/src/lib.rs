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
use tietiezhi_agent_protocol::{
    ClientRequest, JSONRPCRequest, JSONRPCResponse, ServerNotification,
    ThreadApproveGuardianDeniedActionResponse, ThreadArchiveResponse, ThreadDeleteResponse,
    ThreadForkResponse, ThreadInjectItemsResponse, ThreadListResponse, ThreadLoadedListResponse,
    ThreadMetadataUpdateResponse, ThreadReadResponse, ThreadResumeResponse, ThreadRollbackResponse,
    ThreadSetNameResponse, ThreadStartResponse, ThreadUnarchiveResponse, ThreadUnsubscribeResponse,
};
use tietiezhi_agent_state::{RolloutAppender, StateError, StateStore, ThreadMetadata};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

const THREAD_LIST_DEFAULT_LIMIT: usize = 25;
const THREAD_LIST_MAX_LIMIT: usize = 100;

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
    service_tier: Option<String>,
    created_at_ms: u64,
    updated_at_ms: u64,
    recency_at_ms: Option<u64>,
    #[serde(default)]
    turns: Vec<Value>,
}

#[derive(Debug, Clone)]
struct LoadedThread {
    record: ThreadRecord,
    metadata: Option<ThreadMetadata>,
    status: Value,
    guardian_approvals: Vec<Value>,
    injected_items: Vec<Value>,
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
}

impl RpcError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }

    fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("method not found: {method}"),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: -32603,
            message: message.into(),
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
            Err(error) => DispatchOutput {
                response: json!({
                    "id": id,
                    "error": {
                        "code": error.code,
                        "message": error.message
                    }
                }),
                notifications: Vec::new(),
            },
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
            "thread/unsubscribe" => self.thread_unsubscribe(connection_id, &params)?,
            "thread/approveGuardianDeniedAction" => (
                self.thread_approve_guardian_denied_action(&params)?,
                Vec::new(),
            ),
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
            "thread/unsubscribe" => validate!(ThreadUnsubscribeResponse),
            "thread/approveGuardianDeniedAction" => {
                validate!(ThreadApproveGuardianDeniedActionResponse)
            }
            _ => Err(RpcError::method_not_found(method)),
        }
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
            self.thread_open_response(&loaded.record, &loaded.status, loaded.record.turns.clone());
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
        let mut turns = source.record.turns.clone();
        if let Some(last_turn_id) = optional_string(params, "lastTurnId") {
            let index = turns
                .iter()
                .position(|turn| turn.get("id").and_then(Value::as_str) == Some(&last_turn_id))
                .ok_or_else(|| RpcError::invalid(format!("turn not found: {last_turn_id}")))?;
            if turns[index].get("status").and_then(Value::as_str) == Some("inProgress") {
                return Err(RpcError::invalid("cannot fork through an in-progress turn"));
            }
            turns.truncate(index + 1);
        }
        let now = now_ms();
        let id = Uuid::now_v7().to_string();
        let inherited_items = source.injected_items;
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
        record.turns = turns;
        self.apply_open_overrides(&mut record, params)?;
        if let Some(source) = params.get("threadSource").filter(|value| !value.is_null()) {
            record.thread_source = Some(source.clone());
        }
        let loaded = self.create_loaded_thread(record, inherited_items, &mut state)?;
        state
            .subscribers
            .entry(id.clone())
            .or_default()
            .insert(connection_id.into());
        let response =
            self.thread_open_response(&loaded.record, &loaded.status, loaded.record.turns.clone());
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
        let (record, status) = if let Some(loaded) = loaded {
            (loaded.record, loaded.status)
        } else {
            let metadata = self.metadata(&id)?;
            (
                self.record_from_metadata(&metadata)?,
                json!({"type": "notLoaded"}),
            )
        };
        let turns = if params
            .get("includeTurns")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            record.turns.clone()
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
        let loaded_before = state.loaded.remove(&id);
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
        let archived = self.notification_global(&state, "thread/archived", json!({"threadId": id}));
        let mut notifications = vec![archived];
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
        let loaded_before = state.loaded.remove(&id);
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
        let deleted = self.notification_global(&state, "thread/deleted", json!({"threadId": id}));
        let mut notifications = vec![deleted];
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
        loaded.injected_items.extend(items.iter().cloned());
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
        if num_turns > loaded.record.turns.len() {
            return Err(RpcError::invalid(format!(
                "cannot rollback {num_turns} turns from a thread with {} turns",
                loaded.record.turns.len()
            )));
        }
        loaded
            .record
            .turns
            .truncate(loaded.record.turns.len() - num_turns);
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
        let thread = self.thread_value(&loaded.record, &loaded.status, loaded.record.turns.clone());
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

    /// R6 uses this hook to project canonical turns into Thread responses.
    pub fn replace_turns(&self, thread_id: &str, turns: Vec<Value>) -> RpcResult<()> {
        validate_thread_id(thread_id)?;
        let mut state = self.state()?;
        let mut loaded = self.load_thread_locked(thread_id, &mut state)?;
        loaded.record.turns = turns;
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

    fn create_loaded_thread(
        &self,
        record: ThreadRecord,
        injected_items: Vec<Value>,
        state: &mut ManagerState,
    ) -> RpcResult<LoadedThread> {
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
                .ensure_canonical_session_meta(&record.id, canonical_session_meta(&record))
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
        let loaded = LoadedThread {
            record: record.clone(),
            metadata,
            status: json!({"type": "idle"}),
            guardian_approvals: Vec::new(),
            injected_items,
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
        let record = self.record_from_metadata(&metadata)?;
        let injected_items = self
            .inner
            .store
            .recover_rollout(&metadata.rollout_path)
            .map_err(state_error)?
            .response_items;
        let loaded = LoadedThread {
            record,
            metadata: Some(metadata),
            status: json!({"type": "idle"}),
            guardian_approvals: Vec::new(),
            injected_items,
        };
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
                guardian_approvals: Vec::new(),
                injected_items: Vec::new(),
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

fn canonical_session_meta(record: &ThreadRecord) -> Value {
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
    fn invalid_params_return_json_rpc_errors_without_notifications() {
        let (_temp, manager) = manager();
        let output = manager.dispatch(
            "desktop",
            request(1, "thread/resume", json!({"threadId": "../escape"})),
        );
        assert_eq!(output.response["error"]["code"], -32602);
        assert!(output.notifications.is_empty());
    }
}
