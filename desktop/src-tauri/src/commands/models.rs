//! Model capability classification.
//!
//! OpenAI-compatible `/v1/models` carries no capability metadata — every entry
//! is just `{"id": "...", "object": "model"}` — so the id is all we have to go
//! on. Matching is token-based (split on non-alphanumerics) rather than plain
//! substring so "agnes-…" can't be mistaken for an ASR model.
//!
//! This is what keeps an image model out of the chat picker and a chat model out
//! of the dictation (ASR) picker.

use serde::{Deserialize, Deserializer, Serialize};

/// What a model can be used for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    /// Text / multimodal chat completions.
    Chat,
    /// Speech-to-text.
    Asr,
    /// Text-to-speech.
    Tts,
    /// Image generation.
    Image,
    /// Video generation.
    Video,
    Embedding,
    /// Recognised but not usable by this app (rerank, moderation, …).
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub kind: ModelKind,
}

impl ModelInfo {
    pub fn new(id: impl Into<String>) -> Self {
        let id = id.into();
        let kind = classify(&id);
        Self { id, kind }
    }
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
}
