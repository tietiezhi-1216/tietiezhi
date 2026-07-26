use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tokio_util::sync::CancellationToken;

use super::models::{classify, ModelInfo, ModelKind, ModelWireApi, ReasoningEffort};
use super::providers;
use crate::agent::context::ContextAction;
use crate::agent::failure::ChatFailure;
use crate::AppState;

use crate::agent::events::ChatEventEmitter;
pub use crate::agent::events::{ChatEvent, ScopedChatEvent};

const DICTATION_POLISH_TIMEOUT: Duration = Duration::from_secs(90);

fn ensure_chat_model(model: &str, model_info: Option<&ModelInfo>) -> Result<(), String> {
    match model_info
        .map(ModelInfo::effective_kind)
        .unwrap_or_else(|| classify(model))
    {
        ModelKind::Chat => Ok(()),
        _ => Err(format!("模型「{model}」不支持聊天接口，请选择一个聊天模型")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: serde_json::Value,
}

/// Incremental SSE line splitter: feed raw bytes, get complete lines back.
/// Lines are only emitted once their trailing `\n` arrived, so multi-byte
/// UTF-8 sequences split across network chunks are never broken.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct SseLineBuffer {
    buf: Vec<u8>,
}

#[cfg(test)]
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
#[cfg(test)]
pub(crate) fn sse_data(line: &str) -> Option<&str> {
    line.strip_prefix("data:").map(str::trim_start)
}

#[cfg(test)]
#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
}

#[cfg(test)]
#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
}

#[cfg(test)]
#[derive(Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
}

/// The single Tietiezhi companion timeline. Its dedicated control-center
/// configuration resolves the Home, memory, Skills, MCP and safe tools.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn tietiezhi_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: u32,
    device_id: String,
    device_name: String,
    messages: Vec<ChatMessage>,
    on_event: Channel<ScopedChatEvent>,
) -> Result<(), String> {
    let on_event = ChatEventEmitter::new(on_event, "tietiezhi_main".into())?;
    let cancel = CancellationToken::new();
    state
        .chat_cancels
        .lock()
        .unwrap()
        .insert(request_id, cancel.clone());

    let result: Result<bool, ChatFailure> = async {
        let settings = super::settings::read_settings(&app).map_err(ChatFailure::message)?;
        if settings.chat_provider_id.trim().is_empty() || settings.chat_model.trim().is_empty() {
            return Err(ChatFailure::message("请先在设置中配置对话模型"));
        }
        let resolved =
            providers::resolve(&app, &settings.chat_provider_id).map_err(ChatFailure::message)?;
        let model = settings.chat_model;
        let model_info = resolved
            .models
            .iter()
            .find(|candidate| candidate.id == model);
        ensure_chat_model(&model, model_info).map_err(ChatFailure::message)?;
        let wire_api = resolved.wire_api_for_model(&model);

        let env = super::tietiezhi::resolve_env(&app, &device_id, &device_name)
            .map_err(ChatFailure::message)?;
        let reasoning_effort = ReasoningEffort::from_setting(&settings.chat_reasoning_effort);
        let _ = on_event.send(ChatEvent::Started {
            model: model.clone(),
        });
        crate::agent::loop_::run_companion_loop(
            &app,
            &state.http,
            &state.permissions,
            &state.mcp,
            request_id,
            &resolved.base_url,
            resolved.key.as_deref(),
            &model,
            wire_api,
            model_info,
            reasoning_effort,
            messages,
            env,
            ContextAction::Disabled,
            &cancel,
            &on_event,
        )
        .await
    }
    .await;

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
    on_event: Channel<ScopedChatEvent>,
) -> Result<(), String> {
    let on_event = ChatEventEmitter::new(on_event, format!("polish_{request_id}"))?;
    let cancel = CancellationToken::new();
    state
        .chat_cancels
        .lock()
        .unwrap()
        .insert(request_id, cancel.clone());

    let result = match providers::resolve(&app, &provider_id) {
        Ok(resolved) => match ensure_chat_model(
            &model,
            resolved
                .models
                .iter()
                .find(|candidate| candidate.id == model),
        ) {
            Ok(()) => {
                let _ = on_event.send(ChatEvent::Started {
                    model: model.clone(),
                });
                match tokio::time::timeout(
                    DICTATION_POLISH_TIMEOUT,
                    run_stream(
                        &state.http,
                        &resolved.base_url,
                        &model,
                        resolved.wire_api_for_model(&model),
                        &messages,
                        resolved.key.as_deref(),
                        &cancel,
                        |content| {
                            on_event
                                .send(ChatEvent::Delta { content })
                                .map_err(|e| format!("推送消息到界面失败：{e}"))
                        },
                    ),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err("文本润色等待超时，请检查网络后重试".into()),
                }
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
    wire_api: ModelWireApi,
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

    let mut instructions = Vec::new();
    let input = messages
        .iter()
        .filter_map(|message| {
            if message.role == "system" {
                if let Some(text) = message.content.as_str() {
                    instructions.push(text.to_owned());
                }
                return None;
            }
            let kind = if message.role == "assistant" {
                "output_text"
            } else {
                "input_text"
            };
            Some(json!({
                "type":"message",
                "role":message.role,
                "content":[{"type":kind,"text":message.content.as_str().unwrap_or_default()}]
            }))
        })
        .collect();
    let mut request = tietiezhi_agent_model::ResponsesApiRequest::text(model, input);
    request.instructions = instructions.join("\n\n");
    let canonical_base_url = super::api_url(base, "");
    let provider = tietiezhi_agent_model::Provider::openai_compatible(
        "chat",
        canonical_base_url,
        api_key.map(str::to_owned),
    )
    .with_wire_api(match wire_api {
        ModelWireApi::Auto | ModelWireApi::Responses => tietiezhi_agent_model::WireApi::Responses,
        ModelWireApi::ChatCompletions => tietiezhi_agent_model::WireApi::ChatCompletions,
        ModelWireApi::AnthropicMessages => tietiezhi_agent_model::WireApi::AnthropicMessages,
        ModelWireApi::GeminiGenerateContent => {
            tietiezhi_agent_model::WireApi::GeminiGenerateContent
        }
    });
    let client = tietiezhi_agent_model::ResponsesClient::new(http.clone(), provider);
    let stream = client.stream(&request, |event| {
        if let tietiezhi_agent_model::ResponseEvent::OutputTextDelta(content) = event {
            on_delta(content).map_err(tietiezhi_agent_model::ModelError::Consumer)?;
        }
        Ok(())
    });
    tokio::pin!(stream);
    tokio::select! {
        _ = cancel.cancelled() => Ok(true),
        result = &mut stream => result
            .map(|_| false)
            .map_err(|error| error.to_string()),
    }
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
        let error = ensure_chat_model("sensenova-u1-fast", None).unwrap_err();
        assert!(error.contains("不支持聊天接口"));
        assert!(ensure_chat_model("deepseek-v4-flash", None).is_ok());
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
            ModelWireApi::ChatCompletions,
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
