use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use super::context::{
    build_compaction_transcript, build_execution_compaction_transcript, compaction_threshold,
    estimate_payload_tokens, should_compact, summary_message, truncate_summary, ContextAction,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
};
use super::events::{ChatEvent, ChatEventEmitter};
use super::failure::ChatFailure;
use crate::commands::models::{
    ModelCapability, ModelInfo, ModelWireApi, ReasoningEffort, ReasoningMode, ReasoningProfile,
    ReasoningTransport,
};
use crate::mcp::{self, McpManager, McpServerConfig};
use crate::permission::{needs_approval, Decision, PermissionBroker, PermissionMode};
use crate::tools::{self, ToolCtx};

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

#[cfg(test)]
use serde::Deserialize;
#[cfg(test)]
use std::collections::BTreeMap;

#[cfg(test)]
#[derive(Deserialize)]
struct StreamUsage {
    /// OpenAI-standard cache reporting: `prompt_tokens_details.cached_tokens`.
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
    /// DeepSeek-style cache reporting: cache-hit prompt tokens.
    #[serde(default)]
    prompt_cache_hit_tokens: Option<u64>,
}

#[cfg(test)]
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

#[cfg(test)]
#[derive(Deserialize)]
struct PromptTokensDetails {
    #[serde(default)]
    cached_tokens: u64,
}

#[cfg(test)]
#[derive(Deserialize)]
struct ToolCallDelta {
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[cfg(test)]
#[derive(Deserialize, Default)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

/// Accumulates streamed tool-call deltas keyed by index. Handles both
/// fragmented arguments (OpenAI) and whole-call-in-one-delta relays.
#[cfg(test)]
#[derive(Default)]
pub struct ToolCallAccumulator {
    calls: BTreeMap<u32, ToolCall>,
    next_implicit_index: u32,
}

#[cfg(test)]
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
    wire_api: ModelWireApi,
    transcript: &[Value],
    tools: &[Value],
    reasoning: Option<&ReasoningProfile>,
    reasoning_effort: ReasoningEffort,
    emit_output_events: bool,
    cancel: &CancellationToken,
    on_event: &ChatEventEmitter,
) -> Result<StreamOutcome, ChatFailure> {
    let (instructions, input) = chat_transcript_to_responses(transcript);
    let mut request = tietiezhi_agent_model::ResponsesApiRequest::text(model, input);
    request.instructions = instructions;
    request.tools = (!tools.is_empty()).then(|| chat_tools_to_responses(tools));
    request.reasoning = effective_reasoning_effort(reasoning, reasoning_effort).map(|effort| {
        tietiezhi_agent_model::Reasoning {
            effort: Some(effort),
            summary: Some("auto".into()),
            context: None,
        }
    });
    let canonical_base_url = crate::commands::api_url(base_url, "");
    let provider = tietiezhi_agent_model::Provider::openai_compatible(
        "companion",
        canonical_base_url,
        api_key.map(str::to_owned),
    )
    .with_wire_api(agent_model_wire_api(wire_api))
    .with_reasoning_wire_format(agent_model_reasoning_wire_format(
        reasoning
            .map(|profile| profile.transport_for_wire_api(wire_api))
            .unwrap_or(ReasoningTransport::None),
    ));
    let client = tietiezhi_agent_model::ResponsesClient::new(http.clone(), provider);
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    let mut output_started = false;
    let mut retries = 0;
    let result = {
        let stream = client.stream(&request, |event| {
            match event {
                tietiezhi_agent_model::ResponseEvent::OutputTextDelta(content) => {
                    output_started = true;
                    text.push_str(&content);
                    if emit_output_events {
                        on_event
                            .send(ChatEvent::Delta { content })
                            .map_err(|error| {
                                tietiezhi_agent_model::ModelError::Consumer(error.to_string())
                            })?;
                    }
                }
                tietiezhi_agent_model::ResponseEvent::ReasoningContentDelta {
                    delta: content,
                    ..
                }
                | tietiezhi_agent_model::ResponseEvent::ReasoningSummaryDelta {
                    delta: content,
                    ..
                } => {
                    output_started = true;
                    if emit_output_events {
                        on_event
                            .send(ChatEvent::Reasoning { content })
                            .map_err(|error| {
                                tietiezhi_agent_model::ModelError::Consumer(error.to_string())
                            })?;
                    }
                }
                tietiezhi_agent_model::ResponseEvent::OutputItemDone(item) => {
                    if let Some(call) = response_item_tool_call(&item) {
                        output_started = true;
                        tool_calls.push(call);
                    }
                }
                tietiezhi_agent_model::ResponseEvent::Completed {
                    token_usage: Some(usage),
                    ..
                } if emit_output_events => {
                    on_event
                        .send(ChatEvent::Usage {
                            prompt_tokens: usage.input_tokens.max(0) as u64,
                            completion_tokens: usage.output_tokens.max(0) as u64,
                            total_tokens: usage.total_tokens.max(0) as u64,
                            cached_tokens: usage.cached_input_tokens.max(0) as u64,
                        })
                        .map_err(|error| {
                            tietiezhi_agent_model::ModelError::Consumer(error.to_string())
                        })?;
                }
                tietiezhi_agent_model::ResponseEvent::Retrying { attempt, .. } => {
                    retries = attempt.min(u64::from(u8::MAX)) as u8;
                    if emit_output_events {
                        on_event
                            .send(ChatEvent::Retrying {
                                attempt: retries,
                                max_retries: 1,
                                delay_ms: 0,
                                reason: "模型传输暂时不可用".into(),
                            })
                            .map_err(|error| {
                                tietiezhi_agent_model::ModelError::Consumer(error.to_string())
                            })?;
                    }
                }
                _ => {}
            }
            Ok(())
        });
        tokio::pin!(stream);
        tokio::select! {
            _ = cancel.cancelled() => None,
            result = &mut stream => Some(result),
        }
    };
    let Some(result) = result else {
        return Ok(StreamOutcome {
            text,
            tool_calls: vec![],
            cancelled: true,
        });
    };
    result.map_err(|error| {
        let mut failure = model_error_to_chat_failure(error, output_started);
        failure.retries = retries;
        failure
    })?;

    Ok(StreamOutcome {
        text,
        tool_calls,
        cancelled: false,
    })
}

fn agent_model_wire_api(wire_api: ModelWireApi) -> tietiezhi_agent_model::WireApi {
    match wire_api {
        ModelWireApi::Auto | ModelWireApi::Responses => tietiezhi_agent_model::WireApi::Responses,
        ModelWireApi::ChatCompletions => tietiezhi_agent_model::WireApi::ChatCompletions,
        ModelWireApi::AnthropicMessages => tietiezhi_agent_model::WireApi::AnthropicMessages,
        ModelWireApi::GeminiGenerateContent => {
            tietiezhi_agent_model::WireApi::GeminiGenerateContent
        }
    }
}

fn agent_model_reasoning_wire_format(
    transport: ReasoningTransport,
) -> tietiezhi_agent_model::ReasoningWireFormat {
    match transport {
        ReasoningTransport::None => tietiezhi_agent_model::ReasoningWireFormat::Auto,
        ReasoningTransport::ResponsesReasoning => {
            tietiezhi_agent_model::ReasoningWireFormat::ResponsesReasoning
        }
        ReasoningTransport::OpenaiReasoningEffort => {
            tietiezhi_agent_model::ReasoningWireFormat::ChatReasoningEffort
        }
        ReasoningTransport::OpenrouterReasoning => {
            tietiezhi_agent_model::ReasoningWireFormat::OpenRouterReasoning
        }
        ReasoningTransport::EnableThinking => {
            tietiezhi_agent_model::ReasoningWireFormat::EnableThinking
        }
        ReasoningTransport::AnthropicAdaptive => {
            tietiezhi_agent_model::ReasoningWireFormat::AnthropicAdaptive
        }
        ReasoningTransport::AnthropicThinkingBudget => {
            tietiezhi_agent_model::ReasoningWireFormat::AnthropicThinkingBudget
        }
        ReasoningTransport::GeminiThinkingLevel => {
            tietiezhi_agent_model::ReasoningWireFormat::GeminiThinkingLevel
        }
        ReasoningTransport::GeminiThinkingBudget => {
            tietiezhi_agent_model::ReasoningWireFormat::GeminiThinkingBudget
        }
    }
}

fn chat_transcript_to_responses(transcript: &[Value]) -> (String, Vec<Value>) {
    let mut instructions = Vec::new();
    let mut input = Vec::new();
    for message in transcript {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        if role == "system" {
            if let Some(text) = message.get("content").and_then(Value::as_str) {
                instructions.push(text.to_owned());
            }
            continue;
        }
        if role == "tool" {
            input.push(json!({
                "type":"function_call_output",
                "call_id":message.get("tool_call_id").cloned().unwrap_or(Value::Null),
                "output":message.get("content").cloned().unwrap_or(Value::Null)
            }));
            continue;
        }
        let content = chat_content_to_responses(role, message.get("content"));
        if !content.is_empty() {
            input.push(json!({"type":"message","role":role,"content":content}));
        }
        for call in message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            input.push(json!({
                "type":"function_call",
                "call_id":call.get("id").cloned().unwrap_or(Value::Null),
                "name":call.pointer("/function/name").cloned().unwrap_or(Value::Null),
                "arguments":call.pointer("/function/arguments").cloned().unwrap_or_else(|| json!("{}"))
            }));
        }
    }
    (instructions.join("\n\n"), input)
}

fn chat_content_to_responses(role: &str, content: Option<&Value>) -> Vec<Value> {
    let output_type = if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    };
    match content {
        Some(Value::String(text)) if !text.is_empty() => {
            vec![json!({"type":output_type,"text":text})]
        }
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                Some("text" | "input_text" | "output_text") => Some(json!({
                    "type":output_type,
                    "text":part.get("text").and_then(Value::as_str).unwrap_or("")
                })),
                Some("image_url" | "input_image") => Some(json!({
                    "type":"input_image",
                    "image_url":part.pointer("/image_url/url")
                        .or_else(|| part.get("image_url"))
                        .cloned()
                        .unwrap_or(Value::Null)
                })),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn chat_tools_to_responses(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            let function = tool.get("function").unwrap_or(tool);
            let name = function.get("name")?.clone();
            Some(json!({
                "type":"function",
                "name":name,
                "description":function.get("description").cloned().unwrap_or_else(|| json!("")),
                "parameters":function.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object"})),
                "strict":false
            }))
        })
        .collect()
}

fn effective_reasoning_effort(
    profile: Option<&ReasoningProfile>,
    selected: ReasoningEffort,
) -> Option<String> {
    let profile = profile?;
    if profile.mode == ReasoningMode::Fixed {
        return None;
    }
    let effort = if selected == ReasoningEffort::Auto {
        profile.default_effort?
    } else {
        selected
    };
    if !profile.supported_efforts.is_empty() && !profile.supported_efforts.contains(&effort) {
        return profile
            .default_effort
            .filter(|default| profile.supported_efforts.contains(default))
            .and_then(ReasoningEffort::as_wire_value)
            .map(str::to_owned);
    }
    effort.as_wire_value().map(str::to_owned)
}

fn response_item_tool_call(item: &Value) -> Option<ToolCall> {
    let kind = item.get("type").and_then(Value::as_str)?;
    let id = item.get("call_id").and_then(Value::as_str)?.to_owned();
    let name = item.get("name").and_then(Value::as_str)?.to_owned();
    match kind {
        "function_call" => Some(ToolCall {
            id,
            name,
            arguments: item
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}")
                .to_owned(),
        }),
        "custom_tool_call" => Some(ToolCall {
            id,
            name,
            arguments: json!({
                "input":item.get("input").and_then(Value::as_str).unwrap_or("")
            })
            .to_string(),
        }),
        _ => None,
    }
}

fn model_error_to_chat_failure(
    error: tietiezhi_agent_model::ModelError,
    output_started: bool,
) -> ChatFailure {
    let mut failure = match error {
        tietiezhi_agent_model::ModelError::Api { status, message } => {
            let status =
                reqwest::StatusCode::from_u16(status).unwrap_or(reqwest::StatusCode::BAD_GATEWAY);
            ChatFailure::http(status, json!({"error":{"message":message}}).to_string())
        }
        tietiezhi_agent_model::ModelError::Unauthorized { message } => ChatFailure::http(
            reqwest::StatusCode::UNAUTHORIZED,
            json!({"error":{"message":message}}).to_string(),
        ),
        tietiezhi_agent_model::ModelError::Transport(message)
        | tietiezhi_agent_model::ModelError::Stream(message) => {
            ChatFailure::transport(message, output_started)
        }
        other => ChatFailure::message(other.to_string()),
    };
    failure.output_started = output_started;
    failure
}

#[cfg(test)]
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
        ReasoningTransport::ResponsesReasoning => {
            if let Some(value) = selected.as_wire_value() {
                body["reasoning"] = json!({"effort": value});
            }
        }
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
        ReasoningTransport::AnthropicAdaptive => {
            if let Some(value) = selected.as_wire_value() {
                body["output_config"] = json!({"effort":value});
                body["thinking"] = json!({"type":"adaptive"});
            }
        }
        ReasoningTransport::AnthropicThinkingBudget => {
            body["thinking"] = json!({"type":"enabled"});
        }
        ReasoningTransport::GeminiThinkingLevel => {
            if let Some(value) = selected.as_wire_value() {
                body["generationConfig"] =
                    json!({"thinkingConfig":{"thinkingLevel":value,"includeThoughts":true}});
            }
        }
        ReasoningTransport::GeminiThinkingBudget => {
            body["generationConfig"] =
                json!({"thinkingConfig":{"includeThoughts":selected != ReasoningEffort::Off}});
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_with_retries(
    http: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    wire_api: ModelWireApi,
    transcript: &[Value],
    tools: &[Value],
    reasoning: Option<&ReasoningProfile>,
    reasoning_effort: ReasoningEffort,
    emit_output_events: bool,
    cancel: &CancellationToken,
    on_event: &ChatEventEmitter,
) -> Result<StreamOutcome, ChatFailure> {
    stream_once(
        http,
        base_url,
        api_key,
        model,
        wire_api,
        transcript,
        tools,
        reasoning,
        reasoning_effort,
        emit_output_events,
        cancel,
        on_event,
    )
    .await
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
        "fetch" => args
            .get("url")
            .and_then(Value::as_str)
            .map(|url| format!("访问网络：{url}"))
            .unwrap_or_else(|| "访问网络".into()),
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
    wire_api: ModelWireApi,
    messages: &[crate::commands::chat::ChatMessage],
    automatic: bool,
    estimated_tokens: u64,
    context_window: u64,
    cancel: &CancellationToken,
    on_event: &ChatEventEmitter,
) -> Result<Option<String>, ChatFailure> {
    if messages.is_empty() {
        return Err(ChatFailure::message("当前任务还没有可压缩的对话上下文"));
    }
    let transcript = build_compaction_transcript(messages);
    compact_transcript(
        http,
        base_url,
        api_key,
        model,
        wire_api,
        &transcript,
        automatic,
        estimated_tokens,
        context_window,
        cancel,
        on_event,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn compact_transcript(
    http: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    wire_api: ModelWireApi,
    transcript: &[Value],
    automatic: bool,
    estimated_tokens: u64,
    context_window: u64,
    cancel: &CancellationToken,
    on_event: &ChatEventEmitter,
) -> Result<Option<String>, ChatFailure> {
    on_event
        .send(ChatEvent::ContextCompactionStarted {
            automatic,
            estimated_tokens,
            context_window,
        })
        .map_err(|error| ChatFailure::channel(format!("推送上下文压缩状态失败：{error}")))?;

    let outcome = stream_with_retries(
        http,
        base_url,
        api_key,
        model,
        wire_api,
        transcript,
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

/// Legacy companion-only loop. Workspace Work/Code turns use Codex Runtime.
#[allow(clippy::too_many_arguments)]
pub async fn run_companion_loop(
    app: &AppHandle,
    http: &reqwest::Client,
    broker: &PermissionBroker,
    mcp_manager: &McpManager,
    request_id: u32,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    wire_api: ModelWireApi,
    model_info: Option<&ModelInfo>,
    reasoning_effort: ReasoningEffort,
    messages: Vec<crate::commands::chat::ChatMessage>,
    env: AgentEnv,
    context_action: ContextAction,
    cancel: &CancellationToken,
    on_event: &ChatEventEmitter,
) -> Result<bool, ChatFailure> {
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
            wire_api,
            &active_messages,
            false,
            estimated_tokens,
            context_window,
            cancel,
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
                during_turn: false,
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
            wire_api,
            history,
            true,
            estimated_tokens,
            context_window,
            cancel,
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
                during_turn: false,
                summary,
                estimated_tokens_before: estimated_tokens,
                estimated_tokens_after,
                context_window,
            })
            .map_err(|error| ChatFailure::channel(format!("推送上下文压缩结果失败：{error}")))?;
    }

    loop {
        if context_action == ContextAction::Chat {
            let estimated_tokens = estimate_payload_tokens(&transcript, &tool_specs);
            if should_compact(estimated_tokens, context_window) {
                let compaction_transcript = build_execution_compaction_transcript(&transcript);
                let Some(summary) = compact_transcript(
                    http,
                    base_url,
                    api_key,
                    model,
                    wire_api,
                    &compaction_transcript,
                    true,
                    estimated_tokens,
                    context_window,
                    cancel,
                    on_event,
                )
                .await?
                else {
                    return Ok(true);
                };
                transcript = agent_transcript(&system_prompt, &[summary_message(&summary)]);
                let estimated_tokens_after = estimate_payload_tokens(&transcript, &tool_specs);
                if should_compact(estimated_tokens_after, context_window) {
                    return Err(ChatFailure::message(format!(
                        "整理执行上下文后仍预计占用 {estimated_tokens_after} Token，请减少工具或 MCP 定义"
                    )));
                }
                on_event
                    .send(ChatEvent::ContextCompacted {
                        automatic: true,
                        during_turn: true,
                        summary,
                        estimated_tokens_before: estimated_tokens,
                        estimated_tokens_after,
                        context_window,
                    })
                    .map_err(|error| {
                        ChatFailure::channel(format!("推送执行上下文整理结果失败：{error}"))
                    })?;
            }
        }

        let outcome = stream_with_retries(
            http,
            base_url,
            api_key,
            model,
            wire_api,
            &transcript,
            &tool_specs,
            model_info.and_then(ModelInfo::effective_reasoning),
            reasoning_effort,
            true,
            cancel,
            on_event,
        )
        .await?;
        if outcome.cancelled {
            return Ok(true);
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
            if cancel.is_cancelled() {
                return Ok(true);
            }
            let args = call.parsed_args();
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
            let scope = crate::permission::approval_scope(&call.name, &args);
            if !broker.is_session_allowed(request_id, &scope.key)
                && needs_approval(env.permission_mode, &call.name)
            {
                let perm_id = uuid::Uuid::new_v4().to_string();
                let rx = broker.register(&perm_id);
                on_event
                    .send(ChatEvent::PermissionRequest {
                        id: perm_id.clone(),
                        tool: call.name.clone(),
                        description: permission_description(&call.name, &args),
                        scope: scope.label.clone(),
                        args: args.clone(),
                    })
                    .map_err(|e| ChatFailure::channel(format!("推送消息到界面失败：{e}")))?;
                match broker.wait(&perm_id, rx, cancel).await {
                    Decision::Accept => {}
                    Decision::AcceptForSession => broker.allow_for_session(request_id, &scope.key),
                    Decision::Decline => allowed = false,
                    Decision::Cancel => return Ok(true),
                }
                if cancel.is_cancelled() {
                    return Ok(true);
                }
            }

            let tool_started = std::time::Instant::now();
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
                            _ = cancel.cancelled() => None,
                            result = mcp_manager.call_tool(cfg, tool, &args) => Some(result),
                        };
                        match call_result {
                            Some(Ok((out, err))) => {
                                let output =
                                    crate::commands::tietiezhi::redact_tietiezhi_secret_values(
                                        app, &out,
                                    );
                                (
                                    tools::truncate_output(&output),
                                    err,
                                    None,
                                    false,
                                    false,
                                    false,
                                )
                            }
                            Some(Err(error)) => (
                                crate::commands::tietiezhi::redact_tietiezhi_secret_values(
                                    app, &error,
                                ),
                                true,
                                None,
                                false,
                                false,
                                false,
                            ),
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
                    cancel: cancel.clone(),
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

            if cancelled && cancel.is_cancelled() {
                return Ok(true);
            }
        }
    }
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
            protocol_transports: Default::default(),
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
