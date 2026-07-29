use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use serde_json::{Value, json};
use tokio::time::timeout;
use uuid::Uuid;

#[cfg(test)]
use super::Reasoning;
use super::{
    ModelError, Provider, ReasoningWireFormat, ResponseEvent, ResponsesApiRequest, SseDecoder,
    TokenUsage, WireApi,
};

/// Tags for the opaque reasoning blob stored on the canonical reasoning item's
/// `encrypted_content`. The tag records which wire produced the blob so it is
/// only ever replayed back to that same wire.
const ANTHROPIC_THINKING_SIGNATURE: &str = "anthropic_thinking_signature";
const ANTHROPIC_REDACTED_THINKING: &str = "anthropic_redacted_thinking";
const GEMINI_THOUGHT_SIGNATURE: &str = "gemini_thought_signature";

/// Lowest output ceiling among the Claude models that support extended
/// thinking (Opus 4.x). Used to clamp `max_tokens` until the model registry
/// carries a real per-model value.
const ANTHROPIC_MAX_OUTPUT_TOKENS: i64 = 32_000;
/// Room reserved for visible output on top of the thinking budget, and the
/// `max_tokens` used when thinking is off.
const ANTHROPIC_OUTPUT_HEADROOM: i64 = 8_192;

pub(crate) struct WireRequest {
    pub url: String,
    pub accept: &'static str,
    pub body: Value,
    pub headers: Vec<(&'static str, String)>,
}

pub(crate) fn build_wire_request(
    provider: &Provider,
    wire_api: WireApi,
    request: &ResponsesApiRequest,
) -> Result<WireRequest, ModelError> {
    match wire_api {
        WireApi::Responses => Ok(WireRequest {
            url: provider.url_for_path("responses"),
            accept: "text/event-stream",
            body: serde_json::to_value(request).map_err(|error| ModelError::InvalidRequest {
                message: error.to_string(),
            })?,
            headers: Vec::new(),
        }),
        WireApi::ChatCompletions => Ok(WireRequest {
            url: provider.url_for_path("chat/completions"),
            accept: "text/event-stream",
            body: build_chat_request(request, provider.reasoning_wire_format),
            headers: Vec::new(),
        }),
        WireApi::AnthropicMessages => Ok(WireRequest {
            url: provider.url_for_path("messages"),
            accept: "text/event-stream",
            body: build_anthropic_request(request, provider.reasoning_wire_format),
            headers: vec![("anthropic-version", "2023-06-01".into())],
        }),
        WireApi::GeminiGenerateContent => Ok(WireRequest {
            url: gemini_stream_url(provider, &request.model),
            accept: "text/event-stream",
            body: build_gemini_request(request, provider.reasoning_wire_format),
            headers: Vec::new(),
        }),
    }
}

pub(crate) async fn consume_compatible_stream<F>(
    response: reqwest::Response,
    wire_api: WireApi,
    request: &ResponsesApiRequest,
    idle_timeout: Duration,
    on_event: &mut F,
) -> Result<(), ModelError>
where
    F: FnMut(ResponseEvent) -> Result<(), ModelError>,
{
    let headers = response.headers().clone();
    let mut state = CompatibleState::new(request);
    on_event(ResponseEvent::Created)?;
    if let Some(model) = header_string(&headers, "openai-model") {
        state.emit_model(model, on_event)?;
    }

    let content_type = header_string(&headers, "content-type").unwrap_or_default();
    if !content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
    {
        let value = response
            .json::<Value>()
            .await
            .map_err(|error| ModelError::Stream(format!("invalid JSON response: {error}")))?;
        process_compatible_value(wire_api, None, value, &mut state, on_event)?;
        state.finish(on_event)?;
        return Ok(());
    }

    let mut bytes = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    // Third-party gateways interleave heartbeats, comments and vendor-specific
    // frames that are not valid protocol JSON. Skip them like the native
    // Responses path does instead of failing the whole turn, and keep a count
    // so a stream that never completes can report why.
    let mut skipped_frames = 0usize;
    while let Some(chunk) = timeout(idle_timeout, bytes.next())
        .await
        .map_err(|_| ModelError::Stream("idle timeout waiting for SSE".into()))?
    {
        let chunk = chunk.map_err(|error| ModelError::Stream(error.to_string()))?;
        decoder.push(&chunk);
        while let Some(frame) = decoder.next_frame()? {
            if frame.data.is_empty() {
                continue;
            }
            if frame.data == "[DONE]" {
                state.finish(on_event)?;
                return Ok(());
            }
            let Ok(value) = serde_json::from_str::<Value>(&frame.data) else {
                skipped_frames += 1;
                continue;
            };
            if process_compatible_value(
                wire_api,
                frame.event.as_deref(),
                value,
                &mut state,
                on_event,
            )? {
                return Ok(());
            }
        }
    }
    if state.finished {
        Ok(())
    } else if skipped_frames > 0 {
        Err(ModelError::Stream(format!(
            "stream closed before protocol completion ({skipped_frames} unparsable frames skipped)"
        )))
    } else {
        Err(ModelError::Stream(
            "stream closed before protocol completion".into(),
        ))
    }
}

fn process_compatible_value<F>(
    wire_api: WireApi,
    event_name: Option<&str>,
    value: Value,
    state: &mut CompatibleState,
    on_event: &mut F,
) -> Result<bool, ModelError>
where
    F: FnMut(ResponseEvent) -> Result<(), ModelError>,
{
    if let Some(error) = value.get("error") {
        return Err(ModelError::Api {
            status: 500,
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("upstream stream error")
                .to_owned(),
        });
    }
    match wire_api {
        WireApi::ChatCompletions => process_chat_chunk(&value, state, on_event),
        WireApi::AnthropicMessages => process_anthropic_event(event_name, &value, state, on_event),
        WireApi::GeminiGenerateContent => process_gemini_chunk(&value, state, on_event),
        WireApi::Responses => Ok(false),
    }
}

fn build_chat_request(request: &ResponsesApiRequest, format: ReasoningWireFormat) -> Value {
    let mut messages = Vec::new();
    if !request.instructions.trim().is_empty() {
        messages.push(json!({"role":"system","content":request.instructions}));
    }
    messages.extend(canonical_to_chat_messages(&request.input));
    let (tools, _) = compatible_tools(request.tools.as_deref());
    let mut body = json!({
        "model":request.model,
        "messages":messages,
        "stream":true,
        "stream_options":{"include_usage":true},
        "parallel_tool_calls":request.parallel_tool_calls
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools
                .into_iter()
                .map(|tool| json!({"type":"function","function":tool.declaration}))
                .collect(),
        );
        body["tool_choice"] = json!(request.tool_choice);
    }
    if let Some(effort) = request
        .reasoning
        .as_ref()
        .and_then(|reasoning| reasoning.effort.as_deref())
    {
        match format {
            ReasoningWireFormat::OpenRouterReasoning => {
                body["reasoning"] = json!({"effort":effort});
            }
            ReasoningWireFormat::EnableThinking => {
                body["enable_thinking"] = json!(effort != "none" && effort != "off");
            }
            _ => {
                body["reasoning_effort"] = json!(effort);
            }
        }
    }
    if let Some(text) = &request.text
        && let Some(format) = &text.format
    {
        body["response_format"] = json!({
            "type":"json_schema",
            "json_schema":{
                "name":format.name,
                "strict":format.strict,
                "schema":format.schema
            }
        });
    }
    body
}

fn canonical_to_chat_messages(input: &[Value]) -> Vec<Value> {
    let mut messages = Vec::new();
    for item in input {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                let content = canonical_content_to_openai(item.get("content"));
                messages.push(json!({"role":role,"content":content}));
            }
            Some("function_call" | "custom_tool_call" | "tool_search_call") => {
                let call_id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("call");
                let name = canonical_wire_tool_name(item);
                let arguments = canonical_tool_arguments(item);
                messages.push(json!({
                    "role":"assistant",
                    "content":Value::Null,
                    "tool_calls":[{
                        "id":call_id,
                        "type":"function",
                        "function":{"name":name,"arguments":arguments}
                    }]
                }));
            }
            Some("function_call_output" | "custom_tool_call_output") => {
                messages.push(json!({
                    "role":"tool",
                    "tool_call_id":item.get("call_id").cloned().unwrap_or(Value::Null),
                    "content":model_output_text(item.get("output"))
                }));
            }
            _ => {}
        }
    }
    messages
}

fn canonical_content_to_openai(content: Option<&Value>) -> Value {
    let Some(parts) = content.and_then(Value::as_array) else {
        return content.cloned().unwrap_or(Value::String(String::new()));
    };
    let mut out = Vec::new();
    for part in parts {
        match part.get("type").and_then(Value::as_str) {
            Some("input_text" | "output_text" | "text") => out.push(json!({
                "type":"text",
                "text":part.get("text").and_then(Value::as_str).unwrap_or("")
            })),
            Some("input_image" | "image") => {
                if let Some(url) = part
                    .get("image_url")
                    .or_else(|| part.get("url"))
                    .and_then(Value::as_str)
                {
                    out.push(json!({"type":"image_url","image_url":{"url":url}}));
                }
            }
            _ => {}
        }
    }
    Value::Array(out)
}

/// Append content blocks to `messages`, merging into the previous entry when it
/// carries the same role. Anthropic rejects consecutive same-role messages, and
/// a single assistant turn routinely spans a thinking block, text and one or
/// more tool_use blocks.
fn push_anthropic_blocks(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut()
        && last.get("role").and_then(Value::as_str) == Some(role)
        && let Some(content) = last.get_mut("content").and_then(Value::as_array_mut)
    {
        content.extend(blocks);
        return;
    }
    messages.push(json!({ "role": role, "content": Value::Array(blocks) }));
}

/// Rebuild the provider's own thinking block from a canonical reasoning item.
///
/// Anthropic validates the signature against the thinking text, so a block is
/// only replayed when the blob came from this same wire. Reasoning captured on
/// another wire (or with no signature at all) is dropped rather than sent —
/// an unsigned thinking block is a hard 400.
fn canonical_reasoning_to_anthropic(item: &Value) -> Option<Value> {
    let signature = item.get("encrypted_content").and_then(Value::as_str)?;
    if signature.is_empty() {
        return None;
    }
    match item.get("encrypted_content_format").and_then(Value::as_str) {
        Some(ANTHROPIC_REDACTED_THINKING) => {
            Some(json!({"type":"redacted_thinking","data":signature}))
        }
        Some(ANTHROPIC_THINKING_SIGNATURE) => Some(json!({
            "type":"thinking",
            "thinking":canonical_reasoning_text(item),
            "signature":signature
        })),
        _ => None,
    }
}

/// Concatenate the text of a canonical reasoning item's `content` parts.
fn canonical_reasoning_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| part.as_str())
                })
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn build_anthropic_request(request: &ResponsesApiRequest, format: ReasoningWireFormat) -> Value {
    let mut messages = Vec::new();
    for item in &request.input {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                let role = match item.get("role").and_then(Value::as_str) {
                    Some("assistant") => "assistant",
                    _ => "user",
                };
                let blocks = canonical_content_to_anthropic(item.get("content"));
                push_anthropic_blocks(&mut messages, role, blocks);
            }
            Some("reasoning") => {
                if let Some(block) = canonical_reasoning_to_anthropic(item) {
                    push_anthropic_blocks(&mut messages, "assistant", vec![block]);
                }
            }
            Some("function_call" | "custom_tool_call" | "tool_search_call") => {
                push_anthropic_blocks(
                    &mut messages,
                    "assistant",
                    vec![json!({
                        "type":"tool_use",
                        "id":item.get("call_id").cloned().unwrap_or_else(|| json!("call")),
                        "name":canonical_wire_tool_name(item),
                        "input":canonical_tool_arguments_value(item)
                    })],
                );
            }
            Some("function_call_output" | "custom_tool_call_output") => {
                push_anthropic_blocks(
                    &mut messages,
                    "user",
                    vec![json!({
                        "type":"tool_result",
                        "tool_use_id":item.get("call_id").cloned().unwrap_or_else(|| json!("call")),
                        "content":model_output_text(item.get("output"))
                    })],
                );
            }
            _ => {}
        }
    }
    let (tools, _) = compatible_tools(request.tools.as_deref());
    let effort = request
        .reasoning
        .as_ref()
        .and_then(|reasoning| reasoning.effort.as_deref());
    // `max_tokens` counts thinking plus visible output and must stay under the
    // model's output ceiling, so the effort-derived budget cannot be passed
    // through unclamped: `max` effort alone yields 32768 + headroom, which
    // already exceeds Opus 4.x. TODO: read the real per-model ceiling once
    // shared/model-registry/models.json carries maxOutputTokens.
    let budget = effort
        .and_then(reasoning_budget)
        .map(|value| value.min(ANTHROPIC_MAX_OUTPUT_TOKENS - ANTHROPIC_OUTPUT_HEADROOM));
    let mut body = json!({
        "model":request.model,
        "messages":messages,
        "max_tokens":budget.map_or(ANTHROPIC_OUTPUT_HEADROOM, |value| value + ANTHROPIC_OUTPUT_HEADROOM),
        "stream":true
    });
    if !request.instructions.trim().is_empty() {
        body["system"] = json!(request.instructions);
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools
                .into_iter()
                .map(|tool| {
                    json!({
                        "name":tool.declaration["name"],
                        "description":tool.declaration["description"],
                        "input_schema":tool.declaration["parameters"]
                    })
                })
                .collect(),
        );
    }
    match format {
        ReasoningWireFormat::AnthropicAdaptive => {
            if let Some(effort) = effort {
                if effort == "off" || effort == "none" {
                    body["thinking"] = json!({"type":"disabled"});
                } else {
                    body["output_config"] = json!({"effort":anthropic_reasoning_effort(effort)});
                    body["thinking"] = json!({"type":"adaptive"});
                }
            }
        }
        _ => {
            if let Some(budget) = budget {
                body["thinking"] = json!({"type":"enabled","budget_tokens":budget});
            }
        }
    }
    body
}

fn canonical_content_to_anthropic(content: Option<&Value>) -> Vec<Value> {
    let mut out = Vec::new();
    for part in content.and_then(Value::as_array).into_iter().flatten() {
        match part.get("type").and_then(Value::as_str) {
            Some("input_text" | "output_text" | "text") => out.push(json!({
                "type":"text",
                "text":part.get("text").and_then(Value::as_str).unwrap_or("")
            })),
            Some("input_image" | "image") => {
                if let Some(url) = part
                    .get("image_url")
                    .or_else(|| part.get("url"))
                    .and_then(Value::as_str)
                {
                    out.push(anthropic_image_block(url));
                }
            }
            _ => {}
        }
    }
    out
}

fn anthropic_image_block(url: &str) -> Value {
    if let Some((media_type, data)) = parse_data_url(url) {
        json!({"type":"image","source":{"type":"base64","media_type":media_type,"data":data}})
    } else {
        json!({"type":"image","source":{"type":"url","url":url}})
    }
}

/// Append parts to `contents`, merging into the previous entry when it carries
/// the same role, so one model turn stays a single `contents` element.
fn push_gemini_parts(contents: &mut Vec<Value>, role: &str, parts: Vec<Value>) {
    if parts.is_empty() {
        return;
    }
    if let Some(last) = contents.last_mut()
        && last.get("role").and_then(Value::as_str) == Some(role)
        && let Some(existing) = last.get_mut("parts").and_then(Value::as_array_mut)
    {
        existing.extend(parts);
        return;
    }
    contents.push(json!({ "role": role, "parts": Value::Array(parts) }));
}

fn build_gemini_request(request: &ResponsesApiRequest, format: ReasoningWireFormat) -> Value {
    let mut contents = Vec::new();
    let mut call_names = HashMap::new();
    // Gemini expects the thought signature back on the part it was issued
    // with — in practice the function call that the thinking produced — so it
    // is carried forward until the next model part is emitted.
    let mut pending_signature: Option<String> = None;
    for item in &request.input {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                let role = match item.get("role").and_then(Value::as_str) {
                    Some("assistant") => "model",
                    _ => "user",
                };
                let mut parts = canonical_content_to_gemini(item.get("content"));
                if role == "model"
                    && let Some(signature) = pending_signature.take()
                    && let Some(first) = parts.first_mut()
                {
                    first["thoughtSignature"] = json!(signature);
                }
                push_gemini_parts(&mut contents, role, parts);
            }
            Some("reasoning") => {
                if item.get("encrypted_content_format").and_then(Value::as_str)
                    == Some(GEMINI_THOUGHT_SIGNATURE)
                    && let Some(signature) = item.get("encrypted_content").and_then(Value::as_str)
                    && !signature.is_empty()
                {
                    pending_signature = Some(signature.to_owned());
                }
            }
            Some("function_call" | "custom_tool_call" | "tool_search_call") => {
                let name = canonical_wire_tool_name(item);
                if let Some(call_id) = item.get("call_id").and_then(Value::as_str) {
                    call_names.insert(call_id.to_owned(), name.clone());
                }
                let mut part = json!({
                    "functionCall":{"name":name,"args":canonical_tool_arguments_value(item)}
                });
                if let Some(signature) = pending_signature.take() {
                    part["thoughtSignature"] = json!(signature);
                }
                push_gemini_parts(&mut contents, "model", vec![part]);
            }
            Some("function_call_output" | "custom_tool_call_output") => {
                let call_id = item.get("call_id").and_then(Value::as_str).unwrap_or("");
                let name = call_names
                    .get(call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool".into());
                push_gemini_parts(
                    &mut contents,
                    "user",
                    vec![json!({
                        "functionResponse":{
                            "name":name,
                            "response":{"output":model_output_value(item.get("output"))}
                        }
                    })],
                );
            }
            _ => {}
        }
    }
    let (tools, _) = compatible_tools(request.tools.as_deref());
    let mut body = json!({"contents":contents});
    if !request.instructions.trim().is_empty() {
        body["systemInstruction"] = json!({"parts":[{"text":request.instructions}]});
    }
    if !tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations":tools.into_iter().map(|tool| tool.declaration).collect::<Vec<_>>()
        }]);
    }
    let mut generation_config = json!({});
    if let Some(effort) = request
        .reasoning
        .as_ref()
        .and_then(|reasoning| reasoning.effort.as_deref())
    {
        match format {
            ReasoningWireFormat::GeminiThinkingLevel => {
                if effort == "off" || effort == "none" {
                    generation_config["thinkingConfig"] =
                        json!({"thinkingBudget":0,"includeThoughts":false});
                } else {
                    generation_config["thinkingConfig"] = json!({
                        "thinkingLevel":gemini_reasoning_level(effort),
                        "includeThoughts":true
                    });
                }
            }
            _ => {
                if let Some(budget) = reasoning_budget(effort) {
                    generation_config["thinkingConfig"] =
                        json!({"thinkingBudget":budget,"includeThoughts":true});
                }
            }
        }
    }
    if let Some(text) = &request.text
        && let Some(format) = &text.format
    {
        generation_config["responseMimeType"] = json!("application/json");
        generation_config["responseJsonSchema"] = format.schema.clone();
    }
    if generation_config
        .as_object()
        .is_some_and(|value| !value.is_empty())
    {
        body["generationConfig"] = generation_config;
    }
    body
}

fn canonical_content_to_gemini(content: Option<&Value>) -> Vec<Value> {
    let mut out = Vec::new();
    for part in content.and_then(Value::as_array).into_iter().flatten() {
        match part.get("type").and_then(Value::as_str) {
            Some("input_text" | "output_text" | "text") => out.push(json!({
                "text":part.get("text").and_then(Value::as_str).unwrap_or("")
            })),
            Some("input_image" | "image") => {
                if let Some(url) = part
                    .get("image_url")
                    .or_else(|| part.get("url"))
                    .and_then(Value::as_str)
                {
                    if let Some((mime_type, data)) = parse_data_url(url) {
                        out.push(json!({"inlineData":{"mimeType":mime_type,"data":data}}));
                    } else {
                        out.push(json!({"fileData":{"mimeType":"application/octet-stream","fileUri":url}}));
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn gemini_stream_url(provider: &Provider, model: &str) -> String {
    let mut base = provider.base_url.trim_end_matches('/').to_owned();
    if let Some(stripped) = base.strip_suffix("/v1") {
        base = stripped.to_owned();
    } else if let Some(stripped) = base.strip_suffix("/v1beta") {
        base = stripped.to_owned();
    }
    format!(
        "{base}/v1beta/models/{}:streamGenerateContent?alt=sse",
        model.trim_start_matches("models/")
    )
}

#[derive(Clone)]
enum CompatibleToolKind {
    Function,
    Custom,
    ToolSearch,
}

#[derive(Clone)]
struct CompatibleTool {
    declaration: Value,
    canonical_name: String,
    namespace: Option<String>,
    kind: CompatibleToolKind,
}

fn compatible_tools(
    tools: Option<&[Value]>,
) -> (Vec<CompatibleTool>, HashMap<String, CompatibleTool>) {
    let mut out = Vec::new();
    for tool in tools.into_iter().flatten() {
        flatten_tool(tool, None, &mut out);
    }
    let catalog = out
        .iter()
        .cloned()
        .filter_map(|tool| {
            let name = tool
                .declaration
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned)?;
            Some((name, tool))
        })
        .collect();
    (out, catalog)
}

fn flatten_tool(tool: &Value, namespace: Option<&str>, out: &mut Vec<CompatibleTool>) {
    let kind = tool
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("function");
    if kind == "namespace" {
        let child_namespace = tool.get("name").and_then(Value::as_str);
        for child in tool
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            flatten_tool(child, child_namespace, out);
        }
        return;
    }
    let canonical_name = tool
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(kind)
        .to_owned();
    let wire_name = wire_tool_name(namespace, &canonical_name);
    let (tool_kind, parameters) = match kind {
        "custom" => (
            CompatibleToolKind::Custom,
            json!({
                "type":"object",
                "properties":{"input":{"type":"string","description":"Raw tool input"}},
                "required":["input"],
                "additionalProperties":false
            }),
        ),
        "tool_search" => (
            CompatibleToolKind::ToolSearch,
            tool.get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({"type":"object"})),
        ),
        _ => (
            CompatibleToolKind::Function,
            tool.get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({"type":"object"})),
        ),
    };
    let description = tool
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    out.push(CompatibleTool {
        declaration: json!({
            "name":wire_name,
            "description":description,
            "parameters":parameters
        }),
        canonical_name,
        namespace: namespace.map(str::to_owned),
        kind: tool_kind,
    });
}

fn wire_tool_name(namespace: Option<&str>, name: &str) -> String {
    let raw = namespace.map_or_else(
        || name.to_owned(),
        |namespace| format!("{namespace}__{name}"),
    );
    let mut cleaned = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    cleaned.truncate(64);
    cleaned
}

struct ToolAccumulator {
    call_id: String,
    wire_name: String,
    arguments: String,
    added: bool,
}

struct CompatibleState {
    response_id: String,
    message_id: String,
    text: String,
    message_added: bool,
    reasoning_id: String,
    reasoning_added: bool,
    reasoning_index: i64,
    reasoning_text: String,
    // Opaque provider blob that must be echoed back verbatim on the next turn:
    // Anthropic's thinking `signature`, Gemini's `thoughtSignature`. Stored on
    // the canonical reasoning item as `encrypted_content`, mirroring how the
    // Responses wire carries the same thing.
    reasoning_signature: Option<String>,
    reasoning_signature_format: Option<&'static str>,
    tools: BTreeMap<usize, ToolAccumulator>,
    catalog: HashMap<String, CompatibleTool>,
    usage: Option<TokenUsage>,
    last_model: Option<String>,
    finished: bool,
    next_tool_index: usize,
}

impl CompatibleState {
    fn new(request: &ResponsesApiRequest) -> Self {
        let (_, catalog) = compatible_tools(request.tools.as_deref());
        Self {
            response_id: format!("resp_{}", Uuid::new_v4().simple()),
            message_id: format!("msg_{}", Uuid::new_v4().simple()),
            text: String::new(),
            message_added: false,
            reasoning_id: format!("rs_{}", Uuid::new_v4().simple()),
            reasoning_added: false,
            reasoning_index: 0,
            reasoning_text: String::new(),
            reasoning_signature: None,
            reasoning_signature_format: None,
            tools: BTreeMap::new(),
            catalog,
            usage: None,
            last_model: None,
            finished: false,
            next_tool_index: 0,
        }
    }

    fn emit_model<F>(&mut self, model: String, on_event: &mut F) -> Result<(), ModelError>
    where
        F: FnMut(ResponseEvent) -> Result<(), ModelError>,
    {
        if self.last_model.as_deref() != Some(model.as_str()) {
            self.last_model = Some(model.clone());
            on_event(ResponseEvent::ServerModel(model))?;
        }
        Ok(())
    }

    fn push_text<F>(&mut self, delta: &str, on_event: &mut F) -> Result<(), ModelError>
    where
        F: FnMut(ResponseEvent) -> Result<(), ModelError>,
    {
        if !self.message_added {
            self.message_added = true;
            on_event(ResponseEvent::OutputItemAdded(json!({
                "type":"message","id":self.message_id,"role":"assistant","content":[]
            })))?;
        }
        self.text.push_str(delta);
        on_event(ResponseEvent::OutputTextDelta(delta.to_owned()))
    }

    fn push_reasoning<F>(&mut self, delta: &str, on_event: &mut F) -> Result<(), ModelError>
    where
        F: FnMut(ResponseEvent) -> Result<(), ModelError>,
    {
        // Announce the item before its first delta, mirroring what a native
        // Responses stream does for the assistant message.
        self.announce_reasoning(on_event)?;
        self.reasoning_text.push_str(delta);
        on_event(ResponseEvent::ReasoningContentDelta {
            item_id: Some(self.reasoning_id.clone()),
            delta: delta.to_owned(),
            content_index: self.reasoning_index,
        })
    }

    fn announce_reasoning<F>(&mut self, on_event: &mut F) -> Result<(), ModelError>
    where
        F: FnMut(ResponseEvent) -> Result<(), ModelError>,
    {
        if self.reasoning_added {
            return Ok(());
        }
        self.reasoning_added = true;
        on_event(ResponseEvent::OutputItemAdded(json!({
            "type":"reasoning","id":self.reasoning_id,"summary":[],"content":[]
        })))
    }

    /// Capture the provider's opaque thinking blob. Anthropic rejects any
    /// replayed thinking block whose signature is missing or altered, so this
    /// has to survive the round trip through history verbatim.
    fn push_reasoning_signature<F>(
        &mut self,
        signature: &str,
        format: &'static str,
        on_event: &mut F,
    ) -> Result<(), ModelError>
    where
        F: FnMut(ResponseEvent) -> Result<(), ModelError>,
    {
        if signature.is_empty() {
            return Ok(());
        }
        self.announce_reasoning(on_event)?;
        match self.reasoning_signature.as_mut() {
            // Anthropic streams the signature as one or more `signature_delta`
            // chunks that concatenate into the final value.
            Some(existing) if self.reasoning_signature_format == Some(format) => {
                existing.push_str(signature);
            }
            _ => {
                self.reasoning_signature = Some(signature.to_owned());
                self.reasoning_signature_format = Some(format);
            }
        }
        Ok(())
    }

    fn start_tool<F>(
        &mut self,
        index: usize,
        call_id: Option<&str>,
        wire_name: Option<&str>,
        on_event: &mut F,
    ) -> Result<(), ModelError>
    where
        F: FnMut(ResponseEvent) -> Result<(), ModelError>,
    {
        let should_emit = {
            let tool = self.tools.entry(index).or_insert_with(|| ToolAccumulator {
                call_id: call_id
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("call_{}", Uuid::new_v4().simple())),
                wire_name: wire_name.unwrap_or("tool").to_owned(),
                arguments: String::new(),
                added: false,
            });
            if let Some(call_id) = call_id.filter(|value| !value.is_empty()) {
                tool.call_id = call_id.to_owned();
            }
            if let Some(name) = wire_name.filter(|value| !value.is_empty()) {
                tool.wire_name = name.to_owned();
            }
            let should_emit = !tool.added;
            tool.added = true;
            should_emit
        };
        if should_emit {
            let item = self
                .tools
                .get(&index)
                .map(|tool| self.tool_item(tool, false))
                .unwrap_or(Value::Null);
            on_event(ResponseEvent::OutputItemAdded(item))?;
        }
        Ok(())
    }

    fn push_tool_delta<F>(
        &mut self,
        index: usize,
        delta: &str,
        on_event: &mut F,
    ) -> Result<(), ModelError>
    where
        F: FnMut(ResponseEvent) -> Result<(), ModelError>,
    {
        let Some(tool) = self.tools.get_mut(&index) else {
            return Ok(());
        };
        tool.arguments.push_str(delta);
        let is_function = self
            .catalog
            .get(&tool.wire_name)
            .is_none_or(|tool| matches!(tool.kind, CompatibleToolKind::Function));
        if is_function {
            on_event(ResponseEvent::ToolCallInputDelta {
                item_id: tool.call_id.clone(),
                call_id: Some(tool.call_id.clone()),
                delta: delta.to_owned(),
            })?;
        }
        Ok(())
    }

    fn tool_item(&self, tool: &ToolAccumulator, final_item: bool) -> Value {
        let metadata = self.catalog.get(&tool.wire_name);
        let name = metadata
            .map(|tool| tool.canonical_name.as_str())
            .unwrap_or(tool.wire_name.as_str());
        let namespace = metadata.and_then(|tool| tool.namespace.as_deref());
        let kind = metadata.map(|tool| &tool.kind);
        let arguments = if final_item {
            tool.arguments.as_str()
        } else {
            ""
        };
        let mut item = match kind {
            Some(CompatibleToolKind::Custom) => json!({
                "type":"custom_tool_call",
                "call_id":tool.call_id,
                "name":name,
                "input":custom_input(arguments)
            }),
            Some(CompatibleToolKind::ToolSearch) => json!({
                "type":"tool_search_call",
                "execution":"client",
                "call_id":tool.call_id,
                "name":name,
                "arguments":parse_arguments(arguments)
            }),
            _ => json!({
                "type":"function_call",
                "call_id":tool.call_id,
                "name":name,
                "arguments":arguments
            }),
        };
        if let Some(namespace) = namespace {
            item["namespace"] = json!(namespace);
        }
        item
    }

    fn finish<F>(&mut self, on_event: &mut F) -> Result<(), ModelError>
    where
        F: FnMut(ResponseEvent) -> Result<(), ModelError>,
    {
        if self.finished {
            return Ok(());
        }
        // Emit reasoning before the message so history keeps the provider's
        // own ordering; Anthropic requires thinking blocks to lead the
        // assistant turn when they are replayed.
        if self.reasoning_added {
            let mut item = json!({
                "type":"reasoning",
                "id":self.reasoning_id,
                "summary":[],
                "content":[{"type":"reasoning_text","text":self.reasoning_text}]
            });
            if let Some(signature) = self.reasoning_signature.as_deref() {
                item["encrypted_content"] = json!(signature);
                item["encrypted_content_format"] = json!(self.reasoning_signature_format);
            }
            on_event(ResponseEvent::OutputItemDone(item))?;
        }
        if self.message_added {
            on_event(ResponseEvent::OutputItemDone(json!({
                "type":"message",
                "id":self.message_id,
                "role":"assistant",
                "content":[{"type":"output_text","text":self.text}]
            })))?;
        }
        for tool in self.tools.values() {
            on_event(ResponseEvent::OutputItemDone(self.tool_item(tool, true)))?;
        }
        self.finished = true;
        on_event(ResponseEvent::Completed {
            response_id: self.response_id.clone(),
            token_usage: self.usage.clone(),
            end_turn: Some(self.tools.is_empty()),
        })
    }
}

fn process_chat_chunk<F>(
    value: &Value,
    state: &mut CompatibleState,
    on_event: &mut F,
) -> Result<bool, ModelError>
where
    F: FnMut(ResponseEvent) -> Result<(), ModelError>,
{
    if let Some(id) = value.get("id").and_then(Value::as_str) {
        state.response_id = id.to_owned();
    }
    if let Some(model) = value.get("model").and_then(Value::as_str) {
        state.emit_model(model.to_owned(), on_event)?;
    }
    if let Some(usage) = value.get("usage") {
        state.usage = Some(openai_usage(usage));
    }
    for choice in value
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let delta = choice.get("delta").or_else(|| choice.get("message"));
        if let Some(text) = delta
            .and_then(|delta| delta.get("content"))
            .and_then(Value::as_str)
        {
            state.push_text(text, on_event)?;
        }
        if let Some(reasoning) = delta
            .and_then(|delta| {
                delta
                    .get("reasoning_content")
                    .or_else(|| delta.get("reasoning"))
            })
            .and_then(Value::as_str)
        {
            state.push_reasoning(reasoning, on_event)?;
        }
        for tool in delta
            .and_then(|delta| delta.get("tool_calls"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = tool.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let function = tool.get("function").unwrap_or(tool);
            let call_id = tool.get("id").and_then(Value::as_str);
            let name = function.get("name").and_then(Value::as_str);
            state.start_tool(index, call_id, name, on_event)?;
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                state.push_tool_delta(index, arguments, on_event)?;
            }
        }
    }
    Ok(false)
}

fn process_anthropic_event<F>(
    event_name: Option<&str>,
    value: &Value,
    state: &mut CompatibleState,
    on_event: &mut F,
) -> Result<bool, ModelError>
where
    F: FnMut(ResponseEvent) -> Result<(), ModelError>,
{
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .or(event_name)
        .unwrap_or("");
    match kind {
        "message_start" => {
            if let Some(message) = value.get("message") {
                if let Some(id) = message.get("id").and_then(Value::as_str) {
                    state.response_id = id.to_owned();
                }
                if let Some(model) = message.get("model").and_then(Value::as_str) {
                    state.emit_model(model.to_owned(), on_event)?;
                }
                if let Some(usage) = message.get("usage") {
                    state.usage = Some(anthropic_usage(usage, None));
                }
            }
        }
        "content_block_start" => {
            let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let block = value.get("content_block").unwrap_or(value);
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        state.push_text(text, on_event)?;
                    }
                }
                Some("tool_use") => {
                    state.start_tool(
                        index,
                        block.get("id").and_then(Value::as_str),
                        block.get("name").and_then(Value::as_str),
                        on_event,
                    )?;
                    if let Some(input) = block.get("input")
                        && input.as_object().is_some_and(|value| !value.is_empty())
                    {
                        state.push_tool_delta(index, &input.to_string(), on_event)?;
                    }
                }
                Some("thinking") => {
                    if let Some(thinking) = block.get("thinking").and_then(Value::as_str) {
                        state.push_reasoning(thinking, on_event)?;
                    }
                    if let Some(signature) = block.get("signature").and_then(Value::as_str) {
                        state.push_reasoning_signature(
                            signature,
                            ANTHROPIC_THINKING_SIGNATURE,
                            on_event,
                        )?;
                    }
                }
                Some("redacted_thinking") => {
                    // Redacted blocks carry no readable text, only an opaque
                    // `data` blob that still has to be replayed verbatim.
                    if let Some(data) = block.get("data").and_then(Value::as_str) {
                        state.push_reasoning_signature(
                            data,
                            ANTHROPIC_REDACTED_THINKING,
                            on_event,
                        )?;
                    }
                }
                _ => {}
            }
        }
        "content_block_delta" => {
            let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let delta = value.get("delta").unwrap_or(value);
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => {
                    if let Some(text) = delta.get("text").and_then(Value::as_str) {
                        state.push_text(text, on_event)?;
                    }
                }
                Some("input_json_delta") => {
                    if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                        state.push_tool_delta(index, partial, on_event)?;
                    }
                }
                Some("thinking_delta") => {
                    if let Some(thinking) = delta.get("thinking").and_then(Value::as_str) {
                        state.push_reasoning(thinking, on_event)?;
                    }
                }
                Some("signature_delta") => {
                    if let Some(signature) = delta.get("signature").and_then(Value::as_str) {
                        state.push_reasoning_signature(
                            signature,
                            ANTHROPIC_THINKING_SIGNATURE,
                            on_event,
                        )?;
                    }
                }
                _ => {}
            }
        }
        "message_delta" => {
            if let Some(usage) = value.get("usage") {
                let input = state.usage.as_ref().map(|usage| usage.input_tokens);
                state.usage = Some(anthropic_usage(usage, input));
            }
        }
        "message_stop" => {
            state.finish(on_event)?;
            return Ok(true);
        }
        "error" => {
            return Err(ModelError::Stream(
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("anthropic stream error")
                    .to_owned(),
            ));
        }
        _ => {}
    }
    Ok(false)
}

fn process_gemini_chunk<F>(
    value: &Value,
    state: &mut CompatibleState,
    on_event: &mut F,
) -> Result<bool, ModelError>
where
    F: FnMut(ResponseEvent) -> Result<(), ModelError>,
{
    if let Some(model) = value.get("modelVersion").and_then(Value::as_str) {
        state.emit_model(model.to_owned(), on_event)?;
    }
    if let Some(usage) = value.get("usageMetadata") {
        state.usage = Some(gemini_usage(usage));
    }
    let mut completed = false;
    for candidate in value
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for part in candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                if part
                    .get("thought")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    state.push_reasoning(text, on_event)?;
                } else {
                    state.push_text(text, on_event)?;
                }
            }
            // Gemini attaches thoughtSignature to thought parts and to the
            // function calls that follow from them; it has to be replayed on
            // the next turn or the model loses the thinking context.
            if let Some(signature) = part.get("thoughtSignature").and_then(Value::as_str) {
                state.push_reasoning_signature(signature, GEMINI_THOUGHT_SIGNATURE, on_event)?;
            }
            if let Some(call) = part.get("functionCall") {
                let index = state.next_tool_index;
                state.next_tool_index += 1;
                state.start_tool(
                    index,
                    None,
                    call.get("name").and_then(Value::as_str),
                    on_event,
                )?;
                state.push_tool_delta(
                    index,
                    &call
                        .get("args")
                        .cloned()
                        .unwrap_or_else(|| json!({}))
                        .to_string(),
                    on_event,
                )?;
            }
        }
        // Not every finishReason is a clean stop. Treating them all as success
        // silently truncates the turn; mirror the Responses path, which surfaces
        // an incomplete response as a stream error.
        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
            match reason {
                "STOP" | "FINISH_REASON_UNSPECIFIED" => completed = true,
                "MAX_TOKENS" => {
                    return Err(ModelError::Stream(
                        "Incomplete response returned, reason: max_output_tokens".into(),
                    ));
                }
                other => {
                    return Err(ModelError::Stream(format!(
                        "Gemini stopped the response, reason: {other}"
                    )));
                }
            }
        }
    }
    if completed {
        state.finish(on_event)?;
    }
    Ok(completed)
}

fn openai_usage(value: &Value) -> TokenUsage {
    let input_tokens = value
        .get("prompt_tokens")
        .or_else(|| value.get("input_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output_tokens = value
        .get("completion_tokens")
        .or_else(|| value.get("output_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    TokenUsage {
        input_tokens,
        cached_input_tokens: value
            .pointer("/prompt_tokens_details/cached_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        cache_write_input_tokens: 0,
        output_tokens,
        reasoning_output_tokens: value
            .pointer("/completion_tokens_details/reasoning_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        total_tokens: value
            .get("total_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(input_tokens + output_tokens),
    }
}

fn anthropic_usage(value: &Value, previous_input: Option<i64>) -> TokenUsage {
    let input_tokens = value
        .get("input_tokens")
        .and_then(Value::as_i64)
        .or(previous_input)
        .unwrap_or(0);
    let output_tokens = value
        .get("output_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cached = value
        .get("cache_read_input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let written = value
        .get("cache_creation_input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    TokenUsage {
        input_tokens,
        cached_input_tokens: cached,
        cache_write_input_tokens: written,
        output_tokens,
        reasoning_output_tokens: 0,
        total_tokens: input_tokens + output_tokens,
    }
}

fn gemini_usage(value: &Value) -> TokenUsage {
    let input_tokens = value
        .get("promptTokenCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output_tokens = value
        .get("candidatesTokenCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    TokenUsage {
        input_tokens,
        cached_input_tokens: value
            .get("cachedContentTokenCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        cache_write_input_tokens: 0,
        output_tokens,
        reasoning_output_tokens: value
            .get("thoughtsTokenCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        total_tokens: value
            .get("totalTokenCount")
            .and_then(Value::as_i64)
            .unwrap_or(input_tokens + output_tokens),
    }
}

fn canonical_wire_tool_name(item: &Value) -> String {
    wire_tool_name(
        item.get("namespace").and_then(Value::as_str),
        item.get("name").and_then(Value::as_str).unwrap_or("tool"),
    )
}

fn canonical_tool_arguments(item: &Value) -> String {
    match item.get("type").and_then(Value::as_str) {
        Some("custom_tool_call") => json!({
            "input":item.get("input").and_then(Value::as_str).unwrap_or("")
        })
        .to_string(),
        _ => item
            .get("arguments")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| "{}".into()),
    }
}

fn canonical_tool_arguments_value(item: &Value) -> Value {
    serde_json::from_str(&canonical_tool_arguments(item)).unwrap_or_else(|_| json!({}))
}

fn custom_input(arguments: &str) -> String {
    serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("input")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| arguments.to_owned())
}

fn parse_arguments(arguments: &str) -> Value {
    serde_json::from_str(arguments).unwrap_or_else(|_| json!({"raw":arguments}))
}

fn model_output_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
        None => String::new(),
    }
}

fn model_output_value(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(value)) => {
            serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.clone()))
        }
        Some(value) => value.clone(),
        None => Value::Null,
    }
}

fn reasoning_budget(effort: &str) -> Option<i64> {
    match effort.to_ascii_lowercase().as_str() {
        "off" | "none" | "auto" => None,
        "minimal" => Some(1024),
        "low" => Some(2048),
        "medium" => Some(4096),
        "high" => Some(8192),
        "xhigh" => Some(16384),
        "max" => Some(32768),
        "ultra" => Some(65536),
        _ => None,
    }
}

fn anthropic_reasoning_effort(effort: &str) -> &str {
    match effort.to_ascii_lowercase().as_str() {
        "minimal" => "low",
        "xhigh" | "ultra" => "max",
        _ => effort,
    }
}

fn gemini_reasoning_level(effort: &str) -> &str {
    match effort.to_ascii_lowercase().as_str() {
        "minimal" => "minimal",
        "low" => "low",
        "medium" => "medium",
        _ => "high",
    }
}

fn parse_data_url(url: &str) -> Option<(&str, &str)> {
    let value = url.strip_prefix("data:")?;
    let (metadata, data) = value.split_once(',')?;
    let media_type = metadata.strip_suffix(";base64")?;
    Some((media_type, data))
}

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> ResponsesApiRequest {
        let mut request = ResponsesApiRequest::text(
            "model-x",
            vec![
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}),
                json!({"type":"function_call","call_id":"call-1","name":"lookup","arguments":"{\"q\":\"x\"}"}),
                json!({"type":"function_call_output","call_id":"call-1","output":"done"}),
            ],
        );
        request.instructions = "system".into();
        request.tools = Some(vec![json!({
            "type":"function",
            "name":"lookup",
            "description":"Lookup",
            "parameters":{"type":"object","properties":{"q":{"type":"string"}}}
        })]);
        request.reasoning = Some(Reasoning {
            effort: Some("high".into()),
            summary: Some("auto".into()),
            context: None,
        });
        request
    }

    #[test]
    fn encodes_all_supported_wire_requests() {
        let request = request();
        let provider = Provider::openai_compatible("test", "https://example.test/v1", None);
        let chat = build_wire_request(&provider, WireApi::ChatCompletions, &request).unwrap();
        assert_eq!(chat.url, "https://example.test/v1/chat/completions");
        assert_eq!(chat.body["messages"][0]["role"], "system");
        assert_eq!(chat.body["reasoning_effort"], "high");
        assert_eq!(chat.body["tools"][0]["function"]["name"], "lookup");

        let anthropic =
            build_wire_request(&provider, WireApi::AnthropicMessages, &request).unwrap();
        assert_eq!(anthropic.url, "https://example.test/v1/messages");
        assert_eq!(anthropic.body["system"], "system");
        assert_eq!(anthropic.body["thinking"]["budget_tokens"], 8192);
        assert_eq!(anthropic.body["tools"][0]["name"], "lookup");

        let gemini =
            build_wire_request(&provider, WireApi::GeminiGenerateContent, &request).unwrap();
        assert_eq!(
            gemini.url,
            "https://example.test/v1beta/models/model-x:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            gemini.body["tools"][0]["functionDeclarations"][0]["name"],
            "lookup"
        );
        assert_eq!(
            gemini.body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            8192
        );
    }

    #[test]
    fn encodes_protocol_specific_reasoning_parameters() {
        let mut request = request();
        request.reasoning.as_mut().unwrap().effort = Some("xhigh".into());

        let adaptive = Provider::openai_compatible("test", "https://example.test/v1", None)
            .with_reasoning_wire_format(ReasoningWireFormat::AnthropicAdaptive);
        let anthropic =
            build_wire_request(&adaptive, WireApi::AnthropicMessages, &request).unwrap();
        assert_eq!(anthropic.body["output_config"]["effort"], "max");
        assert_eq!(anthropic.body["thinking"]["type"], "adaptive");

        let level = Provider::openai_compatible("test", "https://example.test/v1", None)
            .with_reasoning_wire_format(ReasoningWireFormat::GeminiThinkingLevel);
        let gemini = build_wire_request(&level, WireApi::GeminiGenerateContent, &request).unwrap();
        assert_eq!(
            gemini.body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "high"
        );

        request.reasoning.as_mut().unwrap().effort = Some("none".into());
        let chat = build_wire_request(&level, WireApi::ChatCompletions, &request).unwrap();
        assert_eq!(chat.body["reasoning_effort"], "none");
    }

    #[test]
    fn normalizes_chat_anthropic_and_gemini_events() {
        let request = request();
        let mut state = CompatibleState::new(&request);
        let mut events = Vec::new();
        process_chat_chunk(
            &json!({
                "id":"chat-1",
                "model":"chat-model",
                "choices":[{"delta":{
                    "content":"hello",
                    "tool_calls":[{"index":0,"id":"call-2","function":{"name":"lookup","arguments":"{\"q\":\"y\"}"}}]
                }}],
                "usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}
            }),
            &mut state,
            &mut |event| {
                events.push(event);
                Ok(())
            },
        )
        .unwrap();
        state
            .finish(&mut |event| {
                events.push(event);
                Ok(())
            })
            .unwrap();
        assert!(
            events.iter().any(
                |event| matches!(event, ResponseEvent::OutputTextDelta(text) if text == "hello")
            )
        );
        assert!(events.iter().any(|event| matches!(
            event,
            ResponseEvent::OutputItemDone(item)
                if item["type"] == "function_call" && item["name"] == "lookup"
        )));

        let mut anthropic_state = CompatibleState::new(&request);
        let mut anthropic_events = Vec::new();
        process_anthropic_event(
            Some("content_block_delta"),
            &json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}),
            &mut anthropic_state,
            &mut |event| {
                anthropic_events.push(event);
                Ok(())
            },
        )
        .unwrap();
        assert!(
            anthropic_events
                .iter()
                .any(|event| matches!(event, ResponseEvent::OutputTextDelta(text) if text == "a"))
        );

        let mut gemini_state = CompatibleState::new(&request);
        let mut gemini_events = Vec::new();
        assert!(
            process_gemini_chunk(
                &json!({
                    "modelVersion":"gemini-model",
                    "candidates":[{"content":{"parts":[{"text":"g"}]},"finishReason":"STOP"}],
                    "usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1,"totalTokenCount":5}
                }),
                &mut gemini_state,
                &mut |event| {
                    gemini_events.push(event);
                    Ok(())
                }
            )
            .unwrap()
        );
        assert!(gemini_events.iter().any(
            |event| matches!(event, ResponseEvent::Completed { token_usage: Some(usage), .. } if usage.total_tokens == 5)
        ));
    }

    /// Feed a compatible stream and collect the canonical items it completes.
    fn drain_items(
        request: &ResponsesApiRequest,
        wire_api: WireApi,
        events: Vec<Value>,
    ) -> Vec<Value> {
        let mut state = CompatibleState::new(request);
        let mut items = Vec::new();
        let mut sink = |event: ResponseEvent| {
            if let ResponseEvent::OutputItemDone(item) = &event {
                items.push(item.clone());
            }
            Ok(())
        };
        for event in events {
            process_compatible_value(wire_api, None, event, &mut state, &mut sink).unwrap();
        }
        state.finish(&mut sink).unwrap();
        items
    }

    #[test]
    fn anthropic_thinking_signature_round_trips_through_history() {
        let request = request();
        let items = drain_items(
            &request,
            WireApi::AnthropicMessages,
            vec![
                json!({"type":"content_block_start","index":0,
                    "content_block":{"type":"thinking","thinking":"step "}}),
                json!({"type":"content_block_delta","index":0,
                    "delta":{"type":"thinking_delta","thinking":"one"}}),
                json!({"type":"content_block_delta","index":0,
                    "delta":{"type":"signature_delta","signature":"sig-"}}),
                json!({"type":"content_block_delta","index":0,
                    "delta":{"type":"signature_delta","signature":"abc"}}),
            ],
        );

        let reasoning = items
            .iter()
            .find(|item| item["type"] == "reasoning")
            .expect("compatible stream must complete the reasoning item");
        assert_eq!(reasoning["content"][0]["text"], "step one");
        // Signature deltas concatenate into one blob.
        assert_eq!(reasoning["encrypted_content"], "sig-abc");
        assert_eq!(
            reasoning["encrypted_content_format"],
            ANTHROPIC_THINKING_SIGNATURE
        );

        // Replaying that item must reproduce a signed thinking block.
        let mut replay = ResponsesApiRequest::text("model-x", vec![reasoning.clone()]);
        replay.reasoning = request.reasoning.clone();
        let body = build_anthropic_request(&replay, ReasoningWireFormat::Auto);
        assert_eq!(body["messages"][0]["role"], "assistant");
        assert_eq!(body["messages"][0]["content"][0]["type"], "thinking");
        assert_eq!(body["messages"][0]["content"][0]["thinking"], "step one");
        assert_eq!(body["messages"][0]["content"][0]["signature"], "sig-abc");
    }

    #[test]
    fn anthropic_redacted_thinking_replays_verbatim() {
        let request = request();
        let items = drain_items(
            &request,
            WireApi::AnthropicMessages,
            vec![json!({"type":"content_block_start","index":0,
                "content_block":{"type":"redacted_thinking","data":"blob"}})],
        );
        let reasoning = items
            .iter()
            .find(|item| item["type"] == "reasoning")
            .expect("redacted thinking must still produce a reasoning item");
        assert_eq!(reasoning["encrypted_content"], "blob");

        let replay = ResponsesApiRequest::text("model-x", vec![reasoning.clone()]);
        let body = build_anthropic_request(&replay, ReasoningWireFormat::Auto);
        assert_eq!(
            body["messages"][0]["content"][0]["type"],
            "redacted_thinking"
        );
        assert_eq!(body["messages"][0]["content"][0]["data"], "blob");
    }

    #[test]
    fn anthropic_drops_reasoning_without_a_matching_signature() {
        // An unsigned thinking block, or one captured on another wire, is a
        // hard 400 on Anthropic — it must be dropped rather than replayed.
        let unsigned = json!({"type":"reasoning","id":"rs_1",
            "content":[{"type":"reasoning_text","text":"thought"}]});
        let foreign = json!({"type":"reasoning","id":"rs_2",
            "content":[{"type":"reasoning_text","text":"thought"}],
            "encrypted_content":"blob",
            "encrypted_content_format":GEMINI_THOUGHT_SIGNATURE});
        let request = ResponsesApiRequest::text("model-x", vec![unsigned, foreign]);
        let body = build_anthropic_request(&request, ReasoningWireFormat::Auto);
        assert_eq!(body["messages"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn anthropic_merges_consecutive_same_role_blocks() {
        // Anthropic rejects back-to-back assistant messages, and one turn
        // routinely spans thinking, text and a tool call.
        let request = ResponsesApiRequest::text(
            "model-x",
            vec![
                json!({"type":"reasoning","id":"rs_1",
                    "content":[{"type":"reasoning_text","text":"think"}],
                    "encrypted_content":"sig",
                    "encrypted_content_format":ANTHROPIC_THINKING_SIGNATURE}),
                json!({"type":"message","role":"assistant",
                    "content":[{"type":"output_text","text":"answer"}]}),
                json!({"type":"function_call","call_id":"call-1","name":"lookup","arguments":"{}"}),
                json!({"type":"function_call_output","call_id":"call-1","output":"ok"}),
            ],
        );
        let body = build_anthropic_request(&request, ReasoningWireFormat::Auto);
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2, "assistant blocks must collapse into one");
        assert_eq!(messages[0]["role"], "assistant");
        let blocks = messages[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 3);
        // Thinking has to lead the assistant turn.
        assert_eq!(blocks[0]["type"], "thinking");
        assert_eq!(blocks[2]["type"], "tool_use");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"][0]["type"], "tool_result");
    }

    #[test]
    fn anthropic_max_tokens_stays_within_the_model_ceiling() {
        let provider = Provider::openai_compatible("test", "https://example.test/v1", None);
        for effort in ["high", "xhigh", "max", "ultra"] {
            let mut request = request();
            request.reasoning = Some(Reasoning {
                effort: Some(effort.into()),
                summary: None,
                context: None,
            });
            let body = build_wire_request(&provider, WireApi::AnthropicMessages, &request)
                .unwrap()
                .body;
            let max_tokens = body["max_tokens"].as_i64().unwrap();
            assert!(
                max_tokens <= ANTHROPIC_MAX_OUTPUT_TOKENS,
                "effort {effort} asked for {max_tokens} output tokens"
            );
            if let Some(budget) = body["thinking"]["budget_tokens"].as_i64() {
                assert!(
                    budget < max_tokens,
                    "effort {effort}: thinking budget must leave room for output"
                );
            }
        }
    }

    #[test]
    fn gemini_thought_signature_round_trips_onto_the_function_call() {
        let request = request();
        let items = drain_items(
            &request,
            WireApi::GeminiGenerateContent,
            vec![json!({"candidates":[{"content":{"parts":[
                {"text":"thinking","thought":true,"thoughtSignature":"gsig"}
            ]}}]})],
        );
        let reasoning = items.iter().find(|item| item["type"] == "reasoning").unwrap();
        assert_eq!(reasoning["encrypted_content"], "gsig");
        assert_eq!(
            reasoning["encrypted_content_format"],
            GEMINI_THOUGHT_SIGNATURE
        );

        let replay = ResponsesApiRequest::text(
            "model-x",
            vec![
                reasoning.clone(),
                json!({"type":"function_call","call_id":"c1","name":"lookup","arguments":"{}"}),
            ],
        );
        let body = build_gemini_request(&replay, ReasoningWireFormat::Auto);
        let part = &body["contents"][0]["parts"][0];
        assert_eq!(part["functionCall"]["name"], "lookup");
        assert_eq!(part["thoughtSignature"], "gsig");
    }

    #[test]
    fn gemini_non_stop_finish_reasons_do_not_look_like_success() {
        let request = request();
        for (reason, needle) in [
            ("MAX_TOKENS", "max_output_tokens"),
            ("SAFETY", "SAFETY"),
            ("MALFORMED_FUNCTION_CALL", "MALFORMED_FUNCTION_CALL"),
        ] {
            let mut state = CompatibleState::new(&request);
            let error = process_gemini_chunk(
                &json!({"candidates":[{"finishReason":reason,"content":{"parts":[]}}]}),
                &mut state,
                &mut |_| Ok(()),
            )
            .expect_err("non-STOP finish reasons must not complete the turn");
            assert!(
                error.to_string().contains(needle),
                "{reason} produced {error}"
            );
        }

        let mut state = CompatibleState::new(&request);
        assert!(
            process_gemini_chunk(
                &json!({"candidates":[{"finishReason":"STOP","content":{"parts":[]}}]}),
                &mut state,
                &mut |_| Ok(()),
            )
            .unwrap()
        );
    }
}
