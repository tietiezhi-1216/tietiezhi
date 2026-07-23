use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use super::context::{
    build_compaction_transcript, compaction_threshold, estimate_payload_tokens, should_compact,
    summary_message, truncate_summary, ContextAction, DEFAULT_CONTEXT_WINDOW_TOKENS,
};
use super::events::ChatEvent;
use super::failure::{retry_delay_ms, ChatFailure};
use crate::commands::api_url;
use crate::commands::models::{
    ModelCapability, ModelInfo, ReasoningEffort, ReasoningMode, ReasoningProfile,
    ReasoningTransport,
};
use crate::mcp::{self, McpManager, McpServerConfig};
use crate::permission::{needs_approval, Decision, PermissionBroker, PermissionMode};
use crate::tools::{self, ToolCtx};

pub const MAX_ITERATIONS: usize = 20;
const MODEL_REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const TURN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_IDENTICAL_TOOL_CALLS: u8 = 3;

struct CancelOnDrop(CancellationToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// The fully-resolved execution environment for one agent chat turn.
pub struct AgentEnv {
    pub system_prompt: String,
    pub allowed_tools: Vec<String>,
    pub available_skills: Vec<String>,
    pub permission_mode: PermissionMode,
    pub mcp_configs: Vec<McpServerConfig>,
    pub workspace: PathBuf,
}

/// One fully-accumulated tool call out of the stream.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

impl ToolCall {
    pub fn parsed_args(&self) -> Value {
        serde_json::from_str(&self.arguments)
            .unwrap_or_else(|_| Value::String(self.arguments.clone()))
    }
}

// ---- SSE chunk shapes ------------------------------------------------------

#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    usage: Option<StreamUsage>,
}

#[derive(Deserialize)]
struct StreamUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
    /// OpenAI-standard cache reporting: `prompt_tokens_details.cached_tokens`.
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
    /// DeepSeek-style cache reporting: cache-hit prompt tokens.
    #[serde(default)]
    prompt_cache_hit_tokens: Option<u64>,
}

impl StreamUsage {
    /// Prompt tokens billed from cache, normalized across the OpenAI and
    /// DeepSeek shapes (0 when the provider reports neither).
    fn cached_tokens(&self) -> u64 {
        self.prompt_tokens_details
            .as_ref()
            .map(|d| d.cached_tokens)
            .filter(|&c| c > 0)
            .or(self.prompt_cache_hit_tokens)
            .unwrap_or(0)
    }
}

#[derive(Deserialize)]
struct PromptTokensDetails {
    #[serde(default)]
    cached_tokens: u64,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    // Reasoning models stream their chain-of-thought here: `reasoning_content`
    // (DeepSeek and most OpenAI-compatible relays) or `reasoning` (OpenRouter).
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCallDelta>>,
}

#[derive(Deserialize)]
struct ToolCallDelta {
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[derive(Deserialize, Default)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

/// Accumulates streamed tool-call deltas keyed by index. Handles both
/// fragmented arguments (OpenAI) and whole-call-in-one-delta relays.
#[derive(Default)]
pub struct ToolCallAccumulator {
    calls: BTreeMap<u32, ToolCall>,
    next_implicit_index: u32,
}

impl ToolCallAccumulator {
    fn push(&mut self, delta: ToolCallDelta) {
        let index = delta.index.unwrap_or_else(|| {
            // Some relays omit index; a delta carrying an id starts a new call.
            if delta.id.is_some() && !self.calls.is_empty() {
                self.next_implicit_index += 1;
            }
            self.next_implicit_index
        });
        let entry = self.calls.entry(index).or_insert_with(|| ToolCall {
            id: String::new(),
            name: String::new(),
            arguments: String::new(),
        });
        if let Some(id) = delta.id {
            if !id.is_empty() {
                entry.id = id;
            }
        }
        if let Some(f) = delta.function {
            if let Some(name) = f.name {
                if !name.is_empty() {
                    entry.name = name;
                }
            }
            if let Some(args) = f.arguments {
                entry.arguments.push_str(&args);
            }
        }
    }

    fn finish(self) -> Vec<ToolCall> {
        self.calls
            .into_values()
            .enumerate()
            .map(|(i, mut c)| {
                if c.id.is_empty() {
                    c.id = format!("call_{i}");
                }
                c
            })
            .filter(|c| !c.name.is_empty())
            .collect()
    }
}

struct StreamOutcome {
    text: String,
    tool_calls: Vec<ToolCall>,
    cancelled: bool,
}

/// One streamed chat/completions round: emits text deltas, accumulates tool
/// calls, returns both.
#[allow(clippy::too_many_arguments)]
async fn stream_once(
    http: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    transcript: &[Value],
    tools: &[Value],
    reasoning: Option<&ReasoningProfile>,
    reasoning_effort: ReasoningEffort,
    emit_output_events: bool,
    cancel: &CancellationToken,
    on_event: &Channel<ChatEvent>,
) -> Result<StreamOutcome, ChatFailure> {
    let mut body = json!({
        "model": model,
        "messages": transcript,
        "stream": true,
        "stream_options": {"include_usage": true},
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.to_vec());
    }
    apply_reasoning(&mut body, reasoning, reasoning_effort);

    let mut req = http
        .post(api_url(base_url, "chat/completions"))
        .timeout(MODEL_REQUEST_TIMEOUT)
        .json(&body);
    if let Some(key) = api_key {
        req = req.bearer_auth(key);
    }

    let resp = tokio::select! {
        _ = cancel.cancelled() => return Ok(StreamOutcome { text: String::new(), tool_calls: vec![], cancelled: true }),
        r = req.send() => r.map_err(ChatFailure::request)?,
    };

    let status = resp.status();
    if !status.is_success() {
        let retry_after_ms = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .map(|seconds| seconds.saturating_mul(1_000));
        let body = resp.text().await.unwrap_or_default();
        return Err(ChatFailure::http(status, body, retry_after_ms));
    }

    let mut stream = resp.bytes_stream();
    let mut lines = crate::commands::chat::SseLineBuffer::default();
    let mut text = String::new();
    let mut acc = ToolCallAccumulator::default();
    let mut output_started = false;

    'outer: loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Ok(StreamOutcome { text, tool_calls: vec![], cancelled: true }),
            result = tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()) => {
                result.map_err(|_| ChatFailure::response_timeout(output_started))?
            },
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|error| ChatFailure::stream(error, output_started))?;

        for line in lines.push(&chunk) {
            let Some(data) = crate::commands::chat::sse_data(&line) else {
                continue;
            };
            if data == "[DONE]" {
                break 'outer;
            }
            let Ok(parsed) = serde_json::from_str::<StreamChunk>(data) else {
                continue;
            };
            if let Some(usage) = parsed.usage {
                let total_tokens = if usage.total_tokens == 0 {
                    usage.prompt_tokens + usage.completion_tokens
                } else {
                    usage.total_tokens
                };
                if total_tokens > 0 && emit_output_events {
                    on_event
                        .send(ChatEvent::Usage {
                            prompt_tokens: usage.prompt_tokens,
                            completion_tokens: usage.completion_tokens,
                            total_tokens,
                            cached_tokens: usage.cached_tokens(),
                        })
                        .map_err(|e| ChatFailure::channel(format!("推送消息到界面失败：{e}")))?;
                }
            }
            for choice in parsed.choices {
                // Reasoning first (it precedes the answer), forwarded as its own
                // event so it never mixes into `text`/the transcript replayed to
                // the model.
                if let Some(reasoning) = choice.delta.reasoning_content.or(choice.delta.reasoning) {
                    if !reasoning.is_empty() {
                        output_started = true;
                        if emit_output_events {
                            on_event
                                .send(ChatEvent::Reasoning { content: reasoning })
                                .map_err(|e| {
                                    ChatFailure::channel(format!("推送消息到界面失败：{e}"))
                                })?;
                        }
                    }
                }
                if let Some(content) = choice.delta.content {
                    if !content.is_empty() {
                        output_started = true;
                        text.push_str(&content);
                        if emit_output_events {
                            on_event.send(ChatEvent::Delta { content }).map_err(|e| {
                                ChatFailure::channel(format!("推送消息到界面失败：{e}"))
                            })?;
                        }
                    }
                }
                if let Some(deltas) = choice.delta.tool_calls {
                    if !deltas.is_empty() {
                        output_started = true;
                    }
                    for d in deltas {
                        acc.push(d);
                    }
                }
                let _ = choice.finish_reason;
            }
        }
    }

    Ok(StreamOutcome {
        text,
        tool_calls: acc.finish(),
        cancelled: false,
    })
}

fn apply_reasoning(
    body: &mut Value,
    profile: Option<&ReasoningProfile>,
    selected: ReasoningEffort,
) {
    let Some(profile) = profile else { return };
    if profile.mode == ReasoningMode::Fixed || selected == ReasoningEffort::Auto {
        return;
    }
    if !profile.supported_efforts.is_empty() && !profile.supported_efforts.contains(&selected) {
        return;
    }

    match profile.transport {
        ReasoningTransport::None => {}
        ReasoningTransport::OpenaiReasoningEffort => {
            if let Some(value) = selected.as_wire_value() {
                body["reasoning_effort"] = Value::String(value.into());
            }
        }
        ReasoningTransport::OpenrouterReasoning => {
            if let Some(value) = selected.as_wire_value() {
                body["reasoning"] = json!({"effort": value});
            }
        }
        ReasoningTransport::EnableThinking => {
            body["enable_thinking"] = Value::Bool(selected != ReasoningEffort::Off);
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_with_retries(
    http: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    transcript: &[Value],
    tools: &[Value],
    reasoning: Option<&ReasoningProfile>,
    reasoning_effort: ReasoningEffort,
    emit_output_events: bool,
    cancel: &CancellationToken,
    on_event: &Channel<ChatEvent>,
) -> Result<StreamOutcome, ChatFailure> {
    let mut retries = 0;
    loop {
        match stream_once(
            http,
            base_url,
            api_key,
            model,
            transcript,
            tools,
            reasoning,
            reasoning_effort,
            emit_output_events,
            cancel,
            on_event,
        )
        .await
        {
            Ok(outcome) => return Ok(outcome),
            Err(failure)
                if failure.retryable
                    && !failure.output_started
                    && retries < failure.max_retries() =>
            {
                let max_retries = failure.max_retries();
                retries += 1;
                let delay_ms = retry_delay_ms(retries, failure.retry_after_ms);
                on_event
                    .send(ChatEvent::Retrying {
                        attempt: retries,
                        max_retries,
                        delay_ms,
                        reason: failure.retry_reason().into(),
                    })
                    .map_err(|e| ChatFailure::channel(format!("推送重试状态到界面失败：{e}")))?;
                tokio::select! {
                    _ = cancel.cancelled() => {
                        return Ok(StreamOutcome {
                            text: String::new(),
                            tool_calls: vec![],
                            cancelled: true,
                        });
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => {}
                }
            }
            Err(failure) => return Err(failure.with_retries(retries)),
        }
    }
}

fn permission_description(name: &str, args: &Value) -> String {
    match name {
        "bash" => args
            .get("command")
            .and_then(Value::as_str)
            .map(|c| format!("执行命令：{c}"))
            .unwrap_or_else(|| "执行命令".into()),
        "write_file" => args
            .get("path")
            .and_then(Value::as_str)
            .map(|p| format!("写入文件：{p}"))
            .unwrap_or_else(|| "写入文件".into()),
        "edit_file" => args
            .get("path")
            .and_then(Value::as_str)
            .map(|p| format!("编辑文件：{p}"))
            .unwrap_or_else(|| "编辑文件".into()),
        "device_call" => {
            let device = args
                .get("device_id")
                .and_then(Value::as_str)
                .unwrap_or("未知设备");
            let capability = args
                .get("capability")
                .and_then(Value::as_str)
                .unwrap_or("未知能力");
            format!("在设备 {device} 上调用：{capability}")
        }
        other => format!("调用工具：{other}"),
    }
}

fn builtin_tool_is_exposed(allowed_tools: &[String], name: &str) -> bool {
    allowed_tools.is_empty() || allowed_tools.iter().any(|tool| tool == name)
}

fn agent_transcript(
    system_prompt: &str,
    messages: &[crate::commands::chat::ChatMessage],
) -> Vec<Value> {
    let mut transcript = Vec::with_capacity(messages.len() + 1);
    transcript.push(json!({"role": "system", "content": system_prompt}));
    transcript.extend(
        messages
            .iter()
            .map(|message| json!({"role": message.role, "content": message.content})),
    );
    transcript
}

#[allow(clippy::too_many_arguments)]
async fn compact_messages(
    http: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[crate::commands::chat::ChatMessage],
    automatic: bool,
    estimated_tokens: u64,
    context_window: u64,
    cancel: &CancellationToken,
    on_event: &Channel<ChatEvent>,
) -> Result<Option<String>, ChatFailure> {
    if messages.is_empty() {
        return Err(ChatFailure::message("当前任务还没有可压缩的对话上下文"));
    }
    on_event
        .send(ChatEvent::ContextCompactionStarted {
            automatic,
            estimated_tokens,
            context_window,
        })
        .map_err(|error| ChatFailure::channel(format!("推送上下文压缩状态失败：{error}")))?;

    let transcript = build_compaction_transcript(messages);
    let outcome = stream_with_retries(
        http,
        base_url,
        api_key,
        model,
        &transcript,
        &[],
        None,
        ReasoningEffort::Auto,
        false,
        cancel,
        on_event,
    )
    .await?;
    if outcome.cancelled {
        return Ok(None);
    }
    let summary = truncate_summary(&outcome.text);
    if summary.is_empty() {
        return Err(ChatFailure::message("模型没有生成有效的上下文摘要，请重试"));
    }
    Ok(Some(summary))
}

/// The tool-calling agent loop. Returns `Ok(true)` when cancelled by the user.
#[allow(clippy::too_many_arguments)]
pub async fn run_agent_loop(
    app: &AppHandle,
    http: &reqwest::Client,
    broker: &PermissionBroker,
    mcp_manager: &McpManager,
    request_id: u32,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    model_info: Option<&ModelInfo>,
    reasoning_effort: ReasoningEffort,
    messages: Vec<crate::commands::chat::ChatMessage>,
    env: AgentEnv,
    context_action: ContextAction,
    cancel: &CancellationToken,
    on_event: &Channel<ChatEvent>,
) -> Result<bool, ChatFailure> {
    let turn_started = Instant::now();
    let turn_cancel = cancel.child_token();
    let _turn_guard = CancelOnDrop(turn_cancel.clone());
    let deadline_cancel = turn_cancel.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = deadline_cancel.cancelled() => {}
            _ = tokio::time::sleep(TURN_TIMEOUT) => deadline_cancel.cancel(),
        }
    });

    // MCP is a client-side bridge implemented through native function calling.
    // Unknown and explicitly unsupported models run as plain chat instead of
    // receiving a request body they may reject with HTTP 400.
    let supports_tools =
        model_info.is_some_and(|model| model.has_capability(ModelCapability::ToolCall));
    let mut tool_specs = if supports_tools {
        tools::specs(&env.allowed_tools, &env.available_skills)
    } else {
        Vec::new()
    };
    if supports_tools {
        for cfg in &env.mcp_configs {
            match mcp_manager.list_tools(cfg).await {
                Ok(list) => {
                    for t in list {
                        tool_specs.push(json!({
                            "type": "function",
                            "function": {
                                "name": mcp::namespaced(&cfg.id, &t.name),
                                "description": t.description,
                                "parameters": t.input_schema,
                            }
                        }));
                    }
                }
                // A dead MCP server shouldn't kill the chat; surface in status.
                Err(e) => eprintln!("[mcp] {}: {e}", cfg.name),
            }
        }
    }

    let system_prompt = if supports_tools {
        env.system_prompt.clone()
    } else {
        format!(
            "{}\n\n# 工具限制\n当前模型未声明原生工具调用能力。本轮没有可调用的内置工具或 MCP 工具；不要声称已经读取、执行或修改了本地内容。",
            env.system_prompt
        )
    };
    let context_window = model_info
        .and_then(|model| model.context_window)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW_TOKENS);
    let compact_at_tokens = compaction_threshold(context_window);
    let mut active_messages = messages;
    let mut transcript = agent_transcript(&system_prompt, &active_messages);
    let estimated_tokens = estimate_payload_tokens(&transcript, &tool_specs);

    if context_action == ContextAction::Inspect {
        on_event
            .send(ChatEvent::ContextUsage {
                estimated_tokens,
                context_window,
                compact_at_tokens,
            })
            .map_err(|error| ChatFailure::channel(format!("推送上下文使用情况失败：{error}")))?;
        return Ok(false);
    }

    if context_action == ContextAction::Compact {
        let Some(summary) = compact_messages(
            http,
            base_url,
            api_key,
            model,
            &active_messages,
            false,
            estimated_tokens,
            context_window,
            &turn_cancel,
            on_event,
        )
        .await?
        else {
            return Ok(true);
        };
        active_messages = vec![summary_message(&summary)];
        transcript = agent_transcript(&system_prompt, &active_messages);
        let estimated_tokens_after = estimate_payload_tokens(&transcript, &tool_specs);
        on_event
            .send(ChatEvent::ContextCompacted {
                automatic: false,
                summary,
                estimated_tokens_before: estimated_tokens,
                estimated_tokens_after,
                context_window,
            })
            .map_err(|error| ChatFailure::channel(format!("推送上下文压缩结果失败：{error}")))?;
        return Ok(false);
    }

    if context_action == ContextAction::Chat && should_compact(estimated_tokens, context_window) {
        let current_message = active_messages
            .last()
            .filter(|message| message.role == "user")
            .cloned()
            .ok_or_else(|| ChatFailure::message("上下文已接近上限，但找不到当前用户消息"))?;
        let history = &active_messages[..active_messages.len().saturating_sub(1)];
        if history.is_empty() {
            return Err(ChatFailure::message(format!(
                "本轮输入预计占用 {estimated_tokens} Token，已达到 256K 上下文的 80%，请减少附件或缩短输入"
            )));
        }
        let Some(summary) = compact_messages(
            http,
            base_url,
            api_key,
            model,
            history,
            true,
            estimated_tokens,
            context_window,
            &turn_cancel,
            on_event,
        )
        .await?
        else {
            return Ok(true);
        };
        active_messages = vec![summary_message(&summary), current_message];
        transcript = agent_transcript(&system_prompt, &active_messages);
        let estimated_tokens_after = estimate_payload_tokens(&transcript, &tool_specs);
        if should_compact(estimated_tokens_after, context_window) {
            return Err(ChatFailure::message(format!(
                "压缩后上下文仍预计占用 {estimated_tokens_after} Token，请减少本轮附件或缩短输入"
            )));
        }
        on_event
            .send(ChatEvent::ContextCompacted {
                automatic: true,
                summary,
                estimated_tokens_before: estimated_tokens,
                estimated_tokens_after,
                context_window,
            })
            .map_err(|error| ChatFailure::channel(format!("推送上下文压缩结果失败：{error}")))?;
    }

    let mut last_tool_signature = String::new();
    let mut identical_tool_calls = 0_u8;

    for _ in 0..MAX_ITERATIONS {
        let outcome = stream_with_retries(
            http,
            base_url,
            api_key,
            model,
            &transcript,
            &tool_specs,
            model_info.and_then(ModelInfo::effective_reasoning),
            reasoning_effort,
            true,
            &turn_cancel,
            on_event,
        )
        .await?;
        if outcome.cancelled {
            if cancel.is_cancelled() {
                return Ok(true);
            }
            return Err(ChatFailure::message(
                "任务执行已超过 15 分钟，已停止当前工具和相关进程。请缩小任务范围后继续",
            ));
        }
        if outcome.tool_calls.is_empty() {
            return Ok(false);
        }

        transcript.push(json!({
            "role": "assistant",
            "content": outcome.text,
            "tool_calls": outcome.tool_calls.iter().map(|c| json!({
                "id": c.id,
                "type": "function",
                "function": {"name": c.name, "arguments": c.arguments},
            })).collect::<Vec<_>>(),
        }));

        for call in &outcome.tool_calls {
            if turn_cancel.is_cancelled() {
                if cancel.is_cancelled() {
                    return Ok(true);
                }
                return Err(ChatFailure::message(
                    "任务执行已超过 15 分钟，已停止当前工具和相关进程。请缩小任务范围后继续",
                ));
            }
            let args = call.parsed_args();
            let signature = format!("{}\0{}", call.name, args);
            if signature == last_tool_signature {
                identical_tool_calls = identical_tool_calls.saturating_add(1);
            } else {
                last_tool_signature = signature;
                identical_tool_calls = 1;
            }
            let timeout_ms =
                (call.name == "bash").then(|| tools::bash::effective_timeout_ms(&args));
            on_event
                .send(ChatEvent::ToolCallStart {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    args: args.clone(),
                    timeout_ms,
                })
                .map_err(|e| ChatFailure::channel(format!("推送消息到界面失败：{e}")))?;

            if identical_tool_calls >= MAX_IDENTICAL_TOOL_CALLS {
                let output = format!(
                    "重复调用保护：工具 {} 使用相同参数连续调用了 {} 次，任务已停止。请检查前一次结果或改用其他方法",
                    call.name, identical_tool_calls
                );
                on_event
                    .send(ChatEvent::ToolResult {
                        id: call.id.clone(),
                        output: output.clone(),
                        is_error: true,
                        duration_ms: 0,
                        exit_code: None,
                        timed_out: false,
                        cancelled: false,
                        truncated: false,
                    })
                    .map_err(|e| ChatFailure::channel(format!("推送消息到界面失败：{e}")))?;
                return Err(ChatFailure::message(output));
            }

            // Tool specs are a capability hint to the model, not a security
            // boundary. Reject hallucinated or adversarial builtin calls again
            // at execution time so Work can never invoke Code-only tools.
            if mcp::parse_namespaced(&call.name).is_none()
                && !builtin_tool_is_exposed(&env.allowed_tools, &call.name)
            {
                let output = format!("当前模式未提供工具：{}", call.name);
                on_event
                    .send(ChatEvent::ToolResult {
                        id: call.id.clone(),
                        output: output.clone(),
                        is_error: true,
                        duration_ms: 0,
                        exit_code: None,
                        timed_out: false,
                        cancelled: false,
                        truncated: false,
                    })
                    .map_err(|e| ChatFailure::channel(format!("推送消息到界面失败：{e}")))?;
                transcript.push(json!({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": output,
                }));
                continue;
            }

            // Permission gate.
            let mut allowed = true;
            if !broker.is_session_allowed(request_id, &call.name)
                && needs_approval(env.permission_mode, &call.name, &args, &env.workspace)
            {
                let perm_id = uuid::Uuid::new_v4().to_string();
                let rx = broker.register(&perm_id);
                on_event
                    .send(ChatEvent::PermissionRequest {
                        id: perm_id.clone(),
                        tool: call.name.clone(),
                        description: permission_description(&call.name, &args),
                        args: args.clone(),
                    })
                    .map_err(|e| ChatFailure::channel(format!("推送消息到界面失败：{e}")))?;
                match broker.wait(&perm_id, rx, &turn_cancel).await {
                    Decision::Allow => {}
                    Decision::AllowAlways => broker.allow_for_session(request_id, &call.name),
                    Decision::Deny => allowed = false,
                }
                if turn_cancel.is_cancelled() {
                    if cancel.is_cancelled() {
                        return Ok(true);
                    }
                    return Err(ChatFailure::message(
                        "任务执行已超过 15 分钟，已停止等待操作授权",
                    ));
                }
            }

            let tool_started = Instant::now();
            let (output, is_error, exit_code, timed_out, cancelled, truncated) = if !allowed {
                (
                    "用户拒绝了此操作".to_string(),
                    true,
                    None,
                    false,
                    false,
                    false,
                )
            } else if let Some((server_id, tool)) = mcp::parse_namespaced(&call.name) {
                match env.mcp_configs.iter().find(|c| c.id == server_id) {
                    Some(cfg) => {
                        let call_result = tokio::select! {
                            _ = turn_cancel.cancelled() => None,
                            result = mcp_manager.call_tool(cfg, tool, &args) => Some(result),
                        };
                        match call_result {
                            Some(Ok((out, err))) => {
                                (tools::truncate_output(&out), err, None, false, false, false)
                            }
                            Some(Err(e)) => (e, true, None, false, false, false),
                            None => ("MCP 工具调用已取消".into(), true, None, false, true, false),
                        }
                    }
                    None => (
                        format!("未知的 MCP 服务器：{server_id}"),
                        true,
                        None,
                        false,
                        false,
                        false,
                    ),
                }
            } else {
                let ctx = ToolCtx {
                    app: app.clone(),
                    http: http.clone(),
                    workspace: env.workspace.clone(),
                    available_skills: env.available_skills.clone(),
                    cancel: turn_cancel.clone(),
                    call_id: call.id.clone(),
                    on_event: on_event.clone(),
                };
                match tools::run(&call.name, &args, &ctx).await {
                    Ok(result) => (
                        result.output,
                        result.is_error,
                        result.exit_code,
                        result.timed_out,
                        result.cancelled,
                        result.truncated,
                    ),
                    Err(e) => (e, true, None, false, false, false),
                }
            };
            let duration_ms = tool_started.elapsed().as_millis() as u64;

            on_event
                .send(ChatEvent::ToolResult {
                    id: call.id.clone(),
                    output: output.clone(),
                    is_error,
                    duration_ms,
                    exit_code,
                    timed_out,
                    cancelled,
                    truncated,
                })
                .map_err(|e| ChatFailure::channel(format!("推送消息到界面失败：{e}")))?;

            transcript.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": output,
            }));

            if cancelled && turn_started.elapsed() >= TURN_TIMEOUT && !cancel.is_cancelled() {
                return Err(ChatFailure::message(
                    "任务执行已超过 15 分钟，已停止当前工具和相关进程。请缩小任务范围后继续",
                ));
            }
        }
    }
    Err(ChatFailure::message(format!(
        "已达到最大工具调用轮数（{MAX_ITERATIONS}），请新建任务继续"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(
        index: Option<u32>,
        id: Option<&str>,
        name: Option<&str>,
        args: Option<&str>,
    ) -> ToolCallDelta {
        ToolCallDelta {
            index,
            id: id.map(Into::into),
            function: Some(FunctionDelta {
                name: name.map(Into::into),
                arguments: args.map(Into::into),
            }),
        }
    }

    fn usage(json: &str) -> StreamUsage {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn cached_tokens_reads_openai_and_deepseek_shapes() {
        // OpenAI-standard nested shape.
        assert_eq!(
            usage(r#"{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":40}}"#)
                .cached_tokens(),
            40
        );
        // DeepSeek flat shape.
        assert_eq!(
            usage(r#"{"prompt_tokens":100,"prompt_cache_hit_tokens":24}"#).cached_tokens(),
            24
        );
        // Neither reported → 0, and a zero nested value doesn't mask nothing.
        assert_eq!(usage(r#"{"prompt_tokens":100}"#).cached_tokens(), 0);
        assert_eq!(
            usage(r#"{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":0}}"#)
                .cached_tokens(),
            0
        );
    }

    #[test]
    fn accumulator_joins_fragmented_arguments() {
        let mut acc = ToolCallAccumulator::default();
        acc.push(delta(
            Some(0),
            Some("call_a"),
            Some("read_file"),
            Some("{\"pa"),
        ));
        acc.push(delta(Some(0), None, None, Some("th\":\"a.txt\"}")));
        let calls = acc.finish();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].arguments, "{\"path\":\"a.txt\"}");
        assert_eq!(calls[0].parsed_args()["path"], "a.txt");
    }

    #[test]
    fn accumulator_handles_multiple_and_single_chunk_calls() {
        let mut acc = ToolCallAccumulator::default();
        acc.push(delta(Some(0), Some("a"), Some("t1"), Some("{}")));
        acc.push(delta(Some(1), Some("b"), Some("t2"), Some("{\"x\":1}")));
        let calls = acc.finish();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].name, "t2");
    }

    #[test]
    fn accumulator_synthesizes_missing_index_and_id() {
        let mut acc = ToolCallAccumulator::default();
        acc.push(delta(None, Some("x"), Some("t1"), Some("{}")));
        acc.push(delta(None, Some("y"), Some("t2"), Some("{}")));
        let calls = acc.finish();
        assert_eq!(calls.len(), 2);

        let mut acc = ToolCallAccumulator::default();
        acc.push(delta(Some(0), None, Some("t"), Some("{}")));
        let calls = acc.finish();
        assert_eq!(calls[0].id, "call_0");
    }

    #[test]
    fn accumulator_drops_nameless_noise() {
        let mut acc = ToolCallAccumulator::default();
        acc.push(delta(Some(0), None, None, Some("junk")));
        assert!(acc.finish().is_empty());
    }

    #[test]
    fn execution_rechecks_mode_tool_exposure() {
        let work_tools = vec!["read_file".to_string(), "fetch".to_string()];
        assert!(builtin_tool_is_exposed(&work_tools, "read_file"));
        assert!(!builtin_tool_is_exposed(&work_tools, "bash"));
        assert!(builtin_tool_is_exposed(&[], "bash"));
    }

    fn adjustable_reasoning(transport: ReasoningTransport) -> ReasoningProfile {
        ReasoningProfile {
            mode: ReasoningMode::Effort,
            supported_efforts: vec![ReasoningEffort::Low, ReasoningEffort::High],
            default_effort: Some(ReasoningEffort::High),
            transport,
        }
    }

    #[test]
    fn reasoning_effort_is_added_only_when_supported() {
        let mut body = json!({"model": "test"});
        apply_reasoning(
            &mut body,
            Some(&adjustable_reasoning(
                ReasoningTransport::OpenaiReasoningEffort,
            )),
            ReasoningEffort::High,
        );
        assert_eq!(body["reasoning_effort"], "high");

        let mut unsupported = json!({"model": "test"});
        apply_reasoning(
            &mut unsupported,
            Some(&adjustable_reasoning(
                ReasoningTransport::OpenaiReasoningEffort,
            )),
            ReasoningEffort::Medium,
        );
        assert!(unsupported.get("reasoning_effort").is_none());
    }

    #[test]
    fn auto_reasoning_leaves_provider_default_untouched() {
        let mut body = json!({"model": "test"});
        apply_reasoning(
            &mut body,
            Some(&adjustable_reasoning(
                ReasoningTransport::OpenrouterReasoning,
            )),
            ReasoningEffort::Auto,
        );
        assert!(body.get("reasoning").is_none());
    }
}
