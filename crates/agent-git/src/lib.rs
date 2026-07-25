//! Source-native Codex local/worktree execution environments.
//!
//! A task owns one environment. Git worktrees are detached and keep the
//! selected checkout's tracked and untracked state. Snapshots use a private
//! alternate index and `refs/tietiezhi/snapshots/*`, so the user's index and
//! current branch are never modified.

use globset::{GlobBuilder, GlobMatcher};
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;
use walkdir::WalkDir;

const STATE_VERSION: u32 = 1;
const SNAPSHOT_REF_ROOT: &str = "refs/tietiezhi/snapshots";
const DISABLED_HOOKS_PATH: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };
const MAX_INCLUDED_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_INCLUDED_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_DIFF_BYTES: usize = 512 * 1024;

#[derive(Debug, Error)]
pub enum GitEnvironmentError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid workspace request: {0}")]
    Invalid(String),
    #[error("not a Git repository: {0}")]
    NotGit(PathBuf),
    #[error("Git command failed: {command}: {message}")]
    Git { command: String, message: String },
    #[error("workspace state was not found: {0}")]
    StateNotFound(String),
}

pub type Result<T> = std::result::Result<T, GitEnvironmentError>;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionEnvironment {
    Local,
    #[default]
    Worktree,
}

impl ExecutionEnvironment {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Worktree => "worktree",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub id: String,
    pub label: String,
    pub reference: String,
    pub commit: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHandoff {
    pub branch: String,
    pub commit: String,
    pub snapshot_id: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitChange {
    pub path: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub staged_diff: String,
    pub unstaged_diff: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitDiff {
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub remotes: Vec<String>,
    pub changes: Vec<WorkspaceGitChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCommit {
    pub commit: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDescriptor {
    pub task_id: String,
    pub environment: ExecutionEnvironment,
    pub initialized: bool,
    pub project_root: Option<PathBuf>,
    pub repository_root: Option<PathBuf>,
    pub worktree_root: Option<PathBuf>,
    pub active_root: PathBuf,
    pub relative_project: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub created_at_ms: u64,
    pub snapshots: Vec<WorkspaceSnapshot>,
    pub handoffs: Vec<WorkspaceHandoff>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceState {
    version: u32,
    descriptor: WorkspaceDescriptor,
}

#[derive(Debug, Clone)]
pub struct WorkspaceRuntime {
    state_root: PathBuf,
}

impl WorkspaceRuntime {
    pub fn open(state_root: impl AsRef<Path>) -> Result<Self> {
        let state_root = state_root.as_ref().to_path_buf();
        fs::create_dir_all(state_root.join("states"))?;
        fs::create_dir_all(state_root.join("indexes"))?;
        Ok(Self { state_root })
    }

    pub fn read(&self, task_id: &str) -> Result<Option<WorkspaceDescriptor>> {
        validate_task_id(task_id)?;
        let path = self.state_path(task_id);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let state: WorkspaceState = serde_json::from_slice(&bytes)?;
        if state.version != STATE_VERSION || state.descriptor.task_id != task_id {
            return Err(GitEnvironmentError::Invalid(format!(
                "unsupported workspace state for `{task_id}`"
            )));
        }
        Ok(Some(state.descriptor))
    }

    pub fn resolve(
        &self,
        task_id: &str,
        project_root: Option<&Path>,
        managed_workspace_root: &Path,
        preferred_environment: Option<ExecutionEnvironment>,
    ) -> Result<WorkspaceDescriptor> {
        validate_task_id(task_id)?;
        if let Some(existing) = self.read(task_id)? {
            return self.resolve_existing(existing);
        }
        let created_at_ms = now_ms();
        let descriptor = match project_root {
            None => {
                fs::create_dir_all(managed_workspace_root)?;
                WorkspaceDescriptor {
                    task_id: task_id.into(),
                    environment: ExecutionEnvironment::Local,
                    initialized: true,
                    project_root: None,
                    repository_root: None,
                    worktree_root: None,
                    active_root: canonical(managed_workspace_root)?,
                    relative_project: PathBuf::new(),
                    head: None,
                    branch: None,
                    detached: false,
                    created_at_ms,
                    snapshots: Vec::new(),
                    handoffs: Vec::new(),
                }
            }
            Some(project_root) => {
                let project_root = canonical_directory(project_root)?;
                let environment = preferred_environment.unwrap_or_else(|| {
                    if repository_context(&project_root).is_ok() {
                        ExecutionEnvironment::Worktree
                    } else {
                        ExecutionEnvironment::Local
                    }
                });
                self.create_project_environment(
                    task_id,
                    &project_root,
                    managed_workspace_root,
                    environment,
                    created_at_ms,
                )?
            }
        };
        self.persist(&descriptor)?;
        Ok(descriptor)
    }

    /// Records a pre-R29 workspace without moving it. Registered Git worktrees
    /// cannot be renamed because their common repository stores the path.
    pub fn adopt(
        &self,
        task_id: &str,
        project_root: Option<&Path>,
        active_root: &Path,
    ) -> Result<WorkspaceDescriptor> {
        validate_task_id(task_id)?;
        if let Some(existing) = self.read(task_id)? {
            return self.resolve_existing(existing);
        }
        let active_root = canonical_directory(active_root)?;
        let project_root = project_root.map(canonical_directory).transpose()?;
        let active_context = repository_context(&active_root).ok();
        let source_context = project_root
            .as_deref()
            .and_then(|project| repository_context(project).ok());
        let is_managed_worktree = active_context.as_ref().is_some_and(|active| {
            source_context
                .as_ref()
                .is_some_and(|source| active.repository_root != source.repository_root)
                || active_root.join(".git").is_file()
        });
        let repository_root = source_context
            .as_ref()
            .map(|context| context.repository_root.clone())
            .or_else(|| {
                active_context
                    .as_ref()
                    .map(|context| context.repository_root.clone())
            });
        let worktree_root = is_managed_worktree
            .then(|| {
                active_context
                    .as_ref()
                    .map(|context| context.repository_root.clone())
            })
            .flatten();
        let relative_project = worktree_root
            .as_ref()
            .and_then(|root| active_root.strip_prefix(root).ok())
            .map(Path::to_path_buf)
            .or_else(|| {
                source_context
                    .as_ref()
                    .map(|context| context.relative_project.clone())
            })
            .unwrap_or_default();
        let command_root = worktree_root.as_ref().or(repository_root.as_ref()).cloned();
        let branch = command_root.as_ref().and_then(|root| current_branch(root));
        let descriptor = WorkspaceDescriptor {
            task_id: task_id.into(),
            environment: if is_managed_worktree {
                ExecutionEnvironment::Worktree
            } else {
                ExecutionEnvironment::Local
            },
            initialized: true,
            project_root,
            repository_root,
            worktree_root,
            active_root,
            relative_project,
            head: command_root
                .as_ref()
                .and_then(|root| git_optional(root, ["rev-parse", "HEAD"])),
            detached: is_managed_worktree && branch.is_none(),
            branch,
            created_at_ms: now_ms(),
            snapshots: Vec::new(),
            handoffs: Vec::new(),
        };
        self.persist(&descriptor)?;
        Ok(descriptor)
    }

    pub fn set_environment(
        &self,
        task_id: &str,
        project_root: &Path,
        managed_workspace_root: &Path,
        environment: ExecutionEnvironment,
    ) -> Result<WorkspaceDescriptor> {
        validate_task_id(task_id)?;
        let project_root = canonical_directory(project_root)?;
        let mut current = self.read(task_id)?;
        if current
            .as_ref()
            .is_some_and(|descriptor| descriptor.environment == environment)
        {
            return self.resolve_existing(current.expect("checked above"));
        }

        if let Some(descriptor) = current.as_mut() {
            if descriptor.environment == ExecutionEnvironment::Worktree
                && descriptor.worktree_root.is_some()
                && self.has_changes(task_id)?
            {
                self.snapshot_mut(descriptor, "before switching to Local")?;
            }
            if environment == ExecutionEnvironment::Local {
                descriptor.environment = ExecutionEnvironment::Local;
                descriptor.project_root = Some(project_root.clone());
                descriptor.active_root = project_root;
                descriptor.head =
                    repository_context(&descriptor.active_root)
                        .ok()
                        .and_then(|context| {
                            git_optional(&context.repository_root, ["rev-parse", "HEAD"])
                        });
                descriptor.branch = repository_context(&descriptor.active_root)
                    .ok()
                    .and_then(|context| current_branch(&context.repository_root));
                descriptor.detached = false;
                self.persist(descriptor)?;
                return Ok(descriptor.clone());
            }
            if let Some(worktree_root) = descriptor.worktree_root.as_ref() {
                if worktree_root.exists() {
                    let context = repository_context(&project_root)?;
                    descriptor.environment = ExecutionEnvironment::Worktree;
                    descriptor.repository_root = Some(context.repository_root.clone());
                    descriptor.relative_project = context.relative_project;
                    descriptor.active_root =
                        canonical(&worktree_root.join(&descriptor.relative_project))?;
                    descriptor.head = git_optional(worktree_root, ["rev-parse", "HEAD"]);
                    descriptor.branch = current_branch(worktree_root);
                    descriptor.detached = descriptor.branch.is_none();
                    self.persist(descriptor)?;
                    return Ok(descriptor.clone());
                }
            }
        }

        let mut created = self.create_project_environment(
            task_id,
            &project_root,
            managed_workspace_root,
            environment,
            current
                .as_ref()
                .map(|descriptor| descriptor.created_at_ms)
                .unwrap_or_else(now_ms),
        )?;
        if let Some(current) = current {
            created.snapshots = current.snapshots;
            created.handoffs = current.handoffs;
        }
        self.persist(&created)?;
        Ok(created)
    }

    pub fn has_changes(&self, task_id: &str) -> Result<bool> {
        let descriptor = self
            .read(task_id)?
            .ok_or_else(|| GitEnvironmentError::StateNotFound(task_id.into()))?;
        let Some(root) = git_command_root(&descriptor) else {
            return Ok(false);
        };
        let output = git_output(&root, ["status", "--porcelain=v1", "-z"])?;
        Ok(!output.stdout.is_empty())
    }

    pub fn changed_files(&self, task_id: &str) -> Result<Vec<String>> {
        let descriptor = self
            .read(task_id)?
            .ok_or_else(|| GitEnvironmentError::StateNotFound(task_id.into()))?;
        let Some(root) = git_command_root(&descriptor) else {
            return Ok(Vec::new());
        };
        changed_files(&root, &descriptor.relative_project)
    }

    pub fn diff(&self, task_id: &str) -> Result<WorkspaceGitDiff> {
        let descriptor = self
            .read(task_id)?
            .ok_or_else(|| GitEnvironmentError::StateNotFound(task_id.into()))?;
        let root = git_command_root(&descriptor)
            .ok_or_else(|| GitEnvironmentError::NotGit(descriptor.active_root.clone()))?;
        let mut changes = Vec::new();
        for status in git_status_entries(&root, &descriptor.relative_project)? {
            let repository_path = descriptor.relative_project.join(&status.path);
            let mut staged_diff = if status.staged {
                git_diff(&root, true, &repository_path)?
            } else {
                String::new()
            };
            let mut unstaged_diff = if status.untracked {
                untracked_diff(&descriptor.active_root.join(&status.path))?
            } else if status.unstaged {
                git_diff(&root, false, &repository_path)?
            } else {
                String::new()
            };
            let staged_truncated = truncate_diff(&mut staged_diff);
            let unstaged_truncated = truncate_diff(&mut unstaged_diff);
            changes.push(WorkspaceGitChange {
                path: slash_path(&status.path),
                staged: status.staged,
                unstaged: status.unstaged,
                untracked: status.untracked,
                staged_diff,
                unstaged_diff,
                truncated: staged_truncated || unstaged_truncated,
            });
        }
        let mut remotes = git_stdout(&root, ["remote"])?
            .lines()
            .map(str::trim)
            .filter(|remote| !remote.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        remotes.sort();
        remotes.dedup();
        Ok(WorkspaceGitDiff {
            head: git_optional(&root, ["rev-parse", "--verify", "HEAD"]),
            branch: current_branch(&root),
            detached: current_branch(&root).is_none(),
            remotes,
            changes,
        })
    }

    pub fn stage_paths(&self, task_id: &str, paths: &[String]) -> Result<WorkspaceGitDiff> {
        let descriptor = self.required_git_descriptor(task_id)?;
        let root = git_command_root(&descriptor).expect("validated by required_git_descriptor");
        let paths = scoped_repository_paths(&descriptor, paths)?;
        run_git_paths(&root, &["add", "--"], &paths)?;
        self.diff(task_id)
    }

    pub fn unstage_paths(&self, task_id: &str, paths: &[String]) -> Result<WorkspaceGitDiff> {
        let descriptor = self.required_git_descriptor(task_id)?;
        let root = git_command_root(&descriptor).expect("validated by required_git_descriptor");
        let paths = scoped_repository_paths(&descriptor, paths)?;
        if git_optional(&root, ["rev-parse", "--verify", "HEAD"]).is_some() {
            run_git_paths(&root, &["restore", "--staged", "--"], &paths)?;
        } else {
            run_git_paths(&root, &["rm", "--cached", "--ignore-unmatch", "--"], &paths)?;
        }
        self.diff(task_id)
    }

    pub fn discard_paths(&self, task_id: &str, paths: &[String]) -> Result<WorkspaceGitDiff> {
        let descriptor = self.required_git_descriptor(task_id)?;
        let root = git_command_root(&descriptor).expect("validated by required_git_descriptor");
        let statuses = git_status_entries(&root, &descriptor.relative_project)?;
        for requested in validate_scoped_paths(paths)? {
            let status = statuses
                .iter()
                .find(|status| status.path == requested)
                .ok_or_else(|| {
                    GitEnvironmentError::Invalid(format!(
                        "path is not changed: {}",
                        requested.display()
                    ))
                })?;
            if status.untracked {
                let target = descriptor.active_root.join(&requested);
                let metadata = fs::symlink_metadata(&target)?;
                if metadata.is_dir() && !metadata.file_type().is_symlink() {
                    return Err(GitEnvironmentError::Invalid(format!(
                        "refusing to recursively discard untracked directory: {}",
                        requested.display()
                    )));
                }
                fs::remove_file(target)?;
            } else {
                let repository_path = descriptor.relative_project.join(&requested);
                run_git_paths(
                    &root,
                    &["restore", "--source=HEAD", "--staged", "--worktree", "--"],
                    &[repository_path],
                )?;
            }
        }
        self.diff(task_id)
    }

    pub fn commit(&self, task_id: &str, message: &str) -> Result<WorkspaceGitCommit> {
        let descriptor = self.required_git_descriptor(task_id)?;
        let root = git_command_root(&descriptor).expect("validated by required_git_descriptor");
        let message = message.trim();
        if message.is_empty() || message.len() > 10_000 {
            return Err(GitEnvironmentError::Invalid(
                "commit message must contain 1 to 10000 bytes".into(),
            ));
        }
        if git_status(&root, ["diff", "--cached", "--quiet"])? {
            return Err(GitEnvironmentError::Invalid(
                "there are no staged changes to commit".into(),
            ));
        }
        run_git(&root, ["commit", "-m", message])?;
        let commit = git_stdout(&root, ["rev-parse", "HEAD"])?;
        let summary = git_stdout(&root, ["show", "-s", "--format=%s", "HEAD"])?;
        Ok(WorkspaceGitCommit {
            commit: commit.trim().into(),
            summary: summary.trim().into(),
        })
    }

    pub fn push(&self, task_id: &str, remote: &str, branch: &str) -> Result<WorkspaceGitDiff> {
        let descriptor = self.required_git_descriptor(task_id)?;
        let root = git_command_root(&descriptor).expect("validated by required_git_descriptor");
        let remote = remote.trim();
        let remotes = git_stdout(&root, ["remote"])?;
        if !remotes.lines().any(|candidate| candidate == remote) {
            return Err(GitEnvironmentError::Invalid(format!(
                "unknown Git remote: {remote}"
            )));
        }
        validate_branch(&root, branch)?;
        run_git(
            &root,
            [
                "push",
                "--set-upstream",
                remote,
                &format!("HEAD:refs/heads/{branch}"),
            ],
        )?;
        self.diff(task_id)
    }

    pub fn pull_request_url(&self, task_id: &str, remote: &str, branch: &str) -> Result<String> {
        let descriptor = self.required_git_descriptor(task_id)?;
        let root = git_command_root(&descriptor).expect("validated by required_git_descriptor");
        validate_branch(&root, branch)?;
        let url = git_stdout(&root, ["remote", "get-url", remote])?;
        let repository = github_repository(url.trim()).ok_or_else(|| {
            GitEnvironmentError::Invalid("pull request links currently require GitHub".into())
        })?;
        let remote_head = git_optional(
            &root,
            [
                "symbolic-ref",
                "--short",
                &format!("refs/remotes/{remote}/HEAD"),
            ],
        )
        .and_then(|value| value.split_once('/').map(|(_, branch)| branch.to_owned()))
        .unwrap_or_else(|| "main".into());
        Ok(format!(
            "https://github.com/{repository}/compare/{remote_head}...{branch}?expand=1"
        ))
    }

    fn required_git_descriptor(&self, task_id: &str) -> Result<WorkspaceDescriptor> {
        let descriptor = self
            .read(task_id)?
            .ok_or_else(|| GitEnvironmentError::StateNotFound(task_id.into()))?;
        if git_command_root(&descriptor).is_none() {
            return Err(GitEnvironmentError::NotGit(descriptor.active_root.clone()));
        }
        Ok(descriptor)
    }

    pub fn snapshot(&self, task_id: &str, label: &str) -> Result<WorkspaceSnapshot> {
        let mut descriptor = self
            .read(task_id)?
            .ok_or_else(|| GitEnvironmentError::StateNotFound(task_id.into()))?;
        let snapshot = self.snapshot_mut(&mut descriptor, label)?;
        self.persist(&descriptor)?;
        Ok(snapshot)
    }

    pub fn restore(&self, task_id: &str, snapshot_id: &str) -> Result<WorkspaceDescriptor> {
        validate_snapshot_id(snapshot_id)?;
        let mut descriptor = self
            .read(task_id)?
            .ok_or_else(|| GitEnvironmentError::StateNotFound(task_id.into()))?;
        if descriptor.environment != ExecutionEnvironment::Worktree {
            return Err(GitEnvironmentError::Invalid(
                "snapshots can only be restored into a Worktree environment".into(),
            ));
        }
        let snapshot = descriptor
            .snapshots
            .iter()
            .find(|snapshot| snapshot.id == snapshot_id)
            .cloned()
            .ok_or_else(|| {
                GitEnvironmentError::Invalid(format!("unknown snapshot `{snapshot_id}`"))
            })?;
        if self.has_changes(task_id)? {
            self.snapshot_mut(&mut descriptor, "automatic pre-restore snapshot")?;
        }
        let root = descriptor
            .worktree_root
            .clone()
            .ok_or_else(|| GitEnvironmentError::Invalid("worktree root is missing".into()))?;
        run_git(&root, ["reset", "--hard", snapshot.commit.as_str()])?;
        run_git(&root, ["clean", "-fd"])?;
        descriptor.head = Some(snapshot.commit);
        descriptor.branch = None;
        descriptor.detached = true;
        self.persist(&descriptor)?;
        Ok(descriptor)
    }

    pub fn handoff(
        &self,
        task_id: &str,
        requested_branch: Option<&str>,
        label: &str,
    ) -> Result<WorkspaceHandoff> {
        let mut descriptor = self
            .read(task_id)?
            .ok_or_else(|| GitEnvironmentError::StateNotFound(task_id.into()))?;
        if descriptor.environment != ExecutionEnvironment::Worktree {
            return Err(GitEnvironmentError::Invalid(
                "Local environments do not need a Git handoff".into(),
            ));
        }
        let snapshot = self.snapshot_mut(&mut descriptor, label)?;
        let root = descriptor
            .worktree_root
            .clone()
            .ok_or_else(|| GitEnvironmentError::Invalid("worktree root is missing".into()))?;
        let branch = requested_branch
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "codex/{}-{}",
                    &task_id[..8],
                    slug(label).unwrap_or_else(|| "handoff".into())
                )
            });
        validate_branch(&root, &branch)?;
        if git_status(
            &root,
            [
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )? {
            return Err(GitEnvironmentError::Invalid(format!(
                "branch already exists: {branch}"
            )));
        }
        run_git(&root, ["branch", branch.as_str(), snapshot.commit.as_str()])?;
        let handoff = WorkspaceHandoff {
            branch,
            commit: snapshot.commit.clone(),
            snapshot_id: snapshot.id,
            created_at_ms: now_ms(),
        };
        descriptor.handoffs.push(handoff.clone());
        self.persist(&descriptor)?;
        Ok(handoff)
    }

    /// Saves a final snapshot before unregistering a managed worktree. Snapshot
    /// metadata and private refs survive deletion of the task directory.
    pub fn cleanup(&self, task_id: &str) -> Result<Option<WorkspaceSnapshot>> {
        let Some(mut descriptor) = self.read(task_id)? else {
            return Ok(None);
        };
        let final_snapshot = if descriptor.environment == ExecutionEnvironment::Worktree
            && descriptor.worktree_root.is_some()
            && self.has_changes(task_id)?
        {
            Some(self.snapshot_mut(&mut descriptor, "final snapshot before task deletion")?)
        } else {
            None
        };
        if let (Some(repository_root), Some(worktree_root)) = (
            descriptor.repository_root.as_ref(),
            descriptor.worktree_root.as_ref(),
        ) {
            if worktree_root.exists() {
                let _ = run_git(
                    repository_root,
                    [
                        "worktree",
                        "remove",
                        "--force",
                        &worktree_root.to_string_lossy(),
                    ],
                );
            }
            let _ = run_git(repository_root, ["worktree", "prune"]);
        }
        descriptor.initialized = false;
        descriptor.active_root = descriptor
            .project_root
            .clone()
            .unwrap_or_else(|| descriptor.active_root.clone());
        descriptor.worktree_root = None;
        self.persist(&descriptor)?;
        Ok(final_snapshot)
    }

    fn create_project_environment(
        &self,
        task_id: &str,
        project_root: &Path,
        managed_workspace_root: &Path,
        environment: ExecutionEnvironment,
        created_at_ms: u64,
    ) -> Result<WorkspaceDescriptor> {
        let context = repository_context(project_root);
        if environment == ExecutionEnvironment::Local {
            let context = context.ok();
            return Ok(WorkspaceDescriptor {
                task_id: task_id.into(),
                environment,
                initialized: true,
                project_root: Some(project_root.to_path_buf()),
                repository_root: context
                    .as_ref()
                    .map(|context| context.repository_root.clone()),
                worktree_root: None,
                active_root: project_root.to_path_buf(),
                relative_project: context
                    .as_ref()
                    .map(|context| context.relative_project.clone())
                    .unwrap_or_default(),
                head: context.as_ref().and_then(|context| {
                    git_optional(&context.repository_root, ["rev-parse", "HEAD"])
                }),
                branch: context
                    .as_ref()
                    .and_then(|context| current_branch(&context.repository_root)),
                detached: false,
                created_at_ms,
                snapshots: Vec::new(),
                handoffs: Vec::new(),
            });
        }

        let context = context?;
        if managed_workspace_root.exists() {
            let mut entries = fs::read_dir(managed_workspace_root)?;
            if entries.next().is_some() {
                return Err(GitEnvironmentError::Invalid(format!(
                    "managed workspace is not empty: {}",
                    managed_workspace_root.display()
                )));
            }
            fs::remove_dir(managed_workspace_root)?;
        }
        if let Some(parent) = managed_workspace_root.parent() {
            fs::create_dir_all(parent)?;
        }
        if canonical_parent(managed_workspace_root)?
            .is_some_and(|parent| parent.starts_with(&context.repository_root))
        {
            return Err(GitEnvironmentError::Invalid(
                "managed worktree must be outside the source repository".into(),
            ));
        }
        run_git(
            &context.repository_root,
            [
                "worktree",
                "add",
                "--detach",
                &managed_workspace_root.to_string_lossy(),
                "HEAD",
            ],
        )?;
        if let Err(error) = seed_worktree(&context.repository_root, managed_workspace_root) {
            let _ = run_git(
                &context.repository_root,
                [
                    "worktree",
                    "remove",
                    "--force",
                    &managed_workspace_root.to_string_lossy(),
                ],
            );
            return Err(error);
        }
        let active_root = canonical(&managed_workspace_root.join(&context.relative_project))?;
        Ok(WorkspaceDescriptor {
            task_id: task_id.into(),
            environment,
            initialized: true,
            project_root: Some(project_root.to_path_buf()),
            repository_root: Some(context.repository_root),
            worktree_root: Some(canonical(managed_workspace_root)?),
            active_root,
            relative_project: context.relative_project,
            head: git_optional(managed_workspace_root, ["rev-parse", "HEAD"]),
            branch: current_branch(managed_workspace_root),
            detached: true,
            created_at_ms,
            snapshots: Vec::new(),
            handoffs: Vec::new(),
        })
    }

    fn resolve_existing(&self, mut descriptor: WorkspaceDescriptor) -> Result<WorkspaceDescriptor> {
        if descriptor.environment == ExecutionEnvironment::Worktree {
            let root = descriptor
                .worktree_root
                .as_ref()
                .ok_or_else(|| GitEnvironmentError::Invalid("worktree root is missing".into()))?;
            if !root.is_dir() {
                return Err(GitEnvironmentError::Invalid(format!(
                    "worktree no longer exists: {}",
                    root.display()
                )));
            }
            descriptor.active_root = canonical(&root.join(&descriptor.relative_project))?;
            descriptor.head = git_optional(root, ["rev-parse", "HEAD"]);
            descriptor.branch = current_branch(root);
            descriptor.detached = descriptor.branch.is_none();
        } else {
            descriptor.active_root = canonical_directory(&descriptor.active_root)?;
        }
        Ok(descriptor)
    }

    fn snapshot_mut(
        &self,
        descriptor: &mut WorkspaceDescriptor,
        label: &str,
    ) -> Result<WorkspaceSnapshot> {
        let root = git_command_root(descriptor)
            .ok_or_else(|| GitEnvironmentError::NotGit(descriptor.active_root.clone()))?;
        let repository_root = repository_context(&root)?.repository_root;
        let id = Uuid::now_v7().to_string();
        let reference = format!("{SNAPSHOT_REF_ROOT}/{}/{}", descriptor.task_id, id);
        let index_path = self.state_root.join("indexes").join(format!("{id}.index"));
        let _ = fs::remove_file(&index_path);
        let mut environment = vec![("GIT_INDEX_FILE", index_path.as_os_str())];
        if git_optional(&root, ["rev-parse", "--verify", "HEAD"]).is_some() {
            run_git_env(&root, ["read-tree", "HEAD"], &environment)?;
        }
        run_git_env(&root, ["add", "-A"], &environment)?;
        let included = included_paths(&root)?;
        if !included.is_empty() {
            let mut args = vec![
                OsString::from("add"),
                OsString::from("-f"),
                OsString::from("--"),
            ];
            args.extend(included.iter().map(|path| path.as_os_str().to_owned()));
            run_git_os_env(&root, args, &environment)?;
        }
        let tree = git_stdout_env(&root, ["write-tree"], &environment)?;
        let parent = git_optional(&root, ["rev-parse", "--verify", "HEAD"]);
        let mut args = vec![OsString::from("commit-tree"), OsString::from(tree.trim())];
        if let Some(parent) = parent.as_ref() {
            args.extend([OsString::from("-p"), OsString::from(parent)]);
        }
        let message = if label.trim().is_empty() {
            "Codex workspace snapshot"
        } else {
            label.trim()
        };
        args.extend([OsString::from("-m"), OsString::from(message)]);
        environment.extend([
            ("GIT_AUTHOR_NAME", OsStr::new("Codex")),
            ("GIT_AUTHOR_EMAIL", OsStr::new("noreply@openai.com")),
            ("GIT_COMMITTER_NAME", OsStr::new("Codex")),
            ("GIT_COMMITTER_EMAIL", OsStr::new("noreply@openai.com")),
        ]);
        let commit = git_stdout_os_env(&root, args, &environment)?;
        run_git(
            &repository_root,
            ["update-ref", reference.as_str(), commit.trim()],
        )?;
        let _ = fs::remove_file(index_path);
        let snapshot = WorkspaceSnapshot {
            id,
            label: message.into(),
            reference,
            commit: commit.trim().into(),
            created_at_ms: now_ms(),
        };
        descriptor.snapshots.push(snapshot.clone());
        Ok(snapshot)
    }

    fn state_path(&self, task_id: &str) -> PathBuf {
        self.state_root
            .join("states")
            .join(format!("{task_id}.json"))
    }

    fn persist(&self, descriptor: &WorkspaceDescriptor) -> Result<()> {
        let state = WorkspaceState {
            version: STATE_VERSION,
            descriptor: descriptor.clone(),
        };
        atomic_write(
            &self.state_path(&descriptor.task_id),
            &serde_json::to_vec_pretty(&state)?,
        )
    }
}

#[derive(Debug)]
struct RepositoryContext {
    repository_root: PathBuf,
    relative_project: PathBuf,
}

#[derive(Debug)]
struct IncludeRule {
    exclude: bool,
    matcher: GlobMatcher,
}

fn repository_context(project_root: &Path) -> Result<RepositoryContext> {
    let output = git_stdout(project_root, ["rev-parse", "--show-toplevel"]).map_err(|error| {
        if matches!(error, GitEnvironmentError::Git { .. }) {
            GitEnvironmentError::NotGit(project_root.to_path_buf())
        } else {
            error
        }
    })?;
    let repository_root = canonical(Path::new(output.trim()))?;
    let relative_project = project_root
        .strip_prefix(&repository_root)
        .map_err(|_| GitEnvironmentError::Invalid("project is outside its Git root".into()))?
        .to_path_buf();
    Ok(RepositoryContext {
        repository_root,
        relative_project,
    })
}

fn seed_worktree(source: &Path, worktree: &Path) -> Result<()> {
    let patch = git_output(source, ["diff", "--binary", "HEAD", "--"])?;
    if !patch.stdout.is_empty() {
        let mut command = git_command(worktree);
        let mut child = command
            .args(["apply", "--whitespace=nowarn", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?;
        child
            .stdin
            .take()
            .ok_or_else(|| GitEnvironmentError::Invalid("Git apply stdin is missing".into()))?
            .write_all(&patch.stdout)?;
        let output = child.wait_with_output()?;
        ensure_success("git apply", output)?;
    }
    let untracked = git_output(source, ["ls-files", "--others", "--exclude-standard", "-z"])?;
    for bytes in untracked
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        copy_relative_regular(source, worktree, &path_from_git(bytes)?)?;
    }
    for relative in included_paths(source)? {
        copy_relative_regular(source, worktree, &relative)?;
    }
    Ok(())
}

fn included_paths(root: &Path) -> Result<Vec<PathBuf>> {
    let include_file = root.join(".worktreeinclude");
    let contents = match fs::read_to_string(&include_file) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let rules = parse_include_rules(&contents)?;
    let mut paths = Vec::new();
    let mut total = 0_u64;
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.file_name() != ".git")
    {
        let entry = entry.map_err(|error| {
            GitEnvironmentError::Invalid(format!("scan .worktreeinclude files: {error}"))
        })?;
        if !entry.file_type().is_file() || entry.path().is_symlink() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| GitEnvironmentError::Invalid("included file escaped root".into()))?;
        let slash = slash_path(relative);
        let mut included = false;
        for rule in &rules {
            if rule.matcher.is_match(&slash) {
                included = !rule.exclude;
            }
        }
        if !included {
            continue;
        }
        let size = entry
            .metadata()
            .map_err(|error| {
                GitEnvironmentError::Invalid(format!(
                    "read included file metadata for `{slash}`: {error}"
                ))
            })?
            .len();
        if size > MAX_INCLUDED_FILE_BYTES {
            return Err(GitEnvironmentError::Invalid(format!(
                ".worktreeinclude file exceeds 100 MB: {slash}"
            )));
        }
        total = total.saturating_add(size);
        if total > MAX_INCLUDED_TOTAL_BYTES {
            return Err(GitEnvironmentError::Invalid(
                ".worktreeinclude exceeds the 1 GB total limit".into(),
            ));
        }
        paths.push(relative.to_path_buf());
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn parse_include_rules(contents: &str) -> Result<Vec<IncludeRule>> {
    let mut rules = Vec::new();
    for raw in contents.lines() {
        let raw = raw.trim();
        if raw.is_empty() || raw.starts_with('#') {
            continue;
        }
        let (exclude, raw) = raw
            .strip_prefix('!')
            .map(|rule| (true, rule))
            .unwrap_or((false, raw));
        let raw = raw.trim_start_matches('/');
        let path = Path::new(raw);
        if raw.is_empty()
            || path.is_absolute()
            || path
                .components()
                .any(|component| component == Component::ParentDir)
        {
            return Err(GitEnvironmentError::Invalid(format!(
                "invalid .worktreeinclude rule `{raw}`"
            )));
        }
        let mut pattern = raw.replace('\\', "/");
        if pattern.ends_with('/') {
            pattern.push_str("**");
        } else if !pattern.contains('/') {
            pattern = format!("**/{pattern}");
        }
        let matcher = GlobBuilder::new(&pattern)
            .literal_separator(true)
            .build()
            .map_err(|error| {
                GitEnvironmentError::Invalid(format!(
                    "invalid .worktreeinclude glob `{raw}`: {error}"
                ))
            })?
            .compile_matcher();
        rules.push(IncludeRule { exclude, matcher });
    }
    Ok(rules)
}

fn copy_relative_regular(source: &Path, target: &Path, relative: &Path) -> Result<()> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(GitEnvironmentError::Invalid(format!(
            "invalid relative workspace path: {}",
            relative.display()
        )));
    }
    let source_file = source.join(relative);
    let metadata = fs::symlink_metadata(&source_file)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Ok(());
    }
    let destination = target.join(relative);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source_file, destination)?;
    Ok(())
}

fn changed_files(root: &Path, project_prefix: &Path) -> Result<Vec<String>> {
    let output = git_output(
        root,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let records = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    let mut changed = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.len() >= 4 {
            let repository_path = path_from_git(&record[3..])?;
            if let Ok(relative) = repository_path.strip_prefix(project_prefix) {
                changed.push(slash_path(relative));
            }
            if matches!(record[0], b'R' | b'C') || matches!(record[1], b'R' | b'C') {
                index += 1;
            }
        }
        index += 1;
    }
    changed.sort();
    changed.dedup();
    Ok(changed)
}

#[derive(Debug, Clone)]
struct GitStatusEntry {
    path: PathBuf,
    staged: bool,
    unstaged: bool,
    untracked: bool,
}

fn git_status_entries(root: &Path, project_prefix: &Path) -> Result<Vec<GitStatusEntry>> {
    let output = git_output(
        root,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let records = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.len() >= 4 {
            let repository_path = path_from_git(&record[3..])?;
            if let Ok(path) = repository_path.strip_prefix(project_prefix) {
                let x = record[0];
                let y = record[1];
                entries.push(GitStatusEntry {
                    path: path.to_path_buf(),
                    staged: x != b' ' && x != b'?',
                    unstaged: y != b' ' && y != b'?',
                    untracked: x == b'?' && y == b'?',
                });
            }
            if matches!(record[0], b'R' | b'C') || matches!(record[1], b'R' | b'C') {
                index += 1;
            }
        }
        index += 1;
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

fn git_diff(root: &Path, staged: bool, path: &Path) -> Result<String> {
    let mut arguments = vec![
        OsString::from("diff"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-color"),
    ];
    if staged {
        arguments.push(OsString::from("--cached"));
    }
    arguments.push(OsString::from("--"));
    arguments.push(path.as_os_str().to_owned());
    git_stdout_os_env(root, arguments, &[])
}

fn untracked_diff(path: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Ok("Binary or non-regular untracked file\n".into());
    }
    let bytes = fs::read(path)?;
    if bytes.iter().take(MAX_DIFF_BYTES).any(|byte| *byte == 0) {
        return Ok("Binary untracked file\n".into());
    }
    let body = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_DIFF_BYTES)]);
    let mut diff = format!(
        "--- /dev/null\n+++ b/{}\n",
        path.file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_default()
    );
    for line in body.lines() {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    Ok(diff)
}

fn truncate_diff(diff: &mut String) -> bool {
    if diff.len() <= MAX_DIFF_BYTES {
        return false;
    }
    let mut boundary = MAX_DIFF_BYTES;
    while !diff.is_char_boundary(boundary) {
        boundary -= 1;
    }
    diff.truncate(boundary);
    diff.push_str("\n… diff truncated …\n");
    true
}

fn validate_scoped_paths(paths: &[String]) -> Result<Vec<PathBuf>> {
    if paths.is_empty() {
        return Err(GitEnvironmentError::Invalid(
            "at least one path must be selected".into(),
        ));
    }
    let mut validated = Vec::new();
    for raw in paths {
        let path = Path::new(raw);
        if raw.trim().is_empty()
            || path.is_absolute()
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
        {
            return Err(GitEnvironmentError::Invalid(format!(
                "invalid workspace path: {raw}"
            )));
        }
        validated.push(path.to_path_buf());
    }
    validated.sort();
    validated.dedup();
    Ok(validated)
}

fn scoped_repository_paths(
    descriptor: &WorkspaceDescriptor,
    paths: &[String],
) -> Result<Vec<PathBuf>> {
    Ok(validate_scoped_paths(paths)?
        .into_iter()
        .map(|path| descriptor.relative_project.join(path))
        .collect())
}

fn run_git_paths(root: &Path, prefix: &[&str], paths: &[PathBuf]) -> Result<()> {
    let mut arguments = prefix.iter().map(OsString::from).collect::<Vec<OsString>>();
    arguments.extend(paths.iter().map(|path| path.as_os_str().to_owned()));
    run_git_os_env(root, arguments, &[])
}

fn github_repository(remote: &str) -> Option<String> {
    let path = if let Some(path) = remote.strip_prefix("git@github.com:") {
        path
    } else if let Some(path) = remote.strip_prefix("ssh://git@github.com/") {
        path
    } else {
        remote.strip_prefix("https://github.com/")?
    };
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = path.split('/');
    let owner = parts.next()?;
    let repository = parts.next()?;
    if owner.is_empty() || repository.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{repository}"))
}

fn git_command_root(descriptor: &WorkspaceDescriptor) -> Option<PathBuf> {
    match descriptor.environment {
        ExecutionEnvironment::Worktree => descriptor.worktree_root.clone(),
        ExecutionEnvironment::Local => descriptor.repository_root.clone(),
    }
}

fn validate_task_id(task_id: &str) -> Result<()> {
    let parsed = Uuid::parse_str(task_id)
        .map_err(|_| GitEnvironmentError::Invalid("task id must be a UUID".into()))?;
    if parsed.to_string() != task_id.to_ascii_lowercase() {
        return Err(GitEnvironmentError::Invalid(
            "task id must use canonical UUID form".into(),
        ));
    }
    Ok(())
}

fn validate_snapshot_id(snapshot_id: &str) -> Result<()> {
    Uuid::parse_str(snapshot_id)
        .map(|_| ())
        .map_err(|_| GitEnvironmentError::Invalid("snapshot id must be a UUID".into()))
}

fn validate_branch(root: &Path, branch: &str) -> Result<()> {
    if branch.trim() != branch || branch.is_empty() {
        return Err(GitEnvironmentError::Invalid(
            "branch name must not be empty or padded".into(),
        ));
    }
    run_git(root, ["check-ref-format", "--branch", branch])
}

fn current_branch(root: &Path) -> Option<String> {
    let branch = git_optional(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    (!branch.trim().is_empty()).then(|| branch.trim().into())
}

fn slug(label: &str) -> Option<String> {
    let slug = label
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let slug = slug
        .split('-')
        .filter(|part| !part.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    (!slug.is_empty()).then_some(slug)
}

fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(["-c", &format!("core.hooksPath={DISABLED_HOOKS_PATH}")]);
    command
}

fn run_git<I, S>(root: &Path, arguments: I) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = git_output(root, arguments)?;
    ensure_success("git", output)
}

fn run_git_env<I, S>(root: &Path, arguments: I, environment: &[(&str, &OsStr)]) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = git_output_env(root, arguments, environment)?;
    ensure_success("git", output)
}

fn run_git_os_env(
    root: &Path,
    arguments: Vec<OsString>,
    environment: &[(&str, &OsStr)],
) -> Result<()> {
    let output = git_output_env(root, arguments, environment)?;
    ensure_success("git", output)
}

fn git_stdout<I, S>(root: &Path, arguments: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    git_stdout_env(root, arguments, &[])
}

fn git_stdout_env<I, S>(root: &Path, arguments: I, environment: &[(&str, &OsStr)]) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = git_output_env(root, arguments, environment)?;
    String::from_utf8(output.stdout)
        .map(|output| output.trim().into())
        .map_err(|_| GitEnvironmentError::Invalid("Git output was not UTF-8".into()))
}

fn git_stdout_os_env(
    root: &Path,
    arguments: Vec<OsString>,
    environment: &[(&str, &OsStr)],
) -> Result<String> {
    let output = git_output_env(root, arguments, environment)?;
    String::from_utf8(output.stdout)
        .map(|output| output.trim().into())
        .map_err(|_| GitEnvironmentError::Invalid("Git output was not UTF-8".into()))
}

fn git_output<I, S>(root: &Path, arguments: I) -> Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    git_output_env(root, arguments, &[])
}

fn git_output_env<I, S>(root: &Path, arguments: I, environment: &[(&str, &OsStr)]) -> Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let arguments = arguments
        .into_iter()
        .map(|argument| argument.as_ref().to_owned())
        .collect::<Vec<_>>();
    let command_text = format!(
        "git {}",
        arguments
            .iter()
            .map(|argument| argument.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ")
    );
    let mut command = git_command(root);
    command.args(&arguments);
    for (key, value) in environment {
        command.env(key, value);
    }
    let output = command.output()?;
    if !output.status.success() {
        return Err(GitEnvironmentError::Git {
            command: command_text,
            message: String::from_utf8_lossy(&output.stderr).trim().into(),
        });
    }
    Ok(output)
}

fn git_optional<I, S>(root: &Path, arguments: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    git_stdout(root, arguments).ok()
}

fn git_status<I, S>(root: &Path, arguments: I) -> Result<bool>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let arguments = arguments
        .into_iter()
        .map(|argument| argument.as_ref().to_owned())
        .collect::<Vec<_>>();
    let mut command = git_command(root);
    command.args(&arguments);
    let status = command.status()?;
    Ok(status.success())
}

fn ensure_success(command: &str, output: Output) -> Result<()> {
    if output.status.success() {
        Ok(())
    } else {
        Err(GitEnvironmentError::Git {
            command: command.into(),
            message: String::from_utf8_lossy(&output.stderr).trim().into(),
        })
    }
}

fn path_from_git(bytes: &[u8]) -> Result<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Ok(PathBuf::from(OsStr::from_bytes(bytes)))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec())
            .map(PathBuf::from)
            .map_err(|_| GitEnvironmentError::Invalid("Git path was not UTF-8".into()))
    }
}

fn slash_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn canonical(path: &Path) -> Result<PathBuf> {
    dunce::canonicalize(path).map_err(GitEnvironmentError::Io)
}

fn canonical_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_dir() {
        return Err(GitEnvironmentError::Invalid(format!(
            "directory does not exist: {}",
            path.display()
        )));
    }
    canonical(path)
}

fn canonical_parent(path: &Path) -> Result<Option<PathBuf>> {
    path.parent()
        .filter(|parent| parent.exists())
        .map(canonical)
        .transpose()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| GitEnvironmentError::Invalid("state path has no parent".into()))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("workspace-state"),
        Uuid::new_v4()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(contents)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn run(root: &Path, arguments: &[&str]) {
        let status = Command::new("git")
            .args(["-C"])
            .arg(root)
            .args(arguments)
            .status()
            .unwrap();
        assert!(status.success(), "git failed: {arguments:?}");
    }

    fn repository() -> (TempDir, PathBuf) {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("repository");
        fs::create_dir(&root).unwrap();
        run(&root, &["init", "-q", "--initial-branch=main"]);
        run(&root, &["config", "core.autocrlf", "false"]);
        run(&root, &["config", "user.name", "Test"]);
        run(&root, &["config", "user.email", "test@example.invalid"]);
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        run(&root, &["add", ".gitignore", "tracked.txt"]);
        run(
            &root,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-qm",
                "base",
            ],
        );
        (temporary, root)
    }

    #[test]
    fn detached_worktree_seeds_dirty_untracked_and_included_files_once() {
        let (temporary, root) = repository();
        fs::write(root.join("tracked.txt"), "dirty\n").unwrap();
        fs::write(root.join("untracked.txt"), "untracked\n").unwrap();
        fs::create_dir(root.join("ignored")).unwrap();
        fs::write(root.join("ignored/include.env"), "included\n").unwrap();
        fs::write(root.join("ignored/secret.env"), "secret\n").unwrap();
        fs::write(
            root.join(".worktreeinclude"),
            "ignored/*.env\n!ignored/secret.env\n",
        )
        .unwrap();
        let runtime = WorkspaceRuntime::open(temporary.path().join("state")).unwrap();
        let task_id = Uuid::now_v7().to_string();
        let worktree = temporary.path().join("task/workspace");
        let descriptor = runtime
            .resolve(
                &task_id,
                Some(&root),
                &worktree,
                Some(ExecutionEnvironment::Worktree),
            )
            .unwrap();
        assert_eq!(descriptor.environment, ExecutionEnvironment::Worktree);
        assert!(descriptor.detached);
        assert_eq!(
            fs::read_to_string(worktree.join("tracked.txt")).unwrap(),
            "dirty\n"
        );
        assert!(worktree.join("untracked.txt").is_file());
        assert!(worktree.join("ignored/include.env").is_file());
        assert!(!worktree.join("ignored/secret.env").exists());
        let reopened = runtime
            .resolve(
                &task_id,
                Some(&root),
                &worktree,
                Some(ExecutionEnvironment::Local),
            )
            .unwrap();
        assert_eq!(reopened.active_root, descriptor.active_root);
        runtime.cleanup(&task_id).unwrap();
    }

    #[test]
    fn snapshots_restore_without_touching_user_index_and_handoff_creates_branch() {
        let (temporary, root) = repository();
        let runtime = WorkspaceRuntime::open(temporary.path().join("state")).unwrap();
        let task_id = Uuid::now_v7().to_string();
        let worktree = temporary.path().join("task/workspace");
        runtime
            .resolve(
                &task_id,
                Some(&root),
                &worktree,
                Some(ExecutionEnvironment::Worktree),
            )
            .unwrap();
        fs::write(worktree.join("tracked.txt"), "snapshot\n").unwrap();
        fs::write(worktree.join("new.txt"), "new\n").unwrap();
        let snapshot = runtime.snapshot(&task_id, "checkpoint").unwrap();
        fs::write(worktree.join("tracked.txt"), "later\n").unwrap();
        runtime.restore(&task_id, &snapshot.id).unwrap();
        assert_eq!(
            fs::read_to_string(worktree.join("tracked.txt")).unwrap(),
            "snapshot\n"
        );
        assert!(worktree.join("new.txt").is_file());
        let handoff = runtime
            .handoff(&task_id, Some("codex/test-handoff"), "ready")
            .unwrap();
        assert_eq!(
            git_stdout(&root, ["rev-parse", "codex/test-handoff"]).unwrap(),
            handoff.commit
        );
        runtime.cleanup(&task_id).unwrap();
    }

    #[test]
    fn local_and_worktree_switch_reuses_one_managed_worktree() {
        let (temporary, root) = repository();
        let runtime = WorkspaceRuntime::open(temporary.path().join("state")).unwrap();
        let task_id = Uuid::now_v7().to_string();
        let worktree = temporary.path().join("task/workspace");
        let local = runtime
            .resolve(
                &task_id,
                Some(&root),
                &worktree,
                Some(ExecutionEnvironment::Local),
            )
            .unwrap();
        assert_eq!(local.active_root, canonical(&root).unwrap());
        let isolated = runtime
            .set_environment(&task_id, &root, &worktree, ExecutionEnvironment::Worktree)
            .unwrap();
        let isolated_root = isolated.active_root.clone();
        let local = runtime
            .set_environment(&task_id, &root, &worktree, ExecutionEnvironment::Local)
            .unwrap();
        assert_eq!(local.active_root, canonical(&root).unwrap());
        let isolated = runtime
            .set_environment(&task_id, &root, &worktree, ExecutionEnvironment::Worktree)
            .unwrap();
        assert_eq!(isolated.active_root, isolated_root);
        runtime.cleanup(&task_id).unwrap();
    }

    #[test]
    fn cleanup_saves_dirty_final_snapshot_before_removing_worktree() {
        let (temporary, root) = repository();
        let runtime = WorkspaceRuntime::open(temporary.path().join("state")).unwrap();
        let task_id = Uuid::now_v7().to_string();
        let worktree = temporary.path().join("task/workspace");
        runtime
            .resolve(
                &task_id,
                Some(&root),
                &worktree,
                Some(ExecutionEnvironment::Worktree),
            )
            .unwrap();
        fs::write(worktree.join("tracked.txt"), "final\n").unwrap();
        let snapshot = runtime.cleanup(&task_id).unwrap().unwrap();
        assert!(!worktree.exists());
        assert_eq!(
            git_stdout(&root, ["show", &format!("{}:tracked.txt", snapshot.commit)]).unwrap(),
            "final"
        );
        assert_eq!(runtime.read(&task_id).unwrap().unwrap().snapshots.len(), 1);
    }

    #[test]
    fn adopts_existing_detached_worktree_without_moving_it() {
        let (temporary, root) = repository();
        let legacy = temporary.path().join("legacy-code-workspace");
        run(
            &root,
            &[
                "worktree",
                "add",
                "--detach",
                legacy.to_str().unwrap(),
                "HEAD",
            ],
        );
        fs::write(legacy.join("tracked.txt"), "legacy changes\n").unwrap();
        let runtime = WorkspaceRuntime::open(temporary.path().join("state")).unwrap();
        let task_id = Uuid::now_v7().to_string();

        let descriptor = runtime.adopt(&task_id, Some(&root), &legacy).unwrap();

        assert_eq!(descriptor.environment, ExecutionEnvironment::Worktree);
        let canonical_legacy = canonical(&legacy).unwrap();
        assert_eq!(
            descriptor.worktree_root.as_deref(),
            Some(canonical_legacy.as_path())
        );
        assert_eq!(descriptor.active_root, canonical_legacy);
        assert!(descriptor.detached);
        assert!(descriptor.branch.is_none());
        assert!(runtime
            .changed_files(&task_id)
            .unwrap()
            .contains(&"tracked.txt".into()));
        runtime.cleanup(&task_id).unwrap();
    }

    #[test]
    fn diff_stage_unstage_and_discard_are_path_scoped() {
        let (temporary, root) = repository();
        let runtime = WorkspaceRuntime::open(temporary.path().join("state")).unwrap();
        let task_id = Uuid::now_v7().to_string();
        runtime
            .resolve(
                &task_id,
                Some(&root),
                &temporary.path().join("unused"),
                Some(ExecutionEnvironment::Local),
            )
            .unwrap();
        fs::write(root.join("tracked.txt"), "changed\n").unwrap();
        fs::write(root.join("keep.txt"), "keep\n").unwrap();

        let diff = runtime.diff(&task_id).unwrap();
        assert_eq!(diff.changes.len(), 2);
        assert!(diff
            .changes
            .iter()
            .find(|change| change.path == "tracked.txt")
            .unwrap()
            .unstaged_diff
            .contains("+changed"));

        let staged = runtime
            .stage_paths(&task_id, &["tracked.txt".into()])
            .unwrap();
        assert!(
            staged
                .changes
                .iter()
                .find(|change| change.path == "tracked.txt")
                .unwrap()
                .staged
        );
        runtime
            .unstage_paths(&task_id, &["tracked.txt".into()])
            .unwrap();
        runtime
            .discard_paths(&task_id, &["tracked.txt".into()])
            .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("tracked.txt")).unwrap(),
            "base\n"
        );
        assert_eq!(fs::read_to_string(root.join("keep.txt")).unwrap(), "keep\n");
    }

    #[test]
    fn commit_push_and_pull_request_url_never_force_update() {
        let (temporary, root) = repository();
        let runtime = WorkspaceRuntime::open(temporary.path().join("state")).unwrap();
        let task_id = Uuid::now_v7().to_string();
        runtime
            .resolve(
                &task_id,
                Some(&root),
                &temporary.path().join("unused"),
                Some(ExecutionEnvironment::Local),
            )
            .unwrap();
        fs::write(root.join("tracked.txt"), "committed\n").unwrap();
        runtime
            .stage_paths(&task_id, &["tracked.txt".into()])
            .unwrap();
        let commit = runtime.commit(&task_id, "test commit").unwrap();
        assert_eq!(commit.summary, "test commit");

        let bare = temporary.path().join("remote.git");
        run(
            temporary.path(),
            &["init", "--bare", "-q", bare.to_str().unwrap()],
        );
        run(&root, &["remote", "add", "origin", bare.to_str().unwrap()]);
        runtime.push(&task_id, "origin", "codex/test").unwrap();
        assert_eq!(
            git_stdout(&bare, ["rev-parse", "refs/heads/codex/test"]).unwrap(),
            commit.commit
        );
        run(
            &root,
            &[
                "remote",
                "set-url",
                "origin",
                "git@github.com:openai/codex.git",
            ],
        );
        assert_eq!(
            runtime
                .pull_request_url(&task_id, "origin", "codex/test")
                .unwrap(),
            "https://github.com/openai/codex/compare/main...codex/test?expand=1"
        );
        assert!(runtime
            .push(&task_id, "missing", "codex/test")
            .unwrap_err()
            .to_string()
            .contains("unknown Git remote"));
    }
}
