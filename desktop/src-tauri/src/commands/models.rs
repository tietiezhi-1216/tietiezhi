//! Model capability classification.
//!
//! OpenAI-compatible `/v1/models` carries no capability metadata — every entry
//! is just `{"id": "...", "object": "model"}` — so the id is all we have to go
//! on. Matching is token-based (split on non-alphanumerics) rather than plain
//! substring so "agnes-…" can't be mistaken for an ASR model.
//!
//! This is what keeps an image model out of the chat picker and a chat model out
//! of the dictation (ASR) picker.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Deserializer, Serialize};

pub use crate::agent::context::DEFAULT_CONTEXT_WINDOW_TOKENS;

/// What a model can be used for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    /// Text / multimodal chat completions.
    Chat,
    /// Speech-to-text.
    Asr,
    /// Text-to-speech.
    Tts,
    /// Music and sound-effect generation.
    Audio,
    /// Image generation.
    Image,
    /// Video generation.
    Video,
    Embedding,
    /// Recognised but not usable by this app (rerank, moderation, …).
    Other,
}

impl Default for ModelKind {
    fn default() -> Self {
        Self::Chat
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelCapability {
    ToolCall,
    Reasoning,
    StructuredOutput,
    WebSearch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelModality {
    Text,
    Image,
    Audio,
    Video,
    File,
    Vector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Auto,
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ReasoningEffort {
    pub fn from_setting(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "off" | "none" => Self::Off,
            "minimal" => Self::Minimal,
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "xhigh" => Self::Xhigh,
            "max" => Self::Max,
            _ => Self::Auto,
        }
    }

    pub fn as_wire_value(self) -> Option<&'static str> {
        match self {
            Self::Auto => None,
            Self::Off => Some("none"),
            Self::Minimal => Some("minimal"),
            Self::Low => Some("low"),
            Self::Medium => Some("medium"),
            Self::High => Some("high"),
            Self::Xhigh => Some("xhigh"),
            Self::Max => Some("max"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningMode {
    Fixed,
    Effort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReasoningTransport {
    None,
    OpenaiReasoningEffort,
    OpenrouterReasoning,
    EnableThinking,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningProfile {
    pub mode: ReasoningMode,
    #[serde(default)]
    pub supported_efforts: Vec<ReasoningEffort>,
    #[serde(default)]
    pub default_effort: Option<ReasoningEffort>,
    pub transport: ReasoningTransport,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelOverrides {
    pub kind: Option<ModelKind>,
    pub input_modalities: Option<Vec<ModelModality>>,
    pub output_modalities: Option<Vec<ModelModality>>,
    pub capabilities: BTreeMap<ModelCapability, bool>,
    pub reasoning: Option<ReasoningProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    #[serde(default)]
    pub kind: ModelKind,
    #[serde(default)]
    pub input_modalities: Vec<ModelModality>,
    #[serde(default)]
    pub output_modalities: Vec<ModelModality>,
    #[serde(default)]
    pub capabilities: Vec<ModelCapability>,
    #[serde(default)]
    pub reasoning: Option<ReasoningProfile>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    #[serde(default = "default_capability_source")]
    pub capability_source: String,
    #[serde(default)]
    pub overrides: ModelOverrides,
}

impl ModelInfo {
    pub fn new(id: impl Into<String>) -> Self {
        let id = id.into();
        let kind = classify(&id);
        let (input_modalities, output_modalities) = default_modalities(kind);
        let mut model = Self {
            id,
            kind,
            input_modalities,
            output_modalities,
            capabilities: Vec::new(),
            reasoning: None,
            context_window: Some(DEFAULT_CONTEXT_WINDOW_TOKENS),
            max_output_tokens: None,
            capability_source: default_capability_source(),
            overrides: ModelOverrides::default(),
        };
        model.apply_registry();
        // Temporary product-wide policy. Provider-specific limits will replace
        // this once the Gateway catalog exposes trustworthy context metadata.
        model.context_window = Some(DEFAULT_CONTEXT_WINDOW_TOKENS);
        model
    }

    pub fn effective_kind(&self) -> ModelKind {
        self.overrides.kind.unwrap_or(self.kind)
    }

    pub fn has_capability(&self, capability: ModelCapability) -> bool {
        self.overrides
            .capabilities
            .get(&capability)
            .copied()
            .unwrap_or_else(|| self.capabilities.contains(&capability))
    }

    pub fn effective_reasoning(&self) -> Option<&ReasoningProfile> {
        if !self.has_capability(ModelCapability::Reasoning) {
            return None;
        }
        self.overrides
            .reasoning
            .as_ref()
            .or(self.reasoning.as_ref())
    }

    pub fn merge_overrides_from(&mut self, previous: &Self) {
        self.overrides = previous.overrides.clone();
    }

    fn apply_registry(&mut self) {
        let normalized = self.id.trim().to_ascii_lowercase();
        let registry = registry();
        let entry = registry
            .entries
            .iter()
            .find(|entry| {
                entry
                    .ids
                    .iter()
                    .any(|id| id.eq_ignore_ascii_case(&normalized))
            })
            .or_else(|| {
                registry
                    .entries
                    .iter()
                    .filter(|entry| {
                        entry
                            .prefixes
                            .iter()
                            .any(|prefix| normalized.starts_with(&prefix.to_ascii_lowercase()))
                    })
                    .max_by_key(|entry| {
                        entry
                            .prefixes
                            .iter()
                            .filter(|prefix| normalized.starts_with(&prefix.to_ascii_lowercase()))
                            .map(String::len)
                            .max()
                            .unwrap_or(0)
                    })
            });
        let Some(entry) = entry else { return };

        if let Some(kind) = entry.kind {
            self.kind = kind;
        }
        if let Some(input) = &entry.input_modalities {
            self.input_modalities = input.clone();
        }
        if let Some(output) = &entry.output_modalities {
            self.output_modalities = output.clone();
        }
        if let Some(capabilities) = &entry.capabilities {
            self.capabilities = capabilities.clone();
        }
        if entry.reasoning.is_some() {
            self.reasoning = entry.reasoning.clone();
        }
        self.context_window = entry.context_window.or(self.context_window);
        self.max_output_tokens = entry.max_output_tokens.or(self.max_output_tokens);
        self.capability_source = "registry".into();
    }
}

fn default_capability_source() -> String {
    "inferred".into()
}

fn default_modalities(kind: ModelKind) -> (Vec<ModelModality>, Vec<ModelModality>) {
    match kind {
        ModelKind::Chat => (vec![ModelModality::Text], vec![ModelModality::Text]),
        ModelKind::Asr => (vec![ModelModality::Audio], vec![ModelModality::Text]),
        ModelKind::Tts => (vec![ModelModality::Text], vec![ModelModality::Audio]),
        ModelKind::Audio => (
            vec![ModelModality::Text, ModelModality::Audio],
            vec![ModelModality::Audio],
        ),
        ModelKind::Image => (
            vec![ModelModality::Text, ModelModality::Image],
            vec![ModelModality::Image],
        ),
        ModelKind::Video => (
            vec![
                ModelModality::Text,
                ModelModality::Image,
                ModelModality::Video,
            ],
            vec![ModelModality::Video],
        ),
        ModelKind::Embedding => (vec![ModelModality::Text], vec![ModelModality::Vector]),
        ModelKind::Other => (vec![ModelModality::Text], vec![ModelModality::Text]),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelRegistry {
    #[allow(dead_code)]
    schema_version: u32,
    #[allow(dead_code)]
    updated_at: String,
    entries: Vec<ModelRegistryEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelRegistryEntry {
    #[allow(dead_code)]
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    prefixes: Vec<String>,
    #[serde(default)]
    kind: Option<ModelKind>,
    #[serde(default)]
    input_modalities: Option<Vec<ModelModality>>,
    #[serde(default)]
    output_modalities: Option<Vec<ModelModality>>,
    #[serde(default)]
    capabilities: Option<Vec<ModelCapability>>,
    #[serde(default)]
    reasoning: Option<ReasoningProfile>,
    #[serde(default)]
    context_window: Option<u64>,
    #[serde(default)]
    max_output_tokens: Option<u64>,
}

fn registry() -> &'static ModelRegistry {
    static REGISTRY: OnceLock<ModelRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../shared/model-registry/models.json"
        ))
        .expect("bundled model registry must be valid")
    })
}

/// Lowercased alphanumeric tokens of a model id.
fn tokens(id: &str) -> Vec<String> {
    id.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_ascii_lowercase())
        .collect()
}

/// Derive a model's capability from its id.
pub fn classify(id: &str) -> ModelKind {
    let lower = id.to_ascii_lowercase();
    let tokens = tokens(id);
    let has = |t: &str| tokens.iter().any(|x| x == t);

    // Some provider model ids do not expose their capability in the name.
    // Keep exact, documented exceptions here so they never fall through to
    // the permissive Chat default.
    if let Some(kind) = known_kind_override(&lower) {
        return kind;
    }

    // Speech-to-text first: "speech" alone is ambiguous, so ASR's distinctive
    // markers get to claim it before the TTS rule below.
    if has("asr") || has("stt") || lower.contains("whisper") || lower.contains("transcrib") {
        return ModelKind::Asr;
    }
    if has("tts") || lower.contains("text-to-speech") || has("speech") || has("voice") {
        return ModelKind::Tts;
    }
    if has("music")
        || has("suno")
        || has("udio")
        || has("sfx")
        || lower.contains("text-to-music")
        || lower.contains("sound-effect")
    {
        return ModelKind::Audio;
    }
    if has("image")
        || has("img")
        || lower.contains("dall-e")
        || has("dalle")
        || has("flux")
        || lower.contains("stable-diffusion")
        || has("midjourney")
    {
        return ModelKind::Image;
    }
    if has("video") || has("sora") || has("veo") || has("kling") || has("runway") {
        return ModelKind::Video;
    }
    if has("embedding") || has("embed") || has("bge") || has("m3e") {
        return ModelKind::Embedding;
    }
    if has("rerank") || has("moderation") {
        return ModelKind::Other;
    }
    ModelKind::Chat
}

/// Curated capability overrides for model ids whose names are ambiguous.
pub fn known_kind_override(id: &str) -> Option<ModelKind> {
    match id.trim().to_ascii_lowercase().as_str() {
        "sensenova-u1-fast" => Some(ModelKind::Image),
        _ => None,
    }
}

/// Deserialize `models` from either the current `[{id, kind}]` shape or the
/// legacy `["id", …]` one (settings written before capabilities existed).
pub fn deserialize_models<'de, D>(d: D) -> Result<Vec<ModelInfo>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Stored {
        Info(ModelInfo),
        Id(String),
    }

    let raw = Vec::<Stored>::deserialize(d)?;
    Ok(raw
        .into_iter()
        .map(|m| match m {
            Stored::Info(info) => info,
            Stored::Id(id) => ModelInfo::new(id),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_real_relay_catalog() {
        // Chat
        for id in [
            "gpt-5.5",
            "gpt-5.3-codex-spark",
            "claude-opus-4-6-thinking",
            "gemini-3.1-pro-high",
            "gemini-3-flash-agent",
            "deepseek-v4-flash",
            "gpt-oss-120b-medium",
            "agnes-2.0-flash",
            "codex-auto-review",
            "mimo-v2.5-pro",
        ] {
            assert_eq!(classify(id), ModelKind::Chat, "{id}");
        }

        // Image
        for id in [
            "gpt-image-2",
            "agnes-image-2.1-flash",
            "gemini-2.5-flash-image",
            "gemini-3-pro-image-preview",
            "sensenova-u1-fast",
        ] {
            assert_eq!(classify(id), ModelKind::Image, "{id}");
        }

        assert_eq!(classify("agnes-video-v2.0"), ModelKind::Video);
        assert_eq!(classify("mimo-v2.5-asr"), ModelKind::Asr);
        assert_eq!(classify("whisper-1"), ModelKind::Asr);
        assert_eq!(classify("gpt-4o-transcribe"), ModelKind::Asr);
        assert_eq!(classify("mimo-v2.5-tts"), ModelKind::Tts);
        assert_eq!(classify("suno-music-v4"), ModelKind::Audio);
        assert_eq!(classify("sound-effect-v2"), ModelKind::Audio);
        assert_eq!(classify("text-embedding-3-large"), ModelKind::Embedding);
        assert_eq!(classify("bge-reranker-v2"), ModelKind::Embedding);
    }

    /// Token matching, not substring: "agnes" must not read as ASR.
    #[test]
    fn does_not_substring_match() {
        assert_eq!(classify("agnes-1.5-flash"), ModelKind::Chat);
        assert_ne!(classify("imagine-chat"), ModelKind::Image);
    }

    #[test]
    fn legacy_string_models_migrate() {
        let json = r#"["gpt-5.5","mimo-v2.5-asr"]"#;
        let mut de = serde_json::Deserializer::from_str(json);
        let models = deserialize_models(&mut de).unwrap();
        assert_eq!(models[0].kind, ModelKind::Chat);
        assert_eq!(models[1].kind, ModelKind::Asr);
    }

    #[test]
    fn current_shape_roundtrips() {
        let json = r#"[{"id":"gpt-image-2","kind":"image"}]"#;
        let mut de = serde_json::Deserializer::from_str(json);
        let models = deserialize_models(&mut de).unwrap();
        assert_eq!(models[0].kind, ModelKind::Image);
    }

    #[test]
    fn bundled_registry_enriches_known_chat_models() {
        let model = ModelInfo::new("gpt-5.5");
        assert!(model.input_modalities.contains(&ModelModality::Image));
        assert!(model.has_capability(ModelCapability::ToolCall));
        assert!(model.has_capability(ModelCapability::Reasoning));
        assert_eq!(model.context_window, Some(DEFAULT_CONTEXT_WINDOW_TOKENS));
        assert_eq!(model.capability_source, "registry");
    }

    #[test]
    fn unknown_models_also_default_to_256k_context() {
        let model = ModelInfo::new("future-chat-model");
        assert_eq!(model.context_window, Some(DEFAULT_CONTEXT_WINDOW_TOKENS));
    }

    #[test]
    fn model_ids_with_an_effort_suffix_are_fixed() {
        for (id, expected) in [
            ("gemini-3.1-pro-high", ReasoningEffort::High),
            ("gpt-oss-120b-medium", ReasoningEffort::Medium),
        ] {
            let model = ModelInfo::new(id);
            let profile = model.effective_reasoning().unwrap();
            assert_eq!(profile.mode, ReasoningMode::Fixed, "{id}");
            assert_eq!(profile.default_effort, Some(expected), "{id}");
            assert_eq!(profile.transport, ReasoningTransport::None, "{id}");
        }
    }

    #[test]
    fn deepseek_v4_uses_the_gateway_effort_vocabulary() {
        let model = ModelInfo::new("deepseek-v4-flash");
        let profile = model.effective_reasoning().unwrap();
        assert_eq!(
            profile.supported_efforts,
            vec![
                ReasoningEffort::Off,
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::Xhigh,
            ]
        );
        assert!(!profile.supported_efforts.contains(&ReasoningEffort::Max));
    }

    #[test]
    fn user_capability_override_wins_over_registry() {
        let mut model = ModelInfo::new("gpt-5.5");
        model
            .overrides
            .capabilities
            .insert(ModelCapability::ToolCall, false);
        assert!(!model.has_capability(ModelCapability::ToolCall));
    }
}
