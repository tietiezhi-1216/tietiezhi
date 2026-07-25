//! Source-native thread-scoped Realtime transport compatible with Codex App
//! Server V2.
//!
//! The runtime owns WebSocket/WebRTC sideband sessions, validates PCM frames,
//! projects provider events to exact V2 notification shapes, and reconnects
//! without replaying already delivered input.

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, LOCATION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

const DEFAULT_MODEL_V1: &str = "gpt-realtime-1.5";
const DEFAULT_MODEL_V3: &str = "gpt-live-1-boulder-alpha";
const DEFAULT_SAMPLE_RATE: u32 = 24_000;
const DEFAULT_CHANNELS: u16 = 1;
const MAX_AUDIO_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_RECENT_REQUESTS: usize = 2048;
const RECONNECT_ATTEMPTS: usize = 4;

pub type NotificationSink = Arc<dyn Fn(Value) + Send + Sync + 'static>;

#[derive(Debug, Error)]
pub enum RealtimeError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    NotFound(String),
    #[error("realtime transport failed: {0}")]
    Transport(String),
    #[error("realtime state error: {0}")]
    State(String),
}

#[derive(Debug, Clone)]
pub struct RealtimeProvider {
    pub base_url: String,
    pub bearer_token: Option<String>,
    pub headers: HeaderMap,
}

impl RealtimeProvider {
    pub fn openai_compatible(base_url: impl Into<String>, bearer_token: Option<String>) -> Self {
        Self {
            base_url: base_url.into(),
            bearer_token,
            headers: HeaderMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunk {
    pub data: String,
    pub sample_rate: u32,
    pub num_channels: u16,
    pub samples_per_channel: Option<u32>,
    pub item_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutputModality {
    Text,
    Audio,
}

impl OutputModality {
    fn wire(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Audio => "audio",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RealtimeVersion {
    V1,
    V2,
    V3,
}

impl RealtimeVersion {
    fn wire(self) -> &'static str {
        match self {
            Self::V1 => "v1",
            Self::V2 => "v2",
            Self::V3 => "v3",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StartTransport {
    Websocket,
    Webrtc { sdp: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialItem {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartParams {
    pub thread_id: String,
    pub client_managed_handoffs: Option<bool>,
    pub flush_transcript_tail_on_session_end: Option<bool>,
    pub codex_responses_as_items: Option<bool>,
    pub codex_response_item_prefix: Option<String>,
    pub codex_response_handoff_mode: Option<String>,
    pub model: Option<String>,
    pub output_modality: OutputModality,
    pub include_startup_context: Option<bool>,
    pub initial_items: Option<Vec<InitialItem>>,
    pub prompt: Option<Option<String>>,
    pub realtime_session_id: Option<String>,
    pub transport: Option<StartTransport>,
    pub version: Option<RealtimeVersion>,
    pub voice: Option<String>,
}

#[derive(Debug, Clone)]
struct SessionConfig {
    thread_id: String,
    model: String,
    modality: OutputModality,
    version: RealtimeVersion,
    voice: String,
    instructions: String,
    initial_items: Vec<InitialItem>,
    requested_session_id: Option<String>,
    sideband_call_id: Option<String>,
}

#[derive(Debug)]
enum Outbound {
    Audio(AudioChunk),
    Text { text: String, role: String },
    Speech(String),
}

#[derive(Debug, Clone)]
struct ActiveSession {
    generation: String,
    sender: mpsc::Sender<Outbound>,
    cancel: CancellationToken,
}

#[derive(Default)]
struct RequestDedupe {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl RequestDedupe {
    fn accept(&mut self, request_id: &str) -> bool {
        if !self.seen.insert(request_id.to_owned()) {
            return false;
        }
        self.order.push_back(request_id.to_owned());
        while self.order.len() > MAX_RECENT_REQUESTS {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        true
    }
}

#[derive(Clone, Default)]
pub struct RealtimeRuntime {
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    dedupe: Arc<Mutex<HashMap<String, RequestDedupe>>>,
}

impl RealtimeRuntime {
    pub async fn start(
        &self,
        params: StartParams,
        provider: RealtimeProvider,
        sink: NotificationSink,
    ) -> Result<Value, RealtimeError> {
        validate_thread_id(&params.thread_id)?;
        validate_initial_items(params.initial_items.as_deref().unwrap_or_default())?;
        let version = params.version.unwrap_or(RealtimeVersion::V1);
        let voice = params.voice.unwrap_or_else(|| {
            if version == RealtimeVersion::V1 {
                "cove".into()
            } else {
                "marin".into()
            }
        });
        validate_voice(&voice)?;
        let model = params.model.unwrap_or_else(|| {
            if version == RealtimeVersion::V3 {
                DEFAULT_MODEL_V3.into()
            } else {
                DEFAULT_MODEL_V1.into()
            }
        });
        let instructions = params
            .prompt
            .flatten()
            .unwrap_or_else(|| "You are a concise realtime coding assistant.".into());
        let mut config = SessionConfig {
            thread_id: params.thread_id.clone(),
            model,
            modality: params.output_modality,
            version,
            voice,
            instructions,
            initial_items: params.initial_items.unwrap_or_default(),
            requested_session_id: params.realtime_session_id,
            sideband_call_id: None,
        };

        if let Some(StartTransport::Webrtc { sdp }) = params.transport {
            if sdp.trim().is_empty() || sdp.len() > 1024 * 1024 {
                return Err(RealtimeError::Invalid("WebRTC SDP is invalid".into()));
            }
            let (answer, call_id) = create_webrtc_call(&provider, &config, &sdp).await?;
            config.sideband_call_id = Some(call_id);
            sink(notification(
                "thread/realtime/sdp",
                json!({"threadId":config.thread_id,"sdp":answer}),
            ));
        }

        let generation = Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel(256);
        let cancel = CancellationToken::new();
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| RealtimeError::State("session lock poisoned".into()))?;
            if sessions.contains_key(&config.thread_id) {
                return Err(RealtimeError::Conflict(
                    "Thread already has an active realtime session".into(),
                ));
            }
            sessions.insert(
                config.thread_id.clone(),
                ActiveSession {
                    generation: generation.clone(),
                    sender,
                    cancel: cancel.clone(),
                },
            );
        }
        let sessions = self.sessions.clone();
        tokio::spawn(run_session(
            provider, config, generation, receiver, cancel, sink, sessions,
        ));
        Ok(json!({}))
    }

    pub async fn append_audio(
        &self,
        thread_id: &str,
        request_id: &str,
        audio: AudioChunk,
    ) -> Result<Value, RealtimeError> {
        validate_audio(&audio)?;
        self.send_once(thread_id, request_id, Outbound::Audio(audio))
            .await
    }

    pub async fn append_text(
        &self,
        thread_id: &str,
        request_id: &str,
        text: String,
        role: String,
    ) -> Result<Value, RealtimeError> {
        validate_text(&text)?;
        validate_role(&role)?;
        self.send_once(thread_id, request_id, Outbound::Text { text, role })
            .await
    }

    pub async fn append_speech(
        &self,
        thread_id: &str,
        request_id: &str,
        text: String,
    ) -> Result<Value, RealtimeError> {
        validate_text(&text)?;
        self.send_once(thread_id, request_id, Outbound::Speech(text))
            .await
    }

    pub fn stop(&self, thread_id: &str) -> Result<Value, RealtimeError> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| RealtimeError::State("session lock poisoned".into()))?
            .remove(thread_id)
            .ok_or_else(|| RealtimeError::NotFound("realtime session was not found".into()))?;
        session.cancel.cancel();
        Ok(json!({}))
    }

    pub fn stop_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                session.cancel.cancel();
            }
        }
    }

    pub fn active_threads(&self) -> Result<Vec<String>, RealtimeError> {
        let mut threads = self
            .sessions
            .lock()
            .map_err(|_| RealtimeError::State("session lock poisoned".into()))?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        threads.sort();
        Ok(threads)
    }

    pub fn voices() -> Value {
        json!({
            "voices":{
                "v1":["juniper","maple","spruce","ember","vale","breeze","arbor","sol","cove"],
                "v2":["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"],
                "defaultV1":"cove",
                "defaultV2":"marin"
            }
        })
    }

    async fn send_once(
        &self,
        thread_id: &str,
        request_id: &str,
        outbound: Outbound,
    ) -> Result<Value, RealtimeError> {
        validate_thread_id(thread_id)?;
        if request_id.trim().is_empty() {
            return Err(RealtimeError::Invalid("request id is required".into()));
        }
        {
            let mut dedupe = self
                .dedupe
                .lock()
                .map_err(|_| RealtimeError::State("request dedupe lock poisoned".into()))?;
            if !dedupe
                .entry(thread_id.to_owned())
                .or_default()
                .accept(request_id)
            {
                return Ok(json!({}));
            }
        }
        let sender = self
            .sessions
            .lock()
            .map_err(|_| RealtimeError::State("session lock poisoned".into()))?
            .get(thread_id)
            .map(|session| session.sender.clone())
            .ok_or_else(|| RealtimeError::NotFound("realtime session was not found".into()))?;
        sender
            .send(outbound)
            .await
            .map_err(|_| RealtimeError::Transport("realtime session has closed".into()))?;
        Ok(json!({}))
    }
}

async fn run_session(
    provider: RealtimeProvider,
    config: SessionConfig,
    generation: String,
    mut receiver: mpsc::Receiver<Outbound>,
    cancel: CancellationToken,
    sink: NotificationSink,
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
) {
    let mut started = false;
    let mut last_error = None;
    for attempt in 0..RECONNECT_ATTEMPTS {
        if cancel.is_cancelled() {
            break;
        }
        match connect(&provider, &config).await {
            Ok((mut writer, mut reader)) => {
                last_error = None;
                if config.sideband_call_id.is_none() {
                    if let Err(error) = writer
                        .send(Message::Text(session_update(&config).to_string().into()))
                        .await
                    {
                        last_error = Some(error.to_string());
                        continue;
                    }
                }
                if !started {
                    sink(notification(
                        "thread/realtime/started",
                        json!({
                            "threadId":config.thread_id,
                            "realtimeSessionId":config.requested_session_id,
                            "version":config.version.wire()
                        }),
                    ));
                    started = true;
                }
                let disconnected = loop {
                    tokio::select! {
                        _ = cancel.cancelled() => {
                            let _ = writer.close().await;
                            break false;
                        }
                        outbound = receiver.recv() => {
                            let Some(outbound) = outbound else {
                                let _ = writer.close().await;
                                break false;
                            };
                            for message in outbound_messages(outbound, config.version) {
                                if let Err(error) = writer.send(Message::Text(message.to_string().into())).await {
                                    last_error = Some(error.to_string());
                                    break;
                                }
                            }
                            if last_error.is_some() {
                                break true;
                            }
                        }
                        inbound = reader.next() => {
                            match inbound {
                                Some(Ok(Message::Text(payload))) => project_event(&config.thread_id, &payload, &sink),
                                Some(Ok(Message::Ping(payload))) => {
                                    if writer.send(Message::Pong(payload)).await.is_err() {
                                        break true;
                                    }
                                }
                                Some(Ok(Message::Close(frame))) => {
                                    last_error = frame.map(|frame| frame.reason.to_string());
                                    break true;
                                }
                                Some(Ok(_)) => {}
                                Some(Err(error)) => {
                                    last_error = Some(error.to_string());
                                    break true;
                                }
                                None => break true,
                            }
                        }
                    }
                };
                if !disconnected || cancel.is_cancelled() {
                    break;
                }
            }
            Err(error) => last_error = Some(error.to_string()),
        }
        if attempt + 1 < RECONNECT_ATTEMPTS {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(200 * (1 << attempt))) => {}
            }
        }
    }
    if !cancel.is_cancelled() {
        if let Some(message) = last_error.as_deref() {
            sink(notification(
                "thread/realtime/error",
                json!({"threadId":config.thread_id,"message":message}),
            ));
        }
    }
    sink(notification(
        "thread/realtime/closed",
        json!({
            "threadId":config.thread_id,
            "reason":if cancel.is_cancelled() {Value::Null} else {last_error.map(Value::String).unwrap_or(Value::Null)}
        }),
    ));
    if let Ok(mut sessions) = sessions.lock() {
        if sessions
            .get(&config.thread_id)
            .is_some_and(|active| active.generation == generation)
        {
            sessions.remove(&config.thread_id);
        }
    }
}

type RealtimeSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(
    provider: &RealtimeProvider,
    config: &SessionConfig,
) -> Result<
    (
        futures_util::stream::SplitSink<RealtimeSocket, Message>,
        futures_util::stream::SplitStream<RealtimeSocket>,
    ),
    RealtimeError,
> {
    let url = websocket_url(provider, config)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| RealtimeError::Transport(error.to_string()))?;
    apply_headers(request.headers_mut(), provider, config)?;
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| RealtimeError::Transport(error.to_string()))?;
    Ok(socket.split())
}

fn apply_headers(
    headers: &mut tokio_tungstenite::tungstenite::http::HeaderMap,
    provider: &RealtimeProvider,
    config: &SessionConfig,
) -> Result<(), RealtimeError> {
    if let Some(token) = provider.bearer_token.as_deref() {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| RealtimeError::Invalid("bearer token is invalid".into()))?,
        );
    }
    headers.insert(
        HeaderName::from_static("openai-beta"),
        HeaderValue::from_static("realtime=v1"),
    );
    if let Some(session_id) = config.requested_session_id.as_deref() {
        headers.insert(
            HeaderName::from_static("x-session-id"),
            HeaderValue::from_str(session_id)
                .map_err(|_| RealtimeError::Invalid("realtime session id is invalid".into()))?,
        );
    }
    for (name, value) in &provider.headers {
        headers.insert(name, value.clone());
    }
    Ok(())
}

fn websocket_url(
    provider: &RealtimeProvider,
    config: &SessionConfig,
) -> Result<Url, RealtimeError> {
    let mut url = Url::parse(provider.base_url.trim())
        .map_err(|error| RealtimeError::Invalid(format!("invalid realtime base URL: {error}")))?;
    match url.scheme() {
        "http" => {
            let _ = url.set_scheme("ws");
        }
        "https" => {
            let _ = url.set_scheme("wss");
        }
        "ws" | "wss" => {}
        other => {
            return Err(RealtimeError::Invalid(format!(
                "unsupported realtime URL scheme: {other}"
            )))
        }
    }
    let current = url.path().trim_end_matches('/').to_owned();
    if config.version == RealtimeVersion::V3 {
        if let Some(call_id) = config.sideband_call_id.as_deref() {
            let prefix = normalize_api_prefix(&current);
            url.set_path(&format!("{prefix}/live/{call_id}"));
        } else {
            let prefix = normalize_api_prefix(&current);
            url.set_path(&format!("{prefix}/live"));
        }
    } else {
        let prefix = normalize_api_prefix(&current);
        url.set_path(&format!("{prefix}/realtime"));
        {
            let mut query = url.query_pairs_mut();
            if config.version == RealtimeVersion::V1 {
                query.append_pair("intent", "quicksilver");
            }
            if let Some(call_id) = config.sideband_call_id.as_deref() {
                query.append_pair("call_id", call_id);
            } else {
                query.append_pair("model", &config.model);
            }
        }
    }
    Ok(url)
}

fn normalize_api_prefix(path: &str) -> String {
    let path = path.trim_end_matches('/');
    if path.is_empty() || path == "/" {
        "/v1".into()
    } else if path.ends_with("/realtime") {
        path.trim_end_matches("/realtime").to_owned()
    } else if path.ends_with("/live") {
        path.trim_end_matches("/live").to_owned()
    } else {
        path.to_owned()
    }
}

fn session_update(config: &SessionConfig) -> Value {
    let initial_items = config
        .initial_items
        .iter()
        .map(|item| {
            json!({
                "type":"message",
                "role":item.role,
                "content":[{
                    "type":if item.role == "assistant" {"output_text"} else {"input_text"},
                    "text":item.text
                }]
            })
        })
        .collect::<Vec<_>>();
    if config.version == RealtimeVersion::V3 {
        json!({
            "type":"session.update",
            "session":{
                "type":"realtime",
                "model":config.model,
                "instructions":config.instructions,
                "output_modalities":[config.modality.wire()],
                "audio":{
                    "input":{"format":{"type":"audio/pcm","rate":DEFAULT_SAMPLE_RATE}},
                    "output":{"format":{"type":"audio/pcm","rate":DEFAULT_SAMPLE_RATE},"voice":config.voice}
                },
                "initial_items":initial_items
            }
        })
    } else {
        json!({
            "type":"session.update",
            "session":{
                "type":"realtime",
                "model":config.model,
                "instructions":config.instructions,
                "output_modalities":[config.modality.wire()],
                "audio":{
                    "input":{
                        "format":{"type":"audio/pcm","rate":DEFAULT_SAMPLE_RATE},
                        "noise_reduction":{"type":"near_field"},
                        "transcription":{"model":"gpt-4o-mini-transcribe"},
                        "turn_detection":{
                            "type":"server_vad",
                            "interrupt_response":true,
                            "create_response":true,
                            "silence_duration_ms":500
                        }
                    },
                    "output":{"format":{"type":"audio/pcm","rate":DEFAULT_SAMPLE_RATE},"voice":config.voice}
                }
            }
        })
    }
}

fn outbound_messages(outbound: Outbound, version: RealtimeVersion) -> Vec<Value> {
    match outbound {
        Outbound::Audio(audio) => vec![json!({
            "type":if version == RealtimeVersion::V3 {"input_audio.append"} else {"input_audio_buffer.append"},
            "audio":audio.data
        })],
        Outbound::Text { text, role } => vec![
            json!({
                "type":"conversation.item.create",
                "item":{
                    "type":"message",
                    "role":role,
                    "content":[{
                        "type":if role == "assistant" {"output_text"} else {"input_text"},
                        "text":text
                    }]
                }
            }),
            json!({"type":"response.create"}),
        ],
        Outbound::Speech(text) => vec![
            json!({
                "type":"conversation.item.create",
                "item":{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":text}]
                }
            }),
            json!({"type":"response.create"}),
        ],
    }
}

fn project_event(thread_id: &str, payload: &str, sink: &NotificationSink) {
    let Ok(event) = serde_json::from_str::<Value>(payload) else {
        return;
    };
    let Some(kind) = event.get("type").and_then(Value::as_str) else {
        return;
    };
    let projected = match kind {
        "conversation.input_transcript.delta"
        | "conversation.item.input_audio_transcription.delta" => event
            .get("delta")
            .and_then(Value::as_str)
            .map(|delta| {
                notification(
                    "thread/realtime/transcript/delta",
                    json!({"threadId":thread_id,"role":"user","delta":delta}),
                )
            }),
        "conversation.input_transcript.turn_marked"
        | "conversation.item.input_audio_transcription.completed" => event
            .get("transcript")
            .and_then(Value::as_str)
            .map(|text| {
                notification(
                    "thread/realtime/transcript/done",
                    json!({"threadId":thread_id,"role":"user","text":text}),
                )
            }),
        "conversation.output_transcript.delta"
        | "response.output_text.delta"
        | "response.output_audio_transcript.delta" => event
            .get("delta")
            .and_then(Value::as_str)
            .map(|delta| {
                notification(
                    "thread/realtime/transcript/delta",
                    json!({"threadId":thread_id,"role":"assistant","delta":delta}),
                )
            }),
        "response.output_text.done" => event
            .get("text")
            .and_then(Value::as_str)
            .map(|text| {
                notification(
                    "thread/realtime/transcript/done",
                    json!({"threadId":thread_id,"role":"assistant","text":text}),
                )
            }),
        "response.output_audio_transcript.done" => event
            .get("transcript")
            .and_then(Value::as_str)
            .map(|text| {
                notification(
                    "thread/realtime/transcript/done",
                    json!({"threadId":thread_id,"role":"assistant","text":text}),
                )
            }),
        "conversation.output_audio.delta" | "response.output_audio.delta" | "response.audio.delta" => {
            event
                .get("delta")
                .or_else(|| event.get("data"))
                .and_then(Value::as_str)
                .map(|data| {
                    notification(
                        "thread/realtime/outputAudio/delta",
                        json!({
                            "threadId":thread_id,
                            "audio":{
                                "data":data,
                                "sampleRate":event.get("sample_rate").and_then(Value::as_u64).unwrap_or(DEFAULT_SAMPLE_RATE as u64),
                                "numChannels":event.get("channels").or_else(|| event.get("num_channels")).and_then(Value::as_u64).unwrap_or(DEFAULT_CHANNELS as u64),
                                "samplesPerChannel":event.get("samples_per_channel").cloned().unwrap_or(Value::Null),
                                "itemId":event.get("item_id").cloned().unwrap_or(Value::Null)
                            }
                        }),
                    )
                })
        }
        "conversation.item.added" | "conversation.item.created" => event.get("item").cloned().map(
            |item| {
                notification(
                    "thread/realtime/itemAdded",
                    json!({"threadId":thread_id,"item":item}),
                )
            },
        ),
        "input_audio_buffer.speech_started" => Some(notification(
            "thread/realtime/itemAdded",
            json!({
                "threadId":thread_id,
                "item":{
                    "type":"input_audio_speech_started",
                    "itemId":event.get("item_id").cloned().unwrap_or(Value::Null)
                }
            }),
        )),
        "error" => Some(notification(
            "thread/realtime/error",
            json!({
                "threadId":thread_id,
                "message":event.pointer("/error/message").or_else(|| event.get("message")).and_then(Value::as_str).unwrap_or("realtime provider error")
            }),
        )),
        _ => None,
    };
    if let Some(projected) = projected {
        sink(projected);
    }
}

async fn create_webrtc_call(
    provider: &RealtimeProvider,
    config: &SessionConfig,
    sdp: &str,
) -> Result<(String, String), RealtimeError> {
    let mut base = Url::parse(provider.base_url.trim())
        .map_err(|error| RealtimeError::Invalid(format!("invalid realtime base URL: {error}")))?;
    let prefix = normalize_api_prefix(base.path());
    let path = if config.version == RealtimeVersion::V3 {
        format!("{prefix}/live")
    } else {
        format!("{prefix}/realtime/calls")
    };
    base.set_path(&path);
    if config.version == RealtimeVersion::V1 {
        base.query_pairs_mut()
            .append_pair("intent", "quicksilver")
            .append_pair("architecture", "avas");
    }
    let session = session_update(config)
        .get("session")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let form = reqwest::multipart::Form::new()
        .part(
            "sdp",
            reqwest::multipart::Part::text(sdp.to_owned())
                .mime_str("application/sdp")
                .map_err(|error| RealtimeError::Invalid(error.to_string()))?,
        )
        .part(
            "session",
            reqwest::multipart::Part::text(session.to_string())
                .mime_str("application/json")
                .map_err(|error| RealtimeError::Invalid(error.to_string()))?,
        );
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| RealtimeError::Transport(error.to_string()))?;
    let mut request = client.post(base).multipart(form);
    if let Some(token) = provider.bearer_token.as_deref() {
        request = request.bearer_auth(token);
    }
    for (name, value) in &provider.headers {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| RealtimeError::Transport(error.to_string()))?;
    let status = response.status();
    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response
        .text()
        .await
        .map_err(|error| RealtimeError::Transport(error.to_string()))?;
    if !status.is_success() {
        return Err(RealtimeError::Transport(format!(
            "WebRTC call returned HTTP {}: {}",
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        )));
    }
    let location = location
        .ok_or_else(|| RealtimeError::Transport("WebRTC response has no Location".into()))?;
    let call_id = location
        .split('?')
        .next()
        .unwrap_or(&location)
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .ok_or_else(|| RealtimeError::Transport("WebRTC Location has no call id".into()))?;
    Ok((body, call_id.to_owned()))
}

fn notification(method: &str, params: Value) -> Value {
    json!({"method":method,"params":params})
}

fn validate_thread_id(thread_id: &str) -> Result<(), RealtimeError> {
    if thread_id.trim().is_empty() || thread_id.len() > 256 {
        Err(RealtimeError::Invalid("threadId is invalid".into()))
    } else {
        Ok(())
    }
}

fn validate_text(text: &str) -> Result<(), RealtimeError> {
    if text.is_empty() || text.len() > MAX_TEXT_BYTES {
        Err(RealtimeError::Invalid(
            "realtime text is empty or too large".into(),
        ))
    } else {
        Ok(())
    }
}

fn validate_role(role: &str) -> Result<(), RealtimeError> {
    if matches!(role, "user" | "developer" | "assistant") {
        Ok(())
    } else {
        Err(RealtimeError::Invalid("realtime role is invalid".into()))
    }
}

fn validate_initial_items(items: &[InitialItem]) -> Result<(), RealtimeError> {
    if items.len() > 128 {
        return Err(RealtimeError::Invalid(
            "realtime initialItems exceeds 128 entries".into(),
        ));
    }
    let mut total = 0usize;
    for item in items {
        validate_role(&item.role)?;
        validate_text(&item.text)?;
        total = total.saturating_add(item.text.len());
    }
    if total > 32_768 {
        return Err(RealtimeError::Invalid(
            "realtime initialItems exceeds the 8,192 token budget".into(),
        ));
    }
    Ok(())
}

fn validate_audio(audio: &AudioChunk) -> Result<(), RealtimeError> {
    if audio.sample_rate == 0 || audio.sample_rate > 192_000 {
        return Err(RealtimeError::Invalid("audio sampleRate is invalid".into()));
    }
    if audio.num_channels == 0 || audio.num_channels > 8 {
        return Err(RealtimeError::Invalid(
            "audio numChannels is invalid".into(),
        ));
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&audio.data)
        .map_err(|_| RealtimeError::Invalid("audio data is not valid base64".into()))?;
    if decoded.is_empty() || decoded.len() > MAX_AUDIO_BYTES || decoded.len() % 2 != 0 {
        return Err(RealtimeError::Invalid(
            "audio data is empty, too large, or not PCM16".into(),
        ));
    }
    if let Some(samples) = audio.samples_per_channel {
        let expected = usize::try_from(samples)
            .unwrap_or(usize::MAX)
            .saturating_mul(audio.num_channels as usize)
            .saturating_mul(2);
        if decoded.len() != expected {
            return Err(RealtimeError::Invalid(
                "audio samplesPerChannel does not match PCM data".into(),
            ));
        }
    }
    Ok(())
}

fn validate_voice(voice: &str) -> Result<(), RealtimeError> {
    const VOICES: &[&str] = &[
        "alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral", "cove", "echo", "ember",
        "juniper", "maple", "marin", "sage", "shimmer", "sol", "spruce", "vale", "verse",
    ];
    if VOICES.contains(&voice) {
        Ok(())
    } else {
        Err(RealtimeError::Invalid("realtime voice is invalid".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc as std_mpsc;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    #[test]
    fn exact_notification_projection_covers_audio_and_transcript() {
        let (tx, rx) = std_mpsc::channel();
        let sink: NotificationSink = Arc::new(move |value| tx.send(value).unwrap());
        project_event(
            "thread-1",
            r#"{"type":"response.output_audio.delta","delta":"AAA="}"#,
            &sink,
        );
        assert_eq!(
            rx.recv().unwrap()["method"],
            "thread/realtime/outputAudio/delta"
        );
        project_event(
            "thread-1",
            r#"{"type":"response.output_text.delta","delta":"hello"}"#,
            &sink,
        );
        assert_eq!(
            rx.recv().unwrap()["params"]["role"],
            Value::String("assistant".into())
        );
    }

    #[test]
    fn all_realtime_notifications_match_pinned_app_server_v2() {
        let notifications = [
            notification(
                "thread/realtime/started",
                json!({"threadId":"thread","realtimeSessionId":"session","version":"v2"}),
            ),
            notification(
                "thread/realtime/itemAdded",
                json!({"threadId":"thread","item":{"type":"message"}}),
            ),
            notification(
                "thread/realtime/transcript/delta",
                json!({"threadId":"thread","role":"user","delta":"hi"}),
            ),
            notification(
                "thread/realtime/transcript/done",
                json!({"threadId":"thread","role":"user","text":"hi"}),
            ),
            notification(
                "thread/realtime/outputAudio/delta",
                json!({"threadId":"thread","audio":{
                    "data":"AAA=","sampleRate":24000,"numChannels":1,
                    "samplesPerChannel":1,"itemId":null
                }}),
            ),
            notification(
                "thread/realtime/sdp",
                json!({"threadId":"thread","sdp":"v=0\r\n"}),
            ),
            notification(
                "thread/realtime/error",
                json!({"threadId":"thread","message":"network"}),
            ),
            notification(
                "thread/realtime/closed",
                json!({"threadId":"thread","reason":null}),
            ),
        ];
        for wire in notifications {
            serde_json::from_value::<tietiezhi_agent_protocol::ServerNotification>(wire)
                .expect("notification should match the pinned V2 union");
        }
    }

    #[test]
    fn validates_pcm16_frame_shape() {
        let audio = AudioChunk {
            data: base64::engine::general_purpose::STANDARD.encode([0_u8; 8]),
            sample_rate: 24_000,
            num_channels: 1,
            samples_per_channel: Some(4),
            item_id: None,
        };
        assert!(validate_audio(&audio).is_ok());
        assert!(validate_audio(&AudioChunk {
            samples_per_channel: Some(5),
            ..audio
        })
        .is_err());
    }

    #[test]
    fn websocket_paths_match_codex_versions() {
        let provider = RealtimeProvider::openai_compatible("https://api.example/v1", None);
        let mut config = SessionConfig {
            thread_id: "thread".into(),
            model: "realtime".into(),
            modality: OutputModality::Audio,
            version: RealtimeVersion::V1,
            voice: "cove".into(),
            instructions: String::new(),
            initial_items: Vec::new(),
            requested_session_id: None,
            sideband_call_id: None,
        };
        assert_eq!(
            websocket_url(&provider, &config).unwrap().path(),
            "/v1/realtime"
        );
        config.version = RealtimeVersion::V3;
        config.sideband_call_id = Some("rtc_1".into());
        assert_eq!(
            websocket_url(&provider, &config).unwrap().path(),
            "/v1/live/rtc_1"
        );
    }

    #[tokio::test]
    async fn request_id_dedupe_prevents_duplicate_text_after_disconnect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let received = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
        let captured = received.clone();
        tokio::spawn(async move {
            for _ in 0..2 {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut ws = accept_async(tcp).await.unwrap();
                if let Some(Ok(Message::Text(update))) = ws.next().await {
                    captured
                        .lock()
                        .await
                        .push(serde_json::from_str(&update).unwrap());
                }
                if let Some(Ok(Message::Text(message))) = ws.next().await {
                    captured
                        .lock()
                        .await
                        .push(serde_json::from_str(&message).unwrap());
                }
                let _ = ws.close(None).await;
            }
        });
        let runtime = RealtimeRuntime::default();
        let sink: NotificationSink = Arc::new(|_| {});
        runtime
            .start(
                StartParams {
                    thread_id: "thread".into(),
                    client_managed_handoffs: None,
                    flush_transcript_tail_on_session_end: None,
                    codex_responses_as_items: None,
                    codex_response_item_prefix: None,
                    codex_response_handoff_mode: None,
                    model: Some("test".into()),
                    output_modality: OutputModality::Text,
                    include_startup_context: None,
                    initial_items: None,
                    prompt: None,
                    realtime_session_id: Some("resume-1".into()),
                    transport: Some(StartTransport::Websocket),
                    version: Some(RealtimeVersion::V2),
                    voice: Some("marin".into()),
                },
                RealtimeProvider::openai_compatible(format!("http://{address}/v1"), None),
                sink,
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        runtime
            .append_text("thread", "message-1", "hello".into(), "user".into())
            .await
            .unwrap();
        runtime
            .append_text("thread", "message-1", "hello".into(), "user".into())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        runtime.stop("thread").ok();
        let messages = received.lock().await;
        let creates = messages
            .iter()
            .filter(|message| message["type"] == "conversation.item.create")
            .count();
        assert_eq!(creates, 1);
    }
}
