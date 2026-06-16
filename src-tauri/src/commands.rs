//! Tauri commands exposed to the frontend.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::config::{self, Provider, Settings};
use crate::state::AppState;

#[tauri::command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> Settings {
    state.settings.lock().clone()
}

#[tauri::command]
pub fn save_settings(state: State<'_, Arc<AppState>>, settings: Settings) -> Result<(), String> {
    config::save(&state.config_dir, &settings).map_err(|e| e.to_string())?;
    *state.hotkey.lock() = settings.hotkey.clone();
    *state.settings.lock() = settings;
    Ok(())
}

#[tauri::command]
pub fn list_audio_inputs() -> Vec<String> {
    crate::audio::list_inputs()
}

#[tauri::command]
pub fn start_hotkey_capture(state: State<'_, Arc<AppState>>) {
    state.capturing.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn cancel_hotkey_capture(state: State<'_, Arc<AppState>>) {
    state.capturing.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn dictation_toggle(app: AppHandle) {
    crate::dictation::toggle(&app);
}

#[tauri::command]
pub fn dictation_cancel(app: AppHandle) {
    crate::dictation::cancel(&app);
}

/// Ping a provider's `/models` endpoint to validate base URL + API key.
#[tauri::command]
pub async fn test_provider(provider: Provider) -> Result<String, String> {
    let url = format!("{}/models", provider.base_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(&provider.api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok("连接正常".to_string())
    } else {
        Err(format!("HTTP {}", resp.status()))
    }
}
