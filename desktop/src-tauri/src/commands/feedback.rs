use std::io::Write;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const LOG_MAX_BYTES: u64 = 512 * 1024;
const LOG_TAIL_BYTES: usize = 16 * 1024;

fn error_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位数据目录：{error}"))?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建日志目录失败：{error}"))?;
    Ok(dir.join("panic.log"))
}

/// Append Rust panics to a bounded on-disk log so the feedback reporter can
/// attach native crash context even after a restart.
pub fn install_panic_hook(app: &AppHandle) {
    let Ok(path) = error_log_path(app) else {
        return;
    };
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown".into());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|value| (*value).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".into());
        // Start over once the log grows past the cap; the tail is what matters.
        if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > LOG_MAX_BYTES) {
            let _ = std::fs::remove_file(&path);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(file, "[{timestamp}] panic at {location}: {payload}");
        }
        previous(info);
    }));
}

#[tauri::command]
pub fn read_native_error_log(app: AppHandle) -> Result<String, String> {
    let path = error_log_path(&app)?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(format!("读取错误日志失败：{error}")),
    };
    let tail_start = raw.len().saturating_sub(LOG_TAIL_BYTES);
    let boundary = raw
        .char_indices()
        .map(|(index, _)| index)
        .find(|index| *index >= tail_start)
        .unwrap_or(0);
    Ok(raw[boundary..].to_string())
}
