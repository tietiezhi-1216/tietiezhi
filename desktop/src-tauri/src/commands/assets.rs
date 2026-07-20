use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 512 * 1024;
const MAX_ASSETS_PER_IMPORT: usize = 12;
const MAX_DIRECTORY_ENTRIES: usize = 500;
const MAX_DIRECTORY_DEPTH: usize = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAsset {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub path: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_content: Option<String>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn pick_chat_files(app: AppHandle, images_only: bool) -> Result<Vec<ChatAsset>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut picker = app.dialog().file().set_title(if images_only {
        "添加图片"
    } else {
        "添加文件"
    });
    if images_only {
        picker = picker.add_filter(
            "图片",
            &["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif"],
        );
    }
    picker.pick_files(move |files| {
        let _ = tx.send(files);
    });
    let files = rx.await.map_err(|_| "选择文件失败".to_string())?;
    let paths = files
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .collect();
    inspect_paths(paths)
}

#[tauri::command]
pub async fn pick_chat_folder(app: AppHandle) -> Result<Vec<ChatAsset>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("添加文件夹")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let folder = rx.await.map_err(|_| "选择文件夹失败".to_string())?;
    let paths = folder
        .and_then(|folder| folder.into_path().ok())
        .into_iter()
        .collect();
    inspect_paths(paths)
}

/// Inspect paths delivered by Tauri's native drag-and-drop event.
#[tauri::command]
pub fn inspect_chat_asset_paths(paths: Vec<String>) -> Result<Vec<ChatAsset>, String> {
    inspect_paths(paths.into_iter().map(PathBuf::from).collect())
}

fn inspect_paths(paths: Vec<PathBuf>) -> Result<Vec<ChatAsset>, String> {
    paths
        .into_iter()
        .take(MAX_ASSETS_PER_IMPORT)
        .map(|path| inspect_path(&path))
        .collect()
}

fn inspect_path(path: &Path) -> Result<ChatAsset, String> {
    let path = dunce::canonicalize(path).map_err(|e| format!("无法读取附件：{e}"))?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    if path.is_dir() {
        let (manifest, truncated) = directory_manifest(&path)?;
        return Ok(ChatAsset {
            id: Uuid::new_v4().to_string(),
            kind: "folder".into(),
            name,
            mime_type: "application/x-directory".into(),
            path: path.to_string_lossy().into_owned(),
            size: 0,
            data_url: None,
            text_content: Some(manifest),
            truncated,
        });
    }

    if !path.is_file() {
        return Err(format!("附件不是普通文件或文件夹：{}", path.display()));
    }
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("读取附件信息失败：{e}"))?
        .len();
    let mime_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();

    if mime_type.starts_with("image/") {
        if size > MAX_IMAGE_BYTES {
            return Err(format!("图片「{name}」超过 20 MB，请压缩后再添加"));
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败：{e}"))?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(ChatAsset {
            id: Uuid::new_v4().to_string(),
            kind: "image".into(),
            name,
            mime_type: mime_type.clone(),
            path: path.to_string_lossy().into_owned(),
            size,
            data_url: Some(format!("data:{mime_type};base64,{encoded}")),
            text_content: None,
            truncated: false,
        });
    }

    let (text_content, truncated) = if is_text_file(&path, &mime_type) {
        let mut file = std::fs::File::open(&path).map_err(|e| format!("读取文件失败：{e}"))?;
        let mut bytes = Vec::new();
        file.by_ref()
            .take(MAX_TEXT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取文件失败：{e}"))?;
        let truncated = bytes.len() as u64 > MAX_TEXT_BYTES;
        bytes.truncate(MAX_TEXT_BYTES as usize);
        (
            Some(String::from_utf8_lossy(&bytes).into_owned()),
            truncated,
        )
    } else {
        (None, false)
    };

    Ok(ChatAsset {
        id: Uuid::new_v4().to_string(),
        kind: "file".into(),
        name,
        mime_type,
        path: path.to_string_lossy().into_owned(),
        size,
        data_url: None,
        text_content,
        truncated,
    })
}

fn is_text_file(path: &Path, mime_type: &str) -> bool {
    if mime_type.starts_with("text/") {
        return true;
    }
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some(
            "json"
                | "jsonl"
                | "toml"
                | "yaml"
                | "yml"
                | "xml"
                | "csv"
                | "tsv"
                | "md"
                | "rs"
                | "go"
                | "py"
                | "js"
                | "jsx"
                | "ts"
                | "tsx"
                | "vue"
                | "svelte"
                | "java"
                | "kt"
                | "swift"
                | "c"
                | "h"
                | "cpp"
                | "hpp"
                | "cs"
                | "php"
                | "rb"
                | "sh"
                | "ps1"
                | "sql"
                | "ini"
                | "conf"
                | "log"
                | "env"
        )
    )
}

fn include_directory_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return true;
    }
    !matches!(
        entry.file_name().to_string_lossy().as_ref(),
        ".git" | "node_modules" | "target" | "dist" | ".next" | "vendor"
    )
}

fn directory_manifest(root: &Path) -> Result<(String, bool), String> {
    let mut lines = Vec::new();
    let mut truncated = false;
    for entry in WalkDir::new(root)
        .max_depth(MAX_DIRECTORY_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(include_directory_entry)
        .skip(1)
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                truncated = true;
                continue;
            }
        };
        if lines.len() >= MAX_DIRECTORY_ENTRIES {
            truncated = true;
            break;
        }
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        let mut display = relative.to_string_lossy().replace('\\', "/");
        if entry.file_type().is_dir() {
            display.push('/');
        }
        lines.push(display);
    }
    if lines.is_empty() {
        lines.push("[空文件夹]".into());
    }
    Ok((lines.join("\n"), truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspects_text_image_and_folder_assets() {
        let root = std::env::temp_dir().join(format!("ttz-assets-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(root.join("preview.png"), b"not-a-real-png").unwrap();

        let text = inspect_path(&root.join("src/main.rs")).unwrap();
        assert_eq!(text.kind, "file");
        assert!(text.text_content.unwrap().contains("fn main"));

        let image = inspect_path(&root.join("preview.png")).unwrap();
        assert_eq!(image.kind, "image");
        assert!(image
            .data_url
            .unwrap()
            .starts_with("data:image/png;base64,"));

        let folder = inspect_path(&root).unwrap();
        assert_eq!(folder.kind, "folder");
        assert!(folder.text_content.unwrap().contains("src/main.rs"));

        std::fs::remove_dir_all(root).unwrap();
    }
}
