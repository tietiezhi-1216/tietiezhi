use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::models::{deserialize_models, ModelInfo};
use crate::secrets;

const CURRENT_SETTINGS_VERSION: u32 = 1;
const LEGACY_BUILTIN_PROVIDER_NAME: &str = "官方中转站";
const LEGACY_BUILTIN_PROVIDER_URL: &str = "https://api.terln.com";

/// A model provider (relay / vendor). API keys never live here — they go to the
/// OS credential store, keyed by the provider id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    /// Wire/protocol family: "openai" (OpenAI-compatible) or "mimo" (Xiaomi MiMo).
    #[serde(rename = "type")]
    pub kind: String,
    pub base_url: String,
    /// Models last fetched from the provider, with their capability (cached for
    /// the pickers so each one only offers models it can actually use).
    #[serde(default, deserialize_with = "deserialize_models")]
    pub models: Vec<ModelInfo>,
}

/// Non-sensitive app settings persisted as JSON under `app_config_dir()`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// Internal schema version used for one-time settings migrations.
    pub settings_version: u32,
    /// Configured providers.
    pub providers: Vec<Provider>,
    /// Selection for the main chat.
    pub chat_provider_id: String,
    pub chat_model: String,
    /// Optional model dedicated to conversation-title generation. Empty means
    /// follow the model used by the conversation itself.
    pub title_provider_id: String,
    pub title_model: String,
    /// Selection for dictation speech-to-text.
    pub asr_provider_id: String,
    pub asr_model: String,
    /// Selection for the dictation polish step.
    pub polish_provider_id: String,
    pub polish_model: String,
    /// Whether dictation runs the LLM polish step after ASR.
    pub polish_enabled: bool,
    /// Preferred polish output language: auto|zhCn|zhTw|en|ja|ko.
    pub output_language: String,
    /// Global hotkey that triggers dictation, e.g. "Alt+Space".
    /// Empty falls back to `hotkey::DEFAULT_HOTKEY`.
    pub dictation_hotkey: String,
    /// Custom polish system prompt; empty uses the built-in default.
    pub polish_prompt: String,
    /// Custom chat system prompt; empty uses the built-in default.
    /// Per-agent prompts override this.
    pub system_prompt: String,
    /// Default permission mode for chats without an agent: ask|auto|full.
    pub permission_mode: String,
    /// Skills the user switched off (skills are on by default).
    pub skills_disabled: Vec<String>,
    /// Configured MCP servers.
    pub mcp_servers: Vec<crate::mcp::McpServerConfig>,

    // --- Legacy fields (pre multi-provider); read only for migration. ---
    #[serde(skip_serializing)]
    pub base_url: String,
    #[serde(skip_serializing)]
    pub model: String,
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    Ok(dir.join("settings.json"))
}

fn write_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("写入设置失败：{e}"))
}

/// Read stored settings and run one-time migrations. Also used internally by
/// request commands so the frontend never has to pass connection details back
/// to Rust.
pub(crate) fn read_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        let settings = initial_settings();
        write_settings(app, &settings)?;
        return Ok(settings);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取设置失败：{e}"))?;
    let mut settings: AppSettings =
        serde_json::from_str(&raw).map_err(|e| format!("设置文件损坏：{e}"))?;
    let mut changed = false;

    if settings.settings_version < CURRENT_SETTINGS_VERSION {
        remove_legacy_builtin_provider(&mut settings);
        settings.settings_version = CURRENT_SETTINGS_VERSION;
        changed = true;
    }
    if settings.providers.is_empty() && !settings.base_url.trim().is_empty() {
        settings = migrate_legacy(app, settings);
        changed = true;
    }
    if settings.output_language.is_empty() {
        settings.output_language = "auto".into();
        changed = true;
    }
    if settings.permission_mode.is_empty() {
        settings.permission_mode = "auto".into();
        changed = true;
    }
    if changed {
        write_settings(app, &settings)?;
    }
    Ok(settings)
}

/// First-run settings deliberately contain no provider. Users add and own every
/// model service connection themselves.
fn initial_settings() -> AppSettings {
    AppSettings {
        settings_version: CURRENT_SETTINGS_VERSION,
        polish_enabled: true,
        output_language: "auto".into(),
        permission_mode: "auto".into(),
        ..Default::default()
    }
}

/// Remove the provider that older builds injected automatically. The version
/// gate ensures a user-created provider with the same values is not repeatedly
/// removed in future launches.
fn remove_legacy_builtin_provider(settings: &mut AppSettings) {
    let removed_ids: Vec<String> = settings
        .providers
        .iter()
        .filter(|provider| {
            provider.name == LEGACY_BUILTIN_PROVIDER_NAME
                && provider.base_url.trim().trim_end_matches('/')
                    == LEGACY_BUILTIN_PROVIDER_URL.trim_end_matches('/')
        })
        .map(|provider| provider.id.clone())
        .collect();

    if removed_ids.is_empty() {
        return;
    }

    settings
        .providers
        .retain(|provider| !removed_ids.contains(&provider.id));
    for id in &removed_ids {
        let _ = secrets::delete_provider_key(id);
    }

    if removed_ids.contains(&settings.chat_provider_id) {
        settings.chat_provider_id.clear();
        settings.chat_model.clear();
    }
    if removed_ids.contains(&settings.title_provider_id) {
        settings.title_provider_id.clear();
        settings.title_model.clear();
    }
    if removed_ids.contains(&settings.asr_provider_id) {
        settings.asr_provider_id.clear();
        settings.asr_model.clear();
    }
    if removed_ids.contains(&settings.polish_provider_id) {
        settings.polish_provider_id.clear();
        settings.polish_model.clear();
    }
}

/// Migrate legacy `{base_url, model}` + the old single keyring key into a
/// provider named "我的中转站".
fn migrate_legacy(app: &AppHandle, mut settings: AppSettings) -> AppSettings {
    let base = settings.base_url.trim().to_string();
    if base.is_empty() {
        return settings;
    }
    let id = new_id(app);
    // Carry over only the key the user stored in the legacy app.
    if let Some(k) = secrets::get_api_key()
        .ok()
        .flatten()
        .filter(|key| !key.trim().is_empty())
    {
        let _ = secrets::set_provider_key(&id, &k);
    }
    let model = settings.model.trim().to_string();
    settings.providers.push(Provider {
        id: id.clone(),
        name: "我的中转站".into(),
        kind: "openai".into(),
        base_url: base,
        models: if model.is_empty() {
            Vec::new()
        } else {
            vec![ModelInfo::new(model.clone())]
        },
    });
    settings.chat_provider_id = id;
    settings.chat_model = model;
    if !settings.polish_enabled {
        settings.polish_enabled = true;
    }
    settings
}

/// A random provider id. Uses the app's data dir counter-free entropy via uuid
/// is overkill here; a timestamp+random hex from the OS is enough and avoids a
/// new dependency. IDs only need to be unique within this install.
fn new_id(_app: &AppHandle) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Mix in the address of a stack local for a bit of extra entropy.
    let salt = &nanos as *const _ as usize;
    format!("p{nanos:x}{salt:x}")
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    read_settings(&app)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, mut settings: AppSettings) -> Result<(), String> {
    // Never let legacy fields round-trip back into storage.
    settings.settings_version = CURRENT_SETTINGS_VERSION;
    settings.base_url = String::new();
    settings.model = String::new();
    write_settings(&app, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_settings_default_to_the_conversation_model_for_titles() {
        let settings: AppSettings = serde_json::from_str("{}").unwrap();

        assert!(settings.title_provider_id.is_empty());
        assert!(settings.title_model.is_empty());
    }

    #[test]
    fn first_run_starts_without_a_provider() {
        let settings = initial_settings();

        assert!(settings.providers.is_empty());
        assert!(settings.chat_provider_id.is_empty());
        assert_eq!(settings.settings_version, CURRENT_SETTINGS_VERSION);
    }
}
