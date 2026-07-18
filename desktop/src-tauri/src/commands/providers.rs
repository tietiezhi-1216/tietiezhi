use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::models::ModelInfo;
use super::settings::{read_settings, Provider};
use super::{api_url, snippet};
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
    pub base_url: String,
    pub key: Option<String>,
    #[allow(dead_code)]
    pub kind: String,
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

    let key = secrets::get_provider_key(provider_id)?;

    Ok(Resolved {
        base_url: provider.base_url.clone(),
        key,
        kind: provider.kind.clone(),
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
            let has_key = secrets::get_provider_key(&p.id)?.is_some();
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
    provider: Provider,
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
        Some(existing) => *existing = provider.clone(),
        None => settings.providers.push(provider.clone()),
    }
    super::settings::save_settings(app.clone(), settings)?;

    if let Some(key) = api_key
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
    let key = match api_key
        .map(|k| k.trim().to_owned())
        .filter(|k| !k.is_empty())
    {
        Some(k) => Some(k),
        None => secrets::get_provider_key(&id)?,
    };

    let models = fetch_models(&state.http, &base, key.as_deref(), &kind).await?;

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

async fn fetch_models(
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
        return Err(format!(
            "供应商返回 HTTP {}：{}",
            status.as_u16(),
            snippet(&body)
        ));
    }

    #[derive(Deserialize)]
    struct ModelsResponse {
        #[serde(default)]
        data: Vec<ModelEntry>,
    }
    #[derive(Deserialize)]
    struct ModelEntry {
        id: String,
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
    let mut ids: Vec<String> = parsed.data.into_iter().map(|m| m.id).collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        let fb = fallback_models(kind);
        if !fb.is_empty() {
            return Ok(fb);
        }
    }
    // `/v1/models` carries no capability metadata (the relay drops it — see
    // models.rs), so each id is classified by name.
    Ok(ids.into_iter().map(ModelInfo::new).collect())
}
