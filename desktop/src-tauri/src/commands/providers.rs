use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::models::{
    ModelCapability, ModelInfo, ModelModality, ReasoningEffort, ReasoningMode, ReasoningProfile,
    ReasoningTransport,
};
use super::settings::{read_settings, Provider, WireApi};
use super::{api_url, provider_http_error, snippet};
use crate::{secrets, AppState};

/// A provider as sent to the frontend: the same fields plus whether a key is
/// stored (the key itself never leaves Rust).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    #[serde(flatten)]
    pub provider: Provider,
    pub has_key: bool,
}

/// Resolved connection details for a provider, used by request commands.
pub(crate) struct Resolved {
    pub id: String,
    pub base_url: String,
    pub key: Option<String>,
    #[allow(dead_code)]
    pub kind: String,
    pub wire_api: WireApi,
    pub models: Vec<ModelInfo>,
    pub built_in: bool,
}

#[derive(Debug, Deserialize)]
struct ProviderReasoning {
    mode: ReasoningMode,
    #[serde(default)]
    supported_efforts: Vec<ReasoningEffort>,
    #[serde(default)]
    default_effort: Option<ReasoningEffort>,
    transport: ReasoningTransport,
}

fn apply_provider_reasoning(model: &mut ModelInfo, reasoning: ProviderReasoning) {
    if !model.capabilities.contains(&ModelCapability::Reasoning) {
        model.capabilities.push(ModelCapability::Reasoning);
    }
    model.reasoning = Some(ReasoningProfile {
        mode: reasoning.mode,
        supported_efforts: reasoning.supported_efforts,
        default_effort: reasoning.default_effort,
        transport: reasoning.transport,
    });
}

fn select_provider_api_key(
    gateway_key: Option<String>,
    stored_provider_key: Option<String>,
    built_in: bool,
) -> Result<Option<String>, String> {
    match gateway_key {
        Some(key) => Ok(Some(key)),
        None if built_in => Err("请先登录中转站".into()),
        None => Ok(stored_provider_key),
    }
}

/// Curated fallback catalog per provider type, used when the provider has no
/// `/v1/models` route (Xiaomi MiMo does not document one).
fn fallback_models(kind: &str) -> Vec<ModelInfo> {
    match kind {
        "mimo" => ["mimo-v2.5-pro", "mimo-v2.5-asr", "mimo-v2.5-tts"]
            .into_iter()
            .map(ModelInfo::new)
            .collect(),
        _ => Vec::new(),
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err("非法的供应商 ID".into())
    }
}

/// Resolve a provider's base URL + key by id. `pub(crate)` so chat / dictation
/// commands can look up connection details without the frontend passing them.
pub(crate) fn resolve(app: &AppHandle, provider_id: &str) -> Result<Resolved, String> {
    let settings = read_settings(app)?;
    let provider = settings
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or("未找到所选供应商，请到「设置」检查")?;

    let gateway_key = super::gateway_auth::gateway_api_key(provider_id, &provider.base_url)?;
    let legacy_builtin =
        provider.built_in && super::settings::is_legacy_builtin_provider_url(&provider.base_url);
    let stored_provider_key = if !provider.built_in || legacy_builtin {
        secrets::get_provider_key(provider_id)?
    } else {
        None
    };
    let key = select_provider_api_key(
        gateway_key,
        stored_provider_key,
        provider.built_in && !legacy_builtin,
    )?;

    Ok(Resolved {
        id: provider.id.clone(),
        base_url: provider.base_url.clone(),
        key,
        kind: provider.kind.clone(),
        wire_api: provider.wire_api,
        models: provider.models.clone(),
        built_in: provider.built_in,
    })
}

/// The stored API key for a provider, so the settings editor can show it behind
/// a reveal toggle.
#[tauri::command]
pub fn provider_key(id: String) -> Result<Option<String>, String> {
    validate_id(&id)?;
    secrets::get_provider_key(&id)
}

#[tauri::command]
pub fn list_providers(app: AppHandle) -> Result<Vec<ProviderView>, String> {
    let settings = read_settings(&app)?;
    settings
        .providers
        .into_iter()
        .map(|p| {
            let has_key = !p.built_in && secrets::get_provider_key(&p.id)?.is_some();
            Ok(ProviderView {
                provider: p,
                has_key,
            })
        })
        .collect()
}

/// Create or update a provider. `api_key` (when non-empty) is stored in the
/// keyring; an empty/omitted key leaves any existing key untouched.
#[tauri::command]
pub fn upsert_provider(
    app: AppHandle,
    mut provider: Provider,
    api_key: Option<String>,
) -> Result<(), String> {
    validate_id(&provider.id)?;
    if provider.name.trim().is_empty() {
        return Err("供应商名称不能为空".into());
    }
    if !provider.base_url.starts_with("http://") && !provider.base_url.starts_with("https://") {
        return Err("baseURL 需以 http:// 或 https:// 开头".into());
    }

    let mut settings = read_settings(&app)?;
    match settings.providers.iter_mut().find(|p| p.id == provider.id) {
        Some(existing) => {
            provider.built_in = existing.built_in;
            if existing.built_in {
                provider.name = super::settings::BUILTIN_PROVIDER_NAME.into();
                provider.wire_api = WireApi::Responses;
            }
            *existing = provider.clone();
        }
        None => settings.providers.push(provider.clone()),
    }
    super::settings::save_settings(app.clone(), settings)?;

    if provider.built_in {
        secrets::delete_provider_key(&provider.id)?;
    } else if let Some(key) = api_key
        .map(|k| k.trim().to_owned())
        .filter(|k| !k.is_empty())
    {
        secrets::set_provider_key(&provider.id, &key)?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_provider(app: AppHandle, id: String) -> Result<(), String> {
    let mut settings = read_settings(&app)?;
    if settings.providers.iter().any(|p| p.id == id && p.built_in) {
        return Err("内置渠道不能删除，其访问凭据由应用管理".into());
    }
    settings.providers.retain(|p| p.id != id);
    // Clear any selection that referenced the removed provider.
    for sel in [
        &mut settings.chat_provider_id,
        &mut settings.title_provider_id,
        &mut settings.asr_provider_id,
        &mut settings.polish_provider_id,
    ] {
        if *sel == id {
            sel.clear();
        }
    }
    if settings.title_provider_id.is_empty() {
        settings.title_model.clear();
    }
    super::settings::save_settings(app, settings)?;
    secrets::delete_provider_key(&id)
}

/// Fetch a provider's model list via `GET /v1/models`, caching it into the
/// provider record. Falls back to a curated list for providers without a models
/// route (e.g. MiMo). `api_key` overrides the stored key so users can test a key
/// before saving it.
#[tauri::command]
pub async fn fetch_provider_models(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    base_url: Option<String>,
    kind: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<ModelInfo>, String> {
    // Prefer explicit args (unsaved form values) over the stored provider.
    let stored = read_settings(&app)?
        .providers
        .into_iter()
        .find(|p| p.id == id);
    let base = base_url
        .filter(|b| !b.trim().is_empty())
        .or_else(|| stored.as_ref().map(|p| p.base_url.clone()))
        .ok_or("缺少 baseURL")?;
    let kind = kind
        .filter(|k| !k.trim().is_empty())
        .or_else(|| stored.as_ref().map(|p| p.kind.clone()))
        .unwrap_or_else(|| "openai".into());
    let built_in = stored.as_ref().is_some_and(|provider| provider.built_in);
    let legacy_builtin = built_in && super::settings::is_legacy_builtin_provider_url(&base);
    let key = if built_in && !legacy_builtin {
        let gateway_key = super::gateway_auth::gateway_api_key(&id, &base)?;
        select_provider_api_key(gateway_key, None, true)?
    } else {
        match api_key
            .map(|k| k.trim().to_owned())
            .filter(|k| !k.is_empty())
        {
            Some(key) => Some(key),
            None => {
                let gateway_key = super::gateway_auth::gateway_api_key(&id, &base)?;
                let stored_provider_key = secrets::get_provider_key(&id)?;
                select_provider_api_key(gateway_key, stored_provider_key, false)?
            }
        }
    };

    let mut models = fetch_models(&state.http, &base, key.as_deref(), &kind).await?;

    if let Some(previous) = &stored {
        for model in &mut models {
            if let Some(old) = previous.models.iter().find(|old| old.id == model.id) {
                model.merge_overrides_from(old);
            }
        }
    }

    // Cache into the stored provider, if it exists.
    if stored.is_some() {
        let mut settings = read_settings(&app)?;
        if let Some(p) = settings.providers.iter_mut().find(|p| p.id == id) {
            p.models = models.clone();
        }
        super::settings::save_settings(app, settings)?;
    }
    Ok(models)
}

pub(crate) async fn fetch_models(
    http: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    kind: &str,
) -> Result<Vec<ModelInfo>, String> {
    let base = base_url.trim();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("baseURL 需以 http:// 或 https:// 开头".into());
    }

    let mut req = http
        .get(api_url(base, "models"))
        .timeout(Duration::from_secs(15));
    // MiMo accepts `Authorization: Bearer`, same as OpenAI-compatible relays.
    if let Some(key) = api_key {
        req = req.bearer_auth(key);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let fb = fallback_models(kind);
            if fb.is_empty() {
                return Err(format!("无法连接供应商：{e}"));
            }
            return Ok(fb);
        }
    };
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        let fb = fallback_models(kind);
        if !fb.is_empty() {
            return Ok(fb);
        }
        return Err(provider_http_error("供应商", status, &body));
    }

    #[derive(Deserialize)]
    struct ModelsResponse {
        #[serde(default)]
        data: Vec<ModelEntry>,
    }
    #[derive(Deserialize)]
    struct ModelEntry {
        id: String,
        #[serde(default)]
        capabilities: Vec<String>,
        #[serde(default)]
        supported_parameters: Vec<String>,
        #[serde(default)]
        architecture: Option<ModelArchitecture>,
        #[serde(default)]
        #[allow(dead_code)]
        context_length: Option<u64>,
        #[serde(default)]
        max_output_tokens: Option<u64>,
        #[serde(default)]
        top_provider: Option<TopProvider>,
        #[serde(default)]
        reasoning: Option<ProviderReasoning>,
    }
    #[derive(Deserialize)]
    struct ModelArchitecture {
        #[serde(default)]
        input_modalities: Vec<String>,
        #[serde(default)]
        output_modalities: Vec<String>,
    }
    #[derive(Deserialize)]
    struct TopProvider {
        #[serde(default)]
        max_completion_tokens: Option<u64>,
    }

    let parsed: ModelsResponse = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(_) => {
            let fb = fallback_models(kind);
            if !fb.is_empty() {
                return Ok(fb);
            }
            return Err(format!("响应不是合法的模型列表：{}", snippet(&body)));
        }
    };
    let mut entries = parsed.data;
    entries.sort_by(|a, b| a.id.cmp(&b.id));
    entries.dedup_by(|a, b| a.id == b.id);
    if entries.is_empty() {
        let fb = fallback_models(kind);
        if !fb.is_empty() {
            return Ok(fb);
        }
    }
    Ok(entries
        .into_iter()
        .map(|entry| {
            let mut model = ModelInfo::new(entry.id);
            let mut has_metadata = false;

            if let Some(reasoning) = entry.reasoning {
                apply_provider_reasoning(&mut model, reasoning);
                has_metadata = true;
            }

            if let Some(architecture) = entry.architecture {
                let input = parse_modalities(&architecture.input_modalities);
                let output = parse_modalities(&architecture.output_modalities);
                if !input.is_empty() {
                    model.input_modalities = input;
                    has_metadata = true;
                }
                if !output.is_empty() {
                    model.output_modalities = output;
                    has_metadata = true;
                }
            }

            let declared_capabilities: Vec<_> = entry
                .capabilities
                .iter()
                .filter_map(|value| parse_capability(value))
                .collect();
            if !declared_capabilities.is_empty() {
                // A provider's explicit capability list is more current than
                // the bundled registry. supported_parameters then augments it.
                model.capabilities = declared_capabilities;
                has_metadata = true;
            }
            for capability in entry
                .supported_parameters
                .iter()
                .filter_map(|value| parse_capability(value))
            {
                if !model.capabilities.contains(&capability) {
                    model.capabilities.push(capability);
                }
                has_metadata = true;
            }

            if model.capabilities.contains(&ModelCapability::Reasoning) && model.reasoning.is_none()
            {
                model.reasoning = Some(ReasoningProfile {
                    mode: ReasoningMode::Effort,
                    supported_efforts: vec![
                        ReasoningEffort::Low,
                        ReasoningEffort::Medium,
                        ReasoningEffort::High,
                    ],
                    default_effort: Some(ReasoningEffort::Auto),
                    transport: ReasoningTransport::OpenaiReasoningEffort,
                });
            }

            // Keep every model on the temporary 256K product-wide context
            // policy until Gateway model metadata becomes the source of truth.
            model.context_window = Some(super::models::DEFAULT_CONTEXT_WINDOW_TOKENS);
            model.max_output_tokens = entry
                .max_output_tokens
                .or_else(|| entry.top_provider.and_then(|p| p.max_completion_tokens))
                .or(model.max_output_tokens);
            if model.context_window.is_some() || model.max_output_tokens.is_some() {
                has_metadata = true;
            }
            if has_metadata {
                model.capability_source = "provider".into();
            }
            model
        })
        .collect())
}

fn parse_modalities(values: &[String]) -> Vec<ModelModality> {
    values
        .iter()
        .filter_map(|value| match value.trim().to_ascii_lowercase().as_str() {
            "text" => Some(ModelModality::Text),
            "image" => Some(ModelModality::Image),
            "audio" => Some(ModelModality::Audio),
            "video" => Some(ModelModality::Video),
            "file" | "pdf" => Some(ModelModality::File),
            "vector" | "embeddings" => Some(ModelModality::Vector),
            _ => None,
        })
        .collect()
}

fn parse_capability(value: &str) -> Option<ModelCapability> {
    match value.trim().to_ascii_lowercase().as_str() {
        "tool-call" | "function-call" | "function_calling" | "tools" => {
            Some(ModelCapability::ToolCall)
        }
        "reasoning" | "reasoning_effort" => Some(ModelCapability::Reasoning),
        "structured-output" | "structured_outputs" | "response_format" => {
            Some(ModelCapability::StructuredOutput)
        }
        "web-search" | "web_search" | "web_search_options" => Some(ModelCapability::WebSearch),
        _ => None,
    }
}

#[cfg(test)]
mod builtin_tests {
    use super::*;

    #[test]
    fn built_in_provider_requires_login() {
        let selected = select_provider_api_key(None, Some("stale-provider-key".into()), true);

        assert_eq!(selected.unwrap_err(), "请先登录中转站");
    }

    #[test]
    fn legacy_builtin_can_reuse_its_existing_provider_key() {
        let selected = select_provider_api_key(None, Some("legacy-provider-key".into()), false);

        assert_eq!(selected.unwrap().as_deref(), Some("legacy-provider-key"));
    }

    #[test]
    fn gateway_account_key_has_highest_priority() {
        let selected = select_provider_api_key(
            Some("account-key".into()),
            Some("stored-provider-key".into()),
            true,
        );

        assert_eq!(selected.unwrap().as_deref(), Some("account-key"));
    }

    #[test]
    fn gateway_reasoning_metadata_overrides_registry_profile() {
        let reasoning: ProviderReasoning = serde_json::from_str(
            r#"{
                "mode":"effort",
                "supported_efforts":["off","low","high","xhigh"],
                "default_effort":"high",
                "transport":"openai-reasoning-effort"
            }"#,
        )
        .unwrap();
        let mut model = ModelInfo::new("gpt-5.5");
        apply_provider_reasoning(&mut model, reasoning);
        let profile = model.reasoning.unwrap();
        assert_eq!(
            profile.supported_efforts,
            vec![
                ReasoningEffort::Off,
                ReasoningEffort::Low,
                ReasoningEffort::High,
                ReasoningEffort::Xhigh,
            ]
        );
        assert_eq!(profile.default_effort, Some(ReasoningEffort::High));
    }
}
