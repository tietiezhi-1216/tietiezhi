//! Real-time speech recognition over OpenAI's Realtime WebSocket API.
//!
//! This module owns the wire format; the dictation session drives the loop
//! (feed audio while recording, `commit()` on stop, read events for live
//! deltas). Protocol details follow the OpenAI Realtime transcription spec and
//! may need tweaks as that API evolves.

use base64::Engine as _;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::audio::pcm16_to_bytes;
use crate::config::ResolvedModel;

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug)]
pub enum RtEvent {
    Delta(String),
    Completed(String),
    Error(String),
}

fn to_ws_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    format!("{base}/realtime?intent=transcription")
}

pub async fn connect(model: &ResolvedModel) -> anyhow::Result<WsStream> {
    if model.api_key.trim().is_empty() {
        anyhow::bail!("所选语音识别服务商缺少 API Key");
    }
    let mut request = to_ws_url(&model.base_url).into_client_request()?;
    let headers = request.headers_mut();
    headers.insert(
        "Authorization",
        format!("Bearer {}", model.api_key).parse()?,
    );
    headers.insert("OpenAI-Beta", "realtime=v1".parse()?);

    let (ws, _resp) = connect_async(request).await?;
    Ok(ws)
}

/// Configure the transcription session (model, format, language).
pub fn session_update(model: &ResolvedModel) -> Message {
    let payload = serde_json::json!({
        "type": "transcription_session.update",
        "session": {
            "input_audio_format": "pcm16",
            "input_audio_transcription": {
                "model": model.model,
                "language": model.language,
            },
            "turn_detection": serde_json::Value::Null
        }
    });
    Message::Text(payload.to_string())
}

/// Append a PCM16 frame as base64 audio.
pub fn append(frame: &[i16]) -> Message {
    let b64 = base64::engine::general_purpose::STANDARD.encode(pcm16_to_bytes(frame));
    Message::Text(
        serde_json::json!({ "type": "input_audio_buffer.append", "audio": b64 }).to_string(),
    )
}

/// Signal end-of-utterance so the server finalizes the transcription.
pub fn commit() -> Message {
    Message::Text(serde_json::json!({ "type": "input_audio_buffer.commit" }).to_string())
}

pub fn parse_event(text: &str) -> Option<RtEvent> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    match v.get("type")?.as_str()? {
        "conversation.item.input_audio_transcription.delta" => {
            Some(RtEvent::Delta(v.get("delta")?.as_str()?.to_string()))
        }
        "conversation.item.input_audio_transcription.completed" => Some(RtEvent::Completed(
            v.get("transcript")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string(),
        )),
        "error" => Some(RtEvent::Error(text.to_string())),
        _ => None,
    }
}
