//! Durable local state for the source-level Codex runtime.
//!
//! SQLite is a rebuildable metadata index. Append-only JSONL rollouts are the
//! authoritative execution history and tolerate an incomplete final write.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::NamedTempFile;

const SCHEMA_VERSION: i64 = 3;
const MIGRATION_1: &str = r#"
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    applied_at_ms INTEGER NOT NULL
);

CREATE TABLE threads (
    id TEXT PRIMARY KEY NOT NULL,
    rollout_path TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    title TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    task_mode TEXT NOT NULL DEFAULT 'code',
    archived_at_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_threads_updated_at
    ON threads(archived_at_ms, updated_at_ms DESC, id DESC);
CREATE INDEX idx_threads_project
    ON threads(project_id, task_mode, updated_at_ms DESC);
"#;
const MIGRATION_2: &str = r#"
ALTER TABLE threads ADD COLUMN pinned_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN preview TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN last_complete_ordinal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN recovery_status TEXT NOT NULL DEFAULT 'clean';

CREATE INDEX idx_threads_visible
    ON threads(archived_at_ms, pinned_at_ms DESC, updated_at_ms DESC, id DESC);
"#;
const MIGRATION_3: &str = r#"
ALTER TABLE threads ADD COLUMN canonical_json TEXT NOT NULL DEFAULT '';
"#;

#[derive(Debug)]
pub enum StateError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    Invalid(String),
    Corrupt(String),
}

impl fmt::Display for StateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Sqlite(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
            Self::Invalid(message) | Self::Corrupt(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for StateError {}

impl From<std::io::Error> for StateError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for StateError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<serde_json::Error> for StateError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub type StateResult<T> = Result<T, StateError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadMetadata {
    pub id: String,
    pub rollout_path: PathBuf,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub title: String,
    pub project_id: String,
    pub task_mode: String,
    pub archived_at_ms: u64,
    pub pinned_at_ms: u64,
    pub agent_id: String,
    pub preview: String,
    pub revision: u64,
    pub last_complete_ordinal: u64,
    pub recovery_status: String,
    /// Canonical App Server thread metadata owned by `agent-core`.
    ///
    /// This is an index cache. Rollout session metadata and response items
    /// remain the durable history used to rebuild it.
    pub canonical: Option<Value>,
}

impl ThreadMetadata {
    pub fn validate(&self) -> StateResult<()> {
        if self.id.trim().is_empty() {
            return Err(StateError::Invalid("thread id must not be empty".into()));
        }
        if self.rollout_path.as_os_str().is_empty() {
            return Err(StateError::Invalid("rollout path must not be empty".into()));
        }
        if self.task_mode != "work" && self.task_mode != "code" {
            return Err(StateError::Invalid(format!(
                "invalid task mode: {}",
                self.task_mode
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct PersistedCheckpoint {
    pub ordinal: u64,
    pub revision: u64,
}

#[derive(Debug, Clone)]
pub struct RecoveredCheckpoint {
    pub thread_id: String,
    pub updated_at_ms: u64,
    pub revision: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, Default)]
pub struct RolloutRecovery {
    pub session_thread_id: Option<String>,
    pub session_meta: Option<Value>,
    pub session_created_at_ms: Option<u64>,
    pub checkpoint: Option<RecoveredCheckpoint>,
    pub trailing_events: Vec<Value>,
    pub response_items: Vec<Value>,
    /// Canonical rollout items in append order.
    ///
    /// Unlike the compatibility projections above, this preserves the
    /// `turn_context` / `response_item` / `event_msg` ordering required to
    /// rebuild Codex Turn and Item state without consulting SQLite.
    pub rollout_items: Vec<RecoveredRolloutItem>,
    pub last_ordinal: u64,
    pub truncated_bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecoveredRolloutItem {
    pub timestamp_ms: u64,
    pub ordinal: u64,
    pub item: RecoveredRolloutItemKind,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RecoveredRolloutItemKind {
    SessionMeta(Value),
    TurnContext(Value),
    ResponseItem(Value),
    EventMsg(Value),
}

#[derive(Debug, Clone)]
pub struct StateStore {
    root: PathBuf,
    database_path: PathBuf,
}

impl StateStore {
    pub fn open(root: impl AsRef<Path>) -> StateResult<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)?;
        let store = Self {
            database_path: root.join("state.sqlite3"),
            root,
        };
        if let Err(error) = store.initialize_database() {
            if !is_corruption_error(&error) {
                return Err(error);
            }
            store.backup_corrupt_database()?;
            store.initialize_database()?;
        }
        Ok(store)
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn upsert_checkpoint(
        &self,
        mut metadata: ThreadMetadata,
        payload: &Value,
    ) -> StateResult<PersistedCheckpoint> {
        metadata.validate()?;
        let appender = RolloutAppender::open(&metadata.rollout_path)?;
        let indexed_revision = self
            .thread(&metadata.id)?
            .map_or(0, |current| current.revision);
        let revision = indexed_revision
            .max(appender.last_checkpoint_revision()?)
            .saturating_add(1);
        appender.ensure_session_meta(
            &metadata.id,
            metadata.created_at_ms,
            metadata.rollout_path.as_path(),
        )?;
        let ordinal =
            appender.append_checkpoint(&metadata.id, metadata.updated_at_ms, revision, payload)?;
        appender.sync_data()?;

        metadata.revision = revision;
        metadata.last_complete_ordinal = ordinal;
        metadata.recovery_status = "clean".into();
        self.upsert_metadata(&metadata)?;
        Ok(PersistedCheckpoint { ordinal, revision })
    }

    pub fn upsert_metadata(&self, metadata: &ThreadMetadata) -> StateResult<()> {
        metadata.validate()?;
        let canonical_json = metadata
            .canonical
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?
            .unwrap_or_default();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            r#"
INSERT INTO threads (
    id, rollout_path, created_at_ms, updated_at_ms, title, project_id,
    task_mode, archived_at_ms, pinned_at_ms, agent_id, preview, revision,
    last_complete_ordinal, recovery_status, canonical_json
) VALUES (
    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
)
ON CONFLICT(id) DO UPDATE SET
    rollout_path = excluded.rollout_path,
    created_at_ms = excluded.created_at_ms,
    updated_at_ms = excluded.updated_at_ms,
    title = excluded.title,
    project_id = excluded.project_id,
    task_mode = excluded.task_mode,
    archived_at_ms = excluded.archived_at_ms,
    pinned_at_ms = excluded.pinned_at_ms,
    agent_id = excluded.agent_id,
    preview = excluded.preview,
    revision = excluded.revision,
    last_complete_ordinal = excluded.last_complete_ordinal,
    recovery_status = excluded.recovery_status,
    canonical_json = excluded.canonical_json
"#,
            params![
                metadata.id,
                path_to_string(&metadata.rollout_path)?,
                to_i64(metadata.created_at_ms, "created_at_ms")?,
                to_i64(metadata.updated_at_ms, "updated_at_ms")?,
                metadata.title,
                metadata.project_id,
                metadata.task_mode,
                to_i64(metadata.archived_at_ms, "archived_at_ms")?,
                to_i64(metadata.pinned_at_ms, "pinned_at_ms")?,
                metadata.agent_id,
                metadata.preview,
                to_i64(metadata.revision, "revision")?,
                to_i64(metadata.last_complete_ordinal, "last_complete_ordinal")?,
                metadata.recovery_status,
                canonical_json,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn thread(&self, id: &str) -> StateResult<Option<ThreadMetadata>> {
        let connection = self.connection()?;
        connection
            .query_row(
                &format!("SELECT {} FROM threads WHERE id = ?1", thread_columns()),
                [id],
                row_to_metadata,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_threads(&self, archived: bool) -> StateResult<Vec<ThreadMetadata>> {
        let connection = self.connection()?;
        let comparison = if archived { "<> 0" } else { "= 0" };
        let ordering = if archived {
            "archived_at_ms DESC, id DESC"
        } else {
            "pinned_at_ms DESC, updated_at_ms DESC, id DESC"
        };
        let mut statement = connection.prepare(&format!(
            "SELECT {} FROM threads WHERE archived_at_ms {comparison} ORDER BY {ordering}",
            thread_columns()
        ))?;
        let rows = statement.query_map([], row_to_metadata)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn delete_thread(&self, id: &str) -> StateResult<()> {
        let connection = self.connection()?;
        connection.execute("DELETE FROM threads WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn rollout_appender(&self, path: impl AsRef<Path>) -> StateResult<RolloutAppender> {
        RolloutAppender::open(path)
    }

    pub fn recover_rollout(&self, path: impl AsRef<Path>) -> StateResult<RolloutRecovery> {
        recover_rollout(path.as_ref())
    }

    fn initialize_database(&self) -> StateResult<()> {
        let mut connection = Connection::open(&self.database_path)?;
        configure_connection(&connection)?;
        apply_migrations(&mut connection)?;
        let integrity: String =
            connection.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(StateError::Corrupt(format!(
                "SQLite quick_check failed: {integrity}"
            )));
        }
        Ok(())
    }

    fn connection(&self) -> StateResult<Connection> {
        let connection = Connection::open(&self.database_path)?;
        configure_connection(&connection)?;
        Ok(connection)
    }

    fn backup_corrupt_database(&self) -> StateResult<()> {
        let backup_root = self.root.join("db-backups");
        fs::create_dir_all(&backup_root)?;
        let now = now_ms();
        let mut sequence = 0_u32;
        let backup_dir = loop {
            let path = backup_root.join(format!("sqlite-{now}-{sequence}"));
            match fs::create_dir(&path) {
                Ok(()) => break path,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    sequence = sequence.saturating_add(1);
                }
                Err(error) => return Err(error.into()),
            }
        };
        let mut moved = false;
        for source in sqlite_paths(&self.database_path) {
            if source.exists() {
                let name = source.file_name().ok_or_else(|| {
                    StateError::Invalid(format!("invalid database path: {}", source.display()))
                })?;
                fs::rename(&source, backup_dir.join(name))?;
                moved = true;
            }
        }
        if !moved {
            let _ = fs::remove_dir(&backup_dir);
        }
        Ok(())
    }
}

fn configure_connection(connection: &Connection) -> StateResult<()> {
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    )?;
    Ok(())
}

fn apply_migrations(connection: &mut Connection) -> StateResult<()> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(StateError::Invalid(format!(
            "database schema {version} is newer than supported {SCHEMA_VERSION}"
        )));
    }
    for next_version in (version + 1)..=SCHEMA_VERSION {
        let transaction = connection.transaction()?;
        let sql = match next_version {
            1 => MIGRATION_1,
            2 => MIGRATION_2,
            3 => MIGRATION_3,
            _ => unreachable!(),
        };
        transaction.execute_batch(sql)?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, applied_at_ms) VALUES (?1, ?2)",
            params![next_version, to_i64(now_ms(), "applied_at_ms")?],
        )?;
        transaction.pragma_update(None, "user_version", next_version)?;
        transaction.commit()?;
    }
    Ok(())
}

fn thread_columns() -> &'static str {
    "id, rollout_path, created_at_ms, updated_at_ms, title, project_id, \
     task_mode, archived_at_ms, pinned_at_ms, agent_id, preview, revision, \
     last_complete_ordinal, recovery_status, canonical_json"
}

fn row_to_metadata(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadMetadata> {
    let canonical_json: String = row.get(14)?;
    let canonical = if canonical_json.is_empty() {
        None
    } else {
        Some(serde_json::from_str(&canonical_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                14,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?)
    };
    Ok(ThreadMetadata {
        id: row.get(0)?,
        rollout_path: PathBuf::from(row.get::<_, String>(1)?),
        created_at_ms: from_i64(row.get(2)?, 2)?,
        updated_at_ms: from_i64(row.get(3)?, 3)?,
        title: row.get(4)?,
        project_id: row.get(5)?,
        task_mode: row.get(6)?,
        archived_at_ms: from_i64(row.get(7)?, 7)?,
        pinned_at_ms: from_i64(row.get(8)?, 8)?,
        agent_id: row.get(9)?,
        preview: row.get(10)?,
        revision: from_i64(row.get(11)?, 11)?,
        last_complete_ordinal: from_i64(row.get(12)?, 12)?,
        recovery_status: row.get(13)?,
        canonical,
    })
}

fn from_i64(value: i64, column: usize) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn to_i64(value: u64, field: &str) -> StateResult<i64> {
    i64::try_from(value)
        .map_err(|_| StateError::Invalid(format!("{field} exceeds SQLite integer range")))
}

fn path_to_string(path: &Path) -> StateResult<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| StateError::Invalid(format!("path is not UTF-8: {}", path.display())))
}

fn is_corruption_error(error: &StateError) -> bool {
    match error {
        StateError::Corrupt(_) => true,
        StateError::Sqlite(error) => {
            let detail = error.to_string().to_ascii_lowercase();
            detail.contains("not a database")
                || detail.contains("database disk image is malformed")
                || detail.contains("database schema is malformed")
                || detail.contains("database is corrupt")
        }
        _ => false,
    }
}

fn sqlite_paths(database_path: &Path) -> Vec<PathBuf> {
    ["", "-wal", "-shm"]
        .into_iter()
        .map(|suffix| {
            let mut path = database_path.as_os_str().to_os_string();
            path.push(suffix);
            PathBuf::from(path)
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
enum RolloutItem {
    SessionMeta(Value),
    TurnContext(Value),
    ResponseItem(Value),
    LegacyCheckpoint(LegacyCheckpoint),
    EventMsg(Value),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    thread_id: String,
    created_at_ms: u64,
    rollout_path: String,
    originator: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCheckpoint {
    thread_id: String,
    updated_at_ms: u64,
    revision: u64,
    conversation: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RolloutLine {
    timestamp_ms: u64,
    ordinal: u64,
    #[serde(flatten)]
    item: RolloutItem,
}

#[derive(Debug)]
struct RolloutWriter {
    file: File,
    next_ordinal: u64,
    session_thread_id: Option<String>,
    last_checkpoint_revision: u64,
}

impl RolloutWriter {
    fn open(path: &Path) -> StateResult<Self> {
        let recovery = recover_rollout(path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)?;
        let session_thread_id = recovery.session_thread_id;
        let last_checkpoint_revision = recovery
            .checkpoint
            .as_ref()
            .map_or(0, |checkpoint| checkpoint.revision);
        Ok(Self {
            file,
            next_ordinal: recovery.last_ordinal.saturating_add(1).max(1),
            session_thread_id,
            last_checkpoint_revision,
        })
    }

    fn append(&mut self, item: RolloutItem) -> StateResult<u64> {
        let ordinal = self.next_ordinal;
        let line = RolloutLine {
            timestamp_ms: now_ms(),
            ordinal,
            item,
        };
        serde_json::to_writer(&mut self.file, &line)?;
        self.file.write_all(b"\n")?;
        self.file.flush()?;
        self.next_ordinal = self.next_ordinal.saturating_add(1);
        Ok(ordinal)
    }
}

fn appender_registry() -> &'static Mutex<HashMap<PathBuf, Weak<Mutex<RolloutWriter>>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<RolloutWriter>>>>> =
        OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone)]
pub struct RolloutAppender {
    path: PathBuf,
    writer: Arc<Mutex<RolloutWriter>>,
}

impl RolloutAppender {
    pub fn open(path: impl AsRef<Path>) -> StateResult<Self> {
        let path = path.as_ref().to_path_buf();
        let mut registry = appender_registry()
            .lock()
            .map_err(|_| StateError::Invalid("rollout registry lock is poisoned".into()))?;
        if let Some(writer) = registry.get(&path).and_then(Weak::upgrade) {
            return Ok(Self { path, writer });
        }
        let writer = Arc::new(Mutex::new(RolloutWriter::open(&path)?));
        registry.insert(path.clone(), Arc::downgrade(&writer));
        Ok(Self { path, writer })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn ensure_session_meta(
        &self,
        thread_id: &str,
        created_at_ms: u64,
        rollout_path: &Path,
    ) -> StateResult<()> {
        let mut writer = self.writer()?;
        if let Some(existing) = &writer.session_thread_id {
            if existing == thread_id {
                return Ok(());
            }
            return Err(StateError::Invalid(format!(
                "rollout belongs to thread {existing}, not {thread_id}"
            )));
        }
        let meta = serde_json::to_value(SessionMeta {
            thread_id: thread_id.into(),
            created_at_ms,
            rollout_path: path_to_string(rollout_path)?,
            originator: "tietiezhi-desktop".into(),
        })?;
        writer.append(RolloutItem::SessionMeta(meta))?;
        writer.session_thread_id = Some(thread_id.into());
        Ok(())
    }

    pub fn ensure_canonical_session_meta(&self, thread_id: &str, meta: Value) -> StateResult<()> {
        let meta_thread_id = session_meta_thread_id(&meta)
            .ok_or_else(|| StateError::Invalid("session_meta id is required".into()))?;
        if meta_thread_id != thread_id {
            return Err(StateError::Invalid(format!(
                "session_meta belongs to thread {meta_thread_id}, not {thread_id}"
            )));
        }
        let mut writer = self.writer()?;
        if let Some(existing) = &writer.session_thread_id {
            if existing == thread_id {
                return Ok(());
            }
            return Err(StateError::Invalid(format!(
                "rollout belongs to thread {existing}, not {thread_id}"
            )));
        }
        writer.append(RolloutItem::SessionMeta(meta))?;
        writer.session_thread_id = Some(thread_id.into());
        Ok(())
    }

    pub fn append_event(&self, event: Value) -> StateResult<u64> {
        self.writer()?.append(RolloutItem::EventMsg(event))
    }

    pub fn append_turn_context(&self, context: Value) -> StateResult<u64> {
        self.writer()?.append(RolloutItem::TurnContext(context))
    }

    pub fn append_response_item(&self, item: Value) -> StateResult<u64> {
        self.writer()?.append(RolloutItem::ResponseItem(item))
    }

    pub fn append_checkpoint(
        &self,
        thread_id: &str,
        updated_at_ms: u64,
        revision: u64,
        payload: &Value,
    ) -> StateResult<u64> {
        let mut writer = self.writer()?;
        let ordinal = writer.append(RolloutItem::LegacyCheckpoint(LegacyCheckpoint {
            thread_id: thread_id.into(),
            updated_at_ms,
            revision,
            conversation: payload.clone(),
        }))?;
        writer.last_checkpoint_revision = revision;
        Ok(ordinal)
    }

    pub fn last_checkpoint_revision(&self) -> StateResult<u64> {
        Ok(self.writer()?.last_checkpoint_revision)
    }

    pub fn sync_data(&self) -> StateResult<()> {
        self.writer()?.file.sync_data()?;
        Ok(())
    }

    fn writer(&self) -> StateResult<std::sync::MutexGuard<'_, RolloutWriter>> {
        self.writer
            .lock()
            .map_err(|_| StateError::Invalid("rollout writer lock is poisoned".into()))
    }
}

fn recover_rollout(path: &Path) -> StateResult<RolloutRecovery> {
    let file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RolloutRecovery::default());
        }
        Err(error) => return Err(error.into()),
    };
    let original_len = file.metadata()?.len();
    let mut reader = BufReader::new(file);
    let mut valid_offset = 0_u64;
    let mut recovery = RolloutRecovery::default();
    let mut events_since_checkpoint = Vec::new();

    loop {
        let mut bytes = Vec::new();
        let read = reader.read_until(b'\n', &mut bytes)?;
        if read == 0 {
            break;
        }
        if bytes.last() != Some(&b'\n') {
            break;
        }
        let line = match serde_json::from_slice::<RolloutLine>(&bytes) {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.ordinal == 0 || line.ordinal <= recovery.last_ordinal {
            break;
        }
        valid_offset = valid_offset.saturating_add(read as u64);
        recovery.last_ordinal = line.ordinal;
        let recovered_item = match &line.item {
            RolloutItem::SessionMeta(meta) => {
                Some(RecoveredRolloutItemKind::SessionMeta(meta.clone()))
            }
            RolloutItem::TurnContext(context) => {
                Some(RecoveredRolloutItemKind::TurnContext(context.clone()))
            }
            RolloutItem::ResponseItem(item) => {
                Some(RecoveredRolloutItemKind::ResponseItem(item.clone()))
            }
            RolloutItem::EventMsg(event) => Some(RecoveredRolloutItemKind::EventMsg(event.clone())),
            RolloutItem::LegacyCheckpoint(_) => None,
        };
        if let Some(item) = recovered_item {
            recovery.rollout_items.push(RecoveredRolloutItem {
                timestamp_ms: line.timestamp_ms,
                ordinal: line.ordinal,
                item,
            });
        }
        match line.item {
            RolloutItem::LegacyCheckpoint(checkpoint) => {
                recovery.checkpoint = Some(RecoveredCheckpoint {
                    thread_id: checkpoint.thread_id,
                    updated_at_ms: checkpoint.updated_at_ms,
                    revision: checkpoint.revision,
                    payload: checkpoint.conversation,
                });
                events_since_checkpoint.clear();
            }
            RolloutItem::EventMsg(event) => events_since_checkpoint.push(event),
            RolloutItem::ResponseItem(item) => recovery.response_items.push(item),
            RolloutItem::TurnContext(_) => {}
            RolloutItem::SessionMeta(meta) => {
                if recovery.session_thread_id.is_none() {
                    recovery.session_thread_id = session_meta_thread_id(&meta).map(str::to_owned);
                    recovery.session_created_at_ms = Some(line.timestamp_ms);
                    recovery.session_meta = Some(meta);
                }
            }
        }
    }

    recovery.trailing_events = events_since_checkpoint;
    if valid_offset < original_len {
        let mut file = reader.into_inner();
        file.set_len(valid_offset)?;
        file.seek(SeekFrom::Start(valid_offset))?;
        file.sync_data()?;
        recovery.truncated_bytes = original_len - valid_offset;
    }
    Ok(recovery)
}

fn session_meta_thread_id(meta: &Value) -> Option<&str> {
    meta.get("id")
        .or_else(|| meta.get("threadId"))
        .or_else(|| meta.get("thread_id"))
        .and_then(Value::as_str)
}

pub fn atomic_write(path: impl AsRef<Path>, bytes: &[u8]) -> StateResult<()> {
    let path = path.as_ref();
    let parent = path
        .parent()
        .ok_or_else(|| StateError::Invalid(format!("path has no parent: {}", path.display())))?;
    fs::create_dir_all(parent)?;
    let mut temp = NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file_mut().sync_all()?;
    temp.persist(path)
        .map_err(|error| StateError::Io(error.error))?;
    sync_parent(parent)?;
    Ok(())
}

fn sync_parent(parent: &Path) -> StateResult<()> {
    #[cfg(unix)]
    {
        File::open(parent)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = parent;
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn metadata(root: &Path, id: &str) -> ThreadMetadata {
        ThreadMetadata {
            id: id.into(),
            rollout_path: root.join("tasks").join(id).join("rollout.jsonl"),
            created_at_ms: 100,
            updated_at_ms: 200,
            title: "test".into(),
            project_id: String::new(),
            task_mode: "code".into(),
            archived_at_ms: 0,
            pinned_at_ms: 0,
            agent_id: String::new(),
            preview: "hello".into(),
            revision: 0,
            last_complete_ordinal: 0,
            recovery_status: "clean".into(),
            canonical: None,
        }
    }

    #[test]
    fn migrates_v1_database_without_losing_thread_metadata() {
        let temp = TempDir::new().unwrap();
        let db = temp.path().join("state.sqlite3");
        let connection = Connection::open(&db).unwrap();
        connection.execute_batch(MIGRATION_1).unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations(version, applied_at_ms) VALUES (1, 1)",
                [],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
        connection
            .execute(
                r#"INSERT INTO threads (
                    id, rollout_path, created_at_ms, updated_at_ms, title,
                    project_id, task_mode, archived_at_ms
                ) VALUES (?1, ?2, 1, 2, 'legacy', '', 'code', 0)"#,
                params![
                    "thread-1",
                    temp.path().join("rollout.jsonl").display().to_string()
                ],
            )
            .unwrap();
        drop(connection);

        let store = StateStore::open(temp.path()).unwrap();
        let thread = store.thread("thread-1").unwrap().unwrap();
        assert_eq!(thread.title, "legacy");
        assert_eq!(thread.pinned_at_ms, 0);
        assert_eq!(thread.revision, 0);
        assert_eq!(thread.canonical, None);
        let connection = Connection::open(store.database_path()).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn migrates_v2_index_and_roundtrips_canonical_metadata() {
        let temp = TempDir::new().unwrap();
        let db = temp.path().join("state.sqlite3");
        let connection = Connection::open(&db).unwrap();
        connection.execute_batch(MIGRATION_1).unwrap();
        connection.execute_batch(MIGRATION_2).unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations(version, applied_at_ms) VALUES (1, 1), (2, 2)",
                [],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();
        connection
            .execute(
                r#"INSERT INTO threads (
                    id, rollout_path, created_at_ms, updated_at_ms, title,
                    project_id, task_mode, archived_at_ms, pinned_at_ms,
                    agent_id, preview, revision, last_complete_ordinal,
                    recovery_status
                ) VALUES (?1, ?2, 1, 2, 'v2', '', 'code', 0, 0, '', '', 0, 0, 'clean')"#,
                params![
                    "thread-v2",
                    temp.path().join("rollout.jsonl").display().to_string()
                ],
            )
            .unwrap();
        drop(connection);

        let store = StateStore::open(temp.path()).unwrap();
        let mut thread = store.thread("thread-v2").unwrap().unwrap();
        assert_eq!(thread.canonical, None);
        thread.canonical = Some(json!({"sessionId": "session-1"}));
        store.upsert_metadata(&thread).unwrap();
        assert_eq!(
            store.thread("thread-v2").unwrap().unwrap().canonical,
            Some(json!({"sessionId": "session-1"}))
        );
    }

    #[test]
    fn checkpoint_and_trailing_events_recover_after_partial_final_line() {
        let temp = TempDir::new().unwrap();
        let store = StateStore::open(temp.path().join("runtime")).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut thread = metadata(temp.path(), &id);
        let checkpoint = json!({"id": id, "messages": [{"content": "hello"}]});
        let persisted = store
            .upsert_checkpoint(thread.clone(), &checkpoint)
            .unwrap();
        assert_eq!(persisted.revision, 1);

        let appender = store.rollout_appender(&thread.rollout_path).unwrap();
        appender
            .append_event(json!({
                "type": "delta",
                "threadId": thread.id,
                "turnId": "turn-1",
                "itemId": "item-1",
                "sequence": 1,
                "emittedAtMs": 300,
                "content": " world"
            }))
            .unwrap();
        drop(appender);
        {
            let mut file = OpenOptions::new()
                .append(true)
                .open(&thread.rollout_path)
                .unwrap();
            file.write_all(br#"{"timestampMs":400,"ordinal":"#).unwrap();
            file.flush().unwrap();
        }

        let recovered = store.recover_rollout(&thread.rollout_path).unwrap();
        assert_eq!(recovered.checkpoint.unwrap().payload, checkpoint);
        assert_eq!(recovered.trailing_events.len(), 1);
        assert!(recovered.truncated_bytes > 0);

        store.delete_thread(&thread.id).unwrap();
        thread.updated_at_ms = 400;
        let second = store.upsert_checkpoint(thread, &json!({"id": id})).unwrap();
        assert_eq!(second.revision, 2);
        assert!(second.ordinal > persisted.ordinal);
    }

    #[test]
    fn canonical_rollout_items_preserve_turn_order_and_r5_streams_remain_readable() {
        let temp = TempDir::new().unwrap();
        let store = StateStore::open(temp.path().join("runtime")).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let path = temp.path().join("threads").join(&id).join("rollout.jsonl");
        let appender = store.rollout_appender(&path).unwrap();
        appender
            .ensure_canonical_session_meta(
                &id,
                json!({
                    "id": id,
                    "session_id": id,
                    "cli_version": "test"
                }),
            )
            .unwrap();
        appender
            .append_turn_context(json!({"turn_id": "turn-1", "model": "gpt-test"}))
            .unwrap();
        appender
            .append_response_item(json!({"type": "message", "role": "user", "content": []}))
            .unwrap();
        appender
            .append_event(json!({"type": "task_started", "turn_id": "turn-1"}))
            .unwrap();
        appender.sync_data().unwrap();

        let recovered = store.recover_rollout(path).unwrap();
        assert_eq!(recovered.response_items.len(), 1);
        assert_eq!(recovered.trailing_events.len(), 1);
        assert_eq!(recovered.rollout_items.len(), 4);
        assert!(matches!(
            recovered.rollout_items[0].item,
            RecoveredRolloutItemKind::SessionMeta(_)
        ));
        assert!(matches!(
            recovered.rollout_items[1].item,
            RecoveredRolloutItemKind::TurnContext(_)
        ));
        assert!(matches!(
            recovered.rollout_items[2].item,
            RecoveredRolloutItemKind::ResponseItem(_)
        ));
        assert!(matches!(
            recovered.rollout_items[3].item,
            RecoveredRolloutItemKind::EventMsg(_)
        ));
    }

    #[test]
    fn corrupted_database_is_backed_up_and_rebuilt() {
        let temp = TempDir::new().unwrap();
        let database_path = temp.path().join("state.sqlite3");
        fs::write(&database_path, b"not a sqlite database").unwrap();

        let store = StateStore::open(temp.path()).unwrap();
        assert!(store.list_threads(false).unwrap().is_empty());
        let backups = fs::read_dir(temp.path().join("db-backups"))
            .unwrap()
            .flat_map(|entry| fs::read_dir(entry.unwrap().path()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
    }

    #[test]
    fn atomic_write_replaces_complete_file() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("task.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"new");
    }
}
