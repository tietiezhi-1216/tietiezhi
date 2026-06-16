//! Typed model-provider configuration — the cornerstone of Orbit.
//!
//! Everything an integration needs is described here: which *providers* exist
//! (OpenAI today, self-hosted backends later), which *models* they expose, and
//! how each model is reached (`http` vs `realtime_ws`). Models are categorized
//! by `type` (`asr` / `llm`) so the rest of the app can ask "give me the
//! selected ASR model" without caring who serves it.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

fn default_kind() -> String {
    "openai".to_string()
}
fn default_base_url() -> String {
    "https://api.openai.com/v1".to_string()
}
fn default_transport() -> String {
    "http".to_string()
}

/// A model vendor / endpoint. OpenAI is the first-class `kind`; any
/// OpenAI-compatible endpoint works by overriding `base_url`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

/// A concrete model belonging to a provider, tagged by `type` (`asr` | `llm`)
/// and `transport` (`http` | `realtime_ws`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub provider_id: String,
    /// Human-facing label.
    pub name: String,
    /// The provider's model identifier, e.g. `gpt-4o-transcribe`, `gpt-4o-mini`.
    pub model: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default)]
    pub language: Option<String>,
}

/// A reusable prompt for the LLM polish step. `{{transcript}}` (configurable via
/// [`Settings::insert_position`]) marks where the recognized text is injected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptTemplate {
    pub id: String,
    pub name: String,
    pub template: String,
}

/// The full persisted configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub providers: Vec<Provider>,
    pub models: Vec<Model>,
    pub templates: Vec<PromptTemplate>,
    /// macOS virtual keycode (as a string) that toggles dictation.
    /// Default `54` = right ⌘.
    pub hotkey: String,
    pub asr_model_id: Option<String>,
    pub llm_model_id: Option<String>,
    pub active_template_id: Option<String>,
    pub llm_polish_enabled: bool,
    pub auto_insert: bool,
    /// Placeholder name used inside templates (`{{<insert_position>}}`).
    pub insert_position: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            providers: Vec::new(),
            models: Vec::new(),
            templates: vec![PromptTemplate {
                id: "default-polish".to_string(),
                name: "Polish (default)".to_string(),
                template: "You are a dictation assistant. Rewrite the text between the markers so it is clear, correctly punctuated and natural, keeping the original meaning and language. Output only the rewritten text.\n\n{{transcript}}".to_string(),
            }],
            hotkey: "54".to_string(),
            asr_model_id: None,
            llm_model_id: None,
            active_template_id: Some("default-polish".to_string()),
            llm_polish_enabled: false,
            auto_insert: true,
            insert_position: "transcript".to_string(),
        }
    }
}

impl Settings {
    pub fn provider(&self, id: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.id == id)
    }

    pub fn asr_model(&self) -> Option<&Model> {
        self.asr_model_id
            .as_ref()
            .and_then(|id| self.models.iter().find(|m| &m.id == id))
    }

    pub fn llm_model(&self) -> Option<&Model> {
        self.llm_model_id
            .as_ref()
            .and_then(|id| self.models.iter().find(|m| &m.id == id))
    }

    pub fn active_template(&self) -> Option<&PromptTemplate> {
        self.active_template_id
            .as_ref()
            .and_then(|id| self.templates.iter().find(|t| &t.id == id))
    }
}

/// Resolved credentials + model id ready for an API call.
#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub transport: String,
    pub language: Option<String>,
}

impl Settings {
    pub fn resolve(&self, model: &Model) -> Option<ResolvedModel> {
        let provider = self.provider(&model.provider_id)?;
        Some(ResolvedModel {
            base_url: provider.base_url.clone(),
            api_key: provider.api_key.clone(),
            model: model.model.clone(),
            transport: model.transport.clone(),
            language: model.language.clone(),
        })
    }
}

fn file(dir: &Path) -> std::path::PathBuf {
    dir.join("config.json")
}

pub fn load(dir: &Path) -> Settings {
    let mut settings = match fs::read_to_string(file(dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    // Migrate any pre-keycode hotkey (e.g. the old "MetaRight") to right ⌘.
    if settings.hotkey.parse::<i64>().is_err() {
        settings.hotkey = "54".to_string();
    }
    settings
}

pub fn save(dir: &Path, settings: &Settings) -> anyhow::Result<()> {
    fs::create_dir_all(dir)?;
    fs::write(file(dir), serde_json::to_string_pretty(settings)?)?;
    Ok(())
}
