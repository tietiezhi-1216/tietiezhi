//! Global dictation hotkey + gesture resolution.
//!
//! The monitor only reports raw down/up, and which gesture it was comes down to
//! the FIRST press:
//!
//!   • 单击切换 (click): released before the hold threshold → a hands-free
//!     session that records until the next press. ASR + LLM polish.
//!   • 长按 (hold):      still held past the threshold → push-to-talk; releasing
//!     finishes it. ASR only, NO polish.
//!
//! Recording starts the INSTANT the key goes down (never wait to classify, or
//! the opening syllable gets clipped) — click-vs-hold only decides polish, which
//! isn't needed until commit, so it resolves lazily.

use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use super::capsule;
use super::settings::read_settings;

/// Trigger used when settings carry none.
pub const DEFAULT_HOTKEY: &str = "Alt+Space";

/// Still held past this → push-to-talk. Released sooner → it was a click.
const HOLD_THRESHOLD: Duration = Duration::from_millis(250);

/// The capsule window receives these; it owns audio capture and the pipeline.
const EVENT_START: &str = "dictation:start";
const EVENT_COMMIT: &str = "dictation:commit";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Gesture {
    Idle,
    /// Key down; waiting to see click vs hold.
    Deciding,
    /// Click-to-start toggle session, recording (polish on commit).
    TapRecording,
    /// Push-to-talk, key held, recording (no polish).
    HoldRecording,
}

struct Inner {
    gesture: Gesture,
    /// Bumped per session so a stale hold-timer can't touch a newer one.
    generation: u64,
}

pub struct HotkeyState {
    inner: Mutex<Inner>,
}

impl Default for HotkeyState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                gesture: Gesture::Idle,
                generation: 0,
            }),
        }
    }
}

/// Entry point wired into the global-shortcut plugin's handler.
pub fn on_hotkey_event(app: &AppHandle, state: ShortcutState) {
    match state {
        ShortcutState::Pressed => on_down(app),
        ShortcutState::Released => on_up(app),
    }
}

fn on_down(app: &AppHandle) {
    let hk = app.state::<HotkeyState>();
    let generation = {
        let mut inner = hk.inner.lock().unwrap();
        match inner.gesture {
            Gesture::Idle => {
                inner.gesture = Gesture::Deciding;
                inner.generation += 1;
                inner.generation
            }
            Gesture::TapRecording => {
                // A second click ends the hands-free session (with polish).
                inner.gesture = Gesture::Idle;
                inner.generation += 1;
                drop(inner);
                commit(app, true);
                return;
            }
            _ => return,
        }
    };

    start_session(app);

    // Resolve click-vs-hold lazily; assume "click" until proven a hold.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(HOLD_THRESHOLD).await;
        let hk = handle.state::<HotkeyState>();
        let mut inner = hk.inner.lock().unwrap();
        if inner.generation == generation && inner.gesture == Gesture::Deciding {
            inner.gesture = Gesture::HoldRecording;
        }
    });
}

fn on_up(app: &AppHandle) {
    let hk = app.state::<HotkeyState>();
    let mut inner = hk.inner.lock().unwrap();
    match inner.gesture {
        Gesture::Deciding => {
            // Released before the threshold → it was a click: keep recording
            // hands-free until the next press.
            inner.gesture = Gesture::TapRecording;
        }
        Gesture::HoldRecording => {
            inner.gesture = Gesture::Idle;
            inner.generation += 1;
            drop(inner);
            // Push-to-talk: raw transcript, no polish.
            commit(app, false);
        }
        _ => {}
    }
}

fn start_session(app: &AppHandle) {
    if let Err(e) = capsule::show_for_session(app) {
        eprintln!("[dictation] 无法显示胶囊：{e}");
        return;
    }
    let _ = app.emit_to(capsule::LABEL, EVENT_START, ());
}

fn commit(app: &AppHandle, polish: bool) {
    let _ = app.emit_to(capsule::LABEL, EVENT_COMMIT, polish);
}

/// Clear the gesture state — called by the capsule when a session ends or is
/// cancelled from the UI, so the next hotkey press starts fresh.
#[tauri::command]
pub fn dictation_reset(app: AppHandle) {
    let hk = app.state::<HotkeyState>();
    let mut inner = hk.inner.lock().unwrap();
    inner.gesture = Gesture::Idle;
    inner.generation += 1;
}

/// Start / stop dictation as if the hotkey was clicked (menu or button entry).
#[tauri::command]
pub fn dictation_toggle(app: AppHandle) {
    let hk = app.state::<HotkeyState>();
    let start = {
        let mut inner = hk.inner.lock().unwrap();
        match inner.gesture {
            Gesture::Idle => {
                inner.gesture = Gesture::TapRecording;
                inner.generation += 1;
                true
            }
            _ => {
                inner.gesture = Gesture::Idle;
                inner.generation += 1;
                false
            }
        }
    };
    if start {
        start_session(&app);
    } else {
        commit(&app, true);
    }
}

/// Register `shortcut` as the one global dictation trigger.
fn register(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let parsed = Shortcut::from_str(shortcut).map_err(|e| format!("快捷键无法解析：{e}"))?;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(parsed)
        .map_err(|e| format!("注册快捷键失败（可能已被其它应用占用）：{e}"))
}

/// Apply the stored hotkey at startup.
pub fn apply_from_settings(app: &AppHandle) {
    let stored = read_settings(app)
        .map(|s| s.dictation_hotkey)
        .unwrap_or_default();
    let shortcut = if stored.trim().is_empty() {
        DEFAULT_HOTKEY.to_string()
    } else {
        stored
    };
    if let Err(e) = register(app, &shortcut) {
        eprintln!("[dictation] {e}");
    }
}

/// Change + persist the dictation hotkey. Re-registers immediately so the new
/// binding is live without a restart.
#[tauri::command]
pub fn set_dictation_hotkey(app: AppHandle, shortcut: String) -> Result<(), String> {
    let trimmed = shortcut.trim().to_string();
    if trimmed.is_empty() {
        return Err("快捷键不能为空".into());
    }
    register(&app, &trimmed)?;
    let mut settings = read_settings(&app)?;
    settings.dictation_hotkey = trimmed;
    super::settings::save_settings(app, settings)
}

/// The hotkey currently in effect (stored value, or the built-in default).
#[tauri::command]
pub fn dictation_hotkey(app: AppHandle) -> String {
    read_settings(&app)
        .map(|s| s.dictation_hotkey)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string())
}
