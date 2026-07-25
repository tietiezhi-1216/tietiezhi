use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use bm25::{Document, Language, SearchEngine, SearchEngineBuilder};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    ToolError, ToolFuture, ToolHandler, ToolInvocation, ToolName, ToolOutput, ToolPayload,
    ToolSpec, wire_specs,
};

const MAX_SLEEP_DURATION_MS: u64 = 12 * 60 * 60 * 1000;
const TOOL_SEARCH_DEFAULT_LIMIT: usize = 8;

pub type ContextRemainingProvider = Arc<dyn Fn(&str, &str) -> Option<i64> + Send + Sync + 'static>;

pub fn current_time_handler() -> Arc<dyn ToolHandler> {
    Arc::new(CurrentTimeHandler)
}

pub fn sleep_handler() -> Arc<dyn ToolHandler> {
    Arc::new(SleepHandler)
}

pub fn context_remaining_handler(provider: ContextRemainingProvider) -> Arc<dyn ToolHandler> {
    Arc::new(ContextRemainingHandler { provider })
}

pub fn view_image_handler(cwd: PathBuf, allow_original: bool) -> Arc<dyn ToolHandler> {
    Arc::new(ViewImageHandler {
        cwd,
        allow_original,
    })
}

pub fn web_search_handler() -> Arc<dyn ToolHandler> {
    Arc::new(HostedWebSearchHandler)
}

pub fn tool_search_handler(
    deferred_specs: Vec<ToolSpec>,
    source_descriptions: Vec<(String, Option<String>)>,
) -> Arc<dyn ToolHandler> {
    Arc::new(ToolSearchHandler::new(deferred_specs, source_descriptions))
}

struct CurrentTimeHandler;

impl ToolHandler for CurrentTimeHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::namespaced("clock", "curr_time")
    }

    fn spec(&self) -> ToolSpec {
        let mut spec = ToolSpec::function(
            self.tool_name(),
            "Return the current time in UTC.",
            empty_object_schema(),
        );
        spec.namespace_description = Some("Tools for reading and waiting on time.".into());
        spec.output_schema = Some(json!({
            "type":"object",
            "properties":{"current_time":{
                "type":"string",
                "description":"Current UTC time formatted as YYYY-MM-DD HH:MM:SS UTC."
            }},
            "required":["current_time"],
            "additionalProperties":false
        }));
        spec
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            require_function_payload(&invocation, "curr_time")?;
            let current_time = Utc::now()
                .to_rfc3339_opts(SecondsFormat::Secs, true)
                .replace('T', " ");
            Ok(ToolOutput::success(Value::String(format!(
                "It is {}.",
                current_time.replace('Z', " UTC")
            ))))
        })
    }
}

struct ContextRemainingHandler {
    provider: ContextRemainingProvider,
}

impl ToolHandler for ContextRemainingHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("get_context_remaining")
    }

    fn spec(&self) -> ToolSpec {
        let mut spec = ToolSpec::function(
            self.tool_name(),
            "Get the remaining tokens in the current context window.",
            empty_object_schema(),
        );
        spec.output_schema = Some(json!({
            "type":"object",
            "properties":{"tokens_left":{
                "anyOf":[{"type":"integer"},{"type":"null"}],
                "description":"Remaining tokens in the current context window, or null when unavailable."
            }},
            "required":["tokens_left"],
            "additionalProperties":false
        }));
        spec
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        let provider = Arc::clone(&self.provider);
        Box::pin(async move {
            require_function_payload(&invocation, "get_context_remaining")?;
            let tokens_left = provider(&invocation.thread_id, &invocation.turn_id);
            let text = match tokens_left {
                Some(tokens_left) => {
                    format!("You have {tokens_left} tokens left in this context window.")
                }
                None => "You have unknown tokens left in this context window.".into(),
            };
            Ok(ToolOutput::success(Value::String(text)))
        })
    }
}

struct SleepHandler;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SleepArgs {
    duration_ms: u64,
}

impl ToolHandler for SleepHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::namespaced("clock", "sleep")
    }

    fn spec(&self) -> ToolSpec {
        let mut spec = ToolSpec::function(
            self.tool_name(),
            "Pause execution for a specified duration. The sleep ends early when new input arrives for the active turn. Returns the elapsed wall-clock time.",
            json!({
                "type":"object",
                "properties":{
                    "duration_ms":{
                        "type":"number",
                        "description":format!("How long to sleep in milliseconds. Must be between 1 and {MAX_SLEEP_DURATION_MS}.")
                    }
                },
                "required":["duration_ms"],
                "additionalProperties":false
            }),
        );
        spec.namespace_description = Some("Tools for reading and waiting on time.".into());
        spec
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            let args: SleepArgs = parse_function_args(&invocation, "sleep")?;
            if !(1..=MAX_SLEEP_DURATION_MS).contains(&args.duration_ms) {
                return Err(ToolError::Handler(format!(
                    "duration_ms must be between 1 and {MAX_SLEEP_DURATION_MS}"
                )));
            }
            let started = Instant::now();
            let interrupted = tokio::select! {
                () = tokio::time::sleep(Duration::from_millis(args.duration_ms)) => false,
                () = invocation.cancellation.cancelled() => true,
                () = invocation.input_activity.cancelled() => true,
            };
            let message = if interrupted {
                "Sleep interrupted by new input."
            } else {
                "Sleep completed."
            };
            Ok(ToolOutput::success(Value::String(format!(
                "Wall time: {:.4} seconds\n{message}",
                started.elapsed().as_secs_f64()
            ))))
        })
    }
}

struct ViewImageHandler {
    cwd: PathBuf,
    allow_original: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewImageArgs {
    path: String,
    detail: Option<String>,
}

impl ToolHandler for ViewImageHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("view_image")
    }

    fn spec(&self) -> ToolSpec {
        let mut properties = serde_json::Map::from_iter([(
            "path".into(),
            json!({"type":"string","description":"Local filesystem path to an image file."}),
        )]);
        if self.allow_original {
            properties.insert(
                "detail".into(),
                json!({
                    "type":"string",
                    "enum":["high","original"],
                    "description":"Image detail level. Defaults to high."
                }),
            );
        }
        let mut spec = ToolSpec::function(
            self.tool_name(),
            "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
            json!({
                "type":"object",
                "properties":properties,
                "required":["path"],
                "additionalProperties":false
            }),
        );
        spec.output_schema = Some(json!({
            "type":"object",
            "properties":{
                "image_url":{
                    "type":"string",
                    "description":"Data URL for the loaded image."
                },
                "detail":{
                    "type":"string",
                    "enum":["high","original"],
                    "description":"Image detail hint returned by view_image. Returns `high` for default resized behavior or `original` when original resolution is preserved."
                }
            },
            "required":["image_url","detail"],
            "additionalProperties":false
        }));
        spec
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        let cwd = self.cwd.clone();
        let allow_original = self.allow_original;
        Box::pin(async move {
            let args: ViewImageArgs = parse_function_args(&invocation, "view_image")?;
            let detail = match args.detail.as_deref() {
                None | Some("high") => "high",
                Some("original") if allow_original => "original",
                Some("original") => {
                    return Err(ToolError::Handler(
                        "original image detail is unavailable for this model".into(),
                    ));
                }
                Some(other) => {
                    return Err(ToolError::Handler(format!(
                        "view_image.detail only supports high or original, got {other}"
                    )));
                }
            };
            let path = PathBuf::from(args.path);
            let path = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };
            let metadata = tokio::fs::metadata(&path)
                .await
                .map_err(|error| ToolError::Handler(format!("unable to locate image: {error}")))?;
            if !metadata.is_file() {
                return Err(ToolError::Handler("image path is not a file".into()));
            }
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|error| ToolError::Handler(format!("unable to read image: {error}")))?;
            let image_url = format!(
                "data:application/octet-stream;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            );
            Ok(ToolOutput::success(json!([{
                "type":"input_image",
                "image_url":image_url,
                "detail":detail
            }])))
        })
    }
}

struct HostedWebSearchHandler;

impl ToolHandler for HostedWebSearchHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("web_search")
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec::hosted(self.tool_name(), json!({"type":"web_search"}))
    }

    fn matches_payload(&self, _payload: &ToolPayload) -> bool {
        false
    }

    fn handle(&self, _invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async {
            Err(ToolError::Handler(
                "web_search is executed by the model provider".into(),
            ))
        })
    }
}

struct ToolSearchHandler {
    specs: Vec<ToolSpec>,
    spec: ToolSpec,
    engine: SearchEngine<usize>,
}

impl ToolSearchHandler {
    fn new(specs: Vec<ToolSpec>, source_descriptions: Vec<(String, Option<String>)>) -> Self {
        let documents = specs
            .iter()
            .enumerate()
            .map(|(index, spec)| {
                Document::new(
                    index,
                    format!(
                        "{} {} {}",
                        spec.name.display_name(),
                        spec.description,
                        spec.input_schema
                    ),
                )
            })
            .collect::<Vec<_>>();
        let engine = SearchEngineBuilder::with_documents(Language::English, documents).build();
        let mut unique_sources = BTreeMap::new();
        for (name, description) in source_descriptions {
            unique_sources
                .entry(name)
                .and_modify(|existing: &mut Option<String>| {
                    if existing.is_none() {
                        *existing = description.clone();
                    }
                })
                .or_insert(description);
        }
        let sources = if unique_sources.is_empty() {
            "None currently enabled.".into()
        } else {
            unique_sources
                .into_iter()
                .map(|(name, description)| match description {
                    Some(description) => format!("- {name}: {description}"),
                    None => format!("- {name}"),
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let description = format!(
            "# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nYou have access to tools from the following sources:\n{sources}\nSome of the tools may not have been provided to you upfront, and you should use this tool (`tool_search`) to search for the required tools. For MCP tool discovery, always use `tool_search` instead of `list_mcp_resources` or `list_mcp_resource_templates`."
        );
        let spec = ToolSpec::hosted(
            ToolName::plain("tool_search"),
            json!({
                "type":"tool_search",
                "execution":"client",
                "description":description,
                "parameters":{
                    "type":"object",
                    "properties":{
                        "query":{"type":"string","description":"Search query for deferred tools."},
                        "limit":{"type":"number","description":format!("Maximum number of tools to return. Defaults to {TOOL_SEARCH_DEFAULT_LIMIT}.")}
                    },
                    "required":["query"],
                    "additionalProperties":false
                }
            }),
        );
        Self {
            specs,
            spec,
            engine,
        }
    }
}

impl ToolHandler for ToolSearchHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("tool_search")
    }

    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn matches_payload(&self, payload: &ToolPayload) -> bool {
        matches!(payload, ToolPayload::ToolSearch { .. })
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            let ToolPayload::ToolSearch { arguments } = &invocation.call.payload else {
                return Err(ToolError::InvalidCall(
                    "tool_search requires a search payload".into(),
                ));
            };
            let query = arguments
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|query| !query.is_empty())
                .ok_or_else(|| ToolError::Handler("query must not be empty".into()))?;
            let limit = arguments
                .get("limit")
                .and_then(Value::as_u64)
                .map(|limit| limit as usize)
                .unwrap_or(TOOL_SEARCH_DEFAULT_LIMIT);
            if limit == 0 {
                return Err(ToolError::Handler("limit must be greater than zero".into()));
            }
            let selected = self
                .engine
                .search(query, limit)
                .into_iter()
                .filter_map(|result| self.specs.get(result.document.id))
                .cloned()
                .collect::<Vec<_>>();
            Ok(ToolOutput::success(Value::Array(wire_specs(selected))))
        })
    }
}

fn empty_object_schema() -> Value {
    json!({
        "type":"object",
        "properties":{},
        "additionalProperties":false
    })
}

fn require_function_payload(invocation: &ToolInvocation, tool_name: &str) -> Result<(), ToolError> {
    if matches!(invocation.call.payload, ToolPayload::Function { .. }) {
        Ok(())
    } else {
        Err(ToolError::InvalidCall(format!(
            "{tool_name} requires a function payload"
        )))
    }
}

fn parse_function_args<T: for<'de> Deserialize<'de>>(
    invocation: &ToolInvocation,
    tool_name: &str,
) -> Result<T, ToolError> {
    let ToolPayload::Function { arguments } = &invocation.call.payload else {
        return Err(ToolError::InvalidCall(format!(
            "{tool_name} requires function arguments"
        )));
    };
    serde_json::from_str(arguments)
        .map_err(|error| ToolError::Handler(format!("invalid {tool_name} arguments: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ToolCall, ToolCallRuntime, ToolRegistry, ToolRouter};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    fn invocation(name: ToolName, arguments: Value) -> ToolInvocation {
        ToolInvocation {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            call: ToolCall {
                tool_name: name,
                call_id: "call".into(),
                payload: ToolPayload::Function {
                    arguments: arguments.to_string(),
                },
            },
            cancellation: CancellationToken::new(),
            input_activity: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn current_time_and_context_remaining_match_codex_fragments() {
        let time = current_time_handler()
            .handle(invocation(
                ToolName::namespaced("clock", "curr_time"),
                json!({}),
            ))
            .await
            .unwrap();
        assert!(time.content.as_str().unwrap().starts_with("It is "));
        assert!(time.content.as_str().unwrap().ends_with(" UTC."));
        let context = context_remaining_handler(Arc::new(|_, _| Some(42)))
            .handle(invocation(
                ToolName::plain("get_context_remaining"),
                json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(
            context.content,
            "You have 42 tokens left in this context window."
        );
    }

    #[tokio::test]
    async fn sleep_is_bounded_and_cancellable() {
        let input_activity = CancellationToken::new();
        input_activity.cancel();
        let mut invocation = invocation(
            ToolName::namespaced("clock", "sleep"),
            json!({"duration_ms":1000}),
        );
        invocation.input_activity = input_activity;
        let output = sleep_handler().handle(invocation).await.unwrap();
        assert!(
            output
                .content
                .as_str()
                .unwrap()
                .contains("interrupted by new input")
        );
    }

    #[tokio::test]
    async fn view_image_returns_structured_image_content() {
        let temp = TempDir::new().unwrap();
        tokio::fs::write(temp.path().join("image.bin"), b"image")
            .await
            .unwrap();
        let output = view_image_handler(temp.path().to_path_buf(), true)
            .handle(invocation(
                ToolName::plain("view_image"),
                json!({"path":"image.bin","detail":"original"}),
            ))
            .await
            .unwrap();
        assert_eq!(output.content[0]["type"], "input_image");
        assert_eq!(output.content[0]["detail"], "original");
    }

    #[tokio::test]
    async fn tool_search_uses_bm25_and_returns_deferred_wire_specs() {
        let deferred = vec![
            ToolSpec::function(
                ToolName::plain("calendar_create"),
                "Create calendar event",
                empty_object_schema(),
            ),
            ToolSpec::function(
                ToolName::plain("box_upload"),
                "Upload file to Box",
                empty_object_schema(),
            ),
        ];
        let handler = tool_search_handler(deferred, vec![("apps".into(), None)]);
        let output = handler
            .handle(ToolInvocation {
                thread_id: "thread".into(),
                turn_id: "turn".into(),
                call: ToolCall {
                    tool_name: ToolName::plain("tool_search"),
                    call_id: "search".into(),
                    payload: ToolPayload::ToolSearch {
                        arguments: json!({"query":"calendar event","limit":1}),
                    },
                },
                cancellation: CancellationToken::new(),
                input_activity: CancellationToken::new(),
            })
            .await
            .unwrap();
        assert_eq!(output.content[0]["name"], "calendar_create");
    }

    #[test]
    fn registry_coalesces_clock_namespace_and_hosted_search() {
        let registry = ToolRegistry::new(
            [
                current_time_handler(),
                sleep_handler(),
                web_search_handler(),
            ],
            Vec::new(),
        )
        .unwrap();
        let wire = registry.model_visible_wire_specs();
        assert!(wire.iter().any(|tool| tool["type"] == "web_search"));
        let clock = wire
            .iter()
            .find(|tool| tool["type"] == "namespace")
            .unwrap();
        assert_eq!(clock["name"], "clock");
        assert_eq!(clock["tools"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn builtins_execute_through_the_shared_runtime() {
        let calls = Arc::new(AtomicUsize::new(0));
        let context_calls = Arc::clone(&calls);
        let registry = ToolRegistry::new(
            [
                current_time_handler(),
                context_remaining_handler(Arc::new(move |_, _| {
                    context_calls.fetch_add(1, Ordering::SeqCst);
                    Some(9)
                })),
            ],
            Vec::new(),
        )
        .unwrap();
        let runtime = ToolCallRuntime::new(Arc::new(ToolRouter::new(registry)));
        let response = runtime
            .handle_model_call(
                "thread",
                "turn",
                ToolCall {
                    tool_name: ToolName::plain("get_context_remaining"),
                    call_id: "call".into(),
                    payload: ToolPayload::Function {
                        arguments: "{}".into(),
                    },
                },
                CancellationToken::new(),
            )
            .await;
        assert_eq!(response["type"], "function_call_output");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
