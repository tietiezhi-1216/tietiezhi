//! Source-native Codex memory storage, read tools, citations and consolidation inputs.
//!
//! The database is coordination state. Markdown files under `memories/` are the
//! user-readable memory surface. Writes from an interactive turn are restricted
//! to immutable ad-hoc notes; the consolidation pipeline owns `MEMORY.md`.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub const DEFAULT_MAX_ROLLOUTS_PER_STARTUP: usize = 2;
pub const DEFAULT_MAX_ROLLOUT_AGE_DAYS: i64 = 10;
pub const DEFAULT_MIN_ROLLOUT_IDLE_HOURS: i64 = 6;
pub const DEFAULT_MIN_RATE_LIMIT_REMAINING_PERCENT: i64 = 25;
pub const DEFAULT_MAX_RAW_MEMORIES_FOR_CONSOLIDATION: usize = 256;
pub const DEFAULT_MAX_UNUSED_DAYS: i64 = 30;
pub const DEFAULT_LIST_MAX_RESULTS: usize = 2_000;
pub const MAX_LIST_RESULTS: usize = 2_000;
pub const DEFAULT_SEARCH_MAX_RESULTS: usize = 200;
pub const MAX_SEARCH_RESULTS: usize = 200;
pub const DEFAULT_READ_MAX_TOKENS: usize = 20_000;
pub const SUMMARY_INSTRUCTION_TOKEN_LIMIT: usize = 2_500;
pub const STAGE_ONE_CONCURRENCY_LIMIT: usize = 8;
pub const JOB_LEASE_SECONDS: i64 = 3_600;
pub const JOB_RETRY_DELAY_SECONDS: i64 = 3_600;
pub const PHASE_TWO_HEARTBEAT_SECONDS: u64 = 90;

pub const READ_PATH_TEMPLATE: &str = include_str!("../assets/read_path.md");
pub const STAGE_ONE_SYSTEM_PROMPT: &str = include_str!("../assets/stage_one_system.md");
pub const STAGE_ONE_INPUT_TEMPLATE: &str = include_str!("../assets/stage_one_input.md");
pub const CONSOLIDATION_PROMPT: &str = include_str!("../assets/consolidation.md");

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS stage1_outputs (
    thread_id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    cwd TEXT NOT NULL,
    git_branch TEXT,
    source_updated_at INTEGER NOT NULL,
    raw_memory TEXT NOT NULL,
    rollout_summary TEXT NOT NULL,
    rollout_slug TEXT,
    generated_at INTEGER NOT NULL,
    usage_count INTEGER,
    last_usage INTEGER,
    selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
    selected_for_phase2_source_updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stage1_outputs_source_updated_at
ON stage1_outputs(source_updated_at DESC, thread_id DESC);
CREATE TABLE IF NOT EXISTS jobs (
    kind TEXT NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    worker_id TEXT,
    ownership_token TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    lease_until INTEGER,
    retry_at INTEGER,
    retry_remaining INTEGER NOT NULL,
    last_error TEXT,
    input_watermark INTEGER,
    last_success_watermark INTEGER,
    PRIMARY KEY (kind, job_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_kind_status_retry_lease
ON jobs(kind, status, retry_at, lease_until);
CREATE TABLE IF NOT EXISTS thread_memory_modes (
    thread_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK(mode IN ('enabled', 'disabled', 'polluted')),
    updated_at INTEGER NOT NULL
);
"#;

const JOB_STAGE_ONE: &str = "memory_stage1";
const JOB_PHASE_TWO: &str = "memory_consolidate_global";
const GLOBAL_JOB_KEY: &str = "global";
const DEFAULT_RETRIES: i64 = 3;
const AD_HOC_PREFIX_LEN: usize = "YYYY-MM-DDTHH-MM-SS-".len();

#[derive(Debug, Error)]
pub enum MemoryError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("invalid memory request: {0}")]
    Invalid(String),
    #[error("memory path was not found: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, MemoryError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadMemoryMode {
    Enabled,
    Disabled,
    Polluted,
}

impl ThreadMemoryMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::Polluted => "polluted",
        }
    }
}

impl std::str::FromStr for ThreadMemoryMode {
    type Err = MemoryError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "enabled" => Ok(Self::Enabled),
            "disabled" => Ok(Self::Disabled),
            "polluted" => Ok(Self::Polluted),
            _ => Err(MemoryError::Invalid(format!(
                "unknown thread memory mode `{value}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct MemoriesConfig {
    pub disable_on_external_context: bool,
    pub generate_memories: bool,
    pub use_memories: bool,
    pub dedicated_tools: bool,
    pub max_raw_memories_for_consolidation: usize,
    pub max_unused_days: i64,
    pub max_rollout_age_days: i64,
    pub max_rollouts_per_startup: usize,
    pub min_rollout_idle_hours: i64,
    pub min_rate_limit_remaining_percent: i64,
    pub extract_model: Option<String>,
    pub consolidation_model: Option<String>,
}

impl Default for MemoriesConfig {
    fn default() -> Self {
        Self {
            disable_on_external_context: false,
            generate_memories: true,
            use_memories: true,
            dedicated_tools: false,
            max_raw_memories_for_consolidation: DEFAULT_MAX_RAW_MEMORIES_FOR_CONSOLIDATION,
            max_unused_days: DEFAULT_MAX_UNUSED_DAYS,
            max_rollout_age_days: DEFAULT_MAX_ROLLOUT_AGE_DAYS,
            max_rollouts_per_startup: DEFAULT_MAX_ROLLOUTS_PER_STARTUP,
            min_rollout_idle_hours: DEFAULT_MIN_ROLLOUT_IDLE_HOURS,
            min_rate_limit_remaining_percent: DEFAULT_MIN_RATE_LIMIT_REMAINING_PERCENT,
            extract_model: None,
            consolidation_model: None,
        }
    }
}

impl MemoriesConfig {
    pub fn normalize(mut self) -> Self {
        self.max_raw_memories_for_consolidation =
            self.max_raw_memories_for_consolidation.clamp(1, 4096);
        self.max_unused_days = self.max_unused_days.clamp(0, 365);
        self.max_rollout_age_days = self.max_rollout_age_days.clamp(0, 90);
        self.max_rollouts_per_startup = self.max_rollouts_per_startup.clamp(1, 128);
        self.min_rollout_idle_hours = self.min_rollout_idle_hours.clamp(1, 48);
        self.min_rate_limit_remaining_percent = self.min_rate_limit_remaining_percent.clamp(0, 100);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RolloutCandidate {
    pub thread_id: String,
    pub rollout_path: PathBuf,
    pub cwd: PathBuf,
    pub git_branch: Option<String>,
    pub source_updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StageOneOutput {
    pub thread_id: String,
    pub rollout_path: PathBuf,
    pub cwd: PathBuf,
    pub git_branch: Option<String>,
    pub source_updated_at: i64,
    pub raw_memory: String,
    pub rollout_summary: String,
    pub rollout_slug: Option<String>,
    pub generated_at: i64,
    pub usage_count: Option<i64>,
    pub last_usage: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StageOneClaim {
    pub candidate: RolloutCandidate,
    pub ownership_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhaseTwoClaim {
    pub ownership_token: String,
    pub input_watermark: i64,
    pub inputs: Vec<StageOneOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCitation {
    pub entries: Vec<MemoryCitationEntry>,
    pub thread_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCitationEntry {
    pub path: String,
    pub line_start: usize,
    pub line_end: usize,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryEntryType {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryEntry {
    pub path: String,
    pub entry_type: MemoryEntryType,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SearchMatchMode {
    Any,
    AllOnSameLine,
    AllWithinLines { line_count: usize },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemorySearchMatch {
    pub path: String,
    pub match_line_number: usize,
    pub content_start_line_number: usize,
    pub content: String,
    pub matched_queries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub data: Vec<T>,
    pub next_cursor: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct MemoryRuntime {
    codex_home: PathBuf,
    root: PathBuf,
    extensions_root: PathBuf,
    database_path: PathBuf,
}

impl MemoryRuntime {
    pub fn open(codex_home: impl AsRef<Path>) -> Result<Self> {
        let codex_home = codex_home.as_ref().to_path_buf();
        fs::create_dir_all(&codex_home)?;
        let runtime = Self {
            root: codex_home.join("memories"),
            extensions_root: codex_home.join("memories_extensions"),
            database_path: codex_home.join("memories.sqlite3"),
            codex_home,
        };
        runtime.ensure_layout()?;
        let connection = runtime.connection()?;
        connection.execute_batch(SCHEMA)?;
        Ok(runtime)
    }

    pub fn codex_home(&self) -> &Path {
        &self.codex_home
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn ensure_layout(&self) -> Result<()> {
        ensure_real_directory(&self.root)?;
        ensure_real_directory(&self.extensions_root)?;
        ensure_real_directory(&self.root.join("rollout_summaries"))?;
        ensure_real_directory(&self.root.join("extensions"))?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(&self.database_path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )?;
        Ok(connection)
    }

    pub fn set_thread_mode(&self, thread_id: &str, mode: ThreadMemoryMode) -> Result<()> {
        validate_thread_id(thread_id)?;
        let connection = self.connection()?;
        connection.execute(
            r#"
INSERT INTO thread_memory_modes(thread_id, mode, updated_at)
VALUES (?1, ?2, ?3)
ON CONFLICT(thread_id) DO UPDATE SET
    mode = excluded.mode,
    updated_at = excluded.updated_at
"#,
            params![thread_id, mode.as_str(), now_seconds()],
        )?;
        Ok(())
    }

    pub fn thread_mode(&self, thread_id: &str) -> Result<ThreadMemoryMode> {
        validate_thread_id(thread_id)?;
        let connection = self.connection()?;
        let value = connection
            .query_row(
                "SELECT mode FROM thread_memory_modes WHERE thread_id = ?1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| "enabled".into());
        value.parse()
    }

    pub fn mark_thread_polluted(&self, thread_id: &str) -> Result<bool> {
        if self.thread_mode(thread_id)? != ThreadMemoryMode::Enabled {
            return Ok(false);
        }
        self.set_thread_mode(thread_id, ThreadMemoryMode::Polluted)?;
        let connection = self.connection()?;
        connection.execute(
            "DELETE FROM stage1_outputs WHERE thread_id = ?1",
            [thread_id],
        )?;
        self.enqueue_phase_two(now_seconds())?;
        Ok(true)
    }

    pub fn claim_stage_one(
        &self,
        worker_id: &str,
        candidates: &[RolloutCandidate],
        config: &MemoriesConfig,
    ) -> Result<Vec<StageOneClaim>> {
        validate_thread_id(worker_id)?;
        let config = config.clone().normalize();
        let now = now_seconds();
        let oldest = now.saturating_sub(config.max_rollout_age_days.saturating_mul(86_400));
        let idle = now.saturating_sub(config.min_rollout_idle_hours.saturating_mul(3_600));
        let mut sorted = candidates
            .iter()
            .filter(|candidate| candidate.thread_id != worker_id)
            .filter(|candidate| candidate.source_updated_at >= oldest)
            .filter(|candidate| candidate.source_updated_at <= idle)
            .cloned()
            .collect::<Vec<_>>();
        sorted.sort_by(|left, right| {
            right
                .source_updated_at
                .cmp(&left.source_updated_at)
                .then(right.thread_id.cmp(&left.thread_id))
        });
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let mut claims = Vec::new();
        for candidate in sorted {
            if claims.len() >= config.max_rollouts_per_startup {
                break;
            }
            if self.thread_mode(&candidate.thread_id)? != ThreadMemoryMode::Enabled {
                continue;
            }
            let existing: Option<i64> = transaction
                .query_row(
                    "SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?1",
                    [&candidate.thread_id],
                    |row| row.get(0),
                )
                .optional()?;
            if existing.is_some_and(|updated| updated >= candidate.source_updated_at) {
                continue;
            }
            let ownership_token = Uuid::new_v4().to_string();
            if claim_job(
                &transaction,
                JOB_STAGE_ONE,
                &candidate.thread_id,
                worker_id,
                &ownership_token,
                now,
                JOB_LEASE_SECONDS,
            )? {
                claims.push(StageOneClaim {
                    candidate,
                    ownership_token,
                });
            }
        }
        transaction.commit()?;
        Ok(claims)
    }

    pub fn complete_stage_one(
        &self,
        claim: &StageOneClaim,
        raw_memory: &str,
        rollout_summary: &str,
        rollout_slug: Option<&str>,
    ) -> Result<bool> {
        let raw_memory = redact_secrets(raw_memory);
        let rollout_summary = redact_secrets(rollout_summary);
        if raw_memory.trim().is_empty() || rollout_summary.trim().is_empty() {
            return self.complete_stage_one_without_output(claim);
        }
        let now = now_seconds();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if !owns_job(
            &transaction,
            JOB_STAGE_ONE,
            &claim.candidate.thread_id,
            &claim.ownership_token,
        )? {
            return Ok(false);
        }
        transaction.execute(
            r#"
INSERT INTO stage1_outputs(
    thread_id, rollout_path, cwd, git_branch, source_updated_at,
    raw_memory, rollout_summary, rollout_slug, generated_at,
    usage_count, last_usage, selected_for_phase2,
    selected_for_phase2_source_updated_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, NULL, 0, NULL)
ON CONFLICT(thread_id) DO UPDATE SET
    rollout_path = excluded.rollout_path,
    cwd = excluded.cwd,
    git_branch = excluded.git_branch,
    source_updated_at = excluded.source_updated_at,
    raw_memory = excluded.raw_memory,
    rollout_summary = excluded.rollout_summary,
    rollout_slug = excluded.rollout_slug,
    generated_at = excluded.generated_at
"#,
            params![
                claim.candidate.thread_id,
                path_string(&claim.candidate.rollout_path)?,
                path_string(&claim.candidate.cwd)?,
                claim.candidate.git_branch,
                claim.candidate.source_updated_at,
                raw_memory,
                rollout_summary,
                rollout_slug,
                now,
            ],
        )?;
        finish_job(
            &transaction,
            JOB_STAGE_ONE,
            &claim.candidate.thread_id,
            &claim.ownership_token,
            now,
            Some(claim.candidate.source_updated_at),
        )?;
        enqueue_phase_two_tx(&transaction, claim.candidate.source_updated_at)?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn complete_stage_one_without_output(&self, claim: &StageOneClaim) -> Result<bool> {
        let now = now_seconds();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let completed = finish_job(
            &transaction,
            JOB_STAGE_ONE,
            &claim.candidate.thread_id,
            &claim.ownership_token,
            now,
            Some(claim.candidate.source_updated_at),
        )?;
        transaction.commit()?;
        Ok(completed)
    }

    pub fn fail_stage_one(&self, claim: &StageOneClaim, error: &str) -> Result<bool> {
        let now = now_seconds();
        let connection = self.connection()?;
        let changed = connection.execute(
            r#"
UPDATE jobs SET
    status = 'failed',
    finished_at = ?1,
    lease_until = NULL,
    retry_remaining = MAX(retry_remaining - 1, 0),
    retry_at = ?2,
    last_error = ?3,
    ownership_token = NULL
WHERE kind = ?4 AND job_key = ?5 AND ownership_token = ?6
"#,
            params![
                now,
                now.saturating_add(JOB_RETRY_DELAY_SECONDS),
                truncate(error, 4096),
                JOB_STAGE_ONE,
                claim.candidate.thread_id,
                claim.ownership_token
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn enqueue_phase_two(&self, input_watermark: i64) -> Result<()> {
        let connection = self.connection()?;
        enqueue_phase_two_tx(&connection, input_watermark)
    }

    pub fn claim_phase_two(
        &self,
        worker_id: &str,
        config: &MemoriesConfig,
    ) -> Result<Option<PhaseTwoClaim>> {
        validate_thread_id(worker_id)?;
        let now = now_seconds();
        let ownership_token = Uuid::new_v4().to_string();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if !claim_job(
            &transaction,
            JOB_PHASE_TWO,
            GLOBAL_JOB_KEY,
            worker_id,
            &ownership_token,
            now,
            JOB_LEASE_SECONDS,
        )? {
            return Ok(None);
        }
        let watermark = transaction
            .query_row(
                "SELECT COALESCE(input_watermark, 0) FROM jobs WHERE kind = ?1 AND job_key = ?2",
                params![JOB_PHASE_TWO, GLOBAL_JOB_KEY],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0);
        let inputs = list_stage_one_tx(
            &transaction,
            config.max_raw_memories_for_consolidation.clamp(1, 4096),
            config.max_unused_days,
            now,
        )?;
        transaction.commit()?;
        Ok(Some(PhaseTwoClaim {
            ownership_token,
            input_watermark: watermark,
            inputs,
        }))
    }

    pub fn heartbeat_phase_two(&self, claim: &PhaseTwoClaim) -> Result<bool> {
        let now = now_seconds();
        let connection = self.connection()?;
        Ok(connection.execute(
            "UPDATE jobs SET lease_until = ?1 WHERE kind = ?2 AND job_key = ?3 AND ownership_token = ?4 AND status = 'running'",
            params![
                now.saturating_add(JOB_LEASE_SECONDS),
                JOB_PHASE_TWO,
                GLOBAL_JOB_KEY,
                claim.ownership_token
            ],
        )? == 1)
    }

    pub fn sync_phase_two_inputs(
        &self,
        claim: &PhaseTwoClaim,
        max_memories: usize,
    ) -> Result<PathBuf> {
        self.ensure_layout()?;
        let retained = &claim.inputs[..claim.inputs.len().min(max_memories.max(1))];
        let keep = retained
            .iter()
            .map(rollout_summary_file_stem)
            .collect::<HashSet<_>>();
        let summaries = self.root.join("rollout_summaries");
        for entry in fs::read_dir(&summaries)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("md")
                && path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .is_some_and(|stem| !keep.contains(stem))
            {
                fs::remove_file(path)?;
            }
        }
        for memory in retained {
            let mut body = format!(
                "thread_id: {}\nupdated_at: {}\nrollout_path: {}\ncwd: {}\n",
                memory.thread_id,
                timestamp(memory.source_updated_at),
                memory.rollout_path.display(),
                memory.cwd.display()
            );
            if let Some(branch) = &memory.git_branch {
                body.push_str(&format!("git_branch: {branch}\n"));
            }
            body.push('\n');
            body.push_str(memory.rollout_summary.trim());
            body.push('\n');
            atomic_write(
                &summaries.join(format!("{}.md", rollout_summary_file_stem(memory))),
                body.as_bytes(),
            )?;
        }
        let mut raw = String::from("# Raw Memories\n\n");
        if retained.is_empty() {
            raw.push_str("No raw memories yet.\n");
        } else {
            raw.push_str("Merged stage-1 raw memories (stable ascending thread-id order):\n\n");
            let mut stable = retained.iter().collect::<Vec<_>>();
            stable.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
            for memory in stable {
                raw.push_str(&format!(
                    "## Thread `{}`\nupdated_at: {}\ncwd: {}\nrollout_path: {}\nrollout_summary_file: {}.md\n\n{}\n\n",
                    memory.thread_id,
                    timestamp(memory.source_updated_at),
                    memory.cwd.display(),
                    memory.rollout_path.display(),
                    rollout_summary_file_stem(memory),
                    memory.raw_memory.trim()
                ));
            }
        }
        let path = self.root.join("raw_memories.md");
        atomic_write(&path, raw.as_bytes())?;
        Ok(path)
    }

    pub fn complete_phase_two(&self, claim: &PhaseTwoClaim) -> Result<bool> {
        let now = now_seconds();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        if !owns_job(
            &transaction,
            JOB_PHASE_TWO,
            GLOBAL_JOB_KEY,
            &claim.ownership_token,
        )? {
            return Ok(false);
        }
        transaction.execute("UPDATE stage1_outputs SET selected_for_phase2 = 0", [])?;
        for memory in &claim.inputs {
            transaction.execute(
                "UPDATE stage1_outputs SET selected_for_phase2 = 1, selected_for_phase2_source_updated_at = source_updated_at WHERE thread_id = ?1 AND source_updated_at = ?2",
                params![memory.thread_id, memory.source_updated_at],
            )?;
        }
        let watermark = claim
            .inputs
            .iter()
            .map(|memory| memory.source_updated_at)
            .max()
            .unwrap_or(claim.input_watermark)
            .max(claim.input_watermark);
        finish_job(
            &transaction,
            JOB_PHASE_TWO,
            GLOBAL_JOB_KEY,
            &claim.ownership_token,
            now,
            Some(watermark),
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn apply_consolidation(
        &self,
        memory_markdown: &str,
        memory_summary_markdown: &str,
    ) -> Result<()> {
        if memory_markdown.trim().is_empty() {
            return Err(MemoryError::Invalid(
                "consolidated MEMORY.md must not be empty".into(),
            ));
        }
        if memory_summary_markdown.lines().next() != Some("v1") {
            return Err(MemoryError::Invalid(
                "memory_summary.md must begin with exactly `v1`".into(),
            ));
        }
        atomic_write(&self.root.join("MEMORY.md"), memory_markdown.as_bytes())?;
        atomic_write(
            &self.root.join("memory_summary.md"),
            memory_summary_markdown.as_bytes(),
        )?;
        Ok(())
    }

    pub fn fail_phase_two(&self, claim: &PhaseTwoClaim, error: &str) -> Result<bool> {
        let now = now_seconds();
        let connection = self.connection()?;
        Ok(connection.execute(
            r#"
UPDATE jobs SET status='failed', finished_at=?1, lease_until=NULL,
retry_remaining=MAX(retry_remaining-1,0), retry_at=?2, last_error=?3,
ownership_token=NULL
WHERE kind=?4 AND job_key=?5 AND ownership_token=?6
"#,
            params![
                now,
                now.saturating_add(JOB_RETRY_DELAY_SECONDS),
                truncate(error, 4096),
                JOB_PHASE_TWO,
                GLOBAL_JOB_KEY,
                claim.ownership_token
            ],
        )? == 1)
    }

    pub fn record_citation_usage(&self, citation: &MemoryCitation) -> Result<usize> {
        let ids = citation
            .thread_ids
            .iter()
            .filter(|id| Uuid::parse_str(id).is_ok())
            .collect::<BTreeSet<_>>();
        let now = now_seconds();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let mut updated = 0;
        for id in ids {
            updated += transaction.execute(
                "UPDATE stage1_outputs SET usage_count=COALESCE(usage_count,0)+1,last_usage=?1 WHERE thread_id=?2",
                params![now, id],
            )?;
        }
        transaction.commit()?;
        Ok(updated)
    }

    pub fn developer_instructions(&self, enabled: bool) -> Result<Option<String>> {
        if !enabled {
            return Ok(None);
        }
        let summary_path = self.root.join("memory_summary.md");
        let summary = match read_regular_utf8(&summary_path) {
            Ok(summary) => summary,
            Err(MemoryError::NotFound(_)) => return Ok(None),
            Err(error) => return Err(error),
        };
        let summary =
            truncate_approximately_tokens(summary.trim(), SUMMARY_INSTRUCTION_TOKEN_LIMIT);
        if summary.is_empty() {
            return Ok(None);
        }
        Ok(Some(
            READ_PATH_TEMPLATE
                .replace("{{ base_path }}", &self.root.display().to_string())
                .replace("{{ memory_summary }}", &summary),
        ))
    }

    pub fn list(
        &self,
        relative: Option<&str>,
        cursor: Option<&str>,
        max_results: usize,
    ) -> Result<Page<MemoryEntry>> {
        let path = self.resolve(relative)?;
        let metadata = symlink_metadata(&path)?;
        reject_symlink(&path, &metadata)?;
        let mut entries = if metadata.is_file() {
            vec![MemoryEntry {
                path: display_relative(&self.root, &path),
                entry_type: MemoryEntryType::File,
            }]
        } else if metadata.is_dir() {
            let mut entries = fs::read_dir(&path)?
                .filter_map(std::result::Result::ok)
                .filter_map(|entry| {
                    let file_name = entry.file_name();
                    if file_name.to_string_lossy().starts_with('.') {
                        return None;
                    }
                    let metadata = entry.file_type().ok()?;
                    if metadata.is_symlink() {
                        return None;
                    }
                    let entry_type = if metadata.is_dir() {
                        MemoryEntryType::Directory
                    } else if metadata.is_file() {
                        MemoryEntryType::File
                    } else {
                        return None;
                    };
                    Some(MemoryEntry {
                        path: display_relative(&self.root, &entry.path()),
                        entry_type,
                    })
                })
                .collect::<Vec<_>>();
            entries.sort_by(|left, right| left.path.cmp(&right.path));
            entries
        } else {
            Vec::new()
        };
        paginate(&mut entries, cursor, max_results.clamp(1, MAX_LIST_RESULTS))
    }

    pub fn read(
        &self,
        relative: &str,
        line_offset: usize,
        max_lines: Option<usize>,
        max_tokens: usize,
    ) -> Result<Value> {
        if line_offset == 0 {
            return Err(MemoryError::Invalid(
                "line_offset must be a 1-indexed line number".into(),
            ));
        }
        if max_lines == Some(0) {
            return Err(MemoryError::Invalid(
                "max_lines must be a positive integer".into(),
            ));
        }
        let path = self.resolve(Some(relative))?;
        let content = read_regular_utf8(&path)?;
        let lines = content.split_inclusive('\n').collect::<Vec<_>>();
        if line_offset > lines.len().max(1) {
            return Err(MemoryError::Invalid(
                "line_offset exceeds file length".into(),
            ));
        }
        let start = line_offset.saturating_sub(1);
        let end = max_lines
            .map(|count| start.saturating_add(count).min(lines.len()))
            .unwrap_or(lines.len());
        let raw = lines[start..end].concat();
        let limit = if max_tokens == 0 {
            DEFAULT_READ_MAX_TOKENS
        } else {
            max_tokens
        };
        let output = truncate_approximately_tokens(&raw, limit);
        Ok(json!({
            "path":relative,
            "start_line_number":line_offset,
            "content":output,
            "truncated":end < lines.len() || output != raw
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn search(
        &self,
        queries: Vec<String>,
        match_mode: SearchMatchMode,
        relative: Option<&str>,
        cursor: Option<&str>,
        context_lines: usize,
        case_sensitive: bool,
        normalized: bool,
        max_results: usize,
    ) -> Result<Value> {
        let queries = queries
            .into_iter()
            .map(|query| query.trim().to_owned())
            .collect::<Vec<_>>();
        if queries.is_empty() || queries.iter().any(String::is_empty) {
            return Err(MemoryError::Invalid(
                "queries must not be empty or contain empty strings".into(),
            ));
        }
        if matches!(
            match_mode,
            SearchMatchMode::AllWithinLines { line_count: 0 }
        ) {
            return Err(MemoryError::Invalid(
                "all_within_lines.line_count must be positive".into(),
            ));
        }
        let start = self.resolve(relative)?;
        let metadata = symlink_metadata(&start)?;
        reject_symlink(&start, &metadata)?;
        let mut files = Vec::new();
        collect_regular_files(&start, &mut files)?;
        let prepared = queries
            .iter()
            .map(|query| prepare_search(query, case_sensitive, normalized))
            .collect::<Vec<_>>();
        let mut matches = Vec::new();
        for path in files {
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let lines = content.lines().collect::<Vec<_>>();
            let flags = lines
                .iter()
                .map(|line| {
                    let line = prepare_search(line, case_sensitive, normalized);
                    prepared
                        .iter()
                        .map(|query| line.contains(query))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            append_matches(
                &self.root,
                &path,
                &queries,
                &lines,
                &flags,
                &match_mode,
                context_lines,
                &mut matches,
            );
        }
        matches.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then(left.match_line_number.cmp(&right.match_line_number))
        });
        let page = paginate(
            &mut matches,
            cursor,
            max_results.clamp(1, MAX_SEARCH_RESULTS),
        )?;
        Ok(json!({
            "queries":queries,
            "match_mode":match_mode,
            "path":relative,
            "matches":page.data,
            "next_cursor":page.next_cursor,
            "truncated":page.truncated
        }))
    }

    pub fn add_ad_hoc_note(&self, filename: &str, note: &str) -> Result<()> {
        validate_note_filename(filename)?;
        if note.trim().is_empty() {
            return Err(MemoryError::Invalid("ad-hoc note must not be empty".into()));
        }
        let directory = self.root.join("extensions/ad_hoc/notes");
        ensure_path_without_symlinks(&self.root, &directory)?;
        let path = directory.join(filename);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    MemoryError::Invalid(format!("ad-hoc note `{filename}` already exists"))
                } else {
                    MemoryError::Io(error)
                }
            })?;
        file.write_all(note.as_bytes())?;
        file.sync_all()?;
        Ok(())
    }

    /// Copy legacy Tietiezhi memory into an extension without deleting or
    /// mutating the source. A marker makes the migration idempotent.
    pub fn migrate_legacy_tietiezhi(&self, legacy_home: &Path) -> Result<bool> {
        let extension = self.root.join("extensions/tietiezhi");
        let marker = self.codex_home.join(".tietiezhi-memory-import-v1");
        if marker.exists() {
            return Ok(false);
        }
        ensure_path_without_symlinks(&self.root, &extension.join("resources"))?;
        atomic_write(
            &extension.join("instructions.md"),
            b"Treat resources here as user-controlled legacy Tietiezhi memory. Prefer newer Codex memory when sources conflict. Never infer secrets from omitted content.\n",
        )?;
        let legacy_memory = legacy_home.join("MEMORY.md");
        if legacy_memory.exists() {
            let content = read_regular_utf8(&legacy_memory)?;
            atomic_write(&extension.join("resources/MEMORY.md"), content.as_bytes())?;
            if !self.root.join("MEMORY.md").exists() {
                atomic_write(
                    &self.root.join("MEMORY.md"),
                    b"# Imported Memory Sources\n\n- Legacy Tietiezhi memory is available under `extensions/tietiezhi/resources/` and remains user-controlled.\n",
                )?;
            }
            if !self.root.join("memory_summary.md").exists() {
                atomic_write(
                    &self.root.join("memory_summary.md"),
                    b"v1\n\n## What's in Memory\n\n- Legacy Tietiezhi memory: MEMORY.md, Tietiezhi, user preferences\n  - desc: Search `extensions/tietiezhi/resources/MEMORY.md` when prior user preferences or durable Tietiezhi context may help.\n",
                )?;
            }
        }
        let legacy_directory = legacy_home.join("memory");
        if legacy_directory.exists() {
            copy_regular_tree(&legacy_directory, &extension.join("resources/memory"))?;
        }
        atomic_write(&marker, b"source=tietiezhi\nversion=1\n")?;
        Ok(true)
    }

    /// Clear generated memory rows and roots while preserving per-thread modes.
    pub fn reset(&self) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM stage1_outputs", [])?;
        transaction.execute(
            "DELETE FROM jobs WHERE kind IN (?1, ?2)",
            params![JOB_STAGE_ONE, JOB_PHASE_TWO],
        )?;
        transaction.commit()?;
        clear_root_contents(&self.root)?;
        clear_root_contents(&self.extensions_root)?;
        self.ensure_layout()
    }

    pub fn list_stage_one(&self, limit: usize) -> Result<Vec<StageOneOutput>> {
        let connection = self.connection()?;
        list_stage_one_tx(
            &connection,
            limit.max(1),
            DEFAULT_MAX_UNUSED_DAYS,
            now_seconds(),
        )
    }
}

pub fn stage_one_output_schema() -> Value {
    json!({
        "type":"object",
        "additionalProperties":false,
        "properties":{
            "raw_memory":{"type":"string"},
            "rollout_summary":{"type":"string"},
            "rollout_slug":{"type":["string","null"]}
        },
        "required":["raw_memory","rollout_summary","rollout_slug"]
    })
}

pub fn consolidation_output_schema() -> Value {
    json!({
        "type":"object",
        "additionalProperties":false,
        "properties":{
            "memory_markdown":{"type":"string"},
            "memory_summary_markdown":{"type":"string"}
        },
        "required":["memory_markdown","memory_summary_markdown"]
    })
}

pub fn build_stage_one_input(rollout: &str, rollout_path: &Path, cwd: &Path) -> String {
    STAGE_ONE_INPUT_TEMPLATE
        .replace("{{ rollout_contents }}", rollout)
        .replace("{{ rollout_path }}", &rollout_path.display().to_string())
        .replace("{{ rollout_cwd }}", &cwd.display().to_string())
}

pub fn build_consolidation_prompt(memory_root: &Path, extensions_root: &Path) -> String {
    CONSOLIDATION_PROMPT
        .replace("{{ memory_root }}", &memory_root.display().to_string())
        .replace(
            "{{ memory_extensions_root }}",
            &extensions_root.display().to_string(),
        )
        .replace(
            "{{ memory_extensions_folder_structure }}",
            "Optional source-specific inputs live under the memory root `extensions/` directory. Read each extension's instructions.md before using its resources.",
        )
        .replace(
            "{{ memory_extensions_primary_inputs }}",
            "Read extension instructions and resources only when they are relevant; remove knowledge whose only source was deleted.",
        )
}

/// Removes the hidden citation envelope from a final assistant message and
/// returns the public V2 citation projection.
pub fn strip_and_parse_memory_citation(text: &str) -> (String, Option<MemoryCitation>) {
    let Some(start) = text.find("<oai-mem-citation>") else {
        return (text.to_owned(), None);
    };
    let Some(relative_end) = text[start..].find("</oai-mem-citation>") else {
        return (text.to_owned(), None);
    };
    let end = start + relative_end + "</oai-mem-citation>".len();
    let block = &text[start..end];
    let visible = format!("{}{}", &text[..start], &text[end..])
        .trim_end()
        .to_owned();
    (visible, parse_memory_citation(block))
}

pub fn parse_memory_citation(block: &str) -> Option<MemoryCitation> {
    let entries = extract_block(block, "<citation_entries>", "</citation_entries>")
        .into_iter()
        .flat_map(str::lines)
        .filter_map(parse_citation_entry)
        .collect::<Vec<_>>();
    let ids = extract_block(block, "<rollout_ids>", "</rollout_ids>")
        .or_else(|| extract_block(block, "<thread_ids>", "</thread_ids>"))
        .into_iter()
        .flat_map(str::lines)
        .map(str::trim)
        .filter(|id| Uuid::parse_str(id).is_ok())
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    (!entries.is_empty() || !ids.is_empty()).then_some(MemoryCitation {
        entries,
        thread_ids: ids,
    })
}

pub fn memory_tool_specs() -> Vec<Value> {
    vec![
        json!({
            "type":"function","namespace":"memories","name":"list","strict":false,
            "description":"List entries in the managed memory folder.",
            "parameters":{"type":"object","additionalProperties":false,"properties":{
                "path":{"type":["string","null"]},"cursor":{"type":["string","null"]},
                "max_results":{"type":["integer","null"],"minimum":1,"maximum":2000}
            }}
        }),
        json!({
            "type":"function","namespace":"memories","name":"read","strict":false,
            "description":"Read a bounded line range from one managed memory file.",
            "parameters":{"type":"object","additionalProperties":false,"properties":{
                "path":{"type":"string"},"line_offset":{"type":["integer","null"],"minimum":1},
                "max_lines":{"type":["integer","null"],"minimum":1},
                "max_tokens":{"type":["integer","null"],"minimum":1}
            },"required":["path"]}
        }),
        json!({
            "type":"function","namespace":"memories","name":"search","strict":false,
            "description":"Search managed memory files and return line-numbered evidence.",
            "parameters":{"type":"object","additionalProperties":false,"properties":{
                "queries":{"type":"array","minItems":1,"items":{"type":"string"}},
                "path":{"type":["string","null"]},"cursor":{"type":["string","null"]},
                "match_mode":{"oneOf":[
                    {"type":"object","properties":{"type":{"const":"any"}},"required":["type"]},
                    {"type":"object","properties":{"type":{"const":"all_on_same_line"}},"required":["type"]},
                    {"type":"object","properties":{"type":{"const":"all_within_lines"},"line_count":{"type":"integer","minimum":1}},"required":["type","line_count"]}
                ]},
                "context_lines":{"type":["integer","null"],"minimum":0},
                "case_sensitive":{"type":["boolean","null"]},
                "normalized":{"type":["boolean","null"]},
                "max_results":{"type":["integer","null"],"minimum":1,"maximum":200}
            },"required":["queries"]}
        }),
        json!({
            "type":"function","namespace":"memories","name":"add_ad_hoc_note","strict":false,
            "description":"Add one immutable memory update note only after an explicit user request.",
            "parameters":{"type":"object","additionalProperties":false,"properties":{
                "filename":{"type":"string"},"note":{"type":"string"}
            },"required":["filename","note"]}
        }),
    ]
}

fn claim_job(
    transaction: &Transaction<'_>,
    kind: &str,
    key: &str,
    worker_id: &str,
    ownership_token: &str,
    now: i64,
    lease_seconds: i64,
) -> Result<bool> {
    let row = transaction
        .query_row(
            "SELECT status, lease_until, retry_at, retry_remaining FROM jobs WHERE kind=?1 AND job_key=?2",
            params![kind, key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    if let Some((status, lease_until, retry_at, retries)) = row {
        if status == "running" && lease_until.is_some_and(|lease| lease > now) {
            return Ok(false);
        }
        if retries == 0 || retry_at.is_some_and(|retry| retry > now) {
            return Ok(false);
        }
    }
    transaction.execute(
        r#"
INSERT INTO jobs(kind,job_key,status,worker_id,ownership_token,started_at,lease_until,retry_remaining)
VALUES(?1,?2,'running',?3,?4,?5,?6,?7)
ON CONFLICT(kind,job_key) DO UPDATE SET
 status='running',worker_id=excluded.worker_id,ownership_token=excluded.ownership_token,
 started_at=excluded.started_at,finished_at=NULL,lease_until=excluded.lease_until,
 retry_at=NULL,last_error=NULL
"#,
        params![
            kind,
            key,
            worker_id,
            ownership_token,
            now,
            now.saturating_add(lease_seconds),
            DEFAULT_RETRIES
        ],
    )?;
    Ok(true)
}

fn owns_job(
    transaction: &Transaction<'_>,
    kind: &str,
    key: &str,
    ownership_token: &str,
) -> Result<bool> {
    Ok(transaction
        .query_row(
            "SELECT 1 FROM jobs WHERE kind=?1 AND job_key=?2 AND status='running' AND ownership_token=?3",
            params![kind, key, ownership_token],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn finish_job(
    transaction: &Transaction<'_>,
    kind: &str,
    key: &str,
    ownership_token: &str,
    now: i64,
    watermark: Option<i64>,
) -> Result<bool> {
    Ok(transaction.execute(
        r#"
UPDATE jobs SET status='succeeded',finished_at=?1,lease_until=NULL,retry_at=NULL,
retry_remaining=?2,last_error=NULL,last_success_watermark=COALESCE(?3,last_success_watermark),
ownership_token=NULL
WHERE kind=?4 AND job_key=?5 AND ownership_token=?6
"#,
        params![now, DEFAULT_RETRIES, watermark, kind, key, ownership_token],
    )? == 1)
}

fn enqueue_phase_two_tx(connection: &Connection, watermark: i64) -> Result<()> {
    connection.execute(
        r#"
INSERT INTO jobs(kind,job_key,status,retry_remaining,input_watermark)
VALUES(?1,?2,'pending',?3,?4)
ON CONFLICT(kind,job_key) DO UPDATE SET
 input_watermark=MAX(COALESCE(jobs.input_watermark,0),excluded.input_watermark),
 status=CASE WHEN jobs.status='running' THEN jobs.status ELSE 'pending' END,
 retry_remaining=CASE WHEN jobs.retry_remaining=0 THEN excluded.retry_remaining ELSE jobs.retry_remaining END
"#,
        params![JOB_PHASE_TWO, GLOBAL_JOB_KEY, DEFAULT_RETRIES, watermark],
    )?;
    Ok(())
}

fn list_stage_one_tx(
    connection: &Connection,
    limit: usize,
    max_unused_days: i64,
    now: i64,
) -> Result<Vec<StageOneOutput>> {
    let cutoff = now.saturating_sub(max_unused_days.max(0).saturating_mul(86_400));
    let mut statement = connection.prepare(
        r#"
SELECT thread_id,rollout_path,cwd,git_branch,source_updated_at,raw_memory,
rollout_summary,rollout_slug,generated_at,usage_count,last_usage
FROM stage1_outputs
WHERE COALESCE(last_usage,generated_at) >= ?1
ORDER BY COALESCE(usage_count,0) DESC,COALESCE(last_usage,generated_at) DESC,thread_id DESC
LIMIT ?2
"#,
    )?;
    let rows = statement.query_map(
        params![cutoff, limit.min(i64::MAX as usize) as i64],
        |row| {
            Ok(StageOneOutput {
                thread_id: row.get(0)?,
                rollout_path: PathBuf::from(row.get::<_, String>(1)?),
                cwd: PathBuf::from(row.get::<_, String>(2)?),
                git_branch: row.get(3)?,
                source_updated_at: row.get(4)?,
                raw_memory: row.get(5)?,
                rollout_summary: row.get(6)?,
                rollout_slug: row.get(7)?,
                generated_at: row.get(8)?,
                usage_count: row.get(9)?,
                last_usage: row.get(10)?,
            })
        },
    )?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn parse_citation_entry(line: &str) -> Option<MemoryCitationEntry> {
    let (location, note) = line.trim().rsplit_once("|note=[")?;
    let note = note.strip_suffix(']')?.trim().to_owned();
    let (path, range) = location.rsplit_once(':')?;
    let (start, end) = range.split_once('-')?;
    let path = path.trim();
    if path.is_empty()
        || Path::new(path).is_absolute()
        || Path::new(path).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    Some(MemoryCitationEntry {
        path: path.to_owned(),
        line_start: start.trim().parse().ok()?,
        line_end: end.trim().parse().ok()?,
        note,
    })
}

fn extract_block<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let (_, rest) = text.split_once(start)?;
    let (body, _) = rest.split_once(end)?;
    Some(body)
}

#[allow(clippy::too_many_arguments)]
fn append_matches(
    root: &Path,
    path: &Path,
    queries: &[String],
    lines: &[&str],
    flags: &[Vec<bool>],
    mode: &SearchMatchMode,
    context: usize,
    output: &mut Vec<MemorySearchMatch>,
) {
    match mode {
        SearchMatchMode::Any => {
            for (index, matched) in flags.iter().enumerate() {
                if matched.iter().any(|value| *value) {
                    output.push(build_match(
                        root, path, queries, lines, index, index, context, matched,
                    ));
                }
            }
        }
        SearchMatchMode::AllOnSameLine => {
            for (index, matched) in flags.iter().enumerate() {
                if matched.iter().all(|value| *value) {
                    output.push(build_match(
                        root, path, queries, lines, index, index, context, matched,
                    ));
                }
            }
        }
        SearchMatchMode::AllWithinLines { line_count } => {
            for start in 0..lines.len() {
                let mut matched = vec![false; queries.len()];
                let end_limit = start
                    .saturating_add(line_count.saturating_sub(1))
                    .min(lines.len().saturating_sub(1));
                for (end, row) in flags
                    .iter()
                    .enumerate()
                    .take(end_limit.saturating_add(1))
                    .skip(start)
                {
                    for (flag, row_flag) in matched.iter_mut().zip(row) {
                        *flag |= *row_flag;
                    }
                    if matched.iter().all(|value| *value) {
                        output.push(build_match(
                            root, path, queries, lines, start, end, context, &matched,
                        ));
                        break;
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_match(
    root: &Path,
    path: &Path,
    queries: &[String],
    lines: &[&str],
    start: usize,
    end: usize,
    context: usize,
    flags: &[bool],
) -> MemorySearchMatch {
    let content_start = start.saturating_sub(context);
    let content_end = end
        .saturating_add(context)
        .saturating_add(1)
        .min(lines.len());
    MemorySearchMatch {
        path: display_relative(root, path),
        match_line_number: start + 1,
        content_start_line_number: content_start + 1,
        content: lines[content_start..content_end].join("\n"),
        matched_queries: queries
            .iter()
            .zip(flags)
            .filter_map(|(query, matched)| matched.then_some(query.clone()))
            .collect(),
    }
}

fn prepare_search(value: &str, case_sensitive: bool, normalized: bool) -> String {
    let normalized_value = if normalized {
        value.nfkc().collect::<String>()
    } else {
        value.to_owned()
    };
    if case_sensitive {
        normalized_value
    } else {
        normalized_value.to_lowercase()
    }
}

fn paginate<T>(values: &mut Vec<T>, cursor: Option<&str>, limit: usize) -> Result<Page<T>> {
    let start = cursor
        .map(|cursor| {
            cursor
                .parse::<usize>()
                .map_err(|_| MemoryError::Invalid("cursor must be a non-negative integer".into()))
        })
        .transpose()?
        .unwrap_or(0);
    if start > values.len() {
        return Err(MemoryError::Invalid("cursor exceeds result count".into()));
    }
    let total = values.len();
    let end = start.saturating_add(limit).min(total);
    let data = values.drain(start..end).collect();
    Ok(Page {
        data,
        next_cursor: (end < total).then(|| end.to_string()),
        truncated: end < total,
    })
}

impl MemoryRuntime {
    fn resolve(&self, relative: Option<&str>) -> Result<PathBuf> {
        let relative = relative.unwrap_or_default();
        let path = Path::new(relative);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(MemoryError::Invalid(format!(
                "path `{relative}` must stay inside the memory root"
            )));
        }
        let resolved = self.root.join(path);
        ensure_existing_ancestors_without_symlinks(&self.root, &resolved)?;
        Ok(resolved)
    }
}

fn collect_regular_files(path: &Path, output: &mut Vec<PathBuf>) -> Result<()> {
    let metadata = symlink_metadata(path)?;
    reject_symlink(path, &metadata)?;
    if metadata.is_file() {
        output.push(path.to_path_buf());
        return Ok(());
    }
    if !metadata.is_dir() {
        return Ok(());
    }
    let mut entries = fs::read_dir(path)?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with('.'))
        })
        .collect::<Vec<_>>();
    entries.sort();
    for entry in entries {
        let metadata = fs::symlink_metadata(&entry)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        collect_regular_files(&entry, output)?;
    }
    Ok(())
}

fn copy_regular_tree(source: &Path, destination: &Path) -> Result<()> {
    let metadata = symlink_metadata(source)?;
    reject_symlink(source, &metadata)?;
    if metadata.is_file() {
        let content = read_regular_utf8(source)?;
        if let Some(parent) = destination.parent() {
            ensure_real_directory(parent)?;
        }
        atomic_write(destination, content.as_bytes())?;
        return Ok(());
    }
    ensure_real_directory(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let metadata = entry.file_type()?;
        if metadata.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        copy_regular_tree(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

fn ensure_existing_ancestors_without_symlinks(root: &Path, path: &Path) -> Result<()> {
    let mut current = root.to_path_buf();
    reject_symlink(root, &symlink_metadata(root)?)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| MemoryError::Invalid("path escaped memory root".into()))?;
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => reject_symlink(&current, &metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn ensure_path_without_symlinks(root: &Path, path: &Path) -> Result<()> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| MemoryError::Invalid("path escaped memory root".into()))?;
    let mut current = root.to_path_buf();
    ensure_real_directory(&current)?;
    for component in relative.components() {
        current.push(component);
        ensure_real_directory(&current)?;
    }
    Ok(())
}

fn ensure_real_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            reject_symlink(path, &metadata)?;
            if !metadata.is_dir() {
                return Err(MemoryError::Invalid(format!(
                    "{} must be a directory",
                    path.display()
                )));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path)?;
            let metadata = fs::symlink_metadata(path)?;
            reject_symlink(path, &metadata)?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn clear_root_contents(root: &Path) -> Result<()> {
    match fs::symlink_metadata(root) {
        Ok(metadata) => reject_symlink(root, &metadata)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(root)?;
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let metadata = entry.file_type()?;
        if metadata.is_dir() && !metadata.is_symlink() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn read_regular_utf8(path: &Path) -> Result<String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(MemoryError::NotFound(path.display().to_string()))
        }
        Err(error) => return Err(error.into()),
    };
    reject_symlink(path, &metadata)?;
    if !metadata.is_file() {
        return Err(MemoryError::Invalid(format!(
            "{} is not a file",
            path.display()
        )));
    }
    fs::read_to_string(path).map_err(Into::into)
}

fn symlink_metadata(path: &Path) -> Result<fs::Metadata> {
    fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            MemoryError::NotFound(path.display().to_string())
        } else {
            MemoryError::Io(error)
        }
    })
}

fn reject_symlink(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    if metadata.file_type().is_symlink() {
        return Err(MemoryError::Invalid(format!(
            "{} must not be a symlink",
            path.display()
        )));
    }
    Ok(())
}

fn validate_note_filename(filename: &str) -> Result<()> {
    if filename.len() > 128 || !filename.ends_with(".md") {
        return Err(MemoryError::Invalid(
            "filename must be a Markdown filename of at most 128 bytes".into(),
        ));
    }
    let stem = filename
        .strip_suffix(".md")
        .ok_or_else(|| MemoryError::Invalid("filename must end with .md".into()))?;
    let bytes = stem.as_bytes();
    let timestamp_valid = bytes.len() > AD_HOC_PREFIX_LEN
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b'-')
        && bytes.get(16) == Some(&b'-')
        && bytes.get(19) == Some(&b'-')
        && [
            &bytes[0..4],
            &bytes[5..7],
            &bytes[8..10],
            &bytes[11..13],
            &bytes[14..16],
            &bytes[17..19],
        ]
        .iter()
        .all(|part| part.iter().all(u8::is_ascii_digit));
    let slug = stem.get(AD_HOC_PREFIX_LEN..).unwrap_or_default();
    if !timestamp_valid
        || slug.is_empty()
        || slug.len() > 80
        || !slug
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(MemoryError::Invalid(
            "filename must use YYYY-MM-DDTHH-MM-SS-<lowercase-slug>.md".into(),
        ));
    }
    Ok(())
}

fn validate_thread_id(thread_id: &str) -> Result<()> {
    Uuid::parse_str(thread_id)
        .map(|_| ())
        .map_err(|_| MemoryError::Invalid(format!("invalid thread id `{thread_id}`")))
}

fn display_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn path_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| MemoryError::Invalid(format!("path is not UTF-8: {}", path.display())))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| MemoryError::Invalid("file has no parent".into()))?;
    ensure_real_directory(parent)?;
    let temporary = parent.join(format!(".memory-{}.tmp", Uuid::new_v4()));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

fn rollout_summary_file_stem(memory: &StageOneOutput) -> String {
    let timestamp = timestamp(memory.source_updated_at)
        .replace(':', "-")
        .trim_end_matches('Z')
        .to_owned();
    let hash = Uuid::parse_str(&memory.thread_id)
        .map(|id| format!("{:04x}", id.as_u128() as u16))
        .unwrap_or_else(|_| "0000".into());
    let slug = memory
        .rollout_slug
        .as_deref()
        .map(|slug| {
            slug.chars()
                .take(60)
                .map(|character| {
                    if character.is_ascii_alphanumeric() {
                        character.to_ascii_lowercase()
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
                .trim_matches('_')
                .to_owned()
        })
        .filter(|slug| !slug.is_empty());
    match slug {
        Some(slug) => format!("{timestamp}-{hash}-{slug}"),
        None => format!("{timestamp}-{hash}"),
    }
}

fn redact_secrets(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for line in value.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("api_key=")
            || lower.contains("apikey=")
            || lower.contains("authorization: bearer ")
            || lower.contains("access_token=")
            || lower.contains("secret_key=")
        {
            output.push_str("[REDACTED SECRET]\n");
        } else {
            output.push_str(line);
            output.push('\n');
        }
    }
    output.trim_end().to_owned()
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn truncate_approximately_tokens(value: &str, tokens: usize) -> String {
    let max_chars = tokens.saturating_mul(4);
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    value.chars().take(max_chars).collect()
}

fn timestamp(seconds: i64) -> String {
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339()
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn candidate(id: Uuid, updated_at: i64, root: &Path) -> RolloutCandidate {
        RolloutCandidate {
            thread_id: id.to_string(),
            rollout_path: root.join(format!("{id}.jsonl")),
            cwd: root.join("repo"),
            git_branch: Some("main".into()),
            source_updated_at: updated_at,
        }
    }

    #[test]
    fn citation_is_hidden_parsed_and_usage_is_recorded() {
        let root = tempdir().unwrap();
        let runtime = MemoryRuntime::open(root.path()).unwrap();
        let id = Uuid::now_v7();
        let now = now_seconds();
        let claim = runtime
            .claim_stage_one(
                &Uuid::now_v7().to_string(),
                &[candidate(id, now - 7 * 3_600, root.path())],
                &MemoriesConfig::default(),
            )
            .unwrap()
            .pop()
            .unwrap();
        runtime
            .complete_stage_one(&claim, "durable fact", "summary", Some("task"))
            .unwrap();
        let text = format!(
            "Answer.\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:2-4|note=[used fact]\n</citation_entries>\n<rollout_ids>\n{id}\n{id}\n</rollout_ids>\n</oai-mem-citation>"
        );
        let (visible, citation) = strip_and_parse_memory_citation(&text);
        assert_eq!(visible, "Answer.");
        let citation = citation.unwrap();
        assert_eq!(citation.entries[0].line_start, 2);
        assert_eq!(citation.thread_ids, vec![id.to_string()]);
        assert_eq!(runtime.record_citation_usage(&citation).unwrap(), 1);
        assert_eq!(runtime.list_stage_one(10).unwrap()[0].usage_count, Some(1));
    }

    #[test]
    fn stage_jobs_leases_artifacts_and_reset_preserves_mode() {
        let root = tempdir().unwrap();
        let runtime = MemoryRuntime::open(root.path()).unwrap();
        let worker = Uuid::now_v7().to_string();
        let id = Uuid::now_v7();
        let now = now_seconds();
        runtime
            .set_thread_mode(&id.to_string(), ThreadMemoryMode::Enabled)
            .unwrap();
        let candidate = candidate(id, now - 7 * 3_600, root.path());
        let claim = runtime
            .claim_stage_one(
                &worker,
                std::slice::from_ref(&candidate),
                &MemoriesConfig::default(),
            )
            .unwrap();
        assert_eq!(claim.len(), 1);
        assert!(runtime
            .claim_stage_one(&worker, &[candidate], &MemoriesConfig::default())
            .unwrap()
            .is_empty());
        runtime
            .complete_stage_one(&claim[0], "raw", "summary", Some("slug"))
            .unwrap();
        let phase_two = runtime
            .claim_phase_two(&worker, &MemoriesConfig::default())
            .unwrap()
            .unwrap();
        let raw = runtime.sync_phase_two_inputs(&phase_two, 256).unwrap();
        assert!(fs::read_to_string(raw).unwrap().contains("raw"));
        assert!(runtime.complete_phase_two(&phase_two).unwrap());
        runtime.reset().unwrap();
        assert!(runtime.list_stage_one(10).unwrap().is_empty());
        assert_eq!(
            runtime.thread_mode(&id.to_string()).unwrap(),
            ThreadMemoryMode::Enabled
        );
    }

    #[test]
    fn tools_reject_escape_and_symlinks_and_notes_are_create_only() {
        let root = tempdir().unwrap();
        let runtime = MemoryRuntime::open(root.path()).unwrap();
        atomic_write(&runtime.root.join("MEMORY.md"), b"alpha\nbeta\n").unwrap();
        assert!(runtime.read("../secret", 1, None, 10).is_err());
        assert_eq!(
            runtime
                .read("MEMORY.md", 2, Some(1), 10)
                .unwrap()
                .get("content")
                .and_then(Value::as_str),
            Some("beta\n")
        );
        let filename = "2026-07-25T12-00-00-explicit-note.md";
        runtime.add_ad_hoc_note(filename, "remember this").unwrap();
        assert!(runtime.add_ad_hoc_note(filename, "replace").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path().join("outside"), runtime.root.join("escape"))
                .unwrap();
            assert!(runtime.list(Some("escape"), None, 10).is_err());
        }
    }

    #[test]
    fn disabled_memory_is_not_injected_and_legacy_migration_is_idempotent() {
        let root = tempdir().unwrap();
        let legacy = tempdir().unwrap();
        fs::write(legacy.path().join("MEMORY.md"), "legacy memory").unwrap();
        fs::create_dir(legacy.path().join("memory")).unwrap();
        fs::write(legacy.path().join("memory/topic.md"), "topic").unwrap();
        let runtime = MemoryRuntime::open(root.path()).unwrap();
        assert_eq!(runtime.developer_instructions(false).unwrap(), None);
        assert!(runtime.migrate_legacy_tietiezhi(legacy.path()).unwrap());
        assert!(!runtime.migrate_legacy_tietiezhi(legacy.path()).unwrap());
        assert_eq!(
            fs::read_to_string(
                runtime
                    .root
                    .join("extensions/tietiezhi/resources/MEMORY.md")
            )
            .unwrap(),
            "legacy memory"
        );
    }
}
