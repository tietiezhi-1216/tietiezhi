//! Source-native Codex Responses API transport and model catalog.
//!
//! This is a clean-room adaptation of the wire behavior in OpenAI Codex
//! `rust-v0.145.0`. It does not link, invoke, or embed the Codex executable.

use futures_util::StreamExt;
use regex_lite::Regex;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::time::timeout;
use uuid::Uuid;

const OPENAI_MODEL_HEADER: &str = "openai-model";
const X_REASONING_INCLUDED_HEADER: &str = "x-reasoning-included";
const X_MODELS_ETAG_HEADER: &str = "x-models-etag";
const X_SAFETY_FASTER_MODEL_HEADER: &str = "x-codex-safety-buffering-faster-model";
const TRUSTED_ACCESS_FOR_CYBER: &str = "trusted_access_for_cyber";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningContext {
    Auto,
    CurrentTurn,
    AllTurns,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Reasoning {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<ReasoningContext>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningSummaryDelivery {
    SequentialCutoff,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StreamOptions {
    pub reasoning_summary_delivery: ReasoningSummaryDelivery,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TextFormatType {
    #[default]
    JsonSchema,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct TextFormat {
    pub r#type: TextFormatType,
    pub strict: bool,
    pub schema: Value,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct TextControls {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verbosity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<TextFormat>,
}

/// Exact JSON body sent to the Responses endpoint by the pinned Codex version.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ResponsesApiRequest {
    pub model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub instructions: String,
    pub input: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    pub tool_choice: String,
    pub parallel_tool_calls: bool,
    pub reasoning: Option<Reasoning>,
    pub store: bool,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<StreamOptions>,
    pub include: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextControls>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_metadata: Option<HashMap<String, String>>,
}

impl ResponsesApiRequest {
    pub fn text(model: impl Into<String>, input: Vec<Value>) -> Self {
        Self {
            model: model.into(),
            instructions: String::new(),
            input,
            tools: None,
            tool_choice: "auto".into(),
            parallel_tool_calls: true,
            reasoning: None,
            store: false,
            stream: true,
            stream_options: None,
            include: vec!["reasoning.encrypted_content".into()],
            service_tier: None,
            prompt_cache_key: None,
            text: None,
            client_metadata: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    #[serde(default)]
    pub cache_write_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
}

impl TokenUsage {
    pub fn as_v2_breakdown(&self) -> Value {
        json!({
            "inputTokens": self.input_tokens,
            "cachedInputTokens": self.cached_input_tokens,
            "cacheWriteInputTokens": self.cache_write_input_tokens,
            "outputTokens": self.output_tokens,
            "reasoningOutputTokens": self.reasoning_output_tokens,
            "totalTokens": self.total_tokens
        })
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SafetyBuffering {
    pub use_cases: Vec<String>,
    pub reasons: Vec<String>,
    #[serde(skip)]
    pub show_buffering_ui: bool,
    #[serde(rename = "retry_model")]
    pub faster_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResponseEvent {
    Created,
    /// Internal transport signal used by the App Server layer to publish the
    /// same `error { willRetry: true }` notification as Codex.
    Retrying {
        error: ModelError,
        attempt: u64,
    },
    SafetyBuffering(SafetyBuffering),
    OutputItemDone(Value),
    OutputItemAdded(Value),
    ServerModel(String),
    ModelVerifications(Vec<String>),
    TurnModerationMetadata(Value),
    ServerReasoningIncluded(bool),
    Completed {
        response_id: String,
        token_usage: Option<TokenUsage>,
        end_turn: Option<bool>,
    },
    OutputTextDelta(String),
    ToolCallInputDelta {
        item_id: String,
        call_id: Option<String>,
        delta: String,
    },
    ReasoningSummaryDelta {
        delta: String,
        summary_index: i64,
    },
    ReasoningSummaryDone {
        item_id: String,
        text: String,
        summary_index: i64,
    },
    ReasoningContentDelta {
        delta: String,
        content_index: i64,
    },
    ReasoningSummaryPartAdded {
        summary_index: i64,
    },
    ModelsEtag(String),
}

#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// Number of retries after the initial request.
    pub max_retries: u64,
    pub base_delay: Duration,
    pub retry_429: bool,
    pub retry_5xx: bool,
    pub retry_transport: bool,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 4,
            base_delay: Duration::from_millis(200),
            retry_429: false,
            retry_5xx: true,
            retry_transport: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Provider {
    pub name: String,
    pub base_url: String,
    pub bearer_token: Option<String>,
    pub headers: HeaderMap,
    pub query_params: HashMap<String, String>,
    pub retry: RetryConfig,
    pub stream_max_retries: u64,
    pub stream_idle_timeout: Duration,
}

impl Provider {
    pub fn openai_compatible(
        name: impl Into<String>,
        base_url: impl Into<String>,
        bearer_token: Option<String>,
    ) -> Self {
        Self {
            name: name.into(),
            base_url: base_url.into(),
            bearer_token,
            headers: HeaderMap::new(),
            query_params: HashMap::new(),
            retry: RetryConfig::default(),
            stream_max_retries: 5,
            stream_idle_timeout: Duration::from_secs(300),
        }
    }

    pub fn url_for_path(&self, path: &str) -> String {
        let base = self.base_url.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        let mut url = if path.is_empty() {
            base.to_owned()
        } else {
            format!("{base}/{path}")
        };
        if !self.query_params.is_empty() {
            let mut params = self.query_params.iter().collect::<Vec<_>>();
            params.sort_by(|left, right| left.0.cmp(right.0));
            url.push('?');
            url.push_str(
                &params
                    .into_iter()
                    .map(|(key, value)| format!("{key}={value}"))
                    .collect::<Vec<_>>()
                    .join("&"),
            );
        }
        url
    }
}

#[derive(Debug, Error, Clone, PartialEq)]
pub enum ModelError {
    #[error("request transport failed: {0}")]
    Transport(String),
    #[error("authentication failed: {message}")]
    Unauthorized { message: String },
    #[error("api error {status}: {message}")]
    Api { status: u16, message: String },
    #[error("stream error: {0}")]
    Stream(String),
    #[error("response consumer failed: {0}")]
    Consumer(String),
    #[error("context window exceeded")]
    ContextWindowExceeded,
    #[error("quota exceeded")]
    QuotaExceeded,
    #[error("usage not included")]
    UsageNotIncluded,
    #[error("retryable error: {message}")]
    Retryable {
        message: String,
        delay: Option<Duration>,
    },
    #[error("invalid request: {message}")]
    InvalidRequest { message: String },
    #[error("cyber policy: {message}")]
    CyberPolicy { message: String },
    #[error("server overloaded")]
    ServerOverloaded,
}

impl ModelError {
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Transport(_) | Self::Stream(_) | Self::Retryable { .. }
        ) || matches!(self, Self::Api { status, .. } if *status >= 500)
    }

    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Retryable { delay, .. } => *delay,
            _ => None,
        }
    }

    pub fn as_turn_error(&self) -> Value {
        let codex_error_info = match self {
            Self::ContextWindowExceeded => json!("contextWindowExceeded"),
            Self::QuotaExceeded => json!("usageLimitExceeded"),
            Self::UsageNotIncluded => json!("usageLimitExceeded"),
            Self::InvalidRequest { .. } => json!("badRequest"),
            Self::ServerOverloaded => json!("serverOverloaded"),
            Self::CyberPolicy { .. } => json!("cyberPolicy"),
            Self::Consumer(_) => json!("internalServerError"),
            Self::Transport(_) => json!({"httpConnectionFailed":{"httpStatusCode":null}}),
            Self::Unauthorized { .. } => {
                json!({"httpConnectionFailed":{"httpStatusCode":401}})
            }
            Self::Stream(_) => {
                json!({"responseStreamDisconnected":{"httpStatusCode":null}})
            }
            Self::Api { status, .. } => {
                json!({"httpConnectionFailed":{"httpStatusCode": status}})
            }
            Self::Retryable { .. } => json!("other"),
        };
        json!({
            "message": self.to_string(),
            "codexErrorInfo": codex_error_info,
            "additionalDetails": null
        })
    }
}

#[derive(Debug, Clone)]
pub struct ResponsesClient {
    http: reqwest::Client,
    provider: Provider,
}

impl ResponsesClient {
    pub fn new(http: reqwest::Client, provider: Provider) -> Self {
        Self { http, provider }
    }

    /// Probe the Responses route without creating a model response.
    ///
    /// Responses endpoints are POST-only. An empty JSON object must fail
    /// request validation before model routing, while still distinguishing a
    /// real route from gateways that wrap `Not Found` in HTTP 200.
    pub async fn supports_responses(&self) -> Result<bool, ModelError> {
        let mut request = self
            .http
            .post(self.provider.url_for_path("responses"))
            .header(ACCEPT, "application/json")
            .json(&json!({}));
        if let Some(token) = self
            .provider
            .bearer_token
            .as_deref()
            .filter(|token| !token.is_empty())
        {
            request = request.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        for (name, value) in &self.provider.headers {
            request = request.header(name, value);
        }
        let response = request
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|error| ModelError::Transport(error.to_string()))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status.as_u16() == 404 || status.as_u16() == 501 || response_body_is_not_found(&body) {
            return Ok(false);
        }
        Ok(true)
    }

    pub async fn stream<F>(
        &self,
        request: &ResponsesApiRequest,
        mut on_event: F,
    ) -> Result<(), ModelError>
    where
        F: FnMut(ResponseEvent) -> Result<(), ModelError>,
    {
        let mut stream_attempt = 0;
        loop {
            match self.stream_once(request, &mut on_event).await {
                Ok(()) => return Ok(()),
                Err(error)
                    if error.is_retryable()
                        && stream_attempt < self.provider.stream_max_retries =>
                {
                    stream_attempt += 1;
                    on_event(ResponseEvent::Retrying {
                        error: error.clone(),
                        attempt: stream_attempt,
                    })?;
                    let delay = error
                        .retry_after()
                        .unwrap_or_else(|| stream_backoff(stream_attempt));
                    tokio::time::sleep(delay).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    async fn stream_once<F>(
        &self,
        request: &ResponsesApiRequest,
        on_event: &mut F,
    ) -> Result<(), ModelError>
    where
        F: FnMut(ResponseEvent) -> Result<(), ModelError>,
    {
        let response = self.send_with_retry(request).await?;
        let headers = response.headers().clone();
        if let Some(model) = header_string(&headers, OPENAI_MODEL_HEADER) {
            on_event(ResponseEvent::ServerModel(model))?;
        }
        if let Some(etag) = header_string(&headers, X_MODELS_ETAG_HEADER) {
            on_event(ResponseEvent::ModelsEtag(etag))?;
        }
        if headers.contains_key(X_REASONING_INCLUDED_HEADER) {
            on_event(ResponseEvent::ServerReasoningIncluded(true))?;
        }
        let faster_model = header_string(&headers, X_SAFETY_FASTER_MODEL_HEADER);
        let mut bytes = response.bytes_stream();
        let mut decoder = SseDecoder::default();
        let mut completed = false;
        let mut last_server_model = header_string(&headers, OPENAI_MODEL_HEADER);

        loop {
            let chunk = timeout(self.provider.stream_idle_timeout, bytes.next())
                .await
                .map_err(|_| ModelError::Stream("idle timeout waiting for SSE".into()))?;
            match chunk {
                Some(Ok(chunk)) => decoder.push(&chunk),
                Some(Err(error)) => return Err(ModelError::Stream(error.to_string())),
                None => break,
            }
            while let Some(frame) = decoder.next_frame()? {
                if frame.data == "[DONE]" {
                    continue;
                }
                let event: ResponsesStreamEvent = match serde_json::from_str(&frame.data) {
                    Ok(event) => event,
                    Err(_) => continue,
                };
                if let Some(model) = event.response_model()
                    && last_server_model.as_deref() != Some(model.as_str())
                {
                    on_event(ResponseEvent::ServerModel(model.clone()))?;
                    last_server_model = Some(model);
                }
                if let Some(verifications) = event.model_verifications() {
                    on_event(ResponseEvent::ModelVerifications(verifications))?;
                }
                if let Some(metadata) = event.turn_moderation_metadata() {
                    on_event(ResponseEvent::TurnModerationMetadata(metadata))?;
                }
                if let Some(buffering) = event.safety_buffering(faster_model.as_deref()) {
                    on_event(ResponseEvent::SafetyBuffering(buffering))?;
                }
                if let Some(parsed) = process_responses_event(event)? {
                    completed = matches!(parsed, ResponseEvent::Completed { .. });
                    on_event(parsed)?;
                    if completed {
                        return Ok(());
                    }
                }
            }
        }
        if completed {
            Ok(())
        } else {
            Err(ModelError::Stream(
                "stream closed before response.completed".into(),
            ))
        }
    }

    async fn send_with_retry(
        &self,
        request: &ResponsesApiRequest,
    ) -> Result<reqwest::Response, ModelError> {
        let max_retries = self.provider.retry.max_retries;
        let mut last_error = None;
        for attempt in 0..=max_retries {
            match self.send_once(request).await {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status();
                    let retry = (status.as_u16() == 429 && self.provider.retry.retry_429)
                        || (status.is_server_error() && self.provider.retry.retry_5xx);
                    let retry_after = retry_after_header(response.headers());
                    let body = response.text().await.unwrap_or_default();
                    let message = response_error_message(&body);
                    let error = classify_http_response(status.as_u16(), &body, message);
                    if retry && attempt < max_retries {
                        tokio::time::sleep(retry_after.unwrap_or_else(|| {
                            request_backoff(self.provider.retry.base_delay, attempt + 1)
                        }))
                        .await;
                        last_error = Some(error);
                        continue;
                    }
                    return Err(error);
                }
                Err(error) => {
                    let error = ModelError::Transport(error.to_string());
                    if self.provider.retry.retry_transport && attempt < max_retries {
                        tokio::time::sleep(request_backoff(
                            self.provider.retry.base_delay,
                            attempt + 1,
                        ))
                        .await;
                        last_error = Some(error);
                        continue;
                    }
                    return Err(error);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| ModelError::Transport("request failed".into())))
    }

    async fn send_once(
        &self,
        request: &ResponsesApiRequest,
    ) -> Result<reqwest::Response, reqwest::Error> {
        let mut builder = self
            .http
            .post(self.provider.url_for_path("responses"))
            .header(ACCEPT, "text/event-stream")
            .header(CONTENT_TYPE, "application/json")
            .header("x-client-request-id", Uuid::new_v4().to_string())
            .json(request);
        if let Some(token) = self
            .provider
            .bearer_token
            .as_deref()
            .filter(|token| !token.is_empty())
        {
            builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        for (name, value) in &self.provider.headers {
            builder = builder.header(name, value);
        }
        builder.send().await
    }
}

fn response_body_is_not_found(body: &str) -> bool {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| value.pointer("/error/message").and_then(Value::as_str))
        })
        .unwrap_or(body)
        .trim()
        .to_ascii_lowercase();
    matches!(
        message.as_str(),
        "not found" | "route not found" | "endpoint not found"
    )
}

fn request_backoff(base: Duration, attempt: u64) -> Duration {
    let raw = base.saturating_mul(1_u32 << attempt.saturating_sub(1).min(16));
    raw.mul_f64(jitter_factor())
}

fn stream_backoff(attempt: u64) -> Duration {
    request_backoff(Duration::from_millis(200), attempt)
}

fn jitter_factor() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(100);
    0.9 + f64::from(nanos % 201) / 1_000.0
}

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn retry_after_header(headers: &HeaderMap) -> Option<Duration> {
    headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<f64>().ok())
        .map(Duration::from_secs_f64)
}

fn response_error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .map(str::to_owned)
        })
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| body.trim().chars().take(500).collect())
}

fn classify_http_response(status: u16, body: &str, message: String) -> ModelError {
    if status == 401 {
        return ModelError::Unauthorized { message };
    }
    let value = serde_json::from_str::<Value>(body).ok();
    let code = value
        .as_ref()
        .and_then(|value| value.pointer("/error/code"))
        .and_then(Value::as_str);
    match code {
        Some("unauthorized") => ModelError::Unauthorized { message },
        Some("context_length_exceeded") => ModelError::ContextWindowExceeded,
        Some("insufficient_quota") => ModelError::QuotaExceeded,
        Some("usage_not_included") => ModelError::UsageNotIncluded,
        Some("cyber_policy") => ModelError::CyberPolicy {
            message: nonempty_cyber_message(message),
        },
        Some("invalid_prompt" | "bio_policy") => ModelError::InvalidRequest {
            message: if message.is_empty() {
                "Invalid request.".into()
            } else {
                message
            },
        },
        Some("server_is_overloaded" | "slow_down") => ModelError::ServerOverloaded,
        _ => ModelError::Api { status, message },
    }
}

#[derive(Debug, Default)]
pub struct SseDecoder {
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub event: Option<String>,
    pub data: String,
}

impl SseDecoder {
    pub fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
    }

    pub fn next_frame(&mut self) -> Result<Option<SseFrame>, ModelError> {
        let Some((end, separator_len)) = frame_end(&self.bytes) else {
            return Ok(None);
        };
        let frame = self.bytes.drain(..end).collect::<Vec<_>>();
        self.bytes.drain(..separator_len);
        let text = std::str::from_utf8(&frame)
            .map_err(|error| ModelError::Stream(format!("invalid UTF-8 SSE frame: {error}")))?;
        let mut event = None;
        let mut data = Vec::new();
        for line in text.lines() {
            let line = line.trim_end_matches('\r');
            if line.starts_with(':') {
                continue;
            }
            if let Some(value) = line.strip_prefix("event:") {
                event = Some(value.strip_prefix(' ').unwrap_or(value).to_owned());
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push(value.strip_prefix(' ').unwrap_or(value));
            }
        }
        Ok(Some(SseFrame {
            event,
            data: data.join("\n"),
        }))
    }
}

fn frame_end(bytes: &[u8]) -> Option<(usize, usize)> {
    let crlf = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|end| (end, 4));
    let lf = bytes
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|end| (end, 2));
    match (crlf, lf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(frame), None) | (None, Some(frame)) => Some(frame),
        (None, None) => None,
    }
}

#[derive(Debug, Deserialize)]
struct ResponsesStreamEvent {
    #[serde(rename = "type")]
    kind: String,
    headers: Option<Value>,
    metadata: Option<Value>,
    response: Option<Value>,
    item: Option<Value>,
    item_id: Option<String>,
    call_id: Option<String>,
    delta: Option<String>,
    text: Option<String>,
    summary_index: Option<i64>,
    content_index: Option<i64>,
    safety_buffering: Option<Value>,
}

impl ResponsesStreamEvent {
    fn response_model(&self) -> Option<String> {
        self.response
            .as_ref()
            .and_then(|response| response.get("headers"))
            .and_then(header_model_from_json)
            .or_else(|| self.headers.as_ref().and_then(header_model_from_json))
    }

    fn model_verifications(&self) -> Option<Vec<String>> {
        if self.kind != "response.metadata" {
            return None;
        }
        let mut seen = HashSet::new();
        let values = self
            .metadata
            .as_ref()?
            .get("openai_verification_recommendation")?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .filter(|value| *value == TRUSTED_ACCESS_FOR_CYBER)
            .filter(|value| seen.insert((*value).to_owned()))
            .map(|_| "trustedAccessForCyber".to_owned())
            .collect::<Vec<_>>();
        (!values.is_empty()).then_some(values)
    }

    fn turn_moderation_metadata(&self) -> Option<Value> {
        (self.kind == "response.metadata")
            .then(|| {
                self.metadata
                    .as_ref()?
                    .get("openai_chatgpt_moderation_metadata")
                    .cloned()
            })
            .flatten()
    }

    fn safety_buffering(&self, fallback_model: Option<&str>) -> Option<SafetyBuffering> {
        let value = self.safety_buffering.as_ref()?;
        let retry_model_present = value.as_object()?.contains_key("retry_model");
        let mut buffering: SafetyBuffering = serde_json::from_value(value.clone()).ok()?;
        buffering.show_buffering_ui = true;
        if !retry_model_present {
            buffering.faster_model = fallback_model.map(str::to_owned);
        }
        Some(buffering)
    }
}

fn header_model_from_json(value: &Value) -> Option<String> {
    value.as_object()?.iter().find_map(|(name, value)| {
        if name.eq_ignore_ascii_case("openai-model") || name.eq_ignore_ascii_case("x-openai-model")
        {
            match value {
                Value::String(value) => Some(value.clone()),
                Value::Array(items) => items.first()?.as_str().map(str::to_owned),
                _ => None,
            }
        } else {
            None
        }
    })
}

fn process_responses_event(
    event: ResponsesStreamEvent,
) -> Result<Option<ResponseEvent>, ModelError> {
    match event.kind.as_str() {
        "response.output_item.done" => Ok(event.item.map(ResponseEvent::OutputItemDone)),
        "response.output_item.added" => Ok(event.item.map(ResponseEvent::OutputItemAdded)),
        "response.output_text.delta" => Ok(event.delta.map(ResponseEvent::OutputTextDelta)),
        "response.custom_tool_call_input.delta" => {
            let item_id = event.item_id.or_else(|| event.call_id.clone());
            Ok(match (event.delta, item_id) {
                (Some(delta), Some(item_id)) => Some(ResponseEvent::ToolCallInputDelta {
                    item_id,
                    call_id: event.call_id,
                    delta,
                }),
                _ => None,
            })
        }
        "response.reasoning_summary_text.delta" => Ok(match (event.delta, event.summary_index) {
            (Some(delta), Some(summary_index)) => Some(ResponseEvent::ReasoningSummaryDelta {
                delta,
                summary_index,
            }),
            _ => None,
        }),
        "response.reasoning_summary_text.done" => {
            Ok(match (event.item_id, event.text, event.summary_index) {
                (Some(item_id), Some(text), Some(summary_index)) => {
                    Some(ResponseEvent::ReasoningSummaryDone {
                        item_id,
                        text,
                        summary_index,
                    })
                }
                _ => None,
            })
        }
        "response.reasoning_text.delta" => Ok(match (event.delta, event.content_index) {
            (Some(delta), Some(content_index)) => Some(ResponseEvent::ReasoningContentDelta {
                delta,
                content_index,
            }),
            _ => None,
        }),
        "response.reasoning_summary_part.added" => Ok(event
            .summary_index
            .map(|summary_index| ResponseEvent::ReasoningSummaryPartAdded { summary_index })),
        "response.created" if event.response.is_some() => Ok(Some(ResponseEvent::Created)),
        "response.failed" => Err(classify_failed_response(event.response.as_ref())),
        "response.incomplete" => {
            let reason = event
                .response
                .as_ref()
                .and_then(|response| response.pointer("/incomplete_details/reason"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            Err(ModelError::Stream(format!(
                "Incomplete response returned, reason: {reason}"
            )))
        }
        "response.completed" => parse_completed(event.response),
        _ => Ok(None),
    }
}

fn parse_completed(response: Option<Value>) -> Result<Option<ResponseEvent>, ModelError> {
    let response = response
        .ok_or_else(|| ModelError::Stream("response.completed is missing response".into()))?;
    let id = response
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ModelError::Stream("response.completed is missing id".into()))?;
    let token_usage = response.get("usage").and_then(parse_token_usage);
    Ok(Some(ResponseEvent::Completed {
        response_id: id.to_owned(),
        token_usage,
        end_turn: response.get("end_turn").and_then(Value::as_bool),
    }))
}

fn parse_token_usage(value: &Value) -> Option<TokenUsage> {
    Some(TokenUsage {
        input_tokens: value.get("input_tokens")?.as_i64()?,
        cached_input_tokens: value
            .pointer("/input_tokens_details/cached_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        cache_write_input_tokens: value
            .pointer("/input_tokens_details/cache_write_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        output_tokens: value.get("output_tokens")?.as_i64()?,
        reasoning_output_tokens: value
            .pointer("/output_tokens_details/reasoning_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        total_tokens: value.get("total_tokens")?.as_i64()?,
    })
}

fn classify_failed_response(response: Option<&Value>) -> ModelError {
    let error = response.and_then(|response| response.get("error"));
    let code = error
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str);
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    match code {
        Some("unauthorized") => ModelError::Unauthorized { message },
        Some("context_length_exceeded") => ModelError::ContextWindowExceeded,
        Some("insufficient_quota") => ModelError::QuotaExceeded,
        Some("usage_not_included") => ModelError::UsageNotIncluded,
        Some("cyber_policy") => ModelError::CyberPolicy {
            message: nonempty_cyber_message(message),
        },
        Some("invalid_prompt" | "bio_policy") => ModelError::InvalidRequest {
            message: if message.is_empty() {
                "Invalid request.".into()
            } else {
                message
            },
        },
        Some("server_is_overloaded" | "slow_down") => ModelError::ServerOverloaded,
        _ => ModelError::Retryable {
            delay: (code == Some("rate_limit_exceeded"))
                .then(|| parse_retry_delay(&message))
                .flatten(),
            message,
        },
    }
}

fn nonempty_cyber_message(message: String) -> String {
    if message.trim().is_empty() {
        "This request has been flagged for possible cybersecurity risk.".into()
    } else {
        message
    }
}

fn parse_retry_delay(message: &str) -> Option<Duration> {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = REGEX.get_or_init(|| {
        Regex::new(r"(?i)try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)")
            .expect("static retry regex")
    });
    let captures = regex.captures(message)?;
    let value = captures.get(1)?.as_str().parse::<f64>().ok()?;
    match captures.get(2)?.as_str().to_ascii_lowercase().as_str() {
        "ms" => Some(Duration::from_millis(value as u64)),
        "s" | "second" | "seconds" => Some(Duration::from_secs_f64(value)),
        _ => None,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    models: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnlineModel {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: String,
    pub input_modalities: Vec<String>,
    pub is_default: bool,
}

pub fn bundled_models(include_hidden: bool) -> Vec<Value> {
    let mut models = serde_json::from_str::<Catalog>(include_str!("../models.json"))
        .expect("pinned public model catalog must be valid")
        .models;
    models.retain(|model| {
        include_hidden
            || !model
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    });
    models
}

pub fn list_models(
    cursor: Option<&str>,
    limit: Option<u32>,
    include_hidden: bool,
) -> Result<Value, ModelError> {
    let models = bundled_models(include_hidden);
    paginate_models(&models, cursor, limit)
}

pub fn list_online_models(
    models: Vec<OnlineModel>,
    cursor: Option<&str>,
    limit: Option<u32>,
) -> Result<Value, ModelError> {
    let bundled = bundled_models(true)
        .into_iter()
        .filter_map(|model| {
            let id = model
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase)?;
            Some((id, model))
        })
        .collect::<HashMap<_, _>>();
    let mut projected = models
        .into_iter()
        .filter(|model| !model.id.trim().is_empty())
        .map(|model| {
            let efforts = model
                .reasoning_efforts
                .iter()
                .filter_map(|effort| reasoning_effort_option(effort))
                .collect::<Vec<_>>();
            let default_effort =
                normalized_reasoning_effort(&model.default_reasoning_effort).unwrap_or("medium");
            let input_modalities = model
                .input_modalities
                .iter()
                .filter(|modality| matches!(modality.as_str(), "text" | "image"))
                .cloned()
                .collect::<Vec<_>>();
            if let Some(mut pinned) = bundled.get(&model.id.to_ascii_lowercase()).cloned() {
                pinned["isDefault"] = json!(model.is_default);
                pinned["hidden"] = json!(false);
                if !efforts.is_empty() {
                    pinned["supportedReasoningEfforts"] = json!(efforts);
                    pinned["defaultReasoningEffort"] = json!(default_effort);
                }
                if !input_modalities.is_empty() {
                    pinned["inputModalities"] = json!(input_modalities);
                }
                return pinned;
            }
            json!({
                "id": model.id,
                "model": model.id,
                "upgrade": null,
                "upgradeInfo": null,
                "availabilityNux": null,
                "displayName": model.display_name,
                "description": model.description,
                "hidden": false,
                "supportedReasoningEfforts": efforts,
                "defaultReasoningEffort": default_effort,
                "inputModalities": if input_modalities.is_empty() {
                    vec!["text".to_string()]
                } else {
                    input_modalities
                },
                "supportsPersonality": false,
                "additionalSpeedTiers": [],
                "serviceTiers": [],
                "defaultServiceTier": null,
                "isDefault": model.is_default
            })
        })
        .collect::<Vec<_>>();
    projected.sort_by(|left, right| {
        right["isDefault"]
            .as_bool()
            .cmp(&left["isDefault"].as_bool())
            .then_with(|| {
                left["id"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right["id"].as_str().unwrap_or_default())
            })
    });
    projected.dedup_by(|left, right| {
        left["id"]
            .as_str()
            .unwrap_or_default()
            .eq_ignore_ascii_case(right["id"].as_str().unwrap_or_default())
    });
    paginate_models(&projected, cursor, limit)
}

fn paginate_models(
    models: &[Value],
    cursor: Option<&str>,
    limit: Option<u32>,
) -> Result<Value, ModelError> {
    let total = models.len();
    if total == 0 {
        return Ok(json!({"data": [], "nextCursor": null}));
    }
    let effective_limit = (limit.unwrap_or(total as u32).max(1) as usize).min(total);
    let start = cursor
        .map(|cursor| {
            cursor
                .parse::<usize>()
                .map_err(|_| ModelError::InvalidRequest {
                    message: format!("invalid cursor: {cursor}"),
                })
        })
        .transpose()?
        .unwrap_or(0);
    if start > total {
        return Err(ModelError::InvalidRequest {
            message: format!("cursor {start} exceeds total models {total}"),
        });
    }
    let end = start.saturating_add(effective_limit).min(total);
    Ok(json!({
        "data": models[start..end],
        "nextCursor": (end < total).then(|| end.to_string())
    }))
}

fn normalized_reasoning_effort(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        "ultra" => Some("ultra"),
        _ => None,
    }
}

fn reasoning_effort_option(value: &str) -> Option<Value> {
    let effort = normalized_reasoning_effort(value)?;
    let description = match effort {
        "minimal" => "Fastest responses with minimal reasoning",
        "low" => "Fast responses with lighter reasoning",
        "medium" => "Balances speed and reasoning depth for everyday tasks",
        "high" => "Greater reasoning depth for complex problems",
        "xhigh" => "Extra high reasoning depth for complex problems",
        "max" => "Maximum reasoning depth for the hardest problems",
        "ultra" => "Maximum reasoning with automatic task delegation",
        _ => return None,
    };
    Some(json!({
        "reasoningEffort": effort,
        "description": description
    }))
}

pub fn header_map(values: impl IntoIterator<Item = (String, String)>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    for (name, value) in values {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|error| error.to_string())?;
        let value = HeaderValue::from_str(&value).map_err(|error| error.to_string())?;
        headers.insert(name, value);
    }
    Ok(headers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn request_serialization_matches_responses_wire() {
        let mut request = ResponsesApiRequest::text(
            "gpt-test",
            vec![json!({"role": "user", "content": [{"type":"input_text","text":"hi"}]})],
        );
        request.reasoning = Some(Reasoning {
            effort: Some("high".into()),
            summary: Some("auto".into()),
            context: Some(ReasoningContext::CurrentTurn),
        });
        request.text = Some(TextControls {
            verbosity: Some("low".into()),
            format: Some(TextFormat {
                r#type: TextFormatType::JsonSchema,
                strict: true,
                schema: json!({"type":"object"}),
                name: "output".into(),
            }),
        });
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "model":"gpt-test",
                "input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}],
                "tool_choice":"auto",
                "parallel_tool_calls":true,
                "reasoning":{"effort":"high","summary":"auto","context":"current_turn"},
                "store":false,
                "stream":true,
                "include":["reasoning.encrypted_content"],
                "text":{"verbosity":"low","format":{"type":"json_schema","strict":true,"schema":{"type":"object"},"name":"output"}}
            })
        );
    }

    #[test]
    fn decoder_handles_crlf_multiline_and_utf8_chunking() {
        let text = "event: response.output_text.delta\r\ndata: {\"type\":\"x\",\r\ndata: \"delta\":\"你好\"}\r\n\r\n";
        let bytes = text.as_bytes();
        let split = bytes
            .windows("你".len())
            .position(|window| window == "你".as_bytes())
            .unwrap()
            + 1;
        let mut decoder = SseDecoder::default();
        decoder.push(&bytes[..split]);
        assert_eq!(decoder.next_frame().unwrap(), None);
        decoder.push(&bytes[split..]);
        let frame = decoder.next_frame().unwrap().unwrap();
        assert_eq!(frame.event.as_deref(), Some("response.output_text.delta"));
        assert_eq!(frame.data, "{\"type\":\"x\",\n\"delta\":\"你好\"}");
    }

    #[test]
    fn parses_usage_metadata_and_failure_classes() {
        let completed = ResponsesStreamEvent {
            kind: "response.completed".into(),
            headers: None,
            metadata: None,
            response: Some(json!({
                "id":"resp_1",
                "end_turn":true,
                "usage":{
                    "input_tokens":100,
                    "input_tokens_details":{"cached_tokens":40,"cache_write_tokens":60},
                    "output_tokens":20,
                    "output_tokens_details":{"reasoning_tokens":5},
                    "total_tokens":120
                }
            })),
            item: None,
            item_id: None,
            call_id: None,
            delta: None,
            text: None,
            summary_index: None,
            content_index: None,
            safety_buffering: None,
        };
        assert_eq!(
            process_responses_event(completed).unwrap(),
            Some(ResponseEvent::Completed {
                response_id: "resp_1".into(),
                token_usage: Some(TokenUsage {
                    input_tokens: 100,
                    cached_input_tokens: 40,
                    cache_write_input_tokens: 60,
                    output_tokens: 20,
                    reasoning_output_tokens: 5,
                    total_tokens: 120,
                }),
                end_turn: Some(true)
            })
        );
        assert_eq!(
            classify_failed_response(Some(&json!({
                "error":{"code":"context_length_exceeded","message":"too long"}
            }))),
            ModelError::ContextWindowExceeded
        );
        assert_eq!(
            parse_retry_delay("Please try again in 250 ms"),
            Some(Duration::from_millis(250))
        );
    }

    #[test]
    fn parses_all_stream_delta_and_item_variants() {
        let cases = [
            (
                json!({"type":"response.output_item.added","item":{"type":"message","id":"m1","role":"assistant","content":[]}}),
                ResponseEvent::OutputItemAdded(
                    json!({"type":"message","id":"m1","role":"assistant","content":[]}),
                ),
            ),
            (
                json!({"type":"response.output_item.done","item":{"type":"message","id":"m1","role":"assistant","content":[]}}),
                ResponseEvent::OutputItemDone(
                    json!({"type":"message","id":"m1","role":"assistant","content":[]}),
                ),
            ),
            (
                json!({"type":"response.output_text.delta","delta":"a"}),
                ResponseEvent::OutputTextDelta("a".into()),
            ),
            (
                json!({"type":"response.custom_tool_call_input.delta","call_id":"call_1","delta":"{}"}),
                ResponseEvent::ToolCallInputDelta {
                    item_id: "call_1".into(),
                    call_id: Some("call_1".into()),
                    delta: "{}".into(),
                },
            ),
            (
                json!({"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"s"}),
                ResponseEvent::ReasoningSummaryDelta {
                    delta: "s".into(),
                    summary_index: 0,
                },
            ),
            (
                json!({"type":"response.reasoning_summary_text.done","item_id":"r1","summary_index":0,"text":"summary"}),
                ResponseEvent::ReasoningSummaryDone {
                    item_id: "r1".into(),
                    text: "summary".into(),
                    summary_index: 0,
                },
            ),
            (
                json!({"type":"response.reasoning_text.delta","content_index":1,"delta":"r"}),
                ResponseEvent::ReasoningContentDelta {
                    delta: "r".into(),
                    content_index: 1,
                },
            ),
            (
                json!({"type":"response.reasoning_summary_part.added","summary_index":2}),
                ResponseEvent::ReasoningSummaryPartAdded { summary_index: 2 },
            ),
            (
                json!({"type":"response.created","response":{}}),
                ResponseEvent::Created,
            ),
        ];
        for (wire, expected) in cases {
            let event = serde_json::from_value(wire).unwrap();
            assert_eq!(process_responses_event(event).unwrap(), Some(expected));
        }
        let incomplete = serde_json::from_value(json!({
            "type":"response.incomplete",
            "response":{"incomplete_details":{"reason":"max_output_tokens"}}
        }))
        .unwrap();
        assert_eq!(
            process_responses_event(incomplete).unwrap_err(),
            ModelError::Stream("Incomplete response returned, reason: max_output_tokens".into())
        );
    }

    #[test]
    fn failed_response_error_mapping_matches_codex() {
        let failure = |code: &str, message: &str| {
            classify_failed_response(Some(&json!({"error":{"code":code,"message":message}})))
        };
        assert_eq!(failure("insufficient_quota", ""), ModelError::QuotaExceeded);
        assert_eq!(
            failure("usage_not_included", ""),
            ModelError::UsageNotIncluded
        );
        assert_eq!(
            failure("server_is_overloaded", ""),
            ModelError::ServerOverloaded
        );
        assert!(!ModelError::ServerOverloaded.is_retryable());
        assert_eq!(
            failure("invalid_prompt", "no"),
            ModelError::InvalidRequest {
                message: "no".into()
            }
        );
        assert_eq!(
            failure("cyber_policy", ""),
            ModelError::CyberPolicy {
                message: "This request has been flagged for possible cybersecurity risk.".into()
            }
        );
    }

    #[test]
    fn metadata_deduplicates_verification_and_uses_header_model() {
        let event: ResponsesStreamEvent = serde_json::from_value(json!({
            "type":"response.metadata",
            "headers":{"X-OpenAI-Model":["gpt-rerouted"]},
            "metadata":{
                "openai_verification_recommendation":[
                    "trusted_access_for_cyber",
                    "unknown",
                    "trusted_access_for_cyber"
                ],
                "openai_chatgpt_moderation_metadata":{"flagged":true}
            },
            "safety_buffering":{"use_cases":["cyber"],"reasons":["policy"]}
        }))
        .unwrap();
        assert_eq!(event.response_model().as_deref(), Some("gpt-rerouted"));
        assert_eq!(
            event.model_verifications().unwrap(),
            vec!["trustedAccessForCyber"]
        );
        assert_eq!(
            event.turn_moderation_metadata(),
            Some(json!({"flagged":true}))
        );
        assert_eq!(
            event
                .safety_buffering(Some("gpt-fast"))
                .unwrap()
                .faster_model,
            Some("gpt-fast".into())
        );
    }

    #[test]
    fn model_catalog_matches_codex_pagination() {
        let visible = list_models(None, Some(2), false).unwrap();
        assert_eq!(visible["data"].as_array().unwrap().len(), 2);
        assert_eq!(visible["data"][0]["id"], "gpt-5.6-sol");
        assert_eq!(visible["nextCursor"], "2");
        let hidden = list_models(Some("4"), Some(100), true).unwrap();
        assert_eq!(hidden["data"][0]["id"], "gpt-5.4");
        assert_eq!(hidden["nextCursor"], Value::Null);
        assert!(list_models(Some("bad"), None, false).is_err());
    }

    #[test]
    fn online_catalog_preserves_pinned_models_and_projects_unknown_models() {
        let response = list_online_models(
            vec![
                OnlineModel {
                    id: "relay-model".into(),
                    display_name: "Relay Model".into(),
                    description: "Provider model".into(),
                    reasoning_efforts: vec!["low".into(), "high".into(), "invalid".into()],
                    default_reasoning_effort: "high".into(),
                    input_modalities: vec!["text".into(), "image".into(), "audio".into()],
                    is_default: true,
                },
                OnlineModel {
                    id: "gpt-5.6-sol".into(),
                    display_name: "ignored".into(),
                    description: "ignored".into(),
                    reasoning_efforts: vec!["ultra".into()],
                    default_reasoning_effort: "ultra".into(),
                    input_modalities: vec!["text".into(), "image".into()],
                    is_default: false,
                },
            ],
            None,
            None,
        )
        .unwrap();
        assert_eq!(response["data"][0]["id"], "relay-model");
        assert_eq!(response["data"][0]["isDefault"], true);
        assert_eq!(
            response["data"][0]["supportedReasoningEfforts"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            response["data"][0]["inputModalities"],
            json!(["text", "image"])
        );
        assert_eq!(response["data"][1]["id"], "gpt-5.6-sol");
        assert_eq!(
            response["data"][1]["description"],
            "Latest frontier agentic coding model."
        );
        assert_eq!(
            response["data"][1]["supportedReasoningEfforts"],
            json!([{
                "reasoningEffort": "ultra",
                "description": "Maximum reasoning with automatic task delegation"
            }])
        );
        assert_eq!(response["data"][1]["defaultReasoningEffort"], "ultra");
        assert_eq!(
            response["data"][1]["inputModalities"],
            json!(["text", "image"])
        );
    }

    #[tokio::test]
    async fn http_transport_posts_responses_with_auth_and_streams() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let size = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(request.starts_with("POST /v1/responses HTTP/1.1"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer secret")
            );
            let body = concat!(
                "data: {\"type\":\"response.created\",\"response\":{}}\n\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"end_turn\":true}}\n\n"
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nopenai-model: gpt-test\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let provider = Provider::openai_compatible(
            "test",
            format!("http://{address}/v1"),
            Some("secret".into()),
        );
        let client = ResponsesClient::new(reqwest::Client::new(), provider);
        let mut events = Vec::new();
        client
            .stream(
                &ResponsesApiRequest::text("gpt-test", Vec::new()),
                |event| {
                    events.push(event);
                    Ok(())
                },
            )
            .await
            .unwrap();
        server.await.unwrap();
        assert!(matches!(events[0], ResponseEvent::ServerModel(_)));
        assert!(events.contains(&ResponseEvent::OutputTextDelta("hello".into())));
        assert!(events.iter().any(
            |event| matches!(event, ResponseEvent::Completed { response_id, .. } if response_id == "resp_1")
        ));
    }

    #[tokio::test]
    async fn request_transport_retries_5xx_before_opening_stream() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                let _ = socket.read(&mut request).await.unwrap();
                if attempt == 0 {
                    socket
                        .write_all(
                            b"HTTP/1.1 500 Internal Server Error\r\ncontent-length: 4\r\nconnection: close\r\n\r\nfail",
                        )
                        .await
                        .unwrap();
                } else {
                    let body = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_retry\"}}\n\n";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    socket.write_all(response.as_bytes()).await.unwrap();
                }
            }
        });
        let mut provider =
            Provider::openai_compatible("test", format!("http://{address}/v1"), None);
        provider.retry.max_retries = 1;
        provider.retry.base_delay = Duration::from_millis(1);
        let client = ResponsesClient::new(reqwest::Client::new(), provider);
        let mut events = Vec::new();
        client
            .stream(
                &ResponsesApiRequest::text("gpt-test", Vec::new()),
                |event| {
                    events.push(event);
                    Ok(())
                },
            )
            .await
            .unwrap();
        server.await.unwrap();
        assert!(events.iter().any(
            |event| matches!(event, ResponseEvent::Completed { response_id, .. } if response_id == "resp_retry")
        ));
    }

    #[tokio::test]
    async fn responses_probe_rejects_wrapped_not_found_and_accepts_auth_gate() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests_tx, mut requests_rx) = tokio::sync::mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                let size = socket.read(&mut request).await.unwrap();
                requests_tx
                    .send(String::from_utf8_lossy(&request[..size]).into_owned())
                    .unwrap();
                let (status, body) = if attempt == 0 {
                    ("200 OK", r#"{"success":false,"message":"Not Found"}"#)
                } else {
                    (
                        "401 Unauthorized",
                        r#"{"error":{"message":"missing api key"}}"#,
                    )
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let provider = Provider::openai_compatible("test", format!("http://{address}/v1"), None);
        let client = ResponsesClient::new(reqwest::Client::new(), provider);
        assert!(!client.supports_responses().await.unwrap());
        assert!(client.supports_responses().await.unwrap());
        for _ in 0..2 {
            let request = requests_rx.recv().await.unwrap();
            assert!(request.starts_with("POST /v1/responses HTTP/1.1"));
            assert!(request.ends_with("{}"));
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn disconnected_sse_stream_reconnects_with_retry_notification() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                let _ = socket.read(&mut request).await.unwrap();
                let body = if attempt == 0 {
                    concat!(
                        "data: {\"type\":\"response.created\",\"response\":{}}\n\n",
                        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"
                    )
                } else {
                    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_reconnected\",\"end_turn\":true}}\n\n"
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let mut provider =
            Provider::openai_compatible("test", format!("http://{address}/v1"), None);
        provider.stream_max_retries = 1;
        let client = ResponsesClient::new(reqwest::Client::new(), provider);
        let mut events = Vec::new();
        client
            .stream(
                &ResponsesApiRequest::text("gpt-test", Vec::new()),
                |event| {
                    events.push(event);
                    Ok(())
                },
            )
            .await
            .unwrap();
        server.await.unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            ResponseEvent::Retrying {
                error: ModelError::Stream(message),
                attempt: 1
            } if message == "stream closed before response.completed"
        )));
        assert!(events.iter().any(
            |event| matches!(event, ResponseEvent::Completed { response_id, .. } if response_id == "resp_reconnected")
        ));
    }

    #[tokio::test]
    async fn consumer_failures_do_not_retry_the_model_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let _ = socket.read(&mut request).await.unwrap();
            let body = "data: {\"type\":\"response.created\",\"response\":{}}\n\n";
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let provider = Provider::openai_compatible("test", format!("http://{address}/v1"), None);
        let client = ResponsesClient::new(reqwest::Client::new(), provider);
        let result = client
            .stream(&ResponsesApiRequest::text("gpt-test", Vec::new()), |_| {
                Err(ModelError::Consumer("projection failed".into()))
            })
            .await;
        server.await.unwrap();
        assert_eq!(
            result.unwrap_err(),
            ModelError::Consumer("projection failed".into())
        );
    }

    #[test]
    fn http_error_bodies_preserve_codex_error_classes() {
        assert_eq!(
            classify_http_response(
                401,
                r#"{"error":{"code":"unauthorized","message":"expired"}}"#,
                "expired".into()
            ),
            ModelError::Unauthorized {
                message: "expired".into()
            }
        );
        assert_eq!(
            classify_http_response(
                400,
                r#"{"error":{"code":"context_length_exceeded","message":"too long"}}"#,
                "too long".into()
            ),
            ModelError::ContextWindowExceeded
        );
        assert_eq!(
            classify_http_response(
                429,
                r#"{"error":{"code":"insufficient_quota","message":"quota"}}"#,
                "quota".into()
            ),
            ModelError::QuotaExceeded
        );
        assert_eq!(
            ModelError::UsageNotIncluded.as_turn_error()["codexErrorInfo"],
            "usageLimitExceeded"
        );
    }
}
