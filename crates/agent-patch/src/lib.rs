//! Codex-compatible `apply_patch` parser and atomic filesystem transaction.
//!
//! Parser and fuzzy matching behavior are source-level adaptations of OpenAI
//! Codex `rust-v0.145.0`. The commit layer intentionally strengthens the
//! upstream implementation by validating every hunk before changing disk and
//! rolling back the complete multi-file transaction on commit failure.

mod parser;
mod seek_sequence;
mod streaming_parser;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

pub use parser::{Hunk, ParseError, UpdateFileChunk, parse_patch};
use serde::{Deserialize, Serialize};
use similar::TextDiff;
pub use streaming_parser::StreamingPatchParser;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, PartialEq)]
pub struct ApplyPatchArgs {
    pub patch: String,
    pub hunks: Vec<Hunk>,
    pub workdir: Option<String>,
    pub environment_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum PatchError {
    #[error(transparent)]
    Parse(#[from] ParseError),
    #[error("invalid patch path `{path}`: {message}")]
    InvalidPath { path: String, message: String },
    #[error("failed to read `{path}`: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("failed to apply patch to `{path}`: {message}")]
    Apply { path: PathBuf, message: String },
    #[error("failed to commit patch transaction: {0}")]
    Commit(String),
    #[error("No files were modified.")]
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PatchChangeKind {
    Add,
    Delete,
    Update { move_path: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileUpdateChange {
    pub path: String,
    pub kind: PatchChangeKind,
    pub diff: String,
}

#[derive(Debug, Clone)]
struct FileState {
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct PatchPlan {
    root: PathBuf,
    states: BTreeMap<PathBuf, FileState>,
    changes: Vec<FileUpdateChange>,
    summary: String,
    unified_diff: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedPatch {
    pub changes: Vec<FileUpdateChange>,
    pub summary: String,
    pub unified_diff: String,
}

#[derive(Debug, Clone)]
pub struct TurnDiffTracker {
    root: PathBuf,
    files: BTreeMap<PathBuf, FileState>,
}

impl TurnDiffTracker {
    pub fn new(cwd: impl AsRef<Path>) -> Result<Self, PatchError> {
        let root = cwd
            .as_ref()
            .canonicalize()
            .map_err(|source| PatchError::Read {
                path: cwd.as_ref().to_path_buf(),
                source,
            })?;
        Ok(Self {
            root,
            files: BTreeMap::new(),
        })
    }

    pub fn record(&mut self, plan: &PatchPlan) -> String {
        for (path, state) in &plan.states {
            let entry = self.files.entry(path.clone()).or_insert_with(|| FileState {
                before: state.before.clone(),
                after: state.before.clone(),
            });
            entry.after.clone_from(&state.after);
        }
        self.files.retain(|_, state| state.before != state.after);
        aggregate_diff(&self.root, &self.files)
    }

    pub fn diff(&self) -> String {
        aggregate_diff(&self.root, &self.files)
    }
}

impl PatchPlan {
    pub fn preview(cwd: impl AsRef<Path>, patch: &str) -> Result<Self, PatchError> {
        let parsed = parse_patch(patch)?;
        let root = cwd
            .as_ref()
            .canonicalize()
            .map_err(|source| PatchError::Read {
                path: cwd.as_ref().to_path_buf(),
                source,
            })?;
        if parsed.hunks.is_empty() {
            return Err(PatchError::Empty);
        }

        let mut states = BTreeMap::<PathBuf, FileState>::new();
        let mut changes = Vec::with_capacity(parsed.hunks.len());
        let mut summary_lines = vec!["Success. Updated the following files:".to_string()];

        for hunk in &parsed.hunks {
            match hunk {
                Hunk::AddFile { path, contents } => {
                    let target = resolve_path(&root, path.as_path())?;
                    let before = current_bytes(&target, &mut states)?;
                    let after = contents.as_bytes().to_vec();
                    states.insert(
                        target.clone(),
                        FileState {
                            before: before.clone(),
                            after: Some(after.clone()),
                        },
                    );
                    let display = display_path(&root, &target);
                    changes.push(FileUpdateChange {
                        path: display.clone(),
                        kind: PatchChangeKind::Add,
                        diff: unified_diff(&display, before.as_deref(), Some(&after)),
                    });
                    summary_lines.push(format!("A {display}"));
                }
                Hunk::DeleteFile { path } => {
                    let target = resolve_path(&root, path.as_path())?;
                    let before =
                        current_bytes(&target, &mut states)?.ok_or_else(|| PatchError::Apply {
                            path: target.clone(),
                            message: "file does not exist".into(),
                        })?;
                    states.insert(
                        target.clone(),
                        FileState {
                            before: original_bytes(&target, &states)?,
                            after: None,
                        },
                    );
                    let display = display_path(&root, &target);
                    changes.push(FileUpdateChange {
                        path: display.clone(),
                        kind: PatchChangeKind::Delete,
                        diff: unified_diff(&display, Some(&before), None),
                    });
                    summary_lines.push(format!("D {display}"));
                }
                Hunk::UpdateFile {
                    path,
                    move_path,
                    chunks,
                } => {
                    let source = resolve_path(&root, path.as_path())?;
                    let before =
                        current_bytes(&source, &mut states)?.ok_or_else(|| PatchError::Apply {
                            path: source.clone(),
                            message: "file does not exist".into(),
                        })?;
                    let before_text =
                        String::from_utf8(before.clone()).map_err(|_| PatchError::Apply {
                            path: source.clone(),
                            message: "file is not valid UTF-8".into(),
                        })?;
                    let after_text = apply_chunks(&source, &before_text, chunks.as_slice())?;
                    let after = after_text.into_bytes();
                    let source_original = original_bytes(&source, &states)?;
                    let destination = move_path
                        .as_ref()
                        .map(|path| resolve_path(&root, path.as_path()))
                        .transpose()?;
                    if let Some(destination) = &destination {
                        if destination != &source {
                            let destination_original = original_bytes(destination, &states)?;
                            states.insert(
                                source.clone(),
                                FileState {
                                    before: source_original,
                                    after: None,
                                },
                            );
                            states.insert(
                                destination.clone(),
                                FileState {
                                    before: destination_original,
                                    after: Some(after.clone()),
                                },
                            );
                        } else {
                            states.insert(
                                source.clone(),
                                FileState {
                                    before: source_original,
                                    after: Some(after.clone()),
                                },
                            );
                        }
                    } else {
                        states.insert(
                            source.clone(),
                            FileState {
                                before: source_original,
                                after: Some(after.clone()),
                            },
                        );
                    }
                    let display = display_path(&root, &source);
                    let move_display = destination.as_ref().map(|path| display_path(&root, path));
                    changes.push(FileUpdateChange {
                        path: display.clone(),
                        kind: PatchChangeKind::Update {
                            move_path: move_display,
                        },
                        diff: unified_diff(&display, Some(&before), Some(&after)),
                    });
                    summary_lines.push(format!("M {display}"));
                }
            }
        }

        states.retain(|_, state| state.before != state.after);
        if states.is_empty() {
            return Err(PatchError::Empty);
        }
        let unified_diff = aggregate_diff(&root, &states);
        Ok(Self {
            root,
            states,
            changes,
            summary: format!("{}\n", summary_lines.join("\n")),
            unified_diff,
        })
    }

    pub fn changes(&self) -> &[FileUpdateChange] {
        &self.changes
    }

    pub fn summary(&self) -> &str {
        &self.summary
    }

    pub fn unified_diff(&self) -> &str {
        &self.unified_diff
    }

    pub fn apply(&self) -> Result<AppliedPatch, PatchError> {
        commit_transaction(&self.root, &self.states)?;
        Ok(AppliedPatch {
            changes: self.changes.clone(),
            summary: self.summary.clone(),
            unified_diff: self.unified_diff.clone(),
        })
    }
}

pub fn apply_patch_atomic(cwd: impl AsRef<Path>, patch: &str) -> Result<AppliedPatch, PatchError> {
    PatchPlan::preview(cwd, patch)?.apply()
}

fn original_bytes(
    path: &Path,
    states: &BTreeMap<PathBuf, FileState>,
) -> Result<Option<Vec<u8>>, PatchError> {
    if let Some(state) = states.get(path) {
        return Ok(state.before.clone());
    }
    read_optional(path)
}

fn current_bytes(
    path: &Path,
    states: &mut BTreeMap<PathBuf, FileState>,
) -> Result<Option<Vec<u8>>, PatchError> {
    if let Some(state) = states.get(path) {
        return Ok(state.after.clone());
    }
    let before = read_optional(path)?;
    states.insert(
        path.to_path_buf(),
        FileState {
            before: before.clone(),
            after: before.clone(),
        },
    );
    Ok(before)
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, PatchError> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Err(PatchError::Apply {
            path: path.to_path_buf(),
            message: "path is a directory".into(),
        }),
        Ok(_) => fs::read(path).map(Some).map_err(|source| PatchError::Read {
            path: path.to_path_buf(),
            source,
        }),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(PatchError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn resolve_path(root: &Path, input: &Path) -> Result<PathBuf, PatchError> {
    let candidate = if input.is_absolute() {
        input.to_path_buf()
    } else {
        root.join(input)
    };
    let normalized = lexical_normalize(&candidate).ok_or_else(|| PatchError::InvalidPath {
        path: input.display().to_string(),
        message: "path escapes the working directory".into(),
    })?;
    if !normalized.starts_with(root) {
        return Err(PatchError::InvalidPath {
            path: input.display().to_string(),
            message: "path escapes the working directory".into(),
        });
    }
    let mut ancestor = normalized.as_path();
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or_else(|| PatchError::InvalidPath {
            path: input.display().to_string(),
            message: "path has no existing parent".into(),
        })?;
    }
    let canonical = ancestor.canonicalize().map_err(|source| PatchError::Read {
        path: ancestor.to_path_buf(),
        source,
    })?;
    if !canonical.starts_with(root) {
        return Err(PatchError::InvalidPath {
            path: input.display().to_string(),
            message: "symlink resolves outside the working directory".into(),
        });
    }
    Ok(normalized)
}

fn lexical_normalize(path: &Path) -> Option<PathBuf> {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => result.push(prefix.as_os_str()),
            Component::RootDir => result.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    return None;
                }
            }
            Component::Normal(part) => result.push(part),
        }
    }
    Some(result)
}

fn apply_chunks(
    path: &Path,
    original: &str,
    chunks: &[UpdateFileChunk],
) -> Result<String, PatchError> {
    let mut original_lines: Vec<String> = original.split('\n').map(String::from).collect();
    if original_lines.last().is_some_and(String::is_empty) {
        original_lines.pop();
    }
    let replacements = compute_replacements(&original_lines, path, chunks)?;
    for (start, old_len, new_lines) in replacements.iter().rev() {
        original_lines.splice(*start..*start + *old_len, new_lines.clone());
    }
    if !original_lines.last().is_some_and(String::is_empty) {
        original_lines.push(String::new());
    }
    Ok(original_lines.join("\n"))
}

fn compute_replacements(
    original: &[String],
    path: &Path,
    chunks: &[UpdateFileChunk],
) -> Result<Vec<(usize, usize, Vec<String>)>, PatchError> {
    let mut replacements = Vec::new();
    let mut line_index = 0;
    for chunk in chunks {
        if let Some(context) = &chunk.change_context {
            line_index = seek_sequence::seek_sequence(
                original,
                std::slice::from_ref(context),
                line_index,
                false,
            )
            .map(|index| index + 1)
            .ok_or_else(|| PatchError::Apply {
                path: path.to_path_buf(),
                message: format!("Failed to find context '{context}'"),
            })?;
        }
        if chunk.old_lines.is_empty() {
            replacements.push((original.len(), 0, chunk.new_lines.clone()));
            continue;
        }
        let mut pattern = chunk.old_lines.as_slice();
        let mut replacement = chunk.new_lines.as_slice();
        let mut found =
            seek_sequence::seek_sequence(original, pattern, line_index, chunk.is_end_of_file);
        if found.is_none() && pattern.last().is_some_and(String::is_empty) {
            pattern = &pattern[..pattern.len() - 1];
            if replacement.last().is_some_and(String::is_empty) {
                replacement = &replacement[..replacement.len() - 1];
            }
            found =
                seek_sequence::seek_sequence(original, pattern, line_index, chunk.is_end_of_file);
        }
        let start = found.ok_or_else(|| PatchError::Apply {
            path: path.to_path_buf(),
            message: format!(
                "Failed to find expected lines:\n{}",
                chunk.old_lines.join("\n")
            ),
        })?;
        replacements.push((start, pattern.len(), replacement.to_vec()));
        line_index = start + pattern.len();
    }
    replacements.sort_by_key(|(start, _, _)| *start);
    Ok(replacements)
}

fn unified_diff(path: &str, before: Option<&[u8]>, after: Option<&[u8]>) -> String {
    let before = before
        .and_then(|value| std::str::from_utf8(value).ok())
        .unwrap_or_default();
    let after = after
        .and_then(|value| std::str::from_utf8(value).ok())
        .unwrap_or_default();
    TextDiff::from_lines(before, after)
        .unified_diff()
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string()
}

fn aggregate_diff(root: &Path, states: &BTreeMap<PathBuf, FileState>) -> String {
    states
        .iter()
        .map(|(path, state)| {
            unified_diff(
                &display_path(root, path),
                state.before.as_deref(),
                state.after.as_deref(),
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

fn display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn commit_transaction(
    root: &Path,
    states: &BTreeMap<PathBuf, FileState>,
) -> Result<(), PatchError> {
    let transaction = format!(".tietiezhi-patch-{}", Uuid::new_v4());
    let staging = root.join(transaction);
    fs::create_dir(&staging).map_err(|error| PatchError::Commit(error.to_string()))?;
    let mut staged = BTreeMap::<PathBuf, PathBuf>::new();
    for (index, (path, state)) in states.iter().enumerate() {
        if let Some(after) = &state.after {
            let temp = staging.join(format!("write-{index}"));
            fs::write(&temp, after).map_err(|error| {
                let _ = fs::remove_dir_all(&staging);
                PatchError::Commit(format!("failed to stage {}: {error}", path.display()))
            })?;
            staged.insert(path.clone(), temp);
        }
    }

    let mut committed = Vec::<PathBuf>::new();
    let mut backups = BTreeMap::<PathBuf, PathBuf>::new();
    let mut created_dirs = BTreeSet::<PathBuf>::new();
    for (index, (path, state)) in states.iter().enumerate() {
        committed.push(path.clone());
        if let Err(error) = commit_one(
            path,
            state,
            index,
            &staging,
            &mut staged,
            &mut backups,
            &mut created_dirs,
        ) {
            rollback(&committed, &backups, &created_dirs);
            let _ = fs::remove_dir_all(&staging);
            return Err(PatchError::Commit(error));
        }
    }
    let _ = fs::remove_dir_all(&staging);
    Ok(())
}

fn commit_one(
    path: &Path,
    state: &FileState,
    index: usize,
    staging: &Path,
    staged: &mut BTreeMap<PathBuf, PathBuf>,
    backups: &mut BTreeMap<PathBuf, PathBuf>,
    created_dirs: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    if state.before.is_some() && path.exists() {
        let backup = staging.join(format!("backup-{index}"));
        fs::rename(path, &backup)
            .map_err(|error| format!("failed to back up {}: {error}", path.display()))?;
        backups.insert(path.to_path_buf(), backup);
    }
    if state.after.is_some() {
        ensure_parent(path, created_dirs)?;
        let temp = staged
            .remove(path)
            .ok_or_else(|| format!("missing staged file for {}", path.display()))?;
        fs::rename(&temp, path)
            .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    }
    Ok(())
}

fn ensure_parent(path: &Path, created: &mut BTreeSet<PathBuf>) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let mut missing = Vec::new();
    let mut cursor = parent;
    while !cursor.exists() {
        missing.push(cursor.to_path_buf());
        cursor = cursor
            .parent()
            .ok_or_else(|| format!("cannot create parent for {}", path.display()))?;
    }
    for directory in missing.iter().rev() {
        fs::create_dir(directory)
            .map_err(|error| format!("failed to create {}: {error}", directory.display()))?;
        created.insert(directory.clone());
    }
    Ok(())
}

fn rollback(
    committed: &[PathBuf],
    backups: &BTreeMap<PathBuf, PathBuf>,
    created_dirs: &BTreeSet<PathBuf>,
) {
    for path in committed.iter().rev() {
        let _ = fs::remove_file(path);
        if let Some(backup) = backups.get(path) {
            let _ = fs::rename(backup, path);
        }
    }
    for directory in created_dirs.iter().rev() {
        let _ = fs::remove_dir(directory);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::tempdir;

    #[test]
    fn adds_updates_deletes_and_moves_atomically() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("old.txt"), "alpha\nbeta\n").unwrap();
        fs::write(dir.path().join("delete.txt"), "gone\n").unwrap();
        let patch = "*** Begin Patch\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-alpha\n+omega\n beta\n*** Delete File: delete.txt\n*** Add File: nested/new.txt\n+new\n*** End Patch";
        let result = apply_patch_atomic(dir.path(), patch).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("moved.txt")).unwrap(),
            "omega\nbeta\n"
        );
        assert!(!dir.path().join("old.txt").exists());
        assert!(!dir.path().join("delete.txt").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("nested/new.txt")).unwrap(),
            "new\n"
        );
        assert_eq!(result.changes.len(), 3);
        assert!(result.unified_diff.contains("omega"));
    }

    #[test]
    fn validation_failure_does_not_mutate_any_file() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("keep.txt"), "before\n").unwrap();
        let patch = "*** Begin Patch\n*** Update File: keep.txt\n@@\n-before\n+after\n*** Update File: missing.txt\n@@\n-nope\n+bad\n*** End Patch";
        assert!(PatchPlan::preview(dir.path(), patch).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("keep.txt")).unwrap(),
            "before\n"
        );
    }

    #[test]
    fn rejects_parent_and_symlink_escape() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        let parent = "*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch";
        assert!(matches!(
            PatchPlan::preview(dir.path(), parent),
            Err(PatchError::InvalidPath { .. })
        ));
        #[cfg(unix)]
        {
            let symlink = "*** Begin Patch\n*** Add File: link/escape.txt\n+x\n*** End Patch";
            assert!(matches!(
                PatchPlan::preview(dir.path(), symlink),
                Err(PatchError::InvalidPath { .. })
            ));
        }
    }

    #[test]
    fn streaming_parser_exposes_partial_changes() {
        let mut parser = StreamingPatchParser::default();
        let completed = parser
            .push_delta("*** Begin Patch\n*** Add File: a.txt\n+one\n")
            .unwrap();
        assert_eq!(completed.len(), 1);
        parser.push_delta("*** End Patch").unwrap();
        assert_eq!(parser.finish().unwrap().len(), 1);
    }

    #[test]
    fn turn_diff_is_rebased_to_the_first_change_in_the_turn() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("value.txt"), "one\n").unwrap();
        let mut tracker = TurnDiffTracker::new(dir.path()).unwrap();
        let first = PatchPlan::preview(
            dir.path(),
            "*** Begin Patch\n*** Update File: value.txt\n@@\n-one\n+two\n*** End Patch",
        )
        .unwrap();
        first.apply().unwrap();
        let first_diff = tracker.record(&first);
        assert!(first_diff.contains("+two"));
        let second = PatchPlan::preview(
            dir.path(),
            "*** Begin Patch\n*** Update File: value.txt\n@@\n-two\n+three\n*** End Patch",
        )
        .unwrap();
        second.apply().unwrap();
        let second_diff = tracker.record(&second);
        assert!(second_diff.contains("-one"));
        assert!(second_diff.contains("+three"));
        assert!(!second_diff.contains("+two"));
    }
}
