use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tokio_util::sync::CancellationToken;

use super::models::{classify, ModelKind};
use super::{api_url, providers, snippet};
use crate::agent::failure::ChatFailure;
use crate::AppState;

pub use crate::agent::events::ChatEvent;

fn ensure_chat_model(model: &str) -> Result<(), String> {
    match classify(model) {
        ModelKind::Chat => Ok(()),
        _ => Err(format!("模型「{model}」不支持聊天接口，请选择一个聊天模型")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Incremental SSE line splitter: feed raw bytes, get complete lines back.
/// Lines are only emitted once their trailing `\n` arrived, so multi-byte
/// UTF-8 sequences split across network chunks are never broken.
#[derive(Default)]
pub(crate) struct SseLineBuffer {
    buf: Vec<u8>,
}

impl SseLineBuffer {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // trailing '\n'
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        lines
    }
}

/// Extract the payload of an SSE `data:` line; other fields are ignored.
pub(crate) fn sse_data(line: &str) -> Option<&str> {
    line.strip_prefix("data:").map(str::trim_start)
}

#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
}

#[derive(Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
}

/// Stream one OpenAI-compatible chat completion against the given provider.
/// Connection details are resolved Rust-side from the provider id. Deltas are
/// pushed through `on_event`; the command itself only fails on argument-level
/// problems, so the frontend has a single place (the channel) to observe the
/// outcome.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: u32,
    provider_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    conversation_id: Option<String>,
    agent_id: Option<String>,
    project_id: Option<String>,
    on_event: Channel<ChatEvent>,
) -> Result<(), String> {
    let cancel = CancellationToken::new();
    state
        .chat_cancels
        .lock()
        .unwrap()
        .insert(request_id, cancel.clone());

    let result: Result<bool, ChatFailure> = match providers::resolve(&app, &provider_id) {
        Ok(resolved) => {
            match super::agents::resolve_env(
                &app,
                agent_id.as_deref(),
                project_id.as_deref(),
                conversation_id.as_deref(),
            ) {
                Ok(env) => {
                    // Per-agent model override beats the frontend selection.
                    let model =
                        super::agents::model_override(&app, agent_id.as_deref()).unwrap_or(model);
                    match ensure_chat_model(&model) {
                        Ok(()) => {
                            let _ = on_event.send(ChatEvent::Started {
                                model: model.clone(),
                            });
                            crate::agent::loop_::run_agent_loop(
                                &app,
                                &state.http,
                                &state.permissions,
                                &state.mcp,
                                request_id,
                                &resolved.base_url,
                                resolved.key.as_deref(),
                                &model,
                                messages,
                                env,
                                &cancel,
                                &on_event,
                            )
                            .await
                        }
                        Err(e) => Err(ChatFailure::message(e)),
                    }
                }
                Err(e) => Err(ChatFailure::message(e)),
            }
        }
        Err(e) => Err(ChatFailure::message(e)),
    };

    state.chat_cancels.lock().unwrap().remove(&request_id);
    state.permissions.end_session(request_id);

    let final_event = match result {
        Ok(cancelled) => ChatEvent::Done { cancelled },
        Err(failure) => ChatEvent::Error {
            message: failure.summary,
            detail: failure.detail,
            code: failure.code,
            status: failure.status,
            retryable: failure.retryable,
            retries: failure.retries,
        },
    };
    let _ = on_event.send(final_event);
    Ok(())
}

/// Shared streaming path used by both chat and dictation polish: resolve the
/// provider, run the stream, and drive the outcome channel.
pub(crate) async fn stream_to_channel(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: u32,
    provider_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    on_event: Channel<ChatEvent>,
) -> Result<(), String> {
    let cancel = CancellationToken::new();
    state
        .chat_cancels
        .lock()
        .unwrap()
        .insert(request_id, cancel.clone());

    let result = match providers::resolve(&app, &provider_id) {
        Ok(resolved) => match ensure_chat_model(&model) {
            Ok(()) => {
                let _ = on_event.send(ChatEvent::Started {
                    model: model.clone(),
                });
                run_stream(
                    &state.http,
                    &resolved.base_url,
                    &model,
                    &messages,
                    resolved.key.as_deref(),
                    &cancel,
                    |content| {
                        on_event
                            .send(ChatEvent::Delta { content })
                            .map_err(|e| format!("推送消息到界面失败：{e}"))
                    },
                )
                .await
            }
            Err(e) => Err(e),
        },
        Err(e) => Err(e),
    };

    state.chat_cancels.lock().unwrap().remove(&request_id);

    let final_event = match result {
        Ok(cancelled) => ChatEvent::Done { cancelled },
        Err(message) => {
            let failure = ChatFailure::message(message);
            ChatEvent::Error {
                message: failure.summary,
                detail: failure.detail,
                code: failure.code,
                status: failure.status,
                retryable: failure.retryable,
                retries: failure.retries,
            }
        }
    };
    let _ = on_event.send(final_event);
    Ok(())
}

#[tauri::command]
pub fn chat_cancel(state: State<'_, AppState>, request_id: u32) {
    if let Some(token) = state.chat_cancels.lock().unwrap().get(&request_id) {
        token.cancel();
    }
}

/// Returns `Ok(true)` when the stream was cancelled by the user.
/// IPC-free so tests can drive it against a plain HTTP mock.
async fn run_stream(
    http: &reqwest::Client,
    base_url: &str,
    model: &str,
    messages: &[ChatMessage],
    api_key: Option<&str>,
    cancel: &CancellationToken,
    mut on_delta: impl FnMut(String) -> Result<(), String>,
) -> Result<bool, String> {
    let base = base_url.trim();
    if base.is_empty() {
        return Err("尚未配置中转站 baseURL，请先到「设置」填写".into());
    }
    if model.trim().is_empty() {
        return Err("尚未选择模型，请先在顶部选择模型".into());
    }

    let body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });

    let mut req = http.post(api_url(base, "chat/completions")).json(&body);
    if let Some(key) = api_key {
        req = req.bearer_auth(key);
    }

    let resp = tokio::select! {
        _ = cancel.cancelled() => return Ok(true),
        r = req.send() => r.map_err(|e| format!("无法连接中转站：{e}"))?,
    };

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "中转站返回 HTTP {}：{}",
            status.as_u16(),
            snippet(&body)
        ));
    }

    let mut stream = resp.bytes_stream();
    let mut lines = SseLineBuffer::default();

    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Ok(true),
            c = stream.next() => c,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|e| format!("流式读取中断：{e}"))?;

        for line in lines.push(&chunk) {
            let Some(data) = sse_data(&line) else {
                continue;
            };
            if data == "[DONE]" {
                return Ok(false);
            }
            // Tolerate unknown event shapes (keep-alives, usage frames, …).
            let Ok(parsed) = serde_json::from_str::<StreamChunk>(data) else {
                continue;
            };
            let content = parsed
                .choices
                .into_iter()
                .next()
                .and_then(|c| c.delta.content)
                .unwrap_or_default();
            if !content.is_empty() {
                on_delta(content)?;
            }
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_buffer_handles_chunks_split_mid_line() {
        let mut buf = SseLineBuffer::default();
        assert!(buf.push(b"data: {\"a\":").is_empty());
        let lines = buf.push(b"1}\n\ndata: [DONE]\n");
        assert_eq!(
            lines,
            vec![
                "data: {\"a\":1}".to_string(),
                String::new(),
                "data: [DONE]".to_string(),
            ]
        );
    }

    #[test]
    fn line_buffer_strips_crlf() {
        let mut buf = SseLineBuffer::default();
        assert_eq!(buf.push(b"data: x\r\n"), vec!["data: x".to_string()]);
    }

    #[test]
    fn line_buffer_keeps_multibyte_utf8_across_chunks() {
        let mut buf = SseLineBuffer::default();
        let bytes = "data: 你好\n".as_bytes();
        // Split inside the middle of a CJK character.
        assert!(buf.push(&bytes[..8]).is_empty());
        assert_eq!(buf.push(&bytes[8..]), vec!["data: 你好".to_string()]);
    }

    #[test]
    fn sse_data_extracts_payload() {
        assert_eq!(sse_data("data: {\"x\":1}"), Some("{\"x\":1}"));
        assert_eq!(sse_data("data:[DONE]"), Some("[DONE]"));
        assert_eq!(sse_data(": keep-alive"), None);
        assert_eq!(sse_data("event: ping"), None);
    }

    #[test]
    fn stream_chunk_parses_openai_delta() {
        let chunk: StreamChunk = serde_json::from_str(
            r#"{"id":"1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}"#,
        )
        .unwrap();
        assert_eq!(chunk.choices[0].delta.content.as_deref(), Some("你好"));
    }

    #[test]
    fn image_model_is_rejected_before_chat_request() {
        let error = ensure_chat_model("sensenova-u1-fast").unwrap_err();
        assert!(error.contains("不支持聊天接口"));
        assert!(ensure_chat_model("deepseek-v4-flash").is_ok());
    }

    /// End-to-end: HTTP request → SSE body → parsed deltas, against a real
    /// TCP socket speaking just enough HTTP for reqwest.
    #[tokio::test]
    async fn run_stream_collects_deltas_from_mock_relay() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 8192];
            let _ = sock.read(&mut buf).await.unwrap();
            let body = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n",
                ": keep-alive\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"！\"}}]}\n\n",
                "data: [DONE]\n\n",
            );
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
            sock.shutdown().await.ok();
        });

        let http = reqwest::Client::new();
        let mut collected = String::new();
        let cancelled = run_stream(
            &http,
            &format!("http://{addr}"),
            "mock-model",
            &[ChatMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            Some("test-key"),
            &CancellationToken::new(),
            |content| {
                collected.push_str(&content);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert!(!cancelled);
        assert_eq!(collected, "你好！");
    }
}
