//! The floating dictation capsule window: borderless, transparent, always on
//! top, and pinned bottom-center of the primary monitor's work area.
//!
//! It is created hidden at startup and **never takes focus** — dictation targets
//! whatever app the user is typing in, so stealing focus would move the caret
//! away from the field we're about to insert into. It is only visible for the
//! duration of a dictation session.

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "capsule";
const WIDTH: f64 = 400.0;
const COMPACT_HEIGHT: f64 = 120.0;

/// Bottom-center origin (logical) for a capsule window of the given height.
fn bottom_center(app: &AppHandle, height: f64) -> Result<LogicalPosition<f64>, String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("读取显示器信息失败：{e}"))?
        .ok_or("未找到主显示器")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let ax = area.position.x as f64 / scale;
    let ay = area.position.y as f64 / scale;
    let aw = area.size.width as f64 / scale;
    let ah = area.size.height as f64 / scale;
    Ok(LogicalPosition::new(
        ax + (aw - WIDTH) / 2.0,
        ay + ah - height,
    ))
}

/// Create the capsule window (hidden, non-focusing) if it doesn't exist yet.
/// Called once at startup so it's ready to receive dictation events instantly.
pub fn ensure_capsule(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let pos = bottom_center(app, COMPACT_HEIGHT)?;
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("capsule.html".into()))
        .title("语音听写")
        .decorations(false)
        .transparent(true)
        .shadow(false) // the pill draws its own capsule-shaped shadow
        .always_on_top(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .inner_size(WIDTH, COMPACT_HEIGHT)
        .position(pos.x, pos.y)
        .visible(false)
        // Never steal focus: the caret must stay in the user's target app.
        .focused(false)
        .build()
        .map_err(|e| format!("创建胶囊窗口失败：{e}"))?;
    Ok(())
}

/// Show the capsule for a dictation session, re-anchored to the bottom edge.
/// Deliberately does not focus the window.
pub fn show_for_session(app: &AppHandle) -> Result<(), String> {
    ensure_capsule(app)?;
    let win = app.get_webview_window(LABEL).ok_or("胶囊窗口不存在")?;
    let height = win
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(win.scale_factor().map_err(|e| e.to_string())?)
        .height;
    win.set_position(bottom_center(app, height)?)
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())
}

/// Resize the capsule window while keeping it glued to the bottom edge.
/// Used when the result card expands/collapses above the pill.
#[tauri::command]
pub fn capsule_set_height(app: AppHandle, height: f64) -> Result<(), String> {
    let win = app.get_webview_window(LABEL).ok_or("胶囊窗口不存在")?;
    let height = height.clamp(COMPACT_HEIGHT, 800.0);
    win.set_size(LogicalSize::new(WIDTH, height))
        .map_err(|e| e.to_string())?;
    win.set_position(bottom_center(&app, height)?)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn hide_capsule(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Re-show the capsule (used after an auto-insert fell back to the copy card).
#[tauri::command]
pub fn show_capsule(app: AppHandle) -> Result<(), String> {
    show_for_session(&app)
}
