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

/// Fetch the list of model ids a provider exposes (so users pick instead of
/// typing). OpenAI-compatible providers use `GET /models`; Volcano has a fixed
/// streaming-ASR model.
#[tauri::command]
pub async fn fetch_models(provider: Provider) -> Result<Vec<String>, String> {
    if provider.kind == "volcano" {
        return Ok(vec!["bigmodel".to_string()]);
    }
    let url = format!("{}/models", provider.base_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(&provider.api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}

/// Ping a provider's `/models` endpoint to validate base URL + API key.
#[tauri::command]
pub async fn test_provider(provider: Provider) -> Result<String, String> {
    if provider.kind == "volcano" {
        if provider.app_id.trim().is_empty() || provider.api_key.trim().is_empty() {
            return Err("请填写 AppID 与 Access Token".to_string());
        }
        return Ok("已填写（火山引擎需真机识别时验证）".to_string());
    }
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
