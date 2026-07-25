use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tietiezhi_agent_core::RoutedNotification;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::AppState;

const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_SEARCH_ENTRIES: usize = 50_000;
const MAX_SEARCH_RESULTS: usize = 50;
const NOTIFICATION_EVENT: &str = "codex-v2-notification";

pub(crate) fn handles(method: &str) -> bool {
    matches!(
        method,
        "fs/readFile"
            | "fs/writeFile"
            | "fs/readDirectory"
            | "fs/createDirectory"
            | "fs/getMetadata"
            | "fs/copy"
            | "fs/remove"
            | "fs/watch"
            | "fs/unwatch"
            | "fuzzyFileSearch"
            | "fuzzyFileSearch/sessionStart"
            | "fuzzyFileSearch/sessionUpdate"
            | "fuzzyFileSearch/sessionStop"
    )
}

pub(crate) async fn dispatch(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    method: &str,
    params: &Value,
) -> Result<(Value, Vec<RoutedNotification>), String> {
    match method {
        "fs/readFile" => {
            let path = absolute_path(params, "path")?;
            let metadata = fs::metadata(&path).map_err(io_error("读取文件信息"))?;
            if !metadata.is_file() {
                return Err("fs/readFile 只接受普通文件".into());
            }
            if metadata.len() > MAX_FILE_BYTES {
                return Err("fs/readFile 文件不能超过 100 MB".into());
            }
            let bytes = fs::read(path).map_err(io_error("读取文件"))?;
            Ok((
                json!({"dataBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
                Vec::new(),
            ))
        }
        "fs/writeFile" => {
            let path = resolved_write_path(&absolute_path(params, "path")?)?;
            let encoded = params
                .get("dataBase64")
                .and_then(Value::as_str)
                .ok_or_else(|| "fs/writeFile dataBase64 不能为空".to_string())?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|error| format!("fs/writeFile dataBase64 无效：{error}"))?;
            if bytes.len() as u64 > MAX_FILE_BYTES {
                return Err("fs/writeFile 内容不能超过 100 MB".into());
            }
            atomic_write(&path, &bytes)?;
            Ok((json!({}), Vec::new()))
        }
        "fs/readDirectory" => {
            let path = canonical_directory(&absolute_path(params, "path")?)?;
            let mut entries = fs::read_dir(path)
                .map_err(io_error("读取目录"))?
                .filter_map(Result::ok)
                .map(|entry| {
                    let file_type = entry.file_type().ok();
                    json!({
                        "fileName":entry.file_name().to_string_lossy(),
                        "isDirectory":file_type.as_ref().is_some_and(|kind| kind.is_dir()),
                        "isFile":file_type.as_ref().is_some_and(|kind| kind.is_file())
                    })
                })
                .collect::<Vec<_>>();
            entries
                .sort_by(|left, right| left["fileName"].as_str().cmp(&right["fileName"].as_str()));
            Ok((json!({"entries":entries}), Vec::new()))
        }
        "fs/createDirectory" => {
            let path = resolved_write_path(&absolute_path(params, "path")?)?;
            if params
                .get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(true)
            {
                fs::create_dir_all(path).map_err(io_error("创建目录"))?;
            } else {
                fs::create_dir(path).map_err(io_error("创建目录"))?;
            }
            Ok((json!({}), Vec::new()))
        }
        "fs/getMetadata" => {
            let path = absolute_path(params, "path")?;
            let metadata = fs::symlink_metadata(path).map_err(io_error("读取元数据"))?;
            Ok((
                json!({
                    "isDirectory":metadata.is_dir(),
                    "isFile":metadata.is_file(),
                    "isSymlink":metadata.file_type().is_symlink(),
                    "createdAtMs":system_time_ms(metadata.created().ok()),
                    "modifiedAtMs":system_time_ms(metadata.modified().ok())
                }),
                Vec::new(),
            ))
        }
        "fs/copy" => {
            let source = canonical_existing(&absolute_path(params, "sourcePath")?)?;
            let destination = resolved_write_path(&absolute_path(params, "destinationPath")?)?;
            let metadata = fs::symlink_metadata(&source).map_err(io_error("读取复制来源"))?;
            if metadata.file_type().is_symlink() {
                return Err("fs/copy 不复制符号链接".into());
            }
            if metadata.is_dir() {
                if !params
                    .get("recursive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return Err("复制目录必须设置 recursive: true".into());
                }
                copy_directory(&source, &destination)?;
            } else if metadata.is_file() {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent).map_err(io_error("创建复制目标目录"))?;
                }
                fs::copy(source, destination).map_err(io_error("复制文件"))?;
            } else {
                return Err("fs/copy 来源必须是普通文件或目录".into());
            }
            Ok((json!({}), Vec::new()))
        }
        "fs/remove" => {
            let path = absolute_path(params, "path")?;
            let force = params.get("force").and_then(Value::as_bool).unwrap_or(true);
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if force && error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok((json!({}), Vec::new()));
                }
                Err(error) => return Err(format!("删除路径失败：{error}")),
            };
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                if params
                    .get("recursive")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
                {
                    fs::remove_dir_all(path).map_err(io_error("递归删除目录"))?;
                } else {
                    fs::remove_dir(path).map_err(io_error("删除目录"))?;
                }
            } else {
                fs::remove_file(path).map_err(io_error("删除文件"))?;
            }
            Ok((json!({}), Vec::new()))
        }
        "fs/watch" => {
            let watch_id = required_string(params, "watchId")?;
            let path = canonical_existing(&absolute_path(params, "path")?)?;
            let key = scoped_key(connection_id, &watch_id);
            let cancellation = CancellationToken::new();
            let previous = state
                .codex_fs_watches
                .lock()
                .map_err(|_| "文件监听状态锁已损坏".to_string())?
                .insert(key.clone(), cancellation.clone());
            if let Some(previous) = previous {
                previous.cancel();
            }
            spawn_watch(
                app.clone(),
                connection_id.to_string(),
                watch_id,
                path.clone(),
                cancellation,
            );
            Ok((json!({"path":path}), Vec::new()))
        }
        "fs/unwatch" => {
            let watch_id = required_string(params, "watchId")?;
            if let Some(cancellation) = state
                .codex_fs_watches
                .lock()
                .map_err(|_| "文件监听状态锁已损坏".to_string())?
                .remove(&scoped_key(connection_id, &watch_id))
            {
                cancellation.cancel();
            }
            Ok((json!({}), Vec::new()))
        }
        "fuzzyFileSearch" => {
            let query = params
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let roots = search_roots(params)?;
            let files = fuzzy_file_search(query, &roots);
            Ok((json!({"files":files}), Vec::new()))
        }
        "fuzzyFileSearch/sessionStart" => {
            let session_id = required_string(params, "sessionId")?;
            let roots = search_roots(params)?;
            state
                .codex_fuzzy_sessions
                .lock()
                .map_err(|_| "文件搜索会话锁已损坏".to_string())?
                .insert(scoped_key(connection_id, &session_id), roots);
            Ok((json!({}), Vec::new()))
        }
        "fuzzyFileSearch/sessionUpdate" => {
            let session_id = required_string(params, "sessionId")?;
            let query = params
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let roots = state
                .codex_fuzzy_sessions
                .lock()
                .map_err(|_| "文件搜索会话锁已损坏".to_string())?
                .get(&scoped_key(connection_id, &session_id))
                .cloned()
                .ok_or_else(|| "文件搜索会话不存在".to_string())?;
            let files = fuzzy_file_search(&query, &roots);
            Ok((
                json!({}),
                vec![
                    RoutedNotification {
                        recipients: vec![connection_id.into()],
                        method: "fuzzyFileSearch/sessionUpdated".into(),
                        params: json!({
                            "sessionId":session_id,
                            "query":query,
                            "files":files
                        }),
                    },
                    RoutedNotification {
                        recipients: vec![connection_id.into()],
                        method: "fuzzyFileSearch/sessionCompleted".into(),
                        params: json!({"sessionId":session_id}),
                    },
                ],
            ))
        }
        "fuzzyFileSearch/sessionStop" => {
            let session_id = required_string(params, "sessionId")?;
            state
                .codex_fuzzy_sessions
                .lock()
                .map_err(|_| "文件搜索会话锁已损坏".to_string())?
                .remove(&scoped_key(connection_id, &session_id));
            Ok((json!({}), Vec::new()))
        }
        _ => Err("未知桌面文件方法".into()),
    }
}

fn absolute_path(params: &Value, field: &str) -> Result<PathBuf, String> {
    let path = params
        .get(field)
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{field} 不能为空"))?;
    if !path.is_absolute() {
        return Err(format!("{field} 必须是绝对路径"));
    }
    Ok(path)
}

fn required_string(params: &Value, field: &str) -> Result<String, String> {
    params
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("{field} 不能为空"))
}

fn canonical_existing(path: &Path) -> Result<PathBuf, String> {
    dunce::canonicalize(path).map_err(|error| format!("无法解析路径：{error}"))
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let path = canonical_existing(path)?;
    if !path.is_dir() {
        return Err("路径不是目录".into());
    }
    Ok(path)
}

fn resolved_write_path(path: &Path) -> Result<PathBuf, String> {
    let mut current = path.to_path_buf();
    let mut missing = Vec::new();
    while !current.exists() {
        missing.push(
            current
                .file_name()
                .ok_or_else(|| "路径没有可解析的父目录".to_string())?
                .to_os_string(),
        );
        current = current
            .parent()
            .ok_or_else(|| "路径没有可解析的父目录".to_string())?
            .to_path_buf();
    }
    if fs::symlink_metadata(&current)
        .map_err(io_error("读取写入路径"))?
        .file_type()
        .is_symlink()
    {
        return Err("写入目标不能是符号链接".into());
    }
    let mut resolved =
        dunce::canonicalize(&current).map_err(|error| format!("无法解析路径：{error}"))?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "文件路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(io_error("创建文件目录"))?;
    let temporary = parent.join(format!(".codex-write-{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(io_error("写入临时文件"))?;
    #[cfg(unix)]
    {
        fs::rename(&temporary, path).map_err(io_error("提交文件写入"))
    }
    #[cfg(windows)]
    {
        let backup = parent.join(format!(".codex-write-{}.bak", Uuid::new_v4()));
        let had_original = path.exists();
        if had_original {
            fs::rename(path, &backup).map_err(io_error("暂存原文件"))?;
        }
        match fs::rename(&temporary, path) {
            Ok(()) => {
                if had_original {
                    let _ = fs::remove_file(backup);
                }
                Ok(())
            }
            Err(error) => {
                if had_original {
                    let _ = fs::rename(backup, path);
                }
                let _ = fs::remove_file(temporary);
                Err(format!("提交文件写入失败：{error}"))
            }
        }
    }
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.starts_with(source) {
        return Err("复制目标不能位于来源目录内部".into());
    }
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|error| format!("扫描复制来源失败：{error}"))?;
        if entry.path().is_symlink() {
            return Err("fs/copy 不复制符号链接".into());
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|error| format!("解析复制路径失败：{error}"))?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(target).map_err(io_error("创建复制目录"))?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(io_error("创建复制目录"))?;
            }
            fs::copy(entry.path(), target).map_err(io_error("复制文件"))?;
        }
    }
    Ok(())
}

fn search_roots(params: &Value) -> Result<Vec<PathBuf>, String> {
    params
        .get("roots")
        .and_then(Value::as_array)
        .ok_or_else(|| "roots 必须是数组".to_string())?
        .iter()
        .map(|root| {
            let root = root
                .as_str()
                .map(PathBuf::from)
                .ok_or_else(|| "roots 只能包含路径字符串".to_string())?;
            if !root.is_absolute() {
                return Err("搜索根必须是绝对路径".into());
            }
            canonical_directory(&root)
        })
        .collect()
}

fn fuzzy_file_search(query: &str, roots: &[PathBuf]) -> Vec<Value> {
    if query.is_empty() {
        return Vec::new();
    }
    let mut results = Vec::new();
    for root in roots {
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| entry.file_name() != ".git")
            .take(MAX_SEARCH_ENTRIES)
            .filter_map(Result::ok)
        {
            if entry.path() == root || entry.path().is_symlink() {
                continue;
            }
            let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
            let candidate = relative.to_string_lossy();
            let Some((score, indices)) = fuzzy_score(query, &candidate) else {
                continue;
            };
            results.push(json!({
                "root":root,
                "path":entry.path(),
                "match_type":if entry.file_type().is_dir() {"directory"} else {"file"},
                "file_name":entry.file_name().to_string_lossy(),
                "score":score,
                "indices":indices
            }));
        }
    }
    results.sort_by(|left, right| {
        right["score"]
            .as_u64()
            .cmp(&left["score"].as_u64())
            .then_with(|| left["path"].as_str().cmp(&right["path"].as_str()))
    });
    results.truncate(MAX_SEARCH_RESULTS);
    results
}

fn fuzzy_score(query: &str, candidate: &str) -> Option<(u32, Vec<u32>)> {
    let query = query
        .chars()
        .flat_map(char::to_lowercase)
        .collect::<Vec<_>>();
    let candidate_lower = candidate
        .chars()
        .enumerate()
        .flat_map(|(index, character)| {
            character
                .to_lowercase()
                .map(move |lowercase| (lowercase, index as u32))
        })
        .collect::<Vec<_>>();
    let candidate_chars = candidate.chars().collect::<Vec<_>>();
    let mut indices = Vec::new();
    let mut offset = 0;
    let mut consecutive = 0_u32;
    let mut score = 0_u32;
    for needle in query {
        let found = candidate_lower[offset..]
            .iter()
            .position(|(character, _)| *character == needle)?;
        let lower_index = offset + found;
        let char_index = candidate_lower[lower_index].1;
        indices.push(char_index);
        if found == 0 {
            consecutive += 1;
            score += 20 * consecutive;
        } else {
            consecutive = 0;
            score += 10;
        }
        if char_index == 0
            || candidate_chars
                .get(char_index.saturating_sub(1) as usize)
                .is_some_and(|character| matches!(character, '/' | '\\' | '-' | '_' | '.'))
        {
            score += 40;
        }
        offset = lower_index + 1;
    }
    score += (1_000_u32).saturating_sub(candidate.chars().count() as u32);
    Some((score, indices))
}

fn spawn_watch(
    app: AppHandle,
    connection_id: String,
    watch_id: String,
    path: PathBuf,
    cancellation: CancellationToken,
) {
    tauri::async_runtime::spawn(async move {
        let mut previous = path_fingerprint(&path);
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    let next = path_fingerprint(&path);
                    if next != previous {
                        previous = next;
                        let notification = RoutedNotification {
                            recipients: vec![connection_id.clone()],
                            method: "fs/changed".into(),
                            params: json!({
                                "watchId":watch_id,
                                "changedPaths":[path]
                            }),
                        };
                        let _ = app.emit(NOTIFICATION_EVENT, notification);
                    }
                }
            }
        }
    });
}

fn path_fingerprint(path: &Path) -> String {
    let mut hasher = Sha256::new();
    let entries: Box<dyn Iterator<Item = PathBuf>> = if path.is_dir() {
        Box::new(
            WalkDir::new(path)
                .follow_links(false)
                .max_depth(4)
                .into_iter()
                .take(20_000)
                .filter_map(Result::ok)
                .map(|entry| entry.into_path()),
        )
    } else {
        Box::new(std::iter::once(path.to_path_buf()))
    };
    for entry in entries {
        hasher.update(entry.to_string_lossy().as_bytes());
        if let Ok(metadata) = fs::symlink_metadata(&entry) {
            hasher.update(metadata.len().to_le_bytes());
            hasher.update(system_time_ms(metadata.modified().ok()).to_le_bytes());
        }
    }
    format!("{:x}", hasher.finalize())
}

fn scoped_key(connection_id: &str, id: &str) -> String {
    format!("{connection_id}\0{id}")
}

fn system_time_ms(value: Option<std::time::SystemTime>) -> u64 {
    value
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn io_error(action: &'static str) -> impl Fn(std::io::Error) -> String {
    move |error| format!("{action}失败：{error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_search_is_ranked_bounded_and_skips_git() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("src/components")).unwrap();
        fs::create_dir_all(root.path().join(".git")).unwrap();
        fs::write(root.path().join("src/components/chat-page.tsx"), "x").unwrap();
        fs::write(root.path().join("src/other.txt"), "x").unwrap();
        fs::write(root.path().join(".git/secret"), "x").unwrap();
        let results = fuzzy_file_search("chatp", &[root.path().to_path_buf()]);
        assert_eq!(results.len(), 1);
        assert!(results[0]["path"]
            .as_str()
            .unwrap()
            .ends_with("chat-page.tsx"));
    }

    #[test]
    fn copy_rejects_symlinks_and_nested_destination() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("file"), "content").unwrap();
        assert!(copy_directory(&source, &source.join("nested")).is_err());
    }

    #[test]
    fn fuzzy_score_keeps_match_indices() {
        let (score, indices) = fuzzy_score("abc", "a/b_component.rs").unwrap();
        assert!(score > 0);
        assert_eq!(indices.len(), 3);
        assert!(fuzzy_score("xyz", "component.rs").is_none());
    }
}
