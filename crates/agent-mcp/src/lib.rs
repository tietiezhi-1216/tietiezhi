use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock as StdRwLock};
use std::time::Duration;

use async_trait::async_trait;
use rmcp::model::{
    CallToolRequestParams, ElicitRequestParams, ElicitResult, ElicitationAction, Meta,
    ProgressNotificationParam, ReadResourceRequestParams,
};
use rmcp::service::{NotificationContext, RequestContext, RoleClient, RunningService};
use rmcp::transport::auth::{
    AuthClient, AuthError, AuthorizationManager, AuthorizationSession, CredentialStore,
    StoredCredentials,
};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{ClientHandler, ServiceExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tietiezhi_agent_tools::{
    ToolError, ToolExposure, ToolFuture, ToolHandler, ToolInvocation, ToolName, ToolOutput,
    ToolPayload, ToolSpec,
};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

const DEFAULT_INIT_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_LIST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_OAUTH_TIMEOUT: Duration = Duration::from_secs(300);
const OAUTH_SERVICE: &str = "com.tietiezhi.tietiezhi.mcp-oauth";

pub type HostFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub enabled_tools: Vec<String>,
    #[serde(default)]
    pub disabled_tools: Vec<String>,
    #[serde(default = "default_init_timeout_secs")]
    pub startup_timeout_secs: u64,
    #[serde(default = "default_call_timeout_secs")]
    pub tool_timeout_secs: u64,
    #[serde(default)]
    pub oauth_scopes: Vec<String>,
    pub transport: McpTransport,
}

fn default_true() -> bool {
    true
}

fn default_init_timeout_secs() -> u64 {
    DEFAULT_INIT_TIMEOUT.as_secs()
}

fn default_call_timeout_secs() -> u64 {
    DEFAULT_CALL_TIMEOUT.as_secs()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
        #[serde(default)]
        oauth: bool,
    },
}

impl McpServerConfig {
    pub fn allows_tool(&self, tool: &str) -> bool {
        (self.enabled_tools.is_empty() || self.enabled_tools.iter().any(|item| item == tool))
            && !self.disabled_tools.iter().any(|item| item == tool)
    }

    pub fn startup_timeout(&self) -> Duration {
        Duration::from_secs(self.startup_timeout_secs.max(1))
    }

    pub fn tool_timeout(&self) -> Duration {
        Duration::from_secs(self.tool_timeout_secs.max(1))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallContext {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProgress {
    pub context: McpCallContext,
    pub message: String,
    pub progress: f64,
    pub total: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpElicitation {
    pub request_id: String,
    pub context: McpCallContext,
    pub server_name: String,
    #[serde(flatten)]
    pub request: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpElicitationResponse {
    pub action: String,
    pub content: Option<Value>,
    #[serde(rename = "_meta")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutedServerRequest {
    pub recipients: Vec<String>,
    pub id: Value,
    pub method: String,
    pub params: Value,
}

impl RoutedServerRequest {
    pub fn wire_message(&self) -> Value {
        json!({
            "id": self.id,
            "method": self.method,
            "params": self.params
        })
    }
}

pub struct PendingElicitation {
    pub request: RoutedServerRequest,
    pub receiver: oneshot::Receiver<Result<McpElicitationResponse, String>>,
}

#[derive(Default)]
pub struct ElicitationBroker {
    next_id: AtomicU64,
    pending: StdMutex<HashMap<String, oneshot::Sender<Result<McpElicitationResponse, String>>>>,
}

impl ElicitationBroker {
    pub fn begin(
        &self,
        recipients: Vec<String>,
        elicitation: McpElicitation,
    ) -> Result<PendingElicitation, String> {
        let id = format!(
            "mcp-elicitation-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "MCP elicitation request state lock poisoned".to_string())?
            .insert(id.clone(), sender);
        let mut params = elicitation.request;
        let object = params
            .as_object_mut()
            .ok_or_else(|| "MCP elicitation request must be an object".to_string())?;
        object.insert(
            "threadId".into(),
            Value::String(elicitation.context.thread_id),
        );
        object.insert("turnId".into(), Value::String(elicitation.context.turn_id));
        object.insert("serverName".into(), Value::String(elicitation.server_name));
        let request = RoutedServerRequest {
            recipients,
            id: Value::String(id),
            method: "mcpServer/elicitation/request".into(),
            params,
        };
        Ok(PendingElicitation { request, receiver })
    }

    pub fn resolve(&self, response: &Value) -> Result<bool, String> {
        let id = response
            .get("id")
            .map(request_id_key)
            .ok_or_else(|| "MCP elicitation response id is required".to_string())?;
        let sender = self
            .pending
            .lock()
            .map_err(|_| "MCP elicitation request state lock poisoned".to_string())?
            .remove(&id);
        let Some(sender) = sender else {
            return Ok(false);
        };
        let result = response
            .get("result")
            .cloned()
            .ok_or_else(|| {
                response
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("MCP elicitation failed")
                    .to_owned()
            })
            .and_then(|value| {
                serde_json::from_value(value)
                    .map_err(|error| format!("invalid MCP elicitation response: {error}"))
            });
        let _ = sender.send(result);
        Ok(true)
    }

    pub fn cancel(&self, id: &Value) -> Result<bool, String> {
        Ok(self
            .pending
            .lock()
            .map_err(|_| "MCP elicitation request state lock poisoned".to_string())?
            .remove(&request_id_key(id))
            .is_some())
    }
}

pub trait McpHost: Send + Sync + 'static {
    fn progress(&self, progress: McpProgress);
    fn startup_status(&self, server: &str, status: &str, error: Option<&str>);
    fn oauth_completed(
        &self,
        server: &str,
        thread_id: Option<&str>,
        success: bool,
        error: Option<&str>,
    );
    fn elicit(&self, request: McpElicitation) -> HostFuture<McpElicitationResponse>;
}

#[derive(Default)]
pub struct NullMcpHost;

impl McpHost for NullMcpHost {
    fn progress(&self, _progress: McpProgress) {}
    fn startup_status(&self, _server: &str, _status: &str, _error: Option<&str>) {}
    fn oauth_completed(
        &self,
        _server: &str,
        _thread_id: Option<&str>,
        _success: bool,
        _error: Option<&str>,
    ) {
    }
    fn elicit(&self, _request: McpElicitation) -> HostFuture<McpElicitationResponse> {
        Box::pin(async {
            McpElicitationResponse {
                action: "decline".into(),
                content: None,
                meta: None,
            }
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Option<Value>,
    pub annotations: Option<Value>,
    pub icons: Option<Value>,
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInventory {
    pub server_info: Option<Value>,
    pub tools: Vec<Value>,
    pub resources: Vec<Value>,
    pub resource_templates: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallResult {
    pub content: Vec<Value>,
    pub structured_content: Option<Value>,
    pub is_error: bool,
    #[serde(rename = "_meta")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone)]
pub enum McpToolRuntimeEvent {
    Started {
        context: McpCallContext,
        server: String,
        tool: String,
        arguments: Value,
    },
    Completed {
        context: McpCallContext,
        server: String,
        tool: String,
        arguments: Value,
        result: McpCallResult,
        duration_ms: u64,
    },
    Failed {
        context: McpCallContext,
        server: String,
        tool: String,
        arguments: Value,
        error: String,
        duration_ms: u64,
    },
}

pub type McpToolObserver =
    Arc<dyn Fn(McpToolRuntimeEvent) -> Result<(), ToolError> + Send + Sync + 'static>;

pub struct McpToolHandler {
    manager: McpManager,
    config: McpServerConfig,
    info: McpToolInfo,
    observer: Option<McpToolObserver>,
}

impl McpToolHandler {
    pub fn new(
        manager: McpManager,
        config: McpServerConfig,
        info: McpToolInfo,
        observer: Option<McpToolObserver>,
    ) -> Arc<Self> {
        Arc::new(Self {
            manager,
            config,
            info,
            observer,
        })
    }

    fn read_only(&self) -> bool {
        self.info
            .annotations
            .as_ref()
            .and_then(|value| value.get("readOnlyHint"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
}

impl ToolHandler for McpToolHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(namespaced(&self.config.id, &self.info.name))
    }

    fn spec(&self) -> ToolSpec {
        let mut spec = ToolSpec::function(
            self.tool_name(),
            self.info.description.clone(),
            self.info.input_schema.clone(),
        );
        spec.output_schema.clone_from(&self.info.output_schema);
        spec
    }

    fn exposure(&self) -> ToolExposure {
        ToolExposure::ModelVisible
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        self.read_only()
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            let ToolPayload::Function { arguments } = &invocation.call.payload else {
                return Err(ToolError::InvalidCall(
                    "MCP tools require function arguments".into(),
                ));
            };
            let arguments: Value = serde_json::from_str(arguments).map_err(|error| {
                ToolError::InvalidCall(format!("invalid MCP tool arguments: {error}"))
            })?;
            let context = McpCallContext {
                thread_id: invocation.thread_id,
                turn_id: invocation.turn_id,
                item_id: invocation.call.call_id,
            };
            let destructive = self
                .info
                .annotations
                .as_ref()
                .and_then(|value| value.get("destructiveHint"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if destructive && !self.read_only() {
                match self
                    .manager
                    .approve_destructive_tool(
                        context.clone(),
                        &self.config.id,
                        &self.info.name,
                        self.info.annotations.clone(),
                    )
                    .await
                {
                    "accept" => {}
                    "cancel" => {
                        return Ok(ToolOutput::aborted(&context.item_id, 0.1));
                    }
                    _ => {
                        return Ok(ToolOutput::failure(json!({
                            "error":"destructive MCP tool call declined"
                        })));
                    }
                }
            }
            if let Some(observer) = &self.observer {
                observer(McpToolRuntimeEvent::Started {
                    context: context.clone(),
                    server: self.config.id.clone(),
                    tool: self.info.name.clone(),
                    arguments: arguments.clone(),
                })?;
            }
            let started = std::time::Instant::now();
            let result = tokio::select! {
                result = self.manager.call_tool_rich(
                    &self.config,
                    &self.info.name,
                    &arguments,
                    Some(context.clone()),
                    None,
                ) => result,
                () = invocation.cancellation.cancelled() => {
                    return Ok(ToolOutput::aborted(&context.item_id, started.elapsed().as_secs_f32()));
                }
            };
            let duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            match result {
                Ok(result) => {
                    if let Some(observer) = &self.observer {
                        observer(McpToolRuntimeEvent::Completed {
                            context,
                            server: self.config.id.clone(),
                            tool: self.info.name.clone(),
                            arguments,
                            result: result.clone(),
                            duration_ms,
                        })?;
                    }
                    let mut output = if result.is_error {
                        ToolOutput::failure(json!({
                            "content":result.content,
                            "structuredContent":result.structured_content,
                            "_meta":result.meta
                        }))
                    } else {
                        ToolOutput::success(json!({
                            "content":result.content,
                            "structuredContent":result.structured_content,
                            "_meta":result.meta
                        }))
                    };
                    output.metadata = Some(json!({
                        "type":"mcpToolCall",
                        "server":self.config.id,
                        "tool":self.info.name,
                        "result":result
                    }));
                    Ok(output)
                }
                Err(error) => {
                    if let Some(observer) = &self.observer {
                        observer(McpToolRuntimeEvent::Failed {
                            context,
                            server: self.config.id.clone(),
                            tool: self.info.name.clone(),
                            arguments,
                            error: error.clone(),
                            duration_ms,
                        })?;
                    }
                    Ok(ToolOutput::failure(json!({"error":error})))
                }
            }
        })
    }
}

impl McpCallResult {
    pub fn model_text(&self) -> String {
        let mut output = Vec::new();
        for block in &self.content {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        output.push(text.to_owned());
                    }
                }
                Some("image") | Some("audio") | Some("resource") | Some("resource_link") => {
                    output.push(block.to_string());
                }
                _ => output.push(block.to_string()),
            }
        }
        if let Some(structured) = &self.structured_content {
            output.push(structured.to_string());
        }
        if output.is_empty() {
            "[无输出]".into()
        } else {
            output.join("\n")
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub id: String,
    pub state: String,
    pub tool_count: usize,
    pub error: String,
    pub auth_status: String,
}

#[derive(Debug, thiserror::Error)]
pub enum McpRuntimeError {
    #[error("{0}")]
    Message(String),
    #[error("MCP server `{0}` is not configured for OAuth")]
    OAuthUnsupported(String),
}

#[derive(Default)]
struct ActiveCalls {
    by_token: HashMap<String, McpCallContext>,
    stack: Vec<McpCallContext>,
}

impl ActiveCalls {
    fn insert(&mut self, token: String, context: McpCallContext) {
        self.by_token.insert(token, context.clone());
        self.stack.push(context);
    }

    fn remove(&mut self, token: &str, context: &McpCallContext) {
        self.by_token.remove(token);
        if let Some(index) = self.stack.iter().rposition(|item| item == context) {
            self.stack.remove(index);
        }
    }

    fn resolve(&self, token: &str) -> Option<McpCallContext> {
        self.by_token
            .get(token)
            .cloned()
            .or_else(|| self.stack.last().cloned())
    }
}

#[derive(Clone)]
struct RuntimeClientHandler {
    server: String,
    host: Arc<StdRwLock<Arc<dyn McpHost>>>,
    active_calls: Arc<StdMutex<ActiveCalls>>,
    elicitation_allowed: Arc<StdRwLock<HashMap<String, bool>>>,
}

impl RuntimeClientHandler {
    fn progress_token_key(token: &rmcp::model::ProgressToken) -> String {
        serde_json::to_string(token).unwrap_or_default()
    }

    fn active_context(&self, meta: Option<&Meta>) -> Option<McpCallContext> {
        let token = meta
            .and_then(|meta| meta.0.get("progressToken"))
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .map(|token| Self::progress_token_key(&token));
        let active = self.active_calls.lock().ok()?;
        token
            .as_deref()
            .and_then(|token| active.resolve(token))
            .or_else(|| active.stack.last().cloned())
    }
}

impl ClientHandler for RuntimeClientHandler {
    fn get_info(&self) -> rmcp::model::ClientInfo {
        rmcp::model::ClientInfo::new(
            rmcp::model::ClientCapabilities::builder()
                .enable_elicitation()
                .enable_elicitation_schema_validation()
                .build(),
            rmcp::model::Implementation::new("tietiezhi-codex-runtime", env!("CARGO_PKG_VERSION"))
                .with_title("Tietiezhi Codex Runtime"),
        )
    }

    async fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> Result<ElicitResult, rmcp::ErrorData> {
        let context = self.active_context(match &request {
            ElicitRequestParams::FormElicitationParams { meta, .. }
            | ElicitRequestParams::UrlElicitationParams { meta, .. } => meta.as_ref(),
            _ => None,
        });
        let Some(context) = context else {
            return Ok(ElicitResult::new(ElicitationAction::Decline));
        };
        if !self
            .elicitation_allowed
            .read()
            .ok()
            .and_then(|allowed| allowed.get(&context.thread_id).copied())
            .unwrap_or(true)
        {
            return Ok(ElicitResult::new(ElicitationAction::Decline));
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let request = serde_json::to_value(&request)
            .map_err(|error| rmcp::ErrorData::internal_error(error.to_string(), None))?;
        let host = self
            .host
            .read()
            .map_err(|_| rmcp::ErrorData::internal_error("MCP host lock poisoned", None))?
            .clone();
        let response = host
            .elicit(McpElicitation {
                request_id,
                context,
                server_name: self.server.clone(),
                request,
            })
            .await;
        let action = match response.action.as_str() {
            "accept" => ElicitationAction::Accept,
            "cancel" => ElicitationAction::Cancel,
            _ => ElicitationAction::Decline,
        };
        let mut result = ElicitResult::new(action);
        result.content = response.content;
        result.meta = response
            .meta
            .and_then(|value| serde_json::from_value(value).ok());
        Ok(result)
    }

    async fn on_progress(
        &self,
        params: ProgressNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) {
        let token = Self::progress_token_key(&params.progress_token);
        let context = self
            .active_calls
            .lock()
            .ok()
            .and_then(|active| active.resolve(&token));
        if let Some(context) = context {
            let message = params.message.unwrap_or_else(|| match params.total {
                Some(total) => format!("{:.0}/{total:.0}", params.progress),
                None => format!("{:.0}", params.progress),
            });
            if let Ok(host) = self.host.read() {
                host.progress(McpProgress {
                    context,
                    message,
                    progress: params.progress,
                    total: params.total,
                });
            }
        }
    }
}

type Client = RunningService<RoleClient, RuntimeClientHandler>;

#[derive(Clone)]
struct KeyringCredentialStore {
    account: String,
}

impl KeyringCredentialStore {
    fn new(server_id: &str, url: &str) -> Self {
        let mut hash = Sha256::new();
        hash.update(server_id.as_bytes());
        hash.update([0]);
        hash.update(url.as_bytes());
        Self {
            account: format!("{:x}", hash.finalize()),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, AuthError> {
        keyring::Entry::new(OAUTH_SERVICE, &self.account)
            .map_err(|error| AuthError::InternalError(error.to_string()))
    }
}

#[async_trait]
impl CredentialStore for KeyringCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || match store.entry()?.get_password() {
            Ok(value) => serde_json::from_str(&value)
                .map(Some)
                .map_err(|error| AuthError::InternalError(error.to_string())),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(AuthError::InternalError(error.to_string())),
        })
        .await
        .map_err(|error| AuthError::InternalError(error.to_string()))?
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let value = serde_json::to_string(&credentials)
                .map_err(|error| AuthError::InternalError(error.to_string()))?;
            store
                .entry()?
                .set_password(&value)
                .map_err(|error| AuthError::InternalError(error.to_string()))
        })
        .await
        .map_err(|error| AuthError::InternalError(error.to_string()))?
    }

    async fn clear(&self) -> Result<(), AuthError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || match store.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(AuthError::InternalError(error.to_string())),
        })
        .await
        .map_err(|error| AuthError::InternalError(error.to_string()))?
    }
}

struct OAuthRuntime {
    manager: Arc<Mutex<AuthorizationManager>>,
}

pub struct OAuthLogin {
    pub authorization_url: String,
}

#[derive(Clone)]
pub struct McpManager {
    clients: Arc<Mutex<HashMap<String, Arc<Client>>>>,
    errors: Arc<Mutex<HashMap<String, String>>>,
    auth_required: Arc<Mutex<HashSet<String>>>,
    oauth: Arc<Mutex<HashMap<String, Arc<OAuthRuntime>>>>,
    host: Arc<StdRwLock<Arc<dyn McpHost>>>,
    active_calls: Arc<StdMutex<ActiveCalls>>,
    elicitation_allowed: Arc<StdRwLock<HashMap<String, bool>>>,
}

impl Default for McpManager {
    fn default() -> Self {
        Self {
            clients: Arc::new(Mutex::new(HashMap::new())),
            errors: Arc::new(Mutex::new(HashMap::new())),
            auth_required: Arc::new(Mutex::new(HashSet::new())),
            oauth: Arc::new(Mutex::new(HashMap::new())),
            host: Arc::new(StdRwLock::new(Arc::new(NullMcpHost))),
            active_calls: Arc::new(StdMutex::new(ActiveCalls::default())),
            elicitation_allowed: Arc::new(StdRwLock::new(HashMap::new())),
        }
    }
}

impl McpManager {
    pub fn set_host(&self, host: Arc<dyn McpHost>) -> Result<(), String> {
        *self
            .host
            .write()
            .map_err(|_| "MCP host lock poisoned".to_string())? = host;
        Ok(())
    }

    pub fn set_elicitation_allowed(
        &self,
        thread_id: impl Into<String>,
        allowed: bool,
    ) -> Result<(), String> {
        self.elicitation_allowed
            .write()
            .map_err(|_| "MCP elicitation policy lock poisoned".to_string())?
            .insert(thread_id.into(), allowed);
        Ok(())
    }

    async fn approve_destructive_tool(
        &self,
        context: McpCallContext,
        server: &str,
        tool: &str,
        annotations: Option<Value>,
    ) -> &'static str {
        let allowed = self
            .elicitation_allowed
            .read()
            .ok()
            .and_then(|policies| policies.get(&context.thread_id).copied())
            .unwrap_or(true);
        if !allowed {
            return "decline";
        }
        let host = match self.host.read() {
            Ok(host) => host.clone(),
            Err(_) => return "decline",
        };
        let response = host
            .elicit(McpElicitation {
                request_id: uuid::Uuid::new_v4().to_string(),
                context,
                server_name: server.into(),
                request: json!({
                    "mode":"form",
                    "_meta":{"tietiezhi/mcpToolApproval":{
                        "server":server,
                        "tool":tool,
                        "annotations":annotations
                    }},
                    "message":format!("MCP 工具 `{server}.{tool}` 声明会产生破坏性修改，是否继续？"),
                    "requestedSchema":{
                        "type":"object",
                        "properties":{
                            "confirm":{
                                "type":"boolean",
                                "title":"确认执行"
                            }
                        },
                        "required":["confirm"]
                    }
                }),
            })
            .await;
        match response.action.as_str() {
            "accept" => "accept",
            "cancel" => "cancel",
            _ => "decline",
        }
    }

    async fn oauth_manager(
        &self,
        cfg: &McpServerConfig,
        url: &str,
    ) -> Result<Arc<OAuthRuntime>, String> {
        if let Some(runtime) = self.oauth.lock().await.get(&cfg.id).cloned() {
            return Ok(runtime);
        }
        let mut manager = AuthorizationManager::new(url)
            .await
            .map_err(|error| format!("MCP OAuth 初始化失败：{error}"))?;
        manager.set_credential_store(KeyringCredentialStore::new(&cfg.id, url));
        let _ = manager
            .initialize_from_store()
            .await
            .map_err(|error| format!("MCP OAuth 凭据恢复失败：{error}"))?;
        let runtime = Arc::new(OAuthRuntime {
            manager: Arc::new(Mutex::new(manager)),
        });
        self.oauth
            .lock()
            .await
            .insert(cfg.id.clone(), runtime.clone());
        Ok(runtime)
    }

    async fn connect(&self, cfg: &McpServerConfig) -> Result<Arc<Client>, String> {
        if let Ok(host) = self.host.read() {
            host.startup_status(&cfg.id, "starting", None);
        }
        let handler = RuntimeClientHandler {
            server: cfg.id.clone(),
            host: self.host.clone(),
            active_calls: self.active_calls.clone(),
            elicitation_allowed: self.elicitation_allowed.clone(),
        };
        let client = match &cfg.transport {
            McpTransport::Stdio { command, args, env } => {
                let transport = TokioChildProcess::new(
                    tokio::process::Command::new(command).configure(|command| {
                        command.args(args);
                        command.envs(env);
                        #[cfg(windows)]
                        {
                            use std::os::windows::process::CommandExt;
                            command.creation_flags(0x0800_0000);
                        }
                    }),
                )
                .map_err(|error| format!("启动 MCP 进程失败：{error}"))?;
                tokio::time::timeout(cfg.startup_timeout(), handler.serve(transport))
                    .await
                    .map_err(|_| "MCP 初始化超时".to_string())?
                    .map_err(|error| format!("MCP 握手失败：{error}"))?
            }
            McpTransport::Http {
                url,
                headers,
                oauth,
            } => {
                let mut config = StreamableHttpClientTransportConfig::with_uri(url.clone());
                for (key, value) in headers {
                    if key.eq_ignore_ascii_case("authorization") {
                        config.auth_header = Some(value.clone());
                        continue;
                    }
                    let name = key
                        .parse::<http::HeaderName>()
                        .map_err(|_| format!("无效的 HTTP 头：{key}"))?;
                    let value = value
                        .parse::<http::HeaderValue>()
                        .map_err(|_| format!("无效的 HTTP 头：{key}"))?;
                    config.custom_headers.insert(name, value);
                }
                if *oauth {
                    let mut manager = AuthorizationManager::new(url)
                        .await
                        .map_err(|error| format!("MCP OAuth 初始化失败：{error}"))?;
                    manager.set_credential_store(KeyringCredentialStore::new(&cfg.id, url));
                    match manager.initialize_from_store().await {
                        Ok(true) => {}
                        Ok(false) | Err(AuthError::AuthorizationRequired) => {
                            self.auth_required.lock().await.insert(cfg.id.clone());
                            return Err("MCP OAuth 需要重新授权".into());
                        }
                        Err(error) => return Err(format!("MCP OAuth 凭据恢复失败：{error}")),
                    }
                    let auth_client = AuthClient::new(reqwest13::Client::new(), manager);
                    let transport = StreamableHttpClientTransport::with_client(auth_client, config);
                    return tokio::time::timeout(cfg.startup_timeout(), handler.serve(transport))
                        .await
                        .map_err(|_| "MCP 初始化超时".to_string())?
                        .map_err(|error| format!("MCP 握手失败：{error}"))
                        .map(Arc::new)
                        .inspect(|_| {
                            if let Ok(host) = self.host.read() {
                                host.startup_status(&cfg.id, "ready", None);
                            }
                        });
                }
                let transport =
                    StreamableHttpClientTransport::with_client(reqwest13::Client::new(), config);
                tokio::time::timeout(cfg.startup_timeout(), handler.serve(transport))
                    .await
                    .map_err(|_| "MCP 初始化超时".to_string())?
                    .map_err(|error| format!("MCP 握手失败：{error}"))?
            }
        };
        if let Ok(host) = self.host.read() {
            host.startup_status(&cfg.id, "ready", None);
        }
        Ok(Arc::new(client))
    }

    async fn ensure_started(&self, cfg: &McpServerConfig) -> Result<Arc<Client>, String> {
        if let Some(client) = self.clients.lock().await.get(&cfg.id).cloned() {
            return Ok(client);
        }
        match self.connect(cfg).await {
            Ok(client) => {
                self.errors.lock().await.remove(&cfg.id);
                self.clients
                    .lock()
                    .await
                    .insert(cfg.id.clone(), client.clone());
                Ok(client)
            }
            Err(error) => {
                self.errors
                    .lock()
                    .await
                    .insert(cfg.id.clone(), error.clone());
                if let Ok(host) = self.host.read() {
                    host.startup_status(&cfg.id, "failed", Some(&error));
                }
                Err(error)
            }
        }
    }

    pub async fn start(&self, cfg: &McpServerConfig) -> Result<(), String> {
        self.ensure_started(cfg).await.map(|_| ())
    }

    pub async fn list_tools(&self, cfg: &McpServerConfig) -> Result<Vec<McpToolInfo>, String> {
        let client = self.ensure_started(cfg).await?;
        let tools = tokio::time::timeout(DEFAULT_LIST_TIMEOUT, client.list_all_tools())
            .await
            .map_err(|_| "获取 MCP 工具列表超时".to_string())?
            .map_err(|error| format!("获取 MCP 工具列表失败：{error}"))?;
        tools
            .into_iter()
            .filter(|tool| cfg.allows_tool(tool.name.as_ref()))
            .map(|tool| {
                let value = serde_json::to_value(&tool)
                    .map_err(|error| format!("序列化 MCP 工具失败：{error}"))?;
                Ok(McpToolInfo {
                    name: tool.name.into_owned(),
                    title: value
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    description: tool
                        .description
                        .map(|item| item.into_owned())
                        .unwrap_or_default(),
                    input_schema: Value::Object((*tool.input_schema).clone()),
                    output_schema: value.get("outputSchema").cloned(),
                    annotations: value.get("annotations").cloned(),
                    icons: value.get("icons").cloned(),
                    meta: value.get("_meta").cloned(),
                })
            })
            .collect()
    }

    pub async fn inventory(&self, cfg: &McpServerConfig) -> Result<McpInventory, String> {
        let client = self.ensure_started(cfg).await?;
        let tools = tokio::time::timeout(DEFAULT_LIST_TIMEOUT, client.list_all_tools())
            .await
            .map_err(|_| "获取 MCP 服务器清单超时".to_string())?
            .map_err(|error| format!("获取 MCP 服务器清单失败：{error}"))?;
        let resources = tokio::time::timeout(DEFAULT_LIST_TIMEOUT, client.list_all_resources())
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        let templates =
            tokio::time::timeout(DEFAULT_LIST_TIMEOUT, client.list_all_resource_templates())
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
        Ok(McpInventory {
            server_info: client
                .peer_info()
                .and_then(|value| serde_json::to_value(value.as_ref()).ok())
                .and_then(|value| value.get("serverInfo").cloned()),
            tools: tools
                .into_iter()
                .filter(|tool| cfg.allows_tool(tool.name.as_ref()))
                .filter_map(|value| serde_json::to_value(value).ok())
                .collect(),
            resources: resources
                .into_iter()
                .filter_map(|value| serde_json::to_value(value).ok())
                .collect(),
            resource_templates: templates
                .into_iter()
                .filter_map(|value| serde_json::to_value(value).ok())
                .collect(),
        })
    }

    pub async fn read_resource(
        &self,
        cfg: &McpServerConfig,
        uri: &str,
    ) -> Result<Vec<Value>, String> {
        let client = self.ensure_started(cfg).await?;
        let result = tokio::time::timeout(
            cfg.tool_timeout(),
            client.read_resource(ReadResourceRequestParams::new(uri)),
        )
        .await
        .map_err(|_| "读取 MCP 资源超时".to_string())?
        .map_err(|error| format!("读取 MCP 资源失败：{error}"))?;
        result
            .contents
            .into_iter()
            .map(|value| {
                serde_json::to_value(value).map_err(|error| format!("序列化 MCP 资源失败：{error}"))
            })
            .collect()
    }

    pub async fn call_tool_rich(
        &self,
        cfg: &McpServerConfig,
        tool: &str,
        args: &Value,
        context: Option<McpCallContext>,
        meta: Option<Value>,
    ) -> Result<McpCallResult, String> {
        if !cfg.allows_tool(tool) {
            return Err(format!("MCP 工具 `{tool}` 已被配置过滤"));
        }
        let client = self.ensure_started(cfg).await?;
        let token = uuid::Uuid::new_v4().to_string();
        if let Some(context) = &context {
            self.active_calls
                .lock()
                .map_err(|_| "MCP 调用上下文锁已损坏".to_string())?
                .insert(token.clone(), context.clone());
        }
        let mut params = CallToolRequestParams::new(tool.to_owned());
        params.arguments = args.as_object().cloned();
        let mut meta_map = meta
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        meta_map.insert("progressToken".into(), Value::String(token.clone()));
        params.meta = Some(Meta(meta_map));
        let outcome = tokio::time::timeout(cfg.tool_timeout(), client.call_tool(params)).await;
        if let Some(context) = &context {
            if let Ok(mut active) = self.active_calls.lock() {
                active.remove(&token, context);
            }
        }
        let result = outcome
            .map_err(|_| "MCP 工具调用超时".to_string())?
            .map_err(|error| format!("MCP 工具调用失败：{error}"))?;
        Ok(McpCallResult {
            content: result
                .content
                .into_iter()
                .map(|value| serde_json::to_value(value).unwrap_or(Value::Null))
                .collect(),
            structured_content: result.structured_content,
            is_error: result.is_error.unwrap_or(false),
            meta: result
                .meta
                .and_then(|value| serde_json::to_value(value).ok()),
        })
    }

    pub async fn call_tool(
        &self,
        cfg: &McpServerConfig,
        tool: &str,
        args: &Value,
    ) -> Result<(String, bool), String> {
        let result = self.call_tool_rich(cfg, tool, args, None, None).await?;
        Ok((result.model_text(), result.is_error))
    }

    pub async fn begin_oauth_login(
        &self,
        cfg: McpServerConfig,
        thread_id: Option<String>,
        scopes: Vec<String>,
        timeout: Option<Duration>,
    ) -> Result<OAuthLogin, String> {
        let McpTransport::Http { url, oauth, .. } = &cfg.transport else {
            return Err(McpRuntimeError::OAuthUnsupported(cfg.id).to_string());
        };
        if !oauth {
            return Err(McpRuntimeError::OAuthUnsupported(cfg.id).to_string());
        }
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("启动 MCP OAuth 回调失败：{error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("读取 MCP OAuth 回调地址失败：{error}"))?;
        let redirect_uri = format!("http://127.0.0.1:{}/callback", address.port());
        let runtime = self.oauth_manager(&cfg, url).await?;
        let mut manager_guard = runtime.manager.lock().await;
        let replacement = AuthorizationManager::new(url)
            .await
            .map_err(|error| format!("重置 MCP OAuth 会话失败：{error}"))?;
        let mut manager = std::mem::replace(&mut *manager_guard, replacement);
        manager.set_credential_store(KeyringCredentialStore::new(&cfg.id, url));
        let metadata = manager
            .discover_metadata()
            .await
            .map_err(|error| format!("发现 MCP OAuth 服务失败：{error}"))?;
        manager.set_metadata(metadata);
        let selected_scopes = if scopes.is_empty() {
            cfg.oauth_scopes.clone()
        } else {
            scopes
        };
        let refs = selected_scopes
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let session = AuthorizationSession::new(
            manager,
            &refs,
            &redirect_uri,
            Some("Tietiezhi Codex Runtime"),
            None,
        )
        .await
        .map_err(|error| format!("创建 MCP OAuth 会话失败：{error}"))?;
        let authorization_url = session.get_authorization_url().to_owned();
        drop(manager_guard);

        let this = self.clone();
        let server = cfg.id.clone();
        tokio::spawn(async move {
            let result = wait_for_oauth_callback(
                listener,
                session,
                timeout.unwrap_or(DEFAULT_OAUTH_TIMEOUT),
            )
            .await;
            match result {
                Ok(manager) => {
                    *runtime.manager.lock().await = manager;
                    this.auth_required.lock().await.remove(&server);
                    this.stop(&server).await;
                    if let Ok(host) = this.host.read() {
                        host.oauth_completed(&server, thread_id.as_deref(), true, None);
                    }
                }
                Err(error) => {
                    if let Ok(host) = this.host.read() {
                        host.oauth_completed(&server, thread_id.as_deref(), false, Some(&error));
                    }
                }
            }
        });
        Ok(OAuthLogin { authorization_url })
    }

    pub async fn stop(&self, id: &str) {
        if let Some(client) = self.clients.lock().await.remove(id) {
            if let Ok(client) = Arc::try_unwrap(client) {
                let _ = client.cancel().await;
            }
        }
        self.errors.lock().await.remove(id);
    }

    pub async fn status(&self, configs: &[McpServerConfig]) -> Vec<McpServerStatus> {
        let clients = self.clients.lock().await;
        let errors = self.errors.lock().await;
        let auth_required = self.auth_required.lock().await;
        configs
            .iter()
            .map(|cfg| {
                let (state, error) = if clients.contains_key(&cfg.id) {
                    ("running", String::new())
                } else if let Some(error) = errors.get(&cfg.id) {
                    ("error", error.clone())
                } else {
                    ("stopped", String::new())
                };
                McpServerStatus {
                    id: cfg.id.clone(),
                    state: state.into(),
                    tool_count: 0,
                    error,
                    auth_status: if auth_required.contains(&cfg.id) {
                        "notLoggedIn"
                    } else if matches!(cfg.transport, McpTransport::Http { oauth: true, .. }) {
                        "oAuth"
                    } else if matches!(
                        &cfg.transport,
                        McpTransport::Http { headers, .. }
                            if headers.keys().any(|key| key.eq_ignore_ascii_case("authorization"))
                    ) {
                        "bearerToken"
                    } else {
                        "unsupported"
                    }
                    .into(),
                }
            })
            .collect()
    }

    pub async fn auth_status(&self, cfg: &McpServerConfig) -> String {
        match &cfg.transport {
            McpTransport::Http {
                oauth: true, url, ..
            } => match self.oauth_manager(cfg, url).await {
                Ok(runtime) => match runtime.manager.lock().await.get_access_token().await {
                    Ok(_) => "oAuth",
                    Err(_) => "notLoggedIn",
                },
                Err(_) => "notLoggedIn",
            },
            McpTransport::Http { headers, .. }
                if headers
                    .keys()
                    .any(|key| key.eq_ignore_ascii_case("authorization")) =>
            {
                "bearerToken"
            }
            _ => "unsupported",
        }
        .into()
    }
}

fn request_id_key(id: &Value) -> String {
    id.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_string())
}

async fn wait_for_oauth_callback(
    listener: TcpListener,
    session: AuthorizationSession,
    timeout: Duration,
) -> Result<AuthorizationManager, String> {
    let callback = tokio::time::timeout(timeout, async move {
        let (mut stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buffer = vec![0u8; 32 * 1024];
        let count = stream.read(&mut buffer).await.map_err(|error| error.to_string())?;
        let request = String::from_utf8_lossy(&buffer[..count]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .ok_or_else(|| "无效的 MCP OAuth 回调".to_string())?;
        let callback_url = format!("http://127.0.0.1{target}");
        let result = session
            .handle_callback_url(&callback_url)
            .await
            .map_err(|error| error.to_string());
        let (status, body) = if result.is_ok() {
            ("200 OK", "MCP authorization completed. You may close this window.")
        } else {
            ("400 Bad Request", "MCP authorization failed. Return to Tietiezhi.")
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        result?;
        Ok::<_, String>(session.auth_manager)
    })
    .await
    .map_err(|_| "MCP OAuth 登录超时".to_string())??;
    Ok(callback)
}

pub fn namespaced(server_id: &str, tool: &str) -> String {
    format!("mcp__{server_id}__{tool}")
}

pub fn parse_namespaced(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix("mcp__")?;
    rest.split_once("__")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn config_preserves_old_wire_shape_and_filters_tools() {
        let config: McpServerConfig = serde_json::from_value(json!({
            "id": "docs",
            "name": "Docs",
            "transport": {"kind":"http","url":"https://example.invalid/mcp","headers":{}}
        }))
        .unwrap();
        assert!(config.enabled);
        assert_eq!(config.startup_timeout_secs, 15);
        assert_eq!(config.tool_timeout_secs, 120);
        assert!(matches!(
            config.transport,
            McpTransport::Http { oauth: false, .. }
        ));

        let mut filtered = config;
        filtered.enabled_tools = vec!["read".into()];
        filtered.disabled_tools = vec!["write".into()];
        assert!(filtered.allows_tool("read"));
        assert!(!filtered.allows_tool("write"));
        assert!(!filtered.allows_tool("other"));
    }

    #[test]
    fn namespacing_roundtrips() {
        let name = namespaced("srv-1", "read_query");
        assert_eq!(name, "mcp__srv-1__read_query");
        assert_eq!(parse_namespaced(&name), Some(("srv-1", "read_query")));
        assert_eq!(parse_namespaced("read_file"), None);
    }

    #[test]
    fn rich_result_keeps_multimedia_and_structured_content() {
        let result = McpCallResult {
            content: vec![
                json!({"type":"text","text":"done"}),
                json!({"type":"image","data":"AA==","mimeType":"image/png"}),
                json!({"type":"audio","data":"AA==","mimeType":"audio/wav"}),
            ],
            structured_content: Some(json!({"count":1})),
            is_error: false,
            meta: Some(json!({"trace":"x"})),
        };
        let text = result.model_text();
        assert!(text.contains("done"));
        assert!(text.contains("\"image\""));
        assert!(text.contains("\"audio\""));
        assert!(text.contains("\"count\":1"));
        assert_eq!(serde_json::to_value(result).unwrap()["_meta"]["trace"], "x");
    }

    #[test]
    fn progress_context_uses_exact_token() {
        let mut active = ActiveCalls::default();
        let first = McpCallContext {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            item_id: "first".into(),
        };
        let second = McpCallContext {
            item_id: "second".into(),
            ..first.clone()
        };
        active.insert("\"one\"".into(), first.clone());
        active.insert("\"two\"".into(), second.clone());
        assert_eq!(active.resolve("\"one\""), Some(first.clone()));
        active.remove("\"one\"", &first);
        assert_eq!(active.resolve("\"one\""), Some(second));
    }

    #[tokio::test]
    async fn elicitation_broker_emits_v2_request_and_resolves_exact_response() {
        let broker = ElicitationBroker::default();
        let pending = broker
            .begin(
                vec!["desktop".into()],
                McpElicitation {
                    request_id: "upstream-request".into(),
                    context: McpCallContext {
                        thread_id: "thread-1".into(),
                        turn_id: "turn-1".into(),
                        item_id: "item-1".into(),
                    },
                    server_name: "fixture".into(),
                    request: json!({
                        "mode":"form",
                        "message":"Choose",
                        "requestedSchema":{
                            "type":"object",
                            "properties":{"answer":{"type":"string"}}
                        }
                    }),
                },
            )
            .unwrap();
        let wire = pending.request.wire_message();
        assert!(
            serde_json::from_value::<tietiezhi_agent_protocol::ServerRequest>(wire.clone()).is_ok()
        );
        assert_eq!(wire["params"]["threadId"], "thread-1");
        assert_eq!(wire["params"]["turnId"], "turn-1");
        assert_eq!(wire["params"]["serverName"], "fixture");
        assert!(broker
            .resolve(&json!({
                "id":wire["id"],
                "result":{
                    "action":"accept",
                    "content":{"answer":"yes"},
                    "_meta":{"fixture":true}
                }
            }))
            .unwrap());
        let response = pending.receiver.await.unwrap().unwrap();
        assert_eq!(response.action, "accept");
        assert_eq!(response.content, Some(json!({"answer":"yes"})));
        assert_eq!(response.meta, Some(json!({"fixture":true})));
    }

    #[tokio::test]
    async fn elicitation_broker_distinguishes_cancel_and_unknown_requests() {
        let broker = ElicitationBroker::default();
        let pending = broker
            .begin(
                Vec::new(),
                McpElicitation {
                    request_id: "request".into(),
                    context: McpCallContext {
                        thread_id: "thread".into(),
                        turn_id: "turn".into(),
                        item_id: "item".into(),
                    },
                    server_name: "fixture".into(),
                    request: json!({"mode":"url","message":"Authorize","url":"https://example.test"}),
                },
            )
            .unwrap();
        assert!(broker.cancel(&pending.request.id).unwrap());
        assert!(!broker.cancel(&pending.request.id).unwrap());
        assert!(pending.receiver.await.is_err());
        assert!(!broker
            .resolve(&json!({"id":"unknown","result":{"action":"decline"}}))
            .unwrap());
    }
}
