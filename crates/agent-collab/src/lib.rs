//! Codex-compatible MultiAgentV2 control plane.
//!
//! This is a source-level adaptation of OpenAI Codex `rust-v0.145.0`.
//! It does not invoke or embed the upstream executable.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tietiezhi_agent_tools::{
    ToolError, ToolExposure, ToolFuture, ToolHandler, ToolInvocation, ToolName, ToolOutput,
    ToolPayload, ToolSpec,
};
use tokio::sync::watch;
use uuid::Uuid;

pub const ROOT_AGENT_PATH: &str = "/root";
pub const DEFAULT_MAX_CONCURRENT_THREADS: usize = 6;
pub const DEFAULT_MAX_DEPTH: usize = 1;
pub const MIN_WAIT_TIMEOUT_MS: i64 = 10_000;
pub const DEFAULT_WAIT_TIMEOUT_MS: i64 = 30_000;
pub const MAX_WAIT_TIMEOUT_MS: i64 = 3_600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatusKind {
    PendingInit,
    Running,
    Interrupted,
    Completed,
    Errored,
    Shutdown,
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub status: AgentStatusKind,
    pub message: Option<String>,
}

impl AgentStatus {
    pub fn pending_init() -> Self {
        Self {
            status: AgentStatusKind::PendingInit,
            message: None,
        }
    }

    pub fn running() -> Self {
        Self {
            status: AgentStatusKind::Running,
            message: None,
        }
    }

    pub fn interrupted() -> Self {
        Self {
            status: AgentStatusKind::Interrupted,
            message: None,
        }
    }

    pub fn completed(message: Option<String>) -> Self {
        Self {
            status: AgentStatusKind::Completed,
            message,
        }
    }

    pub fn errored(message: impl Into<String>) -> Self {
        Self {
            status: AgentStatusKind::Errored,
            message: Some(message.into()),
        }
    }

    pub fn is_final(&self) -> bool {
        matches!(
            self.status,
            AgentStatusKind::Completed
                | AgentStatusKind::Errored
                | AgentStatusKind::Shutdown
                | AgentStatusKind::NotFound
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub thread_id: String,
    pub agent_path: String,
    pub parent_thread_id: Option<String>,
    pub root_thread_id: String,
    pub depth: usize,
    #[serde(default = "default_max_concurrent_threads")]
    pub max_concurrent_threads: usize,
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
    pub nickname: Option<String>,
    pub role: Option<String>,
    pub status: AgentStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxMessage {
    pub id: String,
    pub author: String,
    pub recipient: String,
    pub message: String,
    pub trigger_turn: bool,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub author_thread_id: String,
    pub agent_path: String,
    pub task_name: String,
    pub message: String,
    pub agent_type: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub fork_turns: ForkTurns,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForkTurns {
    None,
    All,
    Last(usize),
}

impl ForkTurns {
    pub fn parse(value: Option<&str>) -> Result<Self, CollaborationError> {
        let value = value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("all");
        if value.eq_ignore_ascii_case("none") {
            return Ok(Self::None);
        }
        if value.eq_ignore_ascii_case("all") {
            return Ok(Self::All);
        }
        let turns = value.parse::<usize>().map_err(|_| {
            CollaborationError::Invalid(
                "fork_turns must be `none`, `all`, or a positive integer string".into(),
            )
        })?;
        if turns == 0 {
            return Err(CollaborationError::Invalid(
                "fork_turns must be `none`, `all`, or a positive integer string".into(),
            ));
        }
        Ok(Self::Last(turns))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnedAgent {
    pub thread_id: String,
    pub nickname: Option<String>,
    pub effective_model: Option<String>,
    pub effective_reasoning_effort: Option<String>,
    pub effective_service_tier: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedAgent {
    pub agent_name: String,
    pub agent_status: AgentStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollaborationError {
    Invalid(String),
    NotFound(String),
    Capacity(String),
    Conflict(String),
    Io(String),
    Host(String),
}

impl std::fmt::Display for CollaborationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (kind, message) = match self {
            Self::Invalid(message) => ("invalid collaboration request", message),
            Self::NotFound(message) => ("agent not found", message),
            Self::Capacity(message) => ("agent capacity exceeded", message),
            Self::Conflict(message) => ("agent conflict", message),
            Self::Io(message) => ("collaboration state failed", message),
            Self::Host(message) => ("agent host failed", message),
        };
        write!(formatter, "{kind}: {message}")
    }
}

impl std::error::Error for CollaborationError {}

pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait CollaborationHost: Send + Sync {
    fn spawn<'a>(
        &'a self,
        request: SpawnRequest,
    ) -> HostFuture<'a, Result<SpawnedAgent, CollaborationError>>;

    fn start<'a>(
        &'a self,
        target_thread_id: &'a str,
        message: &'a str,
        model: Option<String>,
        reasoning_effort: Option<String>,
        service_tier: Option<String>,
    ) -> HostFuture<'a, Result<(), CollaborationError>>;

    fn deliver<'a>(
        &'a self,
        target_thread_id: &'a str,
        message: MailboxMessage,
    ) -> HostFuture<'a, Result<(), CollaborationError>>;

    fn interrupt<'a>(
        &'a self,
        target_thread_id: &'a str,
    ) -> HostFuture<'a, Result<(), CollaborationError>>;
}

#[derive(Debug, Clone)]
pub struct CollaborationConfig {
    pub max_concurrent_threads: usize,
    pub max_depth: usize,
}

impl Default for CollaborationConfig {
    fn default() -> Self {
        Self {
            max_concurrent_threads: DEFAULT_MAX_CONCURRENT_THREADS,
            max_depth: DEFAULT_MAX_DEPTH,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ActivityKind {
    Mailbox,
    Status,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    generation: u64,
    kind: ActivityKind,
    thread_ids: Vec<String>,
}

impl Default for Activity {
    fn default() -> Self {
        Self {
            generation: 0,
            kind: ActivityKind::Status,
            thread_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistentState {
    agents: BTreeMap<String, AgentRecord>,
    paths: BTreeMap<String, String>,
    mailboxes: BTreeMap<String, VecDeque<MailboxMessage>>,
    #[serde(default)]
    reserved_paths: BTreeSet<String>,
    generation: u64,
}

struct Inner {
    state_path: Option<PathBuf>,
    config: CollaborationConfig,
    state: Mutex<PersistentState>,
    activity: watch::Sender<Activity>,
}

#[derive(Clone)]
pub struct CollaborationRuntime {
    inner: Arc<Inner>,
}

#[derive(Debug, Clone)]
pub struct SpawnReservation {
    author: AgentRecord,
    path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitOutcome {
    Mailbox(Vec<String>),
    Steered,
    TimedOut,
}

impl Default for CollaborationRuntime {
    fn default() -> Self {
        Self::memory(CollaborationConfig::default())
    }
}

impl CollaborationRuntime {
    pub fn memory(config: CollaborationConfig) -> Self {
        Self::from_state(None, config, PersistentState::default())
    }

    pub fn open(
        state_root: impl AsRef<Path>,
        config: CollaborationConfig,
    ) -> Result<Self, CollaborationError> {
        fs::create_dir_all(state_root.as_ref())
            .map_err(|error| CollaborationError::Io(error.to_string()))?;
        let state_path = state_root.as_ref().join("collaboration.json");
        let state = if state_path.exists() {
            serde_json::from_slice(&fs::read(&state_path).map_err(io_error)?)
                .map_err(|error| CollaborationError::Io(error.to_string()))?
        } else {
            PersistentState::default()
        };
        Ok(Self::from_state(Some(state_path), config, state))
    }

    fn from_state(
        state_path: Option<PathBuf>,
        config: CollaborationConfig,
        mut state: PersistentState,
    ) -> Self {
        state.reserved_paths.clear();
        let activity = Activity {
            generation: state.generation,
            ..Activity::default()
        };
        let (tx, _) = watch::channel(activity);
        Self {
            inner: Arc::new(Inner {
                state_path,
                config,
                state: Mutex::new(state),
                activity: tx,
            }),
        }
    }

    pub fn register_root(&self, thread_id: &str) -> Result<AgentRecord, CollaborationError> {
        self.register_root_with_config(thread_id, self.inner.config.clone())
    }

    pub fn register_root_with_config(
        &self,
        thread_id: &str,
        config: CollaborationConfig,
    ) -> Result<AgentRecord, CollaborationError> {
        validate_thread_id(thread_id)?;
        if config.max_concurrent_threads == 0 {
            return Err(CollaborationError::Invalid(
                "max_concurrent_threads must be at least 1".into(),
            ));
        }
        let mut state = self.state()?;
        if let Some(record) = state.agents.get_mut(thread_id) {
            record.max_concurrent_threads = config.max_concurrent_threads;
            record.max_depth = config.max_depth;
            let record = record.clone();
            self.persist(&state)?;
            return Ok(record);
        }
        let now = now_ms();
        let record = AgentRecord {
            thread_id: thread_id.into(),
            agent_path: ROOT_AGENT_PATH.into(),
            parent_thread_id: None,
            root_thread_id: thread_id.into(),
            depth: 0,
            max_concurrent_threads: config.max_concurrent_threads,
            max_depth: config.max_depth,
            nickname: None,
            role: None,
            status: AgentStatus::running(),
            created_at_ms: now,
            updated_at_ms: now,
        };
        state
            .paths
            .insert(path_key(thread_id, ROOT_AGENT_PATH), thread_id.into());
        state.agents.insert(thread_id.into(), record.clone());
        self.persist(&state)?;
        Ok(record)
    }

    pub fn reserve_spawn(
        &self,
        author_thread_id: &str,
        task_name: &str,
    ) -> Result<SpawnReservation, CollaborationError> {
        validate_agent_name(task_name)?;
        let mut state = self.state()?;
        let author = state
            .agents
            .get(author_thread_id)
            .cloned()
            .ok_or_else(|| CollaborationError::NotFound(author_thread_id.into()))?;
        let depth = author.depth.saturating_add(1);
        let root = state
            .agents
            .get(&author.root_thread_id)
            .cloned()
            .ok_or_else(|| CollaborationError::NotFound(author.root_thread_id.clone()))?;
        if depth > root.max_depth {
            return Err(CollaborationError::Capacity(format!(
                "agent spawn depth {depth} exceeds configured maximum {}",
                root.max_depth
            )));
        }
        let live = state
            .agents
            .values()
            .filter(|agent| {
                agent.root_thread_id == author.root_thread_id
                    && agent.status.status != AgentStatusKind::Shutdown
                    && agent.status.status != AgentStatusKind::NotFound
            })
            .count()
            .saturating_add(
                state
                    .reserved_paths
                    .iter()
                    .filter(|path| path.starts_with(&format!("{}\0", author.root_thread_id)))
                    .count(),
            );
        if live >= root.max_concurrent_threads {
            return Err(CollaborationError::Capacity(format!(
                "maximum concurrent threads per session is {}",
                root.max_concurrent_threads
            )));
        }
        let path = format!("{}/{}", author.agent_path, task_name);
        let key = path_key(&author.root_thread_id, &path);
        if state.paths.contains_key(&key) || !state.reserved_paths.insert(key) {
            return Err(CollaborationError::Conflict(format!(
                "agent path already exists: {path}"
            )));
        }
        Ok(SpawnReservation { author, path })
    }

    pub fn register_existing(
        &self,
        thread_id: &str,
        parent_thread_id: &str,
        agent_path: &str,
        nickname: Option<String>,
        role: Option<String>,
        status: AgentStatus,
    ) -> Result<AgentRecord, CollaborationError> {
        validate_thread_id(thread_id)?;
        validate_thread_id(parent_thread_id)?;
        let mut state = self.state()?;
        if let Some(record) = state.agents.get(thread_id) {
            return Ok(record.clone());
        }
        let parent = state
            .agents
            .get(parent_thread_id)
            .cloned()
            .ok_or_else(|| CollaborationError::NotFound(parent_thread_id.into()))?;
        let expected_prefix = format!("{}/", parent.agent_path);
        if !agent_path.starts_with(&expected_prefix) {
            return Err(CollaborationError::Invalid(format!(
                "agent path {agent_path} is not a child of {}",
                parent.agent_path
            )));
        }
        let now = now_ms();
        let record = AgentRecord {
            thread_id: thread_id.into(),
            agent_path: agent_path.into(),
            parent_thread_id: Some(parent_thread_id.into()),
            root_thread_id: parent.root_thread_id,
            depth: parent.depth + 1,
            max_concurrent_threads: parent.max_concurrent_threads,
            max_depth: parent.max_depth,
            nickname,
            role,
            status,
            created_at_ms: now,
            updated_at_ms: now,
        };
        state.paths.insert(
            path_key(&record.root_thread_id, agent_path),
            thread_id.into(),
        );
        state.agents.insert(thread_id.into(), record.clone());
        self.persist(&state)?;
        Ok(record)
    }

    pub fn abort_spawn(&self, reservation: &SpawnReservation) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.reserved_paths.remove(&path_key(
                &reservation.author.root_thread_id,
                &reservation.path,
            ));
        }
    }

    pub fn commit_spawn(
        &self,
        reservation: SpawnReservation,
        spawned: SpawnedAgent,
        role: Option<String>,
    ) -> Result<AgentRecord, CollaborationError> {
        validate_thread_id(&spawned.thread_id)?;
        let mut state = self.state()?;
        if !state.reserved_paths.remove(&path_key(
            &reservation.author.root_thread_id,
            &reservation.path,
        )) {
            return Err(CollaborationError::Conflict(format!(
                "spawn reservation expired: {}",
                reservation.path
            )));
        }
        if state.agents.contains_key(&spawned.thread_id) {
            return Err(CollaborationError::Conflict(format!(
                "agent thread already exists: {}",
                spawned.thread_id
            )));
        }
        let now = now_ms();
        let record = AgentRecord {
            thread_id: spawned.thread_id.clone(),
            agent_path: reservation.path.clone(),
            parent_thread_id: Some(reservation.author.thread_id),
            root_thread_id: reservation.author.root_thread_id,
            depth: reservation.author.depth + 1,
            max_concurrent_threads: reservation.author.max_concurrent_threads,
            max_depth: reservation.author.max_depth,
            nickname: spawned.nickname,
            role,
            status: AgentStatus::running(),
            created_at_ms: now,
            updated_at_ms: now,
        };
        state.paths.insert(
            path_key(&record.root_thread_id, &record.agent_path),
            record.thread_id.clone(),
        );
        state
            .agents
            .insert(record.thread_id.clone(), record.clone());
        self.signal_locked(
            &mut state,
            ActivityKind::Status,
            vec![record.thread_id.clone()],
        );
        self.persist(&state)?;
        Ok(record)
    }

    pub fn resolve(
        &self,
        author_thread_id: &str,
        target: &str,
    ) -> Result<AgentRecord, CollaborationError> {
        let state = self.state()?;
        if let Some(record) = state.agents.get(target) {
            return Ok(record.clone());
        }
        let author = state
            .agents
            .get(author_thread_id)
            .ok_or_else(|| CollaborationError::NotFound(author_thread_id.into()))?;
        let path = resolve_path(&author.agent_path, target)?;
        let thread_id = state
            .paths
            .get(&path_key(&author.root_thread_id, &path))
            .ok_or_else(|| CollaborationError::NotFound(target.into()))?;
        state
            .agents
            .get(thread_id)
            .cloned()
            .ok_or_else(|| CollaborationError::NotFound(target.into()))
    }

    pub fn record_message(
        &self,
        author_thread_id: &str,
        target_thread_id: &str,
        message: &str,
        trigger_turn: bool,
    ) -> Result<MailboxMessage, CollaborationError> {
        if message.trim().is_empty() {
            return Err(CollaborationError::Invalid(
                "Empty message can't be sent to an agent".into(),
            ));
        }
        let mut state = self.state()?;
        let author = state
            .agents
            .get(author_thread_id)
            .ok_or_else(|| CollaborationError::NotFound(author_thread_id.into()))?
            .agent_path
            .clone();
        let recipient = state
            .agents
            .get(target_thread_id)
            .ok_or_else(|| CollaborationError::NotFound(target_thread_id.into()))?
            .agent_path
            .clone();
        let item = MailboxMessage {
            id: Uuid::now_v7().to_string(),
            author,
            recipient,
            message: message.into(),
            trigger_turn,
            created_at_ms: now_ms(),
        };
        state
            .mailboxes
            .entry(target_thread_id.into())
            .or_default()
            .push_back(item.clone());
        self.signal_locked(
            &mut state,
            ActivityKind::Mailbox,
            vec![author_thread_id.into(), target_thread_id.into()],
        );
        self.persist(&state)?;
        Ok(item)
    }

    pub fn drain_mailbox(
        &self,
        thread_id: &str,
    ) -> Result<Vec<MailboxMessage>, CollaborationError> {
        let mut state = self.state()?;
        let messages = state
            .mailboxes
            .entry(thread_id.into())
            .or_default()
            .drain(..)
            .collect::<Vec<_>>();
        self.persist(&state)?;
        Ok(messages)
    }

    pub fn discard_message(
        &self,
        thread_id: &str,
        message_id: &str,
    ) -> Result<(), CollaborationError> {
        let mut state = self.state()?;
        if let Some(mailbox) = state.mailboxes.get_mut(thread_id) {
            mailbox.retain(|message| message.id != message_id);
        }
        self.persist(&state)
    }

    pub fn status(&self, thread_id: &str) -> AgentStatus {
        self.inner
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .agents
                    .get(thread_id)
                    .map(|agent| agent.status.clone())
            })
            .unwrap_or(AgentStatus {
                status: AgentStatusKind::NotFound,
                message: None,
            })
    }

    pub fn update_status(
        &self,
        thread_id: &str,
        status: AgentStatus,
    ) -> Result<(), CollaborationError> {
        let mut state = self.state()?;
        let record = state
            .agents
            .get_mut(thread_id)
            .ok_or_else(|| CollaborationError::NotFound(thread_id.into()))?;
        record.status = status;
        record.updated_at_ms = now_ms();
        self.signal_locked(&mut state, ActivityKind::Status, vec![thread_id.into()]);
        self.persist(&state)
    }

    pub fn descendants(&self, thread_id: &str) -> Vec<String> {
        let Ok(state) = self.inner.state.lock() else {
            return Vec::new();
        };
        let mut output = Vec::new();
        let mut pending = vec![thread_id.to_string()];
        while let Some(parent) = pending.pop() {
            let children = state
                .agents
                .values()
                .filter(|agent| agent.parent_thread_id.as_deref() == Some(parent.as_str()))
                .map(|agent| agent.thread_id.clone())
                .collect::<Vec<_>>();
            for child in children.into_iter().rev() {
                pending.push(child.clone());
                output.push(child);
            }
        }
        output
    }

    pub fn list(
        &self,
        author_thread_id: &str,
        path_prefix: Option<&str>,
    ) -> Result<Vec<ListedAgent>, CollaborationError> {
        let state = self.state()?;
        let author = state
            .agents
            .get(author_thread_id)
            .ok_or_else(|| CollaborationError::NotFound(author_thread_id.into()))?;
        let prefix = path_prefix
            .map(|prefix| resolve_path(&author.agent_path, prefix))
            .transpose()?;
        let mut records = state
            .agents
            .values()
            .filter(|agent| agent.root_thread_id == author.root_thread_id)
            .filter(|agent| {
                !matches!(
                    agent.status.status,
                    AgentStatusKind::Shutdown | AgentStatusKind::NotFound
                )
            })
            .filter(|agent| {
                prefix.as_ref().is_none_or(|prefix| {
                    agent.agent_path == *prefix
                        || agent
                            .agent_path
                            .strip_prefix(prefix)
                            .is_some_and(|suffix| suffix.starts_with('/'))
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        records.sort_by(|left, right| {
            left.agent_path
                .cmp(&right.agent_path)
                .then_with(|| left.thread_id.cmp(&right.thread_id))
        });
        Ok(records
            .into_iter()
            .map(|agent| ListedAgent {
                agent_name: agent.agent_path,
                agent_status: agent.status,
            })
            .collect())
    }

    pub async fn wait(
        &self,
        author_thread_id: &str,
        timeout_ms: i64,
        cancellation: tokio_util::sync::CancellationToken,
        input_activity: tokio_util::sync::CancellationToken,
    ) -> Result<WaitOutcome, CollaborationError> {
        if timeout_ms < MIN_WAIT_TIMEOUT_MS {
            return Err(CollaborationError::Invalid(format!(
                "timeout_ms must be at least {MIN_WAIT_TIMEOUT_MS}"
            )));
        }
        if timeout_ms > MAX_WAIT_TIMEOUT_MS {
            return Err(CollaborationError::Invalid(format!(
                "timeout_ms must be at most {MAX_WAIT_TIMEOUT_MS}"
            )));
        }
        let root_thread_id = {
            let state = self.state()?;
            state
                .agents
                .get(author_thread_id)
                .ok_or_else(|| CollaborationError::NotFound(author_thread_id.into()))?
                .root_thread_id
                .clone()
        };
        let mut receiver = self.inner.activity.subscribe();
        let generation = receiver.borrow().generation;
        let timeout = Duration::from_millis(timeout_ms as u64);
        tokio::select! {
            _ = cancellation.cancelled() => Err(CollaborationError::Host("wait cancelled".into())),
            _ = input_activity.cancelled() => Ok(WaitOutcome::Steered),
            result = tokio::time::timeout(timeout, async {
                loop {
                    receiver.changed().await.map_err(|_| {
                        CollaborationError::Host("collaboration activity channel closed".into())
                    })?;
                    let activity = receiver.borrow_and_update().clone();
                    let same_tree = {
                        let state = self.state()?;
                        activity.thread_ids.iter().any(|thread_id| {
                            state.agents.get(thread_id).is_some_and(|agent| {
                                agent.root_thread_id == root_thread_id
                            })
                        })
                    };
                    if activity.generation > generation && same_tree {
                        return Ok(activity);
                    }
                }
            }) => match result {
                Ok(Ok(activity)) => Ok(WaitOutcome::Mailbox(activity.thread_ids)),
                Ok(Err(error)) => Err(error),
                Err(_) => Ok(WaitOutcome::TimedOut),
            }
        }
    }

    pub fn tree_for(&self, thread_id: &str) -> Result<Vec<AgentRecord>, CollaborationError> {
        let state = self.state()?;
        let root = state
            .agents
            .get(thread_id)
            .ok_or_else(|| CollaborationError::NotFound(thread_id.into()))?
            .root_thread_id
            .clone();
        Ok(state
            .agents
            .values()
            .filter(|agent| agent.root_thread_id == root)
            .cloned()
            .collect())
    }

    fn state(&self) -> Result<MutexGuard<'_, PersistentState>, CollaborationError> {
        self.inner
            .state
            .lock()
            .map_err(|_| CollaborationError::Io("state lock poisoned".into()))
    }

    fn signal_locked(
        &self,
        state: &mut PersistentState,
        kind: ActivityKind,
        thread_ids: Vec<String>,
    ) {
        state.generation = state.generation.saturating_add(1);
        self.inner.activity.send_replace(Activity {
            generation: state.generation,
            kind,
            thread_ids,
        });
    }

    fn persist(&self, state: &PersistentState) -> Result<(), CollaborationError> {
        let Some(path) = &self.inner.state_path else {
            return Ok(());
        };
        let bytes = serde_json::to_vec_pretty(state)
            .map_err(|error| CollaborationError::Io(error.to_string()))?;
        let temporary = path.with_extension(format!("json.tmp.{}", Uuid::now_v7()));
        fs::write(&temporary, bytes).map_err(io_error)?;
        fs::rename(&temporary, path).map_err(io_error)
    }
}

#[derive(Clone)]
pub struct CollaborationTools {
    runtime: CollaborationRuntime,
    host: Arc<dyn CollaborationHost>,
}

impl CollaborationTools {
    pub fn new(runtime: CollaborationRuntime, host: Arc<dyn CollaborationHost>) -> Self {
        Self { runtime, host }
    }

    pub fn handlers(&self) -> Vec<Arc<dyn ToolHandler>> {
        vec![
            Arc::new(CollabHandler::new(
                CollabToolKind::Spawn,
                self.runtime.clone(),
                Arc::clone(&self.host),
            )),
            Arc::new(CollabHandler::new(
                CollabToolKind::SendMessage,
                self.runtime.clone(),
                Arc::clone(&self.host),
            )),
            Arc::new(CollabHandler::new(
                CollabToolKind::Followup,
                self.runtime.clone(),
                Arc::clone(&self.host),
            )),
            Arc::new(CollabHandler::new(
                CollabToolKind::Wait,
                self.runtime.clone(),
                Arc::clone(&self.host),
            )),
            Arc::new(CollabHandler::new(
                CollabToolKind::Interrupt,
                self.runtime.clone(),
                Arc::clone(&self.host),
            )),
            Arc::new(CollabHandler::new(
                CollabToolKind::List,
                self.runtime.clone(),
                Arc::clone(&self.host),
            )),
        ]
    }
}

#[derive(Clone, Copy)]
enum CollabToolKind {
    Spawn,
    SendMessage,
    Followup,
    Wait,
    Interrupt,
    List,
}

struct CollabHandler {
    kind: CollabToolKind,
    runtime: CollaborationRuntime,
    host: Arc<dyn CollaborationHost>,
}

impl CollabHandler {
    fn new(
        kind: CollabToolKind,
        runtime: CollaborationRuntime,
        host: Arc<dyn CollaborationHost>,
    ) -> Self {
        Self {
            kind,
            runtime,
            host,
        }
    }
}

impl ToolHandler for CollabHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(match self.kind {
            CollabToolKind::Spawn => "spawn_agent",
            CollabToolKind::SendMessage => "send_message",
            CollabToolKind::Followup => "followup_task",
            CollabToolKind::Wait => "wait_agent",
            CollabToolKind::Interrupt => "interrupt_agent",
            CollabToolKind::List => "list_agents",
        })
    }

    fn spec(&self) -> ToolSpec {
        let (description, properties, required) = match self.kind {
            CollabToolKind::Spawn => (
                "Spawn a new agent to work on a concrete, bounded subtask. Spawned agents inherit the parent model and context by default.",
                json!({
                    "message":{"type":"string"},
                    "task_name":{"type":"string","description":"Use lowercase letters, digits, and underscores."},
                    "agent_type":{"type":"string"},
                    "model":{"type":"string"},
                    "reasoning_effort":{"type":"string"},
                    "service_tier":{"type":"string"},
                    "fork_turns":{"type":"string","description":"`none`, `all`, or a positive integer string."},
                    "fork_context":{"type":"boolean","description":"Deprecated and rejected in MultiAgentV2."}
                }),
                vec!["message", "task_name"],
            ),
            CollabToolKind::SendMessage => (
                "Send a message to an existing agent. The message is queued and does not trigger a new turn.",
                json!({"target":{"type":"string"},"message":{"type":"string"}}),
                vec!["target", "message"],
            ),
            CollabToolKind::Followup => (
                "Send a follow-up task to a non-root agent and trigger a turn when it is idle.",
                json!({"target":{"type":"string"},"message":{"type":"string"}}),
                vec!["target", "message"],
            ),
            CollabToolKind::Wait => (
                "Wait for a mailbox update from any live agent or for steered user input.",
                json!({"timeout_ms":{"type":"integer","minimum":MIN_WAIT_TIMEOUT_MS,"maximum":MAX_WAIT_TIMEOUT_MS}}),
                vec![],
            ),
            CollabToolKind::Interrupt => (
                "Interrupt an agent's current turn. The agent remains available.",
                json!({"target":{"type":"string"}}),
                vec!["target"],
            ),
            CollabToolKind::List => (
                "List live agents in the current root thread tree.",
                json!({"path_prefix":{"type":"string"}}),
                vec![],
            ),
        };
        let mut spec = ToolSpec::function(
            self.tool_name(),
            description,
            json!({
                "type":"object",
                "properties":properties,
                "required":required,
                "additionalProperties":false
            }),
        );
        spec.output_schema = match self.kind {
            CollabToolKind::Spawn => Some(json!({
                "type":"object",
                "properties":{"task_name":{"type":"string"}},
                "required":["task_name"],
                "additionalProperties":false
            })),
            CollabToolKind::Wait => Some(json!({
                "type":"object",
                "properties":{
                    "message":{"type":"string"},
                    "timed_out":{"type":"boolean"}
                },
                "required":["message","timed_out"],
                "additionalProperties":false
            })),
            CollabToolKind::Interrupt => Some(json!({
                "type":"object",
                "properties":{"previous_status":agent_status_schema()},
                "required":["previous_status"],
                "additionalProperties":false
            })),
            CollabToolKind::List => Some(json!({
                "type":"object",
                "properties":{
                    "agents":{
                        "type":"array",
                        "items":{
                            "type":"object",
                            "properties":{
                                "agent_name":{"type":"string"},
                                "agent_status":agent_status_schema()
                            },
                            "required":["agent_name","agent_status"],
                            "additionalProperties":false
                        }
                    }
                },
                "required":["agents"],
                "additionalProperties":false
            })),
            CollabToolKind::SendMessage | CollabToolKind::Followup => None,
        };
        spec
    }

    fn exposure(&self) -> ToolExposure {
        ToolExposure::ModelVisible
    }

    fn waits_for_runtime_cancellation(&self) -> bool {
        matches!(self.kind, CollabToolKind::Wait)
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            let arguments = function_arguments(&invocation.call.payload)?;
            match self.kind {
                CollabToolKind::Spawn => {
                    let args: SpawnArgs = parse_arguments(arguments)?;
                    if args.fork_context.is_some() {
                        return Err(ToolError::InvalidCall(
                            "fork_context is not supported in MultiAgentV2; use fork_turns instead"
                                .into(),
                        ));
                    }
                    if args.message.trim().is_empty() {
                        return Err(ToolError::InvalidCall(
                            "Empty message can't be sent to an agent".into(),
                        ));
                    }
                    let fork_turns =
                        ForkTurns::parse(args.fork_turns.as_deref()).map_err(tool_error)?;
                    if matches!(fork_turns, ForkTurns::All) && args.agent_type.is_some() {
                        return Err(ToolError::InvalidCall(
                            "agent_type cannot be overridden for a full-history fork".into(),
                        ));
                    }
                    let reservation = self
                        .runtime
                        .reserve_spawn(&invocation.thread_id, &args.task_name)
                        .map_err(tool_error)?;
                    let request = SpawnRequest {
                        author_thread_id: invocation.thread_id.clone(),
                        agent_path: reservation.path.clone(),
                        task_name: args.task_name,
                        message: args.message.clone(),
                        agent_type: args.agent_type.clone(),
                        model: args.model.clone(),
                        reasoning_effort: args.reasoning_effort.clone(),
                        service_tier: args.service_tier.clone(),
                        fork_turns,
                    };
                    let spawned = match self.host.spawn(request).await {
                        Ok(spawned) => spawned,
                        Err(error) => {
                            self.runtime.abort_spawn(&reservation);
                            return Err(tool_error(error));
                        }
                    };
                    let start_model = spawned.effective_model.clone();
                    let start_reasoning_effort = spawned.effective_reasoning_effort.clone();
                    let start_service_tier = spawned.effective_service_tier.clone();
                    let record = self
                        .runtime
                        .commit_spawn(reservation, spawned, args.agent_type)
                        .map_err(tool_error)?;
                    if let Err(error) = self
                        .host
                        .start(
                            &record.thread_id,
                            &args.message,
                            start_model,
                            start_reasoning_effort,
                            start_service_tier,
                        )
                        .await
                    {
                        let _ = self.runtime.update_status(
                            &record.thread_id,
                            AgentStatus::errored(error.to_string()),
                        );
                        return Err(tool_error(error));
                    }
                    Ok(ToolOutput::success(json!({
                        "task_name":record.agent_path
                    }))
                    .with_metadata(collab_metadata(
                        "spawnAgent",
                        &invocation,
                        Some(&record),
                        Some(args.message),
                        Some("started"),
                        None,
                    )))
                }
                CollabToolKind::SendMessage | CollabToolKind::Followup => {
                    let args: MessageArgs = parse_arguments(arguments)?;
                    let target = self
                        .runtime
                        .resolve(&invocation.thread_id, &args.target)
                        .map_err(tool_error)?;
                    let trigger = matches!(self.kind, CollabToolKind::Followup);
                    if trigger && target.agent_path == ROOT_AGENT_PATH {
                        return Err(ToolError::InvalidCall(
                            "Follow-up tasks can't target the root agent".into(),
                        ));
                    }
                    let message = self
                        .runtime
                        .record_message(
                            &invocation.thread_id,
                            &target.thread_id,
                            &args.message,
                            trigger,
                        )
                        .map_err(tool_error)?;
                    if let Err(error) = self.host.deliver(&target.thread_id, message.clone()).await
                    {
                        let _ = self.runtime.discard_message(&target.thread_id, &message.id);
                        return Err(tool_error(error));
                    }
                    self.runtime
                        .discard_message(&target.thread_id, &message.id)
                        .map_err(tool_error)?;
                    if trigger {
                        self.runtime
                            .update_status(&target.thread_id, AgentStatus::running())
                            .map_err(tool_error)?;
                    }
                    Ok(
                        ToolOutput::success(Value::String(String::new())).with_metadata(
                            collab_metadata(
                                if trigger { "resumeAgent" } else { "sendInput" },
                                &invocation,
                                Some(&target),
                                Some(args.message),
                                Some("interacted"),
                                None,
                            ),
                        ),
                    )
                }
                CollabToolKind::Wait => {
                    let args: WaitArgs = parse_arguments(arguments)?;
                    let timeout_ms = args.timeout_ms.unwrap_or(DEFAULT_WAIT_TIMEOUT_MS);
                    let outcome = self
                        .runtime
                        .wait(
                            &invocation.thread_id,
                            timeout_ms,
                            invocation.cancellation.clone(),
                            invocation.input_activity.clone(),
                        )
                        .await
                        .map_err(tool_error)?;
                    let (message, timed_out, thread_ids) = match outcome {
                        WaitOutcome::Mailbox(thread_ids) => {
                            let summary = if thread_ids.is_empty() {
                                "Wait completed.".into()
                            } else {
                                format!("Agent updates: {}", thread_ids.join(", "))
                            };
                            (summary, false, thread_ids)
                        }
                        WaitOutcome::Steered => {
                            ("Wait interrupted by new input.".into(), false, Vec::new())
                        }
                        WaitOutcome::TimedOut => ("Wait timed out.".into(), true, Vec::new()),
                    };
                    Ok(ToolOutput::success(json!({
                        "message":message,
                        "timed_out":timed_out
                    }))
                    .with_metadata(collab_metadata_raw(
                        "wait",
                        &invocation,
                        thread_ids,
                        Vec::new(),
                        None,
                        None,
                    )))
                }
                CollabToolKind::Interrupt => {
                    let args: TargetArgs = parse_arguments(arguments)?;
                    let target = self
                        .runtime
                        .resolve(&invocation.thread_id, &args.target)
                        .map_err(tool_error)?;
                    if target.agent_path == ROOT_AGENT_PATH {
                        return Err(ToolError::InvalidCall("root is not a spawned agent".into()));
                    }
                    if target.thread_id == invocation.thread_id {
                        return Err(ToolError::InvalidCall(
                            "an agent cannot interrupt itself; return your result and let the parent interrupt you if needed"
                                .into(),
                        ));
                    }
                    let previous_status = target.status.clone();
                    self.host
                        .interrupt(&target.thread_id)
                        .await
                        .map_err(tool_error)?;
                    if matches!(
                        previous_status.status,
                        AgentStatusKind::PendingInit | AgentStatusKind::Running
                    ) {
                        self.runtime
                            .update_status(&target.thread_id, AgentStatus::interrupted())
                            .map_err(tool_error)?;
                    }
                    Ok(ToolOutput::success(json!({
                        "previous_status":agent_status_tool_value(&previous_status)
                    }))
                    .with_metadata(collab_metadata(
                        "closeAgent",
                        &invocation,
                        Some(&target),
                        None,
                        Some("interrupted"),
                        Some(previous_status),
                    )))
                }
                CollabToolKind::List => {
                    let args: ListArgs = parse_arguments(arguments)?;
                    let agents = self
                        .runtime
                        .list(&invocation.thread_id, args.path_prefix.as_deref())
                        .map_err(tool_error)?;
                    Ok(ToolOutput::success(json!({
                        "agents":agents.into_iter().map(|agent| json!({
                            "agent_name":agent.agent_name,
                            "agent_status":agent_status_tool_value(&agent.agent_status)
                        })).collect::<Vec<_>>()
                    })))
                }
            }
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpawnArgs {
    message: String,
    task_name: String,
    agent_type: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    fork_turns: Option<String>,
    fork_context: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageArgs {
    target: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetArgs {
    target: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitArgs {
    timeout_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    path_prefix: Option<String>,
}

fn function_arguments(payload: &ToolPayload) -> Result<&str, ToolError> {
    match payload {
        ToolPayload::Function { arguments } => Ok(arguments),
        _ => Err(ToolError::InvalidCall(
            "collaboration tools require function arguments".into(),
        )),
    }
}

fn parse_arguments<T: for<'de> Deserialize<'de>>(arguments: &str) -> Result<T, ToolError> {
    serde_json::from_str(arguments)
        .map_err(|error| ToolError::InvalidCall(format!("invalid arguments: {error}")))
}

fn collab_metadata(
    tool: &str,
    invocation: &ToolInvocation,
    receiver: Option<&AgentRecord>,
    prompt: Option<String>,
    activity: Option<&str>,
    previous_status: Option<AgentStatus>,
) -> Value {
    let mut metadata = collab_metadata_raw(
        tool,
        invocation,
        receiver
            .map(|agent| vec![agent.thread_id.clone()])
            .unwrap_or_default(),
        receiver
            .map(|agent| {
                vec![json!({
                    "threadId":agent.thread_id,
                    "agentNickname":agent.nickname,
                    "agentRole":agent.role
                })]
            })
            .unwrap_or_default(),
        prompt,
        activity.map(|kind| {
            json!({
                "kind":kind,
                "agentThreadId":receiver.map(|agent| agent.thread_id.clone()),
                "agentPath":receiver.map(|agent| agent.agent_path.clone()),
                "previousStatus":previous_status
            })
        }),
    );
    if let Some(receiver) = receiver {
        metadata["codexCollaboration"]["agentsStates"] =
            Value::Object(serde_json::Map::from_iter([(
                receiver.thread_id.clone(),
                serde_json::to_value(&receiver.status).unwrap_or(Value::Null),
            )]));
    }
    metadata
}

fn collab_metadata_raw(
    tool: &str,
    invocation: &ToolInvocation,
    receiver_thread_ids: Vec<String>,
    receiver_agents: Vec<Value>,
    prompt: Option<String>,
    activity: Option<Value>,
) -> Value {
    json!({
        "codexCollaboration":{
            "tool":tool,
            "senderThreadId":invocation.thread_id,
            "receiverThreadIds":receiver_thread_ids,
            "receiverAgents":receiver_agents,
            "prompt":prompt,
            "activity":activity
        }
    })
}

fn validate_thread_id(thread_id: &str) -> Result<(), CollaborationError> {
    Uuid::parse_str(thread_id)
        .map(|_| ())
        .map_err(|_| CollaborationError::Invalid(format!("invalid thread id: {thread_id}")))
}

fn validate_agent_name(name: &str) -> Result<(), CollaborationError> {
    if name.is_empty() {
        return Err(CollaborationError::Invalid(
            "agent_name must not be empty".into(),
        ));
    }
    if matches!(name, "root" | "." | "..") {
        return Err(CollaborationError::Invalid(format!(
            "agent_name `{name}` is reserved"
        )));
    }
    if !name.chars().all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
    }) {
        return Err(CollaborationError::Invalid(
            "agent_name must use only lowercase letters, digits, and underscores".into(),
        ));
    }
    Ok(())
}

fn resolve_path(author: &str, target: &str) -> Result<String, CollaborationError> {
    if target.is_empty() {
        return Err(CollaborationError::Invalid(
            "agent path must not be empty".into(),
        ));
    }
    if target == ROOT_AGENT_PATH {
        return Ok(target.into());
    }
    let path = if target.starts_with('/') {
        target.into()
    } else {
        format!("{author}/{target}")
    };
    let Some(segments) = path.strip_prefix("/root") else {
        return Err(CollaborationError::Invalid(
            "absolute agent paths must start with `/root`".into(),
        ));
    };
    if segments.ends_with('/') {
        return Err(CollaborationError::Invalid(
            "agent path must not end with `/`".into(),
        ));
    }
    for segment in segments.split('/').filter(|segment| !segment.is_empty()) {
        validate_agent_name(segment)?;
    }
    Ok(path)
}

fn path_key(root_thread_id: &str, path: &str) -> String {
    format!("{root_thread_id}\0{path}")
}

fn default_max_concurrent_threads() -> usize {
    DEFAULT_MAX_CONCURRENT_THREADS
}

fn default_max_depth() -> usize {
    DEFAULT_MAX_DEPTH
}

fn io_error(error: std::io::Error) -> CollaborationError {
    CollaborationError::Io(error.to_string())
}

fn tool_error(error: CollaborationError) -> ToolError {
    match error {
        CollaborationError::Invalid(message)
        | CollaborationError::NotFound(message)
        | CollaborationError::Capacity(message)
        | CollaborationError::Conflict(message) => ToolError::InvalidCall(message),
        CollaborationError::Io(message) | CollaborationError::Host(message) => {
            ToolError::Handler(message)
        }
    }
}

fn agent_status_tool_value(status: &AgentStatus) -> Value {
    match status.status {
        AgentStatusKind::PendingInit => json!("pending_init"),
        AgentStatusKind::Running => json!("running"),
        AgentStatusKind::Interrupted => json!("interrupted"),
        AgentStatusKind::Completed => json!({"completed":status.message}),
        AgentStatusKind::Errored => {
            json!({"errored":status.message.clone().unwrap_or_else(|| "unknown error".into())})
        }
        AgentStatusKind::Shutdown => json!("shutdown"),
        AgentStatusKind::NotFound => json!("not_found"),
    }
}

fn agent_status_schema() -> Value {
    json!({
        "oneOf":[
            {"type":"string","enum":["pending_init","running","interrupted","shutdown","not_found"]},
            {
                "type":"object",
                "properties":{"completed":{"type":["string","null"]}},
                "required":["completed"],
                "additionalProperties":false
            },
            {
                "type":"object",
                "properties":{"errored":{"type":"string"}},
                "required":["errored"],
                "additionalProperties":false
            }
        ]
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    struct NoopHost;

    impl CollaborationHost for NoopHost {
        fn spawn<'a>(
            &'a self,
            _request: SpawnRequest,
        ) -> HostFuture<'a, Result<SpawnedAgent, CollaborationError>> {
            Box::pin(async {
                Ok(SpawnedAgent {
                    thread_id: Uuid::now_v7().to_string(),
                    nickname: None,
                    effective_model: None,
                    effective_reasoning_effort: None,
                    effective_service_tier: None,
                })
            })
        }

        fn deliver<'a>(
            &'a self,
            _target_thread_id: &'a str,
            _message: MailboxMessage,
        ) -> HostFuture<'a, Result<(), CollaborationError>> {
            Box::pin(async { Ok(()) })
        }

        fn start<'a>(
            &'a self,
            _target_thread_id: &'a str,
            _message: &'a str,
            _model: Option<String>,
            _reasoning_effort: Option<String>,
            _service_tier: Option<String>,
        ) -> HostFuture<'a, Result<(), CollaborationError>> {
            Box::pin(async { Ok(()) })
        }

        fn interrupt<'a>(
            &'a self,
            _target_thread_id: &'a str,
        ) -> HostFuture<'a, Result<(), CollaborationError>> {
            Box::pin(async { Ok(()) })
        }
    }

    fn root(runtime: &CollaborationRuntime) -> String {
        let id = Uuid::now_v7().to_string();
        runtime.register_root(&id).expect("root");
        id
    }

    #[test]
    fn canonical_paths_and_limits_match_v2() {
        let runtime = CollaborationRuntime::memory(CollaborationConfig {
            max_concurrent_threads: 2,
            max_depth: 1,
        });
        let root = root(&runtime);
        let reservation = runtime.reserve_spawn(&root, "worker_1").expect("reserve");
        assert_eq!(reservation.path, "/root/worker_1");
        let child = Uuid::now_v7().to_string();
        runtime
            .commit_spawn(
                reservation,
                SpawnedAgent {
                    thread_id: child.clone(),
                    nickname: None,
                    effective_model: None,
                    effective_reasoning_effort: None,
                    effective_service_tier: None,
                },
                None,
            )
            .expect("commit");
        assert!(matches!(
            runtime.reserve_spawn(&root, "worker_2"),
            Err(CollaborationError::Capacity(_))
        ));
        assert!(matches!(
            runtime.reserve_spawn(&child, "nested"),
            Err(CollaborationError::Capacity(_))
        ));
        assert!(matches!(
            runtime.reserve_spawn(&root, "BadName"),
            Err(CollaborationError::Invalid(_))
        ));
    }

    #[tokio::test]
    async fn mailbox_wait_and_persistence_survive_restart() {
        let temp = tempfile::tempdir().expect("temp");
        let runtime =
            CollaborationRuntime::open(temp.path(), CollaborationConfig::default()).expect("open");
        let root = root(&runtime);
        let reservation = runtime.reserve_spawn(&root, "worker").expect("reserve");
        let child = Uuid::now_v7().to_string();
        runtime
            .commit_spawn(
                reservation,
                SpawnedAgent {
                    thread_id: child.clone(),
                    nickname: Some("Worker".into()),
                    effective_model: None,
                    effective_reasoning_effort: None,
                    effective_service_tier: None,
                },
                Some("default".into()),
            )
            .expect("commit");
        let wait_root = root.clone();
        let waiter = {
            let runtime = runtime.clone();
            tokio::spawn(async move {
                runtime
                    .wait(
                        &wait_root,
                        MIN_WAIT_TIMEOUT_MS,
                        CancellationToken::new(),
                        CancellationToken::new(),
                    )
                    .await
            })
        };
        tokio::task::yield_now().await;
        runtime
            .record_message(&child, &root, "done", false)
            .expect("message");
        assert!(matches!(
            waiter.await.expect("join").expect("wait"),
            WaitOutcome::Mailbox(_)
        ));
        drop(runtime);

        let reopened = CollaborationRuntime::open(temp.path(), CollaborationConfig::default())
            .expect("reopen");
        assert_eq!(
            reopened
                .resolve(&root, "worker")
                .expect("resolve")
                .thread_id,
            child
        );
        assert_eq!(reopened.drain_mailbox(&root).expect("mailbox").len(), 1);
    }

    #[test]
    fn fork_turns_parser_rejects_legacy_and_zero() {
        assert_eq!(ForkTurns::parse(None).expect("default"), ForkTurns::All);
        assert_eq!(
            ForkTurns::parse(Some("none")).expect("none"),
            ForkTurns::None
        );
        assert_eq!(
            ForkTurns::parse(Some("3")).expect("last"),
            ForkTurns::Last(3)
        );
        assert!(ForkTurns::parse(Some("0")).is_err());
        assert!(ForkTurns::parse(Some("invalid")).is_err());
    }

    #[tokio::test]
    async fn handlers_expose_six_v2_tools() {
        let runtime = CollaborationRuntime::default();
        let root = root(&runtime);
        let tools = CollaborationTools::new(runtime, Arc::new(NoopHost));
        let handlers = tools.handlers();
        let names = handlers
            .iter()
            .map(|handler| handler.tool_name().name)
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "spawn_agent",
                "send_message",
                "followup_task",
                "wait_agent",
                "interrupt_agent",
                "list_agents"
            ]
        );
        let output = handlers[0]
            .handle(ToolInvocation {
                thread_id: root,
                turn_id: Uuid::now_v7().to_string(),
                call: tietiezhi_agent_tools::ToolCall {
                    tool_name: ToolName::plain("spawn_agent"),
                    call_id: "call_spawn".into(),
                    payload: ToolPayload::Function {
                        arguments:
                            r#"{"message":"inspect","task_name":"worker","fork_turns":"none"}"#
                                .into(),
                    },
                },
                cancellation: CancellationToken::new(),
                input_activity: CancellationToken::new(),
            })
            .await
            .expect("spawn");
        assert_eq!(output.content, json!({"task_name":"/root/worker"}));
        assert_eq!(
            output
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.pointer("/codexCollaboration/tool")),
            Some(&json!("spawnAgent"))
        );
    }
}
