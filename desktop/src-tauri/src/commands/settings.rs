use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::models::{
    deserialize_models, known_kind_override, ModelInfo, ModelKind, DEFAULT_CONTEXT_WINDOW_TOKENS,
};
use crate::secrets;

const CURRENT_SETTINGS_VERSION: u32 = 6;
pub(crate) const BUILTIN_PROVIDER_ID: &str = "builtin-official";
pub(crate) const BUILTIN_PROVIDER_NAME: &str = "Tietiezhi Gateway";
pub(crate) const BUILTIN_PROVIDER_URL: &str = "https://tietiezhi.vip/v1";
const LEGACY_BUILTIN_PROVIDER_URL: &str = "https://api.terln.com/v1";
// Public client credential for the free built-in gateway. This is intentionally
// distributed with the app and must not be used for private or paid accounts.
pub(crate) const BUILTIN_PROVIDER_API_KEY: &str = "sk-terln-fiMX4TCzhvzVLruPLZGoN9JxdjADgTPU";

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
    /// Built-in entries provide a ready-to-configure starting point. They can
    /// be edited, but are kept in the list so the empty state stays actionable.
    #[serde(default)]
    pub built_in: bool,
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
    /// Per-chat reasoning control. English wire value: auto|off|minimal|low|…
    pub chat_reasoning_effort: String,
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
    /// Show per-reply stats (model, tokens, timing) inline under each assistant
    /// message. Off by default; the details popover is always available.
    pub show_message_stats: bool,
    /// Show the model's reasoning / chain-of-thought (collapsed) above replies.
    /// Off by default; only reasoning models that stream it are affected.
    pub show_reasoning: bool,
    /// Show cached, context-aware task suggestions in the workspace empty state.
    pub smart_suggestions_enabled: bool,
    /// Allow suggestion refreshes to use a user-configured non-built-in provider.
    /// Off by default because these background requests may incur charges.
    pub smart_suggestions_allow_paid_models: bool,

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

    if settings.providers.is_empty() && !settings.base_url.trim().is_empty() {
        settings = migrate_legacy(app, settings);
        changed = true;
    }
    if ensure_builtin_provider(&mut settings) {
        changed = true;
    }
    if settings.settings_version < 3 && migrate_model_capability_profiles(&mut settings) {
        changed = true;
    }
    if settings.settings_version < 4 && refresh_registry_capability_profiles(&mut settings) {
        changed = true;
    }
    if settings.settings_version < 5 {
        settings.smart_suggestions_enabled = true;
        settings.smart_suggestions_allow_paid_models = false;
        changed = true;
    }
    if settings.settings_version < 6 {
        for provider in &mut settings.providers {
            for model in &mut provider.models {
                model.context_window = Some(DEFAULT_CONTEXT_WINDOW_TOKENS);
            }
        }
        changed = true;
    }
    if normalize_known_model_capabilities(&mut settings) {
        changed = true;
    }
    if settings.settings_version < CURRENT_SETTINGS_VERSION {
        settings.settings_version = CURRENT_SETTINGS_VERSION;
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
    if settings.chat_reasoning_effort.is_empty() {
        settings.chat_reasoning_effort = "auto".into();
        changed = true;
    }
    if changed {
        write_settings(app, &settings)?;
    }
    Ok(settings)
}

/// Settings v3 separates detected model capabilities from user overrides.
/// Preserve a legacy manual kind edit as an override while enriching every
/// cached model from the bundled registry.
fn migrate_model_capability_profiles(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    for provider in &mut settings.providers {
        for model in &mut provider.models {
            let previous_kind = model.kind;
            let mut enriched = ModelInfo::new(model.id.clone());
            if previous_kind != enriched.kind {
                enriched.overrides.kind = Some(previous_kind);
            }
            *model = enriched;
            changed = true;
        }
    }
    changed
}

/// Registry data evolves independently from user settings. Refresh its base
/// profile without losing provider metadata or explicit user overrides.
fn refresh_registry_capability_profiles(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    for provider in &mut settings.providers {
        for model in &mut provider.models {
            let mut refreshed = ModelInfo::new(model.id.clone());
            if model.capability_source == "provider" {
                refreshed.kind = model.kind;
                refreshed.input_modalities = model.input_modalities.clone();
                refreshed.output_modalities = model.output_modalities.clone();
                refreshed.capabilities = model.capabilities.clone();
                refreshed.context_window = model.context_window;
                refreshed.max_output_tokens = model.max_output_tokens;
                if refreshed.reasoning.is_none() {
                    refreshed.reasoning = model.reasoning.clone();
                }
                refreshed.capability_source = "provider".into();
            }
            refreshed.overrides = model.overrides.clone();
            *model = refreshed;
            changed = true;
        }
    }
    changed
}

fn initial_settings() -> AppSettings {
    AppSettings {
        settings_version: CURRENT_SETTINGS_VERSION,
        providers: vec![builtin_provider()],
        polish_enabled: true,
        output_language: "auto".into(),
        permission_mode: "auto".into(),
        chat_reasoning_effort: "auto".into(),
        smart_suggestions_enabled: true,
        smart_suggestions_allow_paid_models: false,
        ..Default::default()
    }
}

fn builtin_provider() -> Provider {
    Provider {
        id: BUILTIN_PROVIDER_ID.into(),
        name: BUILTIN_PROVIDER_NAME.into(),
        kind: "openai".into(),
        base_url: BUILTIN_PROVIDER_URL.into(),
        built_in: true,
        models: Vec::new(),
    }
}

fn normalized_provider_url(value: &str) -> &str {
    let trimmed = value.trim().trim_end_matches('/');
    trimmed.strip_suffix("/v1").unwrap_or(trimmed)
}

/// Reuse an existing official-endpoint entry when possible so upgrades neither
/// duplicate the provider nor disconnect its keyring entry.
fn ensure_builtin_provider(settings: &mut AppSettings) -> bool {
    let official_url = normalized_provider_url(BUILTIN_PROVIDER_URL);
    let legacy_url = normalized_provider_url(LEGACY_BUILTIN_PROVIDER_URL);
    if let Some(index) = settings.providers.iter().position(|provider| {
        let provider_url = normalized_provider_url(&provider.base_url);
        provider.built_in || provider_url == official_url || provider_url == legacy_url
    }) {
        let mut provider = settings.providers.remove(index);
        let migrate_legacy_url = normalized_provider_url(&provider.base_url) == legacy_url;
        let changed = index != 0
            || !provider.built_in
            || provider.name != BUILTIN_PROVIDER_NAME
            || migrate_legacy_url;
        provider.built_in = true;
        provider.name = BUILTIN_PROVIDER_NAME.into();
        if migrate_legacy_url {
            provider.base_url = BUILTIN_PROVIDER_URL.into();
        }
        settings.providers.insert(0, provider);
        return changed;
    }
    settings.providers.insert(0, builtin_provider());
    true
}

/// Correct cached capabilities for documented ambiguous model ids and clear
/// stale text-model selections. This runs on every settings read so existing
/// installations are repaired without requiring a manual model refresh.
fn normalize_known_model_capabilities(settings: &mut AppSettings) -> bool {
    let mut changed = false;

    for provider in &mut settings.providers {
        for model in &mut provider.models {
            if let Some(kind) = known_kind_override(&model.id) {
                if model.kind != kind {
                    model.kind = kind;
                    changed = true;
                }
            }
        }
    }

    let invalid_selections = [
        (&settings.chat_provider_id, &settings.chat_model),
        (&settings.title_provider_id, &settings.title_model),
        (&settings.asr_provider_id, &settings.asr_model),
        (&settings.polish_provider_id, &settings.polish_model),
    ]
    .map(|(provider_id, model)| {
        let configured = settings
            .providers
            .iter()
            .find(|provider| provider.id == *provider_id)
            .and_then(|provider| {
                provider
                    .models
                    .iter()
                    .find(|candidate| candidate.id == *model)
            })
            .map(ModelInfo::effective_kind);
        match configured {
            Some(kind) => kind != ModelKind::Chat,
            None => matches!(known_kind_override(model), Some(kind) if kind != ModelKind::Chat),
        }
    });

    for ((provider_id, model), invalid) in [
        (&mut settings.chat_provider_id, &mut settings.chat_model),
        (&mut settings.title_provider_id, &mut settings.title_model),
        (&mut settings.asr_provider_id, &mut settings.asr_model),
        (&mut settings.polish_provider_id, &mut settings.polish_model),
    ]
    .into_iter()
    .zip(invalid_selections)
    {
        if invalid {
            provider_id.clear();
            model.clear();
            changed = true;
        }
    }

    changed
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
        built_in: false,
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
    ensure_builtin_provider(&mut settings);
    normalize_known_model_capabilities(&mut settings);
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
    fn first_run_starts_with_an_editable_builtin_provider() {
        let settings = initial_settings();

        assert_eq!(settings.providers.len(), 1);
        assert!(settings.providers[0].built_in);
        assert_eq!(settings.providers[0].id, BUILTIN_PROVIDER_ID);
        assert!(settings.chat_provider_id.is_empty());
        assert!(settings.smart_suggestions_enabled);
        assert!(!settings.smart_suggestions_allow_paid_models);
        assert_eq!(settings.settings_version, CURRENT_SETTINGS_VERSION);
    }

    #[test]
    fn registry_refresh_fixes_stale_reasoning_levels_and_keeps_overrides() {
        use crate::commands::models::{
            ModelCapability, ReasoningEffort, ReasoningMode, ReasoningProfile, ReasoningTransport,
        };

        let mut stale = ModelInfo::new("deepseek-v4-flash");
        stale.reasoning = Some(ReasoningProfile {
            mode: ReasoningMode::Effort,
            supported_efforts: vec![ReasoningEffort::Low, ReasoningEffort::Max],
            default_effort: Some(ReasoningEffort::Max),
            transport: ReasoningTransport::OpenaiReasoningEffort,
        });
        stale.capability_source = "provider".into();
        stale
            .overrides
            .capabilities
            .insert(ModelCapability::ToolCall, false);
        let mut settings = AppSettings {
            providers: vec![Provider {
                id: "relay".into(),
                name: "Relay".into(),
                kind: "openai".into(),
                base_url: "https://example.com/v1".into(),
                built_in: false,
                models: vec![stale],
            }],
            ..Default::default()
        };

        assert!(refresh_registry_capability_profiles(&mut settings));
        let refreshed = &settings.providers[0].models[0];
        let profile = refreshed.effective_reasoning().unwrap();
        assert!(profile.supported_efforts.contains(&ReasoningEffort::Xhigh));
        assert!(!profile.supported_efforts.contains(&ReasoningEffort::Max));
        assert!(!refreshed.has_capability(ModelCapability::ToolCall));
        assert_eq!(refreshed.capability_source, "provider");
    }

    #[test]
    fn existing_official_endpoint_is_promoted_without_duplication() {
        let mut settings = AppSettings {
            providers: vec![Provider {
                id: "existing".into(),
                name: "我的渠道".into(),
                kind: "openai".into(),
                base_url: "https://api.terln.com/v1/".into(),
                built_in: false,
                models: Vec::new(),
            }],
            ..Default::default()
        };

        let changed = ensure_builtin_provider(&mut settings);

        assert!(changed);
        assert_eq!(settings.providers.len(), 1);
        assert!(settings.providers[0].built_in);
        assert_eq!(settings.providers[0].id, "existing");
        assert_eq!(settings.providers[0].name, BUILTIN_PROVIDER_NAME);
        assert_eq!(settings.providers[0].base_url, BUILTIN_PROVIDER_URL);
    }

    #[test]
    fn ambiguous_image_model_is_reclassified_and_removed_from_text_selections() {
        let mut settings = AppSettings {
            providers: vec![Provider {
                id: "provider".into(),
                name: "Provider".into(),
                kind: "openai".into(),
                base_url: "https://example.com/v1".into(),
                built_in: false,
                models: vec![ModelInfo {
                    kind: ModelKind::Chat,
                    ..ModelInfo::new("sensenova-u1-fast")
                }],
            }],
            chat_provider_id: "provider".into(),
            chat_model: "sensenova-u1-fast".into(),
            title_provider_id: "provider".into(),
            title_model: "sensenova-u1-fast".into(),
            polish_provider_id: "provider".into(),
            polish_model: "sensenova-u1-fast".into(),
            ..Default::default()
        };

        assert!(normalize_known_model_capabilities(&mut settings));
        assert_eq!(settings.providers[0].models[0].kind, ModelKind::Image);
        assert!(settings.chat_provider_id.is_empty());
        assert!(settings.chat_model.is_empty());
        assert!(settings.title_provider_id.is_empty());
        assert!(settings.title_model.is_empty());
        assert!(settings.polish_provider_id.is_empty());
        assert!(settings.polish_model.is_empty());
        assert!(!normalize_known_model_capabilities(&mut settings));
    }
}
