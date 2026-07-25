//! Codex-compatible tool registry, router, lifecycle, and parallel admission.
//!
//! This crate is a source-level adaptation of OpenAI Codex `rust-v0.145.0`.
//! It does not invoke or embed the upstream executable.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

pub mod builtins;

pub type ToolFuture<'a> = Pin<Box<dyn Future<Output = Result<ToolOutput, ToolError>> + Send + 'a>>;
pub type LifecycleFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolName {
    pub namespace: Option<String>,
    pub name: String,
}

impl ToolName {
    pub fn plain(name: impl Into<String>) -> Self {
        Self {
            namespace: None,
            name: name.into(),
        }
    }

    pub fn namespaced(namespace: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            namespace: Some(namespace.into()),
            name: name.into(),
        }
    }

    pub fn display_name(&self) -> String {
        self.namespace
            .as_ref()
            .map(|namespace| format!("{namespace}{}", self.name))
            .unwrap_or_else(|| self.name.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolExposure {
    ModelVisible,
    Deferred,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: ToolName,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Option<Value>,
    pub namespace_description: Option<String>,
    pub strict: bool,
    pub defer_loading: Option<bool>,
    pub wire_override: Option<Value>,
}

impl ToolSpec {
    pub fn function(name: ToolName, description: impl Into<String>, input_schema: Value) -> Self {
        Self {
            name,
            description: description.into(),
            input_schema,
            output_schema: None,
            namespace_description: None,
            strict: false,
            defer_loading: None,
            wire_override: None,
        }
    }

    pub fn hosted(name: ToolName, wire: Value) -> Self {
        Self {
            name,
            description: String::new(),
            input_schema: Value::Null,
            output_schema: None,
            namespace_description: None,
            strict: false,
            defer_loading: None,
            wire_override: Some(wire),
        }
    }

    fn function_wire(&self) -> Value {
        let mut wire = json!({
            "type": "function",
            "name": self.name.name,
            "description": self.description,
            "parameters": self.input_schema,
            "strict": self.strict
        });
        if let Some(defer_loading) = self.defer_loading {
            wire["defer_loading"] = json!(defer_loading);
        }
        if let Some(output_schema) = &self.output_schema {
            wire["output_schema"] = output_schema.clone();
        }
        wire
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ToolPayload {
    Function { arguments: String },
    Custom { input: String },
    ToolSearch { arguments: Value },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub tool_name: ToolName,
    pub call_id: String,
    pub payload: ToolPayload,
}

#[derive(Debug, Clone)]
pub struct ToolInvocation {
    pub thread_id: String,
    pub turn_id: String,
    pub call: ToolCall,
    pub cancellation: CancellationToken,
    pub input_activity: CancellationToken,
}

pub fn dynamic_tool_server_request(
    request_id: Value,
    invocation: &ToolInvocation,
) -> Result<Value, ToolError> {
    let ToolPayload::Function { arguments } = &invocation.call.payload else {
        return Err(ToolError::InvalidCall(
            "dynamic tool requires function arguments".into(),
        ));
    };
    let arguments: Value = serde_json::from_str(arguments)
        .map_err(|error| ToolError::InvalidCall(format!("invalid tool arguments: {error}")))?;
    let request = json!({
        "id": request_id,
        "method": "item/tool/call",
        "params": {
            "threadId": invocation.thread_id,
            "turnId": invocation.turn_id,
            "callId": invocation.call.call_id,
            "namespace": invocation.call.tool_name.namespace,
            "tool": invocation.call.tool_name.name,
            "arguments": arguments
        }
    });
    serde_json::from_value::<tietiezhi_agent_protocol::ServerRequest>(request.clone())
        .map_err(|error| ToolError::InvalidCall(error.to_string()))?;
    Ok(request)
}

pub fn dynamic_tool_response_output(response: Value) -> Result<ToolOutput, ToolError> {
    let success = response
        .get("success")
        .and_then(Value::as_bool)
        .ok_or_else(|| ToolError::InvalidCall("success is required".into()))?;
    if !response.get("contentItems").is_some_and(Value::is_array) {
        return Err(ToolError::InvalidCall(
            "contentItems must be an array".into(),
        ));
    }
    Ok(ToolOutput {
        success,
        content: response,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutput {
    pub content: Value,
    pub success: bool,
}

impl ToolOutput {
    pub fn success(content: Value) -> Self {
        Self {
            content,
            success: true,
        }
    }

    pub fn aborted(call_id: &str, elapsed_seconds: f32) -> Self {
        Self {
            content: json!({
                "callId": call_id,
                "error": "tool call aborted",
                "elapsedSeconds": elapsed_seconds.max(0.1)
            }),
            success: false,
        }
    }

    pub fn to_response_item(&self, call: &ToolCall) -> Value {
        let output = model_output(&self.content);
        match &call.payload {
            ToolPayload::Custom { .. } => json!({
                "type": "custom_tool_call_output",
                "call_id": call.call_id,
                "output": output
            }),
            ToolPayload::ToolSearch { .. } => json!({
                "type": "tool_search_output",
                "call_id": call.call_id,
                "status": "completed",
                "execution": "client",
                "tools": self.content.as_array().cloned().unwrap_or_default()
            }),
            ToolPayload::Function { .. } => json!({
                "type": "function_call_output",
                "call_id": call.call_id,
                "output": output
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolError {
    Duplicate(String),
    Unknown(String),
    InvalidCall(String),
    Handler(String),
    Join(String),
}

impl fmt::Display for ToolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (kind, message) = match self {
            Self::Duplicate(message) => ("duplicate tool", message),
            Self::Unknown(message) => ("unknown tool", message),
            Self::InvalidCall(message) => ("invalid tool call", message),
            Self::Handler(message) => ("tool handler failed", message),
            Self::Join(message) => ("tool task failed", message),
        };
        write!(formatter, "{kind}: {message}")
    }
}

impl std::error::Error for ToolError {}

pub trait ToolHandler: Send + Sync {
    fn tool_name(&self) -> ToolName;
    fn spec(&self) -> ToolSpec;
    fn exposure(&self) -> ToolExposure {
        ToolExposure::ModelVisible
    }
    fn supports_parallel_tool_calls(&self) -> bool {
        false
    }
    fn waits_for_runtime_cancellation(&self) -> bool {
        false
    }
    fn matches_payload(&self, payload: &ToolPayload) -> bool {
        matches!(
            payload,
            ToolPayload::Function { .. } | ToolPayload::ToolSearch { .. }
        )
    }
    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolOutcome {
    Success,
    Failure,
    Aborted,
}

#[derive(Debug, Clone)]
pub struct ToolLifecycleEvent<'a> {
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub call_id: &'a str,
    pub tool_name: &'a ToolName,
}

pub trait ToolLifecycleContributor: Send + Sync {
    fn on_tool_start<'a>(&'a self, _event: ToolLifecycleEvent<'a>) -> LifecycleFuture<'a> {
        Box::pin(async {})
    }

    fn on_tool_finish<'a>(
        &'a self,
        _event: ToolLifecycleEvent<'a>,
        _outcome: ToolOutcome,
    ) -> LifecycleFuture<'a> {
        Box::pin(async {})
    }
}

#[derive(Clone)]
pub struct ToolRegistry {
    tools: Arc<HashMap<ToolName, Arc<dyn ToolHandler>>>,
    lifecycle: Arc<Vec<Arc<dyn ToolLifecycleContributor>>>,
}

impl ToolRegistry {
    pub fn new(
        tools: impl IntoIterator<Item = Arc<dyn ToolHandler>>,
        lifecycle: Vec<Arc<dyn ToolLifecycleContributor>>,
    ) -> Result<Self, ToolError> {
        let mut by_name = HashMap::new();
        for tool in tools {
            let name = tool.tool_name();
            if by_name.insert(name.clone(), tool).is_some() {
                return Err(ToolError::Duplicate(name.display_name()));
            }
        }
        Ok(Self {
            tools: Arc::new(by_name),
            lifecycle: Arc::new(lifecycle),
        })
    }

    pub fn handler(&self, name: &ToolName) -> Option<Arc<dyn ToolHandler>> {
        self.tools.get(name).map(Arc::clone)
    }

    pub fn model_visible_specs(&self) -> Vec<ToolSpec> {
        let mut specs = self
            .tools
            .values()
            .filter(|handler| handler.exposure() == ToolExposure::ModelVisible)
            .map(|handler| handler.spec())
            .collect::<Vec<_>>();
        specs.sort_by_key(|spec| spec.name.display_name());
        specs
    }

    pub fn model_visible_wire_specs(&self) -> Vec<Value> {
        wire_specs(self.model_visible_specs())
    }

    pub fn deferred_specs(&self) -> Vec<ToolSpec> {
        let mut specs = self
            .tools
            .values()
            .filter(|handler| handler.exposure() == ToolExposure::Deferred)
            .map(|handler| handler.spec())
            .collect::<Vec<_>>();
        specs.sort_by_key(|spec| spec.name.display_name());
        specs
    }
}

#[derive(Clone)]
pub struct ToolRouter {
    registry: ToolRegistry,
}

impl ToolRouter {
    pub fn new(registry: ToolRegistry) -> Self {
        Self { registry }
    }

    pub fn model_visible_specs(&self) -> Vec<ToolSpec> {
        self.registry.model_visible_specs()
    }

    pub fn model_visible_wire_specs(&self) -> Vec<Value> {
        self.registry.model_visible_wire_specs()
    }

    pub fn tool_supports_parallel(&self, call: &ToolCall) -> bool {
        self.registry
            .handler(&call.tool_name)
            .is_some_and(|handler| {
                handler.exposure() != ToolExposure::Hidden && handler.supports_parallel_tool_calls()
            })
    }

    pub fn build_tool_call(item: &Value) -> Result<Option<ToolCall>, ToolError> {
        match item.get("type").and_then(Value::as_str) {
            Some("function_call") => Ok(Some(ToolCall {
                tool_name: ToolName {
                    namespace: optional_string(item, "namespace"),
                    name: required_string(item, "name")?,
                },
                call_id: required_string(item, "call_id")?,
                payload: ToolPayload::Function {
                    arguments: required_string(item, "arguments")?,
                },
            })),
            Some("custom_tool_call") => Ok(Some(ToolCall {
                tool_name: ToolName {
                    namespace: optional_string(item, "namespace"),
                    name: required_string(item, "name")?,
                },
                call_id: required_string(item, "call_id")?,
                payload: ToolPayload::Custom {
                    input: required_string(item, "input")?,
                },
            })),
            Some("tool_search_call")
                if item.get("execution").and_then(Value::as_str) == Some("client") =>
            {
                Ok(Some(ToolCall {
                    tool_name: ToolName::plain("tool_search"),
                    call_id: required_string(item, "call_id")?,
                    payload: ToolPayload::ToolSearch {
                        arguments: item.get("arguments").cloned().unwrap_or(Value::Null),
                    },
                }))
            }
            Some("tool_search_call") => Ok(None),
            _ => Ok(None),
        }
    }

    async fn dispatch(
        &self,
        invocation: ToolInvocation,
        terminal_outcome: Arc<AtomicBool>,
    ) -> Result<ToolOutput, ToolError> {
        let handler = self
            .registry
            .handler(&invocation.call.tool_name)
            .ok_or_else(|| ToolError::Unknown(invocation.call.tool_name.display_name()))?;
        if handler.exposure() == ToolExposure::Hidden
            || !handler.matches_payload(&invocation.call.payload)
        {
            return Err(ToolError::Unknown(invocation.call.tool_name.display_name()));
        }
        let event = ToolLifecycleEvent {
            thread_id: &invocation.thread_id,
            turn_id: &invocation.turn_id,
            call_id: &invocation.call.call_id,
            tool_name: &invocation.call.tool_name,
        };
        for contributor in self.registry.lifecycle.iter() {
            contributor.on_tool_start(event.clone()).await;
        }
        let output = handler.handle(invocation.clone()).await;
        let outcome = match &output {
            Ok(output) if output.success => ToolOutcome::Success,
            Ok(_) | Err(_) => ToolOutcome::Failure,
        };
        if !terminal_outcome.swap(true, Ordering::AcqRel) {
            for contributor in self.registry.lifecycle.iter() {
                contributor.on_tool_finish(event.clone(), outcome).await;
            }
        }
        output
    }
}

#[derive(Clone)]
pub struct ToolCallRuntime {
    router: Arc<ToolRouter>,
    admission: Arc<RwLock<()>>,
}

impl ToolCallRuntime {
    pub fn new(router: Arc<ToolRouter>) -> Self {
        Self {
            router,
            admission: Arc::new(RwLock::new(())),
        }
    }

    pub async fn handle(
        &self,
        thread_id: impl Into<String>,
        turn_id: impl Into<String>,
        call: ToolCall,
        cancellation: CancellationToken,
    ) -> Result<ToolOutput, ToolError> {
        self.handle_with_activity(
            thread_id,
            turn_id,
            call,
            cancellation,
            CancellationToken::new(),
        )
        .await
    }

    pub async fn handle_with_activity(
        &self,
        thread_id: impl Into<String>,
        turn_id: impl Into<String>,
        call: ToolCall,
        cancellation: CancellationToken,
        input_activity: CancellationToken,
    ) -> Result<ToolOutput, ToolError> {
        let started = Instant::now();
        let supports_parallel = self.router.tool_supports_parallel(&call);
        let handler = self
            .router
            .registry
            .handler(&call.tool_name)
            .ok_or_else(|| ToolError::Unknown(call.tool_name.display_name()))?;
        let waits_for_runtime_cancellation = handler.waits_for_runtime_cancellation();
        let thread_id = thread_id.into();
        let turn_id = turn_id.into();
        let invocation = ToolInvocation {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            call: call.clone(),
            cancellation: cancellation.clone(),
            input_activity,
        };
        let router = Arc::clone(&self.router);
        let admission = Arc::clone(&self.admission);
        let terminal_outcome = Arc::new(AtomicBool::new(false));
        let dispatch_terminal_outcome = Arc::clone(&terminal_outcome);
        let mut task = tokio::spawn(async move {
            if supports_parallel {
                let _guard = admission.read().await;
                router.dispatch(invocation, dispatch_terminal_outcome).await
            } else {
                let _guard = admission.write().await;
                router.dispatch(invocation, dispatch_terminal_outcome).await
            }
        });
        tokio::select! {
            result = &mut task => result.map_err(|error| ToolError::Join(error.to_string()))?,
            _ = cancellation.cancelled() => {
                if terminal_outcome.swap(true, Ordering::AcqRel) || task.is_finished() {
                    return task.await.map_err(|error| ToolError::Join(error.to_string()))?;
                }
                if waits_for_runtime_cancellation {
                    let _ = task.await;
                } else {
                    task.abort();
                    let _ = task.await;
                }
                self.notify_aborted(&call, &thread_id, &turn_id).await;
                Ok(ToolOutput::aborted(&call.call_id, started.elapsed().as_secs_f32()))
            }
        }
    }

    pub async fn handle_model_call(
        &self,
        thread_id: impl Into<String>,
        turn_id: impl Into<String>,
        call: ToolCall,
        cancellation: CancellationToken,
    ) -> Value {
        self.handle_model_call_with_activity(
            thread_id,
            turn_id,
            call,
            cancellation,
            CancellationToken::new(),
        )
        .await
    }

    pub async fn handle_model_call_with_activity(
        &self,
        thread_id: impl Into<String>,
        turn_id: impl Into<String>,
        call: ToolCall,
        cancellation: CancellationToken,
        input_activity: CancellationToken,
    ) -> Value {
        match self
            .handle_with_activity(
                thread_id,
                turn_id,
                call.clone(),
                cancellation,
                input_activity,
            )
            .await
        {
            Ok(output) => output.to_response_item(&call),
            Err(error) => ToolOutput {
                content: Value::String(error.to_string()),
                success: false,
            }
            .to_response_item(&call),
        }
    }

    async fn notify_aborted(&self, call: &ToolCall, thread_id: &str, turn_id: &str) {
        let event = ToolLifecycleEvent {
            thread_id,
            turn_id,
            call_id: &call.call_id,
            tool_name: &call.tool_name,
        };
        for contributor in self.router.registry.lifecycle.iter() {
            contributor
                .on_tool_finish(event.clone(), ToolOutcome::Aborted)
                .await;
        }
    }
}

fn required_string(item: &Value, key: &str) -> Result<String, ToolError> {
    item.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ToolError::InvalidCall(format!("{key} is required")))
}

fn optional_string(item: &Value, key: &str) -> Option<String> {
    item.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn model_output(content: &Value) -> Value {
    match content {
        Value::String(_) | Value::Array(_) => content.clone(),
        other => Value::String(other.to_string()),
    }
}

pub fn wire_specs(specs: impl IntoIterator<Item = ToolSpec>) -> Vec<Value> {
    let mut plain = Vec::new();
    let mut namespaces: BTreeMap<String, (String, Vec<Value>)> = BTreeMap::new();
    for spec in specs {
        if let Some(wire) = spec.wire_override.clone() {
            plain.push(wire);
        } else if let Some(namespace) = &spec.name.namespace {
            let description = spec
                .namespace_description
                .clone()
                .unwrap_or_else(|| format!("Tools in the {namespace} namespace."));
            namespaces
                .entry(namespace.clone())
                .or_insert_with(|| (description, Vec::new()))
                .1
                .push(spec.function_wire());
        } else {
            plain.push(spec.function_wire());
        }
    }
    plain.extend(namespaces.into_iter().map(|(name, (description, tools))| {
        json!({
            "type": "namespace",
            "name": name,
            "description": description,
            "tools": tools
        })
    }));
    plain
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    struct TestHandler {
        name: ToolName,
        exposure: ToolExposure,
        parallel: bool,
        waits_for_cancellation: bool,
        active: Arc<AtomicUsize>,
        max_active: Arc<AtomicUsize>,
        delay: Duration,
    }

    impl ToolHandler for TestHandler {
        fn tool_name(&self) -> ToolName {
            self.name.clone()
        }

        fn spec(&self) -> ToolSpec {
            ToolSpec::function(
                self.name.clone(),
                self.name.display_name(),
                json!({"type":"object"}),
            )
        }

        fn exposure(&self) -> ToolExposure {
            self.exposure
        }

        fn supports_parallel_tool_calls(&self) -> bool {
            self.parallel
        }

        fn waits_for_runtime_cancellation(&self) -> bool {
            self.waits_for_cancellation
        }

        fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
            let active = Arc::clone(&self.active);
            let max_active = Arc::clone(&self.max_active);
            let delay = self.delay;
            Box::pin(async move {
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                max_active.fetch_max(now, Ordering::SeqCst);
                if invocation.cancellation.is_cancelled() && delay.is_zero() {
                    active.fetch_sub(1, Ordering::SeqCst);
                    return Ok(ToolOutput::aborted(&invocation.call.call_id, 0.1));
                }
                tokio::time::sleep(delay).await;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(ToolOutput::success(
                    json!({"callId":invocation.call.call_id}),
                ))
            })
        }
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(String, ToolOutcome)>>);

    impl ToolLifecycleContributor for Recorder {
        fn on_tool_start<'a>(&'a self, event: ToolLifecycleEvent<'a>) -> LifecycleFuture<'a> {
            Box::pin(async move {
                self.0
                    .lock()
                    .unwrap()
                    .push((format!("start:{}", event.call_id), ToolOutcome::Success));
            })
        }

        fn on_tool_finish<'a>(
            &'a self,
            event: ToolLifecycleEvent<'a>,
            outcome: ToolOutcome,
        ) -> LifecycleFuture<'a> {
            Box::pin(async move {
                self.0
                    .lock()
                    .unwrap()
                    .push((format!("finish:{}", event.call_id), outcome));
            })
        }
    }

    fn handler(name: &str, parallel: bool, delay_ms: u64) -> Arc<TestHandler> {
        Arc::new(TestHandler {
            name: ToolName::plain(name),
            exposure: ToolExposure::ModelVisible,
            parallel,
            waits_for_cancellation: false,
            active: Arc::new(AtomicUsize::new(0)),
            max_active: Arc::new(AtomicUsize::new(0)),
            delay: Duration::from_millis(delay_ms),
        })
    }

    fn call(name: &str, id: &str) -> ToolCall {
        ToolCall {
            tool_name: ToolName::plain(name),
            call_id: id.into(),
            payload: ToolPayload::Function {
                arguments: "{}".into(),
            },
        }
    }

    #[test]
    fn registry_rejects_duplicates_and_hides_non_visible_specs() {
        let first = handler("read", true, 0);
        assert!(matches!(
            ToolRegistry::new(
                [
                    Arc::clone(&first) as Arc<dyn ToolHandler>,
                    first as Arc<dyn ToolHandler>
                ],
                Vec::new()
            ),
            Err(ToolError::Duplicate(_))
        ));
        let hidden = Arc::new(TestHandler {
            exposure: ToolExposure::Hidden,
            ..TestHandler {
                name: ToolName::plain("hidden"),
                exposure: ToolExposure::ModelVisible,
                parallel: true,
                waits_for_cancellation: false,
                active: Arc::new(AtomicUsize::new(0)),
                max_active: Arc::new(AtomicUsize::new(0)),
                delay: Duration::ZERO,
            }
        });
        let registry = ToolRegistry::new([hidden as Arc<dyn ToolHandler>], Vec::new()).unwrap();
        assert!(registry.model_visible_specs().is_empty());
    }

    #[test]
    fn router_parses_function_custom_and_client_search_calls() {
        let function = ToolRouter::build_tool_call(&json!({
            "type":"function_call","name":"read","arguments":"{}","call_id":"a"
        }))
        .unwrap()
        .unwrap();
        assert_eq!(function.tool_name, ToolName::plain("read"));
        let custom = ToolRouter::build_tool_call(&json!({
            "type":"custom_tool_call","namespace":"mcp__","name":"draw","input":"x","call_id":"b"
        }))
        .unwrap()
        .unwrap();
        assert_eq!(custom.tool_name, ToolName::namespaced("mcp__", "draw"));
        assert!(
            ToolRouter::build_tool_call(&json!({
                "type":"tool_search_call","execution":"server","call_id":"c"
            }))
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn dynamic_tool_bridge_uses_exact_app_server_request_and_response_shapes() {
        let invocation = ToolInvocation {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            call: ToolCall {
                tool_name: ToolName::namespaced("apps__", "lookup"),
                call_id: "call".into(),
                payload: ToolPayload::Function {
                    arguments: r#"{"query":"value"}"#.into(),
                },
            },
            cancellation: CancellationToken::new(),
            input_activity: CancellationToken::new(),
        };
        let request = dynamic_tool_server_request(json!(7), &invocation).unwrap();
        assert_eq!(request["method"], "item/tool/call");
        assert_eq!(request["params"]["namespace"], "apps__");
        assert_eq!(request["params"]["arguments"]["query"], "value");
        let output = dynamic_tool_response_output(json!({
            "contentItems":[{"type":"inputText","text":"done"}],
            "success":true
        }))
        .unwrap();
        assert!(output.success);
        assert_eq!(
            output.to_response_item(&invocation.call)["type"],
            "function_call_output"
        );
    }

    #[tokio::test]
    async fn unknown_tools_return_model_visible_failure_items() {
        let registry = ToolRegistry::new(Vec::<Arc<dyn ToolHandler>>::new(), Vec::new()).unwrap();
        let runtime = ToolCallRuntime::new(Arc::new(ToolRouter::new(registry)));
        let response = runtime
            .handle_model_call(
                "thread",
                "turn",
                call("missing", "call"),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(response["type"], "function_call_output");
        assert!(
            response["output"]
                .as_str()
                .unwrap()
                .contains("unknown tool")
        );
    }

    #[tokio::test]
    async fn parallel_tools_share_the_gate_while_serial_tools_exclude_them() {
        let parallel = handler("read", true, 40);
        let serial = handler("write", false, 10);
        let max = Arc::clone(&parallel.max_active);
        let registry = ToolRegistry::new(
            [
                parallel as Arc<dyn ToolHandler>,
                serial as Arc<dyn ToolHandler>,
            ],
            Vec::new(),
        )
        .unwrap();
        let runtime = ToolCallRuntime::new(Arc::new(ToolRouter::new(registry)));
        let first = runtime.handle("t", "r", call("read", "a"), CancellationToken::new());
        let second = runtime.handle("t", "r", call("read", "b"), CancellationToken::new());
        let (first, second) = tokio::join!(first, second);
        assert!(first.unwrap().success);
        assert!(second.unwrap().success);
        assert_eq!(max.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn serial_tools_do_not_overlap_parallel_tools() {
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let make = |name: &str, parallel: bool, delay: u64| {
            Arc::new(TestHandler {
                name: ToolName::plain(name),
                exposure: ToolExposure::ModelVisible,
                parallel,
                waits_for_cancellation: false,
                active: Arc::clone(&active),
                max_active: Arc::clone(&max_active),
                delay: Duration::from_millis(delay),
            }) as Arc<dyn ToolHandler>
        };
        let registry = ToolRegistry::new(
            [make("read", true, 40), make("write", false, 10)],
            Vec::new(),
        )
        .unwrap();
        let runtime = ToolCallRuntime::new(Arc::new(ToolRouter::new(registry)));
        let read = tokio::spawn({
            let runtime = runtime.clone();
            async move {
                runtime
                    .handle("t", "r", call("read", "a"), CancellationToken::new())
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(5)).await;
        let write = runtime.handle("t", "r", call("write", "b"), CancellationToken::new());
        let (read, write) = tokio::join!(read, write);
        assert!(read.unwrap().unwrap().success);
        assert!(write.unwrap().success);
        assert_eq!(max_active.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn lifecycle_has_exactly_one_terminal_outcome_on_cancellation() {
        let recorder = Arc::new(Recorder::default());
        let registry = ToolRegistry::new(
            [handler("slow", true, 500) as Arc<dyn ToolHandler>],
            vec![Arc::clone(&recorder) as Arc<dyn ToolLifecycleContributor>],
        )
        .unwrap();
        let runtime = ToolCallRuntime::new(Arc::new(ToolRouter::new(registry)));
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let output = runtime
            .handle("thread", "turn", call("slow", "call"), cancellation)
            .await
            .unwrap();
        assert!(!output.success);
        assert_eq!(
            recorder.0.lock().unwrap().as_slice(),
            [("finish:call".into(), ToolOutcome::Aborted)]
        );
    }
}
