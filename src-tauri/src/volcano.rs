//! 火山引擎 / 豆包语音 — 大模型流式语音识别 (sauc/bigmodel) over WebSocket.
//!
//! Endpoint: wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
//! Auth headers: X-Api-App-Key (AppID), X-Api-Access-Key (Access Token),
//! X-Api-Resource-Id (volc.bigasr.sauc.duration), X-Api-Request-Id, X-Api-Connect-Id.
//!
//! Wire format is a custom binary frame:
//!   byte0 = (version=1 << 4) | (header_size=1)              = 0x11
//!   byte1 = (message_type << 4) | message_type_flags
//!   byte2 = (serialization << 4) | compression
//!   byte3 = 0x00 (reserved)
//!   [4-byte big-endian sequence — present when the flags' low bit is set]
//!   4-byte big-endian payload size
//!   payload (gzip-compressed; JSON for control, raw PCM for audio)
//!
//! message_type: full client = 0b0001, audio only = 0b0010,
//!               full server response = 0b1001, error = 0b1111.
//! flags: NO_SEQ=0, POS_SEQ=1, NEG_SEQ=2 (last, no num), NEG_WITH_SEQ=3 (last + num).
//!
//! NOTE: implemented from the documented protocol; needs a real AppID + Access
//! Token to validate end-to-end and may need small tweaks against the live API.

use std::io::{Read, Write};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::config::ResolvedModel;

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

const ENDPOINT: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";

#[derive(Debug)]
pub enum VolcEvent {
    Result { text: String, is_final: bool },
    Error(String),
    Other,
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    let _ = enc.write_all(data);
    enc.finish().unwrap_or_default()
}

fn gunzip(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let _ = GzDecoder::new(data).read_to_end(&mut out);
    out
}

pub async fn connect(model: &ResolvedModel) -> anyhow::Result<WsStream> {
    if model.app_id.trim().is_empty() || model.api_key.trim().is_empty() {
        anyhow::bail!("火山引擎需要填写 AppID 与 Access Token");
    }
    let endpoint = if model.base_url.starts_with("ws") {
        model.base_url.clone()
    } else {
        ENDPOINT.to_string()
    };

    let mut request = endpoint.into_client_request()?;
    let h = request.headers_mut();
    h.insert("X-Api-App-Key", model.app_id.parse()?);
    h.insert("X-Api-Access-Key", model.api_key.parse()?);
    h.insert("X-Api-Resource-Id", model.resource_id.parse()?);
    h.insert("X-Api-Request-Id", uuid::Uuid::new_v4().to_string().parse()?);
    h.insert("X-Api-Connect-Id", uuid::Uuid::new_v4().to_string().parse()?);

    let (ws, _resp) = connect_async(request).await?;
    Ok(ws)
}

/// First packet: audio metadata + request parameters (JSON, gzip), seq = 1.
pub fn full_client_request(model: &ResolvedModel) -> Vec<u8> {
    let model_name = if model.model.trim().is_empty() {
        "bigmodel".to_string()
    } else {
        model.model.clone()
    };
    let json = serde_json::json!({
        "user": { "uid": "orbit" },
        "audio": { "format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1 },
        "request": {
            "model_name": model_name,
            "enable_punc": true,
            "result_type": "single"
        }
    });
    let payload = gzip(json.to_string().as_bytes());
    // header: full client(0b0001) | POS_SEQ(0b0001); JSON(0b0001) | GZIP(0b0001)
    let mut frame = vec![0x11u8, 0x11, 0x11, 0x00];
    frame.extend_from_slice(&1i32.to_be_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    frame
}

/// An audio packet. `last` marks the final chunk (negative sequence).
pub fn audio_request(pcm: &[u8], seq: i32, last: bool) -> Vec<u8> {
    let payload = gzip(pcm);
    // byte1: audio(0b0010) | (NEG_WITH_SEQ 0b0011 when last else POS_SEQ 0b0001)
    let byte1 = if last { 0x23u8 } else { 0x21u8 };
    let seq_val = if last { -seq } else { seq };
    // byte2: serialization NONE(0) | GZIP(1)
    let mut frame = vec![0x11u8, byte1, 0x01, 0x00];
    frame.extend_from_slice(&seq_val.to_be_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    frame
}

pub fn parse_response(data: &[u8]) -> VolcEvent {
    if data.len() < 4 {
        return VolcEvent::Other;
    }
    let header_size = ((data[0] & 0x0f) as usize) * 4;
    let msg_type = data[1] >> 4;
    let flags = data[1] & 0x0f;
    let compression = data[2] & 0x0f;

    let mut p = header_size.max(4);
    // Sequence number present when the low flag bit is set (POS / NEG_WITH_SEQ).
    if flags & 0x01 != 0 {
        if data.len() < p + 4 {
            return VolcEvent::Other;
        }
        p += 4;
    }

    match msg_type {
        0b1001 => {
            if data.len() < p + 4 {
                return VolcEvent::Other;
            }
            let size = u32::from_be_bytes([data[p], data[p + 1], data[p + 2], data[p + 3]]) as usize;
            p += 4;
            if data.len() < p + size {
                return VolcEvent::Other;
            }
            let raw = &data[p..p + size];
            let bytes = if compression == 0x01 {
                gunzip(raw)
            } else {
                raw.to_vec()
            };
            let v: serde_json::Value = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(_) => return VolcEvent::Other,
            };
            let text = v
                .get("result")
                .and_then(|r| r.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .to_string();
            // The server marks the last packet with NEG flags (bit 1 set).
            let is_final = flags & 0x02 != 0;
            VolcEvent::Result { text, is_final }
        }
        0b1111 => {
            if data.len() < p + 8 {
                return VolcEvent::Error("火山引擎返回错误".to_string());
            }
            let code = u32::from_be_bytes([data[p], data[p + 1], data[p + 2], data[p + 3]]);
            let size =
                u32::from_be_bytes([data[p + 4], data[p + 5], data[p + 6], data[p + 7]]) as usize;
            let start = p + 8;
            let msg = if data.len() >= start + size {
                let raw = &data[start..start + size];
                let bytes = if compression == 0x01 {
                    gunzip(raw)
                } else {
                    raw.to_vec()
                };
                String::from_utf8_lossy(&bytes).to_string()
            } else {
                String::new()
            };
            VolcEvent::Error(format!("火山引擎错误 {code}：{msg}"))
        }
        _ => VolcEvent::Other,
    }
}
