use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tietiezhi_agent_account::{
    AccountDispatchOutput, AccountNotification, AccountRpcError, AccountServerRequest,
    ImmediateLogin,
};
use tietiezhi_agent_approval::{
    category_approval_requirement, ApprovalCategory, ApprovalKey, ApprovalRequirement,
    AskForApproval, CommandExecutionApprovalDecision, CommandExecutionApprovalParams,
    FileChangeApprovalDecision, FileChangeApprovalParams, PermissionsApprovalParams,
    PersistentApprovalRule, PersistentApprovalStore, RoutedServerRequest as ApprovalServerRequest,
};
use tietiezhi_agent_context::compaction_prompt_history;
use tietiezhi_agent_core::{
    CompactionExecutionSnapshot, DispatchOutput, RoutedNotification, RuntimeDefaults,
    ThreadManager, TurnExecutionSnapshot,
};
use tietiezhi_agent_execpolicy::{
    ApprovalPolicy as ExecApprovalPolicy, EvaluationContext as ExecEvaluationContext,
    ExecPolicyOutcome as RuntimeExecPolicyOutcome,
};
use tietiezhi_agent_model::{
    list_online_models, supports_original_image_detail, ModelError, OnlineModel, Reasoning,
    ResponseEvent, ResponsesApiRequest, ResponsesClient, TextControls, TextFormat, TextFormatType,
};
use tietiezhi_agent_network::{
    NetworkApprovalDecision, NetworkDomainPermission, NetworkExecutionRequest, NetworkMode,
    NetworkPolicy, NetworkPolicyAmendment,
};
use tietiezhi_agent_protocol::{
    ClientRequest, JSONRPCRequest, JSONRPCResponse, ListMcpServerStatusResponse,
    McpResourceReadResponse, McpServerOauthLoginResponse, McpServerToolCallResponse,
    ModelListResponse, PermissionProfileListResponse, ServerNotification,
};
use tietiezhi_agent_tools::builtins::{
    apply_patch_handler, context_remaining_handler, current_time_handler,
    request_permissions_handler, sleep_handler, unified_exec_handlers, view_image_handler,
    web_search_handler, CommandApprovalRequest, CommandNetworkRequest, CommandPolicyOutcome,
    CommandPolicyRequest, CommandRuntimeEvent, FileChangeApprovalRequest,
    PermissionsApprovalRequest,
};
use tietiezhi_agent_tools::{ToolCall, ToolCallRuntime, ToolPayload, ToolRegistry, ToolRouter};
use tokio_util::sync::CancellationToken;

use crate::AppState;

const CODEX_NOTIFICATION_EVENT: &str = "codex-v2-notification";
const CODEX_SERVER_REQUEST_EVENT: &str = "codex-v2-server-request";

#[derive(Debug, Clone)]
pub(crate) struct ExternalAuthTokens {
    access_token: String,
    account_id: String,
    plan_type: Option<String>,
}

fn runtime_defaults(app: &AppHandle) -> Result<RuntimeDefaults, String> {
    let settings = super::settings::read_settings(app)?;
    let model_context_windows = settings
        .providers
        .iter()
        .find(|provider| provider.id == settings.chat_provider_id)
        .map(|provider| {
            provider
                .models
                .iter()
                .filter_map(|model| {
                    let context_window = model.context_window?;
                    let context_window = i64::try_from(context_window).ok()?;
                    (context_window > 0).then(|| (model.id.to_ascii_lowercase(), context_window))
                })
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let cwd = dirs::home_dir()
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| "无法定位默认工作目录".to_string())?;
    let approval_policy = match settings.permission_mode.as_str() {
        "ask" => json!("untrusted"),
        "full" => json!("never"),
        _ => json!("on-request"),
    };
    let sandbox = if settings.permission_mode == "full" {
        json!({"type": "dangerFullAccess"})
    } else {
        json!({
            "type": "workspaceWrite",
            "writableRoots": [cwd],
            "networkAccess": false,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false
        })
    };
    let reasoning_effort = match settings.chat_reasoning_effort.as_str() {
        "" | "auto" | "off" => None,
        effort => Some(effort.to_string()),
    };
    Ok(RuntimeDefaults {
        model: nonempty_or_unconfigured(settings.chat_model),
        model_provider: nonempty_or_unconfigured(settings.chat_provider_id),
        cwd,
        approval_policy,
        approvals_reviewer: "user".into(),
        sandbox,
        reasoning_effort,
        service_tier: None,
        model_context_windows,
        cli_version: env!("CARGO_PKG_VERSION").into(),
    })
}

fn nonempty_or_unconfigured(value: String) -> String {
    if value.trim().is_empty() {
        "unconfigured".into()
    } else {
        value
    }
}

fn thread_manager(app: &AppHandle, state: &AppState) -> Result<ThreadManager, String> {
    let mut slot = state
        .codex_core
        .lock()
        .map_err(|_| "Codex Runtime 状态锁已损坏".to_string())?;
    if let Some(manager) = slot.as_ref() {
        return Ok(manager.clone());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let manager = ThreadManager::open(
        app_data.join("agent-runtime"),
        app_data.join("tasks"),
        runtime_defaults(app)?,
    )
    .map_err(|error| format!("初始化 Codex Runtime 失败：{error:?}"))?;
    *slot = Some(manager.clone());
    Ok(manager)
}

fn persistent_approval_store(
    app: &AppHandle,
    state: &AppState,
) -> Result<PersistentApprovalStore, String> {
    let mut slot = state
        .codex_persistent_approvals
        .lock()
        .map_err(|_| "Codex 持久审批规则锁已损坏".to_string())?;
    if let Some(store) = slot.as_ref() {
        return Ok(store.clone());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let store =
        PersistentApprovalStore::open(app_data.join("agent-runtime").join("approval-rules.json"))
            .map_err(|error| format!("无法打开持久审批规则：{error}"))?;
    *slot = Some(store.clone());
    Ok(store)
}

fn emit_notifications(app: &AppHandle, notifications: &[RoutedNotification]) -> Result<(), String> {
    for notification in notifications {
        app.emit(CODEX_NOTIFICATION_EVENT, notification)
            .map_err(|error| format!("发送 Codex 通知失败：{error}"))?;
    }
    Ok(())
}

fn emit_server_request(app: &AppHandle, request: &AccountServerRequest) -> Result<(), String> {
    app.emit(CODEX_SERVER_REQUEST_EVENT, request)
        .map_err(|error| format!("发送 Codex Server Request 失败：{error}"))
}

fn emit_approval_server_request(
    app: &AppHandle,
    request: &ApprovalServerRequest,
) -> Result<(), String> {
    app.emit(CODEX_SERVER_REQUEST_EVENT, request)
        .map_err(|error| format!("发送 Codex 审批请求失败：{error}"))
}

#[tauri::command]
pub fn codex_v2_server_response(
    state: State<'_, AppState>,
    response: Value,
) -> Result<bool, String> {
    if state
        .codex_account_requests
        .resolve(&response)
        .map_err(account_rpc_error)?
    {
        return Ok(true);
    }
    if state.codex_mcp_requests.resolve(&response)? {
        return Ok(true);
    }
    state
        .codex_approval_requests
        .resolve(&response)
        .map_err(|error| format!("Codex approval 状态错误：{error}"))
}

fn cancel_thread(state: &AppState, thread_id: &str, expected_turn_id: Option<&str>) {
    if let Ok(cancels) = state.codex_cancels.lock() {
        if let Some((turn_id, cancel)) = cancels.get(thread_id) {
            if expected_turn_id.is_none_or(|expected| expected == turn_id) {
                cancel.cancel();
            }
        }
    }
}

fn signal_turn_input_activity(state: &AppState, thread_id: &str, turn_id: &str) {
    if let Ok(mut activity) = state.codex_input_activity.lock() {
        let Some((active_turn_id, token)) = activity.get_mut(thread_id) else {
            return;
        };
        if active_turn_id != turn_id {
            return;
        }
        token.cancel();
        *token = CancellationToken::new();
    }
}

fn turn_input_activity_token(app: &AppHandle, thread_id: &str, turn_id: &str) -> CancellationToken {
    app.state::<AppState>()
        .codex_input_activity
        .lock()
        .ok()
        .and_then(|activity| {
            activity
                .get(thread_id)
                .filter(|(active_turn_id, _)| active_turn_id == turn_id)
                .map(|(_, token)| token.clone())
        })
        .unwrap_or_default()
}

/// Dispatch one App Server V2 request without embedding an upstream binary.
///
/// The request itself remains synchronous so JSON-RPC acceptance and lifecycle
/// notifications preserve their order. A successful `turn/start` launches the
/// source-native Responses executor on Tauri's async runtime.
#[tauri::command]
pub async fn codex_v2_request(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    request: Value,
) -> Result<DispatchOutput, String> {
    if connection_id.trim().is_empty() {
        return Err("connectionId 不能为空".into());
    }
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    state
        .codex_account
        .register_connection(&connection_id)
        .map_err(account_rpc_error)?;
    if tietiezhi_agent_account::AccountRuntime::handles(&method) {
        let output =
            dispatch_account_request(&app, &state, &connection_id, &request, &method).await?;
        emit_notifications(&app, &output.notifications)?;
        return Ok(output);
    }
    if method == "model/list" {
        if let Some(output) = online_model_list(&app, &request)? {
            return Ok(output);
        }
    }
    if method == "permissionProfile/list" {
        return permission_profile_list(&request);
    }
    if matches!(
        method.as_str(),
        "mcpServer/oauth/login"
            | "mcpServer/resource/read"
            | "mcpServer/tool/call"
            | "mcpServerStatus/list"
    ) {
        return dispatch_mcp_request(&app, &state, &request, &method).await;
    }
    if matches!(
        method.as_str(),
        "windowsSandbox/readiness" | "windowsSandbox/setupStart"
    ) {
        let output = dispatch_windows_sandbox(&connection_id, &request, &method)?;
        emit_notifications(&app, &output.notifications)?;
        return Ok(output);
    }
    if method.starts_with("command/exec") {
        return dispatch_command_exec(&app, &state, &connection_id, &request, &method).await;
    }
    if method == "thread/shellCommand" {
        return dispatch_thread_shell_command(&app, &state, &connection_id, &request).await;
    }
    let thread_id = request
        .pointer("/params/threadId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let requested_turn_id = request
        .pointer("/params/turnId")
        .and_then(Value::as_str)
        .map(str::to_owned);

    let manager = thread_manager(&app, &state)?;
    let output = manager.dispatch(&connection_id, request);
    if method == "turn/steer" && output.response.get("error").is_none() {
        if let (Some(thread_id), Some(turn_id)) =
            (thread_id.as_deref(), requested_turn_id.as_deref())
        {
            signal_turn_input_activity(&state, thread_id, turn_id);
        }
    }
    let should_cancel = output.response.get("error").is_none()
        && matches!(
            method.as_str(),
            "turn/interrupt" | "thread/archive" | "thread/delete"
        );
    if should_cancel {
        if let Some(thread_id) = thread_id.as_deref() {
            let expected_turn_id = (method == "turn/interrupt")
                .then_some(requested_turn_id.as_deref())
                .flatten();
            cancel_thread(&state, thread_id, expected_turn_id);
            if matches!(method.as_str(), "thread/archive" | "thread/delete") {
                state
                    .codex_session_approvals
                    .clear_session(thread_id)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    emit_notifications(&app, &output.notifications)?;

    let starts_new_turn = method == "turn/start"
        && output
            .notifications
            .iter()
            .any(|notification| notification.method == "turn/started");
    if starts_new_turn {
        if let (Some(thread_id), Some(turn_id)) = (
            thread_id,
            output
                .response
                .pointer("/result/turn/id")
                .and_then(Value::as_str)
                .map(str::to_owned),
        ) {
            launch_turn_executor(&app, &state, manager, thread_id, turn_id);
        }
    } else if method == "thread/compact/start" && output.response.get("error").is_none() {
        let turn_id = output
            .notifications
            .iter()
            .find(|notification| notification.method == "turn/started")
            .and_then(|notification| notification.params.pointer("/turn/id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            launch_compaction_executor(&app, &state, manager, thread_id, turn_id);
        }
    }
    Ok(output)
}

fn permission_profile_list(request: &Value) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("permissionProfile/list 参数不符合 App Server V2：{error}"),
        ));
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let profiles = [
        json!({"id":":read-only","description":null,"allowed":true}),
        json!({"id":":workspace","description":null,"allowed":true}),
        json!({"id":":danger-full-access","description":null,"allowed":true}),
    ];
    let total = profiles.len();
    let start = match params.get("cursor").filter(|value| !value.is_null()) {
        Some(cursor) => match cursor
            .as_str()
            .and_then(|cursor| cursor.parse::<usize>().ok())
        {
            Some(start) if start <= total => start,
            _ => {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "invalid permission profile cursor",
                ));
            }
        },
        None => 0,
    };
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .map(|limit| usize::try_from(limit).unwrap_or(usize::MAX))
        .unwrap_or(total)
        .max(1)
        .min(total);
    let end = start.saturating_add(limit).min(total);
    let result = json!({
        "data":profiles[start..end],
        "nextCursor":(end < total).then(|| end.to_string())
    });
    debug_assert!(serde_json::from_value::<PermissionProfileListResponse>(result.clone()).is_ok());
    dispatch_success(request, result)
}

fn online_model_list(app: &AppHandle, request: &Value) -> Result<Option<DispatchOutput>, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(Some(dispatch_error(
            request,
            -32602,
            format!("model/list 参数不符合 App Server V2：{error}"),
        )));
    }
    let settings = super::settings::read_settings(app)?;
    let Some(provider) = settings
        .providers
        .iter()
        .find(|provider| provider.id == settings.chat_provider_id)
    else {
        return Ok(None);
    };
    let models = provider
        .models
        .iter()
        .filter(|model| {
            model.effective_kind() == super::models::ModelKind::Chat && !model.id.trim().is_empty()
        })
        .map(|model| {
            let reasoning = model.effective_reasoning();
            let reasoning_efforts = reasoning
                .map(|profile| {
                    profile
                        .supported_efforts
                        .iter()
                        .filter_map(|effort| effort.as_wire_value().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            let default_reasoning_effort = reasoning
                .and_then(|profile| profile.default_effort)
                .and_then(|effort| effort.as_wire_value())
                .unwrap_or("medium")
                .to_owned();
            let input_modalities = model
                .input_modalities
                .iter()
                .filter_map(|modality| match modality {
                    super::models::ModelModality::Text => Some("text".into()),
                    super::models::ModelModality::Image => Some("image".into()),
                    _ => None,
                })
                .collect();
            OnlineModel {
                id: model.id.clone(),
                display_name: model.id.clone(),
                description: format!("{} 提供的 Agent 模型", provider.name),
                reasoning_efforts,
                default_reasoning_effort,
                input_modalities,
                is_default: model.id == settings.chat_model,
            }
        })
        .collect::<Vec<_>>();
    if models.is_empty() {
        return Ok(None);
    }
    let cursor = match request
        .pointer("/params/cursor")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "model/list cursor 必须是字符串".to_string())
        })
        .transpose()
    {
        Ok(value) => value,
        Err(error) => return Ok(Some(dispatch_error(request, -32602, error))),
    };
    let limit = match request
        .pointer("/params/limit")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "model/list limit 必须是无符号 32 位整数".to_string())
        })
        .transpose()
    {
        Ok(value) => value,
        Err(error) => return Ok(Some(dispatch_error(request, -32602, error))),
    };
    let result = match list_online_models(models, cursor, limit) {
        Ok(result) => result,
        Err(error) => {
            return Ok(Some(dispatch_error(
                request,
                -32602,
                format!("模型目录无效：{error}"),
            )));
        }
    };
    if let Err(error) = serde_json::from_value::<ModelListResponse>(result.clone()) {
        return Ok(Some(dispatch_error(
            request,
            -32603,
            format!("在线模型目录不符合 App Server V2：{error}"),
        )));
    }
    let response = json!({
        "id": request.get("id").cloned().unwrap_or(Value::Null),
        "result": result
    });
    serde_json::from_value::<JSONRPCResponse>(response.clone())
        .map_err(|error| format!("model/list JSON-RPC 响应无效：{error}"))?;
    Ok(Some(DispatchOutput {
        response,
        notifications: Vec::new(),
    }))
}

fn dispatch_error(request: &Value, code: i64, message: impl Into<String>) -> DispatchOutput {
    DispatchOutput {
        response: json!({
            "id": request.get("id").cloned().unwrap_or(Value::Null),
            "error": {
                "code": code,
                "message": message.into()
            }
        }),
        notifications: Vec::new(),
    }
}

fn dispatch_success(request: &Value, result: Value) -> Result<DispatchOutput, String> {
    let response = json!({
        "id": request.get("id").cloned().unwrap_or(Value::Null),
        "result": result
    });
    serde_json::from_value::<JSONRPCResponse>(response.clone())
        .map_err(|error| format!("Codex JSON-RPC 响应无效：{error}"))?;
    Ok(DispatchOutput {
        response,
        notifications: Vec::new(),
    })
}

async fn dispatch_mcp_request(
    app: &AppHandle,
    state: &AppState,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("{method} 参数不符合 App Server V2：{error}"),
        ));
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let settings = super::settings::read_settings(app)?;
    let resolve_server = |name: &str| -> Result<crate::mcp::McpServerConfig, String> {
        let config = settings
            .mcp_servers
            .iter()
            .find(|config| config.enabled && config.id == name)
            .ok_or_else(|| format!("No MCP server named '{name}' found."))?;
        super::tietiezhi::resolve_mcp_config_secrets(app, config)
    };
    match method {
        "mcpServer/oauth/login" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let config = match resolve_server(name) {
                Ok(config) => config,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let scopes = params
                .get("scopes")
                .and_then(Value::as_array)
                .map(|scopes| {
                    scopes
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let timeout = params
                .get("timeoutSecs")
                .and_then(Value::as_u64)
                .map(Duration::from_secs);
            let login = match state
                .mcp
                .begin_oauth_login(config, thread_id, scopes, timeout)
                .await
            {
                Ok(login) => login,
                Err(error) => return Ok(dispatch_error(request, -32603, error)),
            };
            let result = json!({"authorizationUrl":login.authorization_url});
            serde_json::from_value::<McpServerOauthLoginResponse>(result.clone())
                .map_err(|error| format!("MCP OAuth 响应不符合 App Server V2：{error}"))?;
            dispatch_success(request, result)
        }
        "mcpServer/resource/read" => {
            let server = params
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let uri = params
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let config = match resolve_server(server) {
                Ok(config) => config,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            let contents = match state.mcp.read_resource(&config, uri).await {
                Ok(contents) => contents,
                Err(error) => return Ok(dispatch_error(request, -32603, error)),
            };
            let result = json!({"contents":contents});
            serde_json::from_value::<McpResourceReadResponse>(result.clone())
                .map_err(|error| format!("MCP 资源响应不符合 App Server V2：{error}"))?;
            dispatch_success(request, result)
        }
        "mcpServer/tool/call" => {
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let server = params
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let tool = params
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let config = match resolve_server(server) {
                Ok(config) => config,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            let manager = thread_manager(app, &app.state::<AppState>())?;
            let turn_id = match manager.active_turn_id(thread_id) {
                Ok(turn_id) => turn_id,
                Err(error) => {
                    return Ok(dispatch_error(
                        request,
                        -32602,
                        format!("MCP thread 无效：{error:?}"),
                    ));
                }
            };
            let item_id = format!("mcp-rpc-{}", uuid::Uuid::new_v4());
            let context = turn_id
                .as_ref()
                .map(|turn_id| tietiezhi_agent_mcp::McpCallContext {
                    thread_id: thread_id.into(),
                    turn_id: turn_id.clone(),
                    item_id: item_id.clone(),
                });
            if let Some(context) = &context {
                let notifications = manager
                    .local_tool_item_started(
                        &context.thread_id,
                        &context.turn_id,
                        json!({
                            "type":"mcpToolCall",
                            "id":context.item_id,
                            "server":server,
                            "tool":tool,
                            "status":"inProgress",
                            "arguments":arguments,
                            "appContext":null,
                            "pluginId":null,
                            "result":null,
                            "error":null,
                            "durationMs":null
                        }),
                    )
                    .map_err(|error| format!("记录 MCP 工具调用失败：{error:?}"))?;
                emit_notifications(app, &notifications)?;
            }
            let started = std::time::Instant::now();
            let called = state
                .mcp
                .call_tool_rich(
                    &config,
                    tool,
                    &arguments,
                    context.clone(),
                    params.get("_meta").cloned(),
                )
                .await;
            let duration_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
            if let Some(context) = &context {
                let item = match &called {
                    Ok(result) => json!({
                        "type":"mcpToolCall",
                        "id":context.item_id,
                        "server":server,
                        "tool":tool,
                        "status":if result.is_error { "failed" } else { "completed" },
                        "arguments":arguments,
                        "appContext":null,
                        "pluginId":null,
                        "result":{
                            "content":result.content,
                            "structuredContent":result.structured_content,
                            "_meta":result.meta
                        },
                        "error":if result.is_error {
                            json!({"message":result.model_text()})
                        } else {
                            Value::Null
                        },
                        "durationMs":duration_ms
                    }),
                    Err(error) => json!({
                        "type":"mcpToolCall",
                        "id":context.item_id,
                        "server":server,
                        "tool":tool,
                        "status":"failed",
                        "arguments":arguments,
                        "appContext":null,
                        "pluginId":null,
                        "result":null,
                        "error":{"message":error},
                        "durationMs":duration_ms
                    }),
                };
                let notifications = manager
                    .local_tool_item_completed(&context.thread_id, &context.turn_id, item)
                    .map_err(|error| format!("记录 MCP 工具结果失败：{error:?}"))?;
                emit_notifications(app, &notifications)?;
            }
            let result = match called {
                Ok(result) => serde_json::to_value(result)
                    .map_err(|error| format!("序列化 MCP 工具响应失败：{error}"))?,
                Err(error) => return Ok(dispatch_error(request, -32603, error)),
            };
            serde_json::from_value::<McpServerToolCallResponse>(result.clone())
                .map_err(|error| format!("MCP 工具响应不符合 App Server V2：{error}"))?;
            dispatch_success(request, result)
        }
        "mcpServerStatus/list" => {
            let mut configs = settings
                .mcp_servers
                .iter()
                .filter(|config| config.enabled)
                .map(|config| super::tietiezhi::resolve_mcp_config_secrets(app, config))
                .collect::<Result<Vec<_>, _>>()?;
            configs.sort_by(|left, right| left.id.cmp(&right.id));
            let total = configs.len();
            let start = match params.get("cursor").filter(|value| !value.is_null()) {
                Some(cursor) => match cursor
                    .as_str()
                    .and_then(|cursor| cursor.parse::<usize>().ok())
                {
                    Some(start) if start <= total => start,
                    _ => return Ok(dispatch_error(request, -32602, "invalid MCP cursor")),
                },
                None => 0,
            };
            let limit = params
                .get("limit")
                .and_then(Value::as_u64)
                .map(|limit| usize::try_from(limit).unwrap_or(usize::MAX))
                .unwrap_or(total)
                .max(1);
            let end = start.saturating_add(limit).min(total);
            let tools_only =
                params.get("detail").and_then(Value::as_str) == Some("toolsAndAuthOnly");
            let mut data = Vec::new();
            for config in &configs[start..end] {
                let auth_status = state.mcp.auth_status(config).await;
                let inventory = state.mcp.inventory(config).await.ok();
                let mut tools = serde_json::Map::new();
                if let Some(inventory) = &inventory {
                    for tool in &inventory.tools {
                        if let Some(name) = tool.get("name").and_then(Value::as_str) {
                            tools.insert(name.into(), tool.clone());
                        }
                    }
                }
                data.push(json!({
                    "name":config.id,
                    "serverInfo":inventory.as_ref().and_then(|item| item.server_info.clone()),
                    "tools":tools,
                    "resources":if tools_only {
                        Vec::<Value>::new()
                    } else {
                        inventory.as_ref().map(|item| item.resources.clone()).unwrap_or_default()
                    },
                    "resourceTemplates":if tools_only {
                        Vec::<Value>::new()
                    } else {
                        inventory.as_ref().map(|item| item.resource_templates.clone()).unwrap_or_default()
                    },
                    "authStatus":auth_status
                }));
            }
            let result = json!({
                "data":data,
                "nextCursor":(end < total).then(|| end.to_string())
            });
            serde_json::from_value::<ListMcpServerStatusResponse>(result.clone())
                .map_err(|error| format!("MCP 状态响应不符合 App Server V2：{error}"))?;
            dispatch_success(request, result)
        }
        _ => Ok(dispatch_error(request, -32601, "unknown MCP method")),
    }
}

async fn dispatch_command_exec(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("{method} 参数不符合 App Server V2：{error}"),
        ));
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let process_id = params
        .get("processId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let owner = format!("connection/{connection_id}");
    match method {
        "command/exec" => {
            let command = params
                .get("command")
                .and_then(Value::as_array)
                .map(|command| {
                    command
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if command.is_empty() || command[0].trim().is_empty() {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "command/exec command must not be empty",
                ));
            }
            let tty = params.get("tty").and_then(Value::as_bool).unwrap_or(false);
            let stream_stdin = tty
                || params
                    .get("streamStdin")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            let stream_output = tty
                || params
                    .get("streamStdoutStderr")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            if (tty || stream_stdin || stream_output) && process_id.is_none() {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "command/exec tty or streaming requires a client-supplied processId",
                ));
            }
            if process_id.as_deref().is_some_and(str::is_empty) {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "command/exec processId must not be empty",
                ));
            }
            if params.get("size").is_some_and(|size| !size.is_null()) && !tty {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "command/exec size requires tty: true",
                ));
            }
            let disable_cap = params
                .get("disableOutputCap")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if disable_cap
                && params
                    .get("outputBytesCap")
                    .is_some_and(|value| !value.is_null())
            {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "disableOutputCap cannot be combined with outputBytesCap",
                ));
            }
            let disable_timeout = params
                .get("disableTimeout")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if disable_timeout
                && params
                    .get("timeoutMs")
                    .is_some_and(|value| !value.is_null())
            {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "disableTimeout cannot be combined with timeoutMs",
                ));
            }
            let timeout = if disable_timeout {
                None
            } else {
                let timeout_ms = match params.get("timeoutMs").filter(|value| !value.is_null()) {
                    Some(value) => match value.as_i64().filter(|value| *value >= 0) {
                        Some(value) => value as u64,
                        None => {
                            return Ok(dispatch_error(
                                request,
                                -32602,
                                "timeoutMs must be non-negative",
                            ));
                        }
                    },
                    None => 10 * 60 * 1_000,
                };
                Some(Duration::from_millis(timeout_ms))
            };
            let output_bytes_cap = if disable_cap {
                None
            } else {
                Some(
                    params
                        .get("outputBytesCap")
                        .filter(|value| !value.is_null())
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                        .unwrap_or(tietiezhi_agent_exec::DEFAULT_OUTPUT_BYTES_CAP),
                )
            };
            let cwd = params
                .get("cwd")
                .and_then(Value::as_str)
                .map(std::path::PathBuf::from)
                .unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);
            let mut env = params
                .get("env")
                .and_then(Value::as_object)
                .map(|env| {
                    env.iter()
                        .map(|(key, value)| {
                            (
                                key.clone(),
                                value
                                    .as_str()
                                    .map(str::to_owned)
                                    .filter(|_| !value.is_null()),
                            )
                        })
                        .collect::<HashMap<_, _>>()
                })
                .unwrap_or_default();
            let size = match terminal_size(params.get("size")) {
                Ok(size) => size,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            let sandbox_policy_value = params
                .get("sandboxPolicy")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(runtime_defaults(app)?.sandbox);
            let sandbox_policy =
                match tietiezhi_agent_sandbox::SandboxPolicy::from_value(sandbox_policy_value) {
                    Ok(policy) => policy,
                    Err(error) => return Ok(dispatch_error(request, -32602, error.to_string())),
                };
            let _network = if sandbox_policy.is_restricted() && sandbox_policy.network_access() {
                match state
                    .codex_network
                    .prepare_execution(NetworkExecutionRequest {
                        thread_id: format!("command-exec/{connection_id}"),
                        turn_id: "command-exec".into(),
                        item_id: process_id.clone().unwrap_or_else(|| "command-exec".into()),
                        command: command.join(" "),
                        policy: NetworkPolicy {
                            enabled: true,
                            mode: NetworkMode::Full,
                            domains: Default::default(),
                            allow_local_binding: false,
                        },
                        approver: None,
                    })
                    .await
                {
                    Ok(prepared) => {
                        env.extend(prepared.env().clone());
                        Some(prepared)
                    }
                    Err(error) => {
                        return Ok(dispatch_error(request, -32603, error.to_string()));
                    }
                }
            } else {
                None
            };
            let exposed_process_id = process_id
                .clone()
                .unwrap_or_else(|| format!("internal-{}", state.codex_exec.allocate_session_id()));
            let id =
                tietiezhi_agent_exec::SessionId::new(owner.clone(), exposed_process_id.clone());
            let events = match state
                .codex_exec
                .spawn(
                    id.clone(),
                    tietiezhi_agent_exec::ExecRequest {
                        command,
                        cwd,
                        env,
                        tty,
                        stream_stdin,
                        size,
                        output_bytes_cap,
                        timeout,
                        cancellation: None,
                        sandbox_policy: Some(sandbox_policy),
                    },
                )
                .await
            {
                Ok(events) => events,
                Err(error) => return Ok(dispatch_error(request, -32602, error.to_string())),
            };
            let result = if stream_output {
                wait_streamed_command_exec(
                    app,
                    connection_id,
                    &exposed_process_id,
                    events,
                    &state.codex_exec,
                    &id,
                )
                .await?
            } else {
                state
                    .codex_exec
                    .wait(&id, None)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "command/exec ended without a result".to_string())?
            };
            let _ = state.codex_exec.remove(&id);
            let exit_code = if result.timed_out {
                124
            } else {
                result.exit_code
            };
            dispatch_success(
                request,
                json!({
                    "exitCode":exit_code,
                    "stdout":if stream_output { String::new() } else { result.stdout },
                    "stderr":if stream_output { String::new() } else { result.stderr }
                }),
            )
        }
        "command/exec/write" => {
            let Some(process_id) = process_id else {
                return Ok(dispatch_error(request, -32602, "processId is required"));
            };
            let id = tietiezhi_agent_exec::SessionId::new(owner, process_id);
            let bytes = match params.get("deltaBase64").filter(|value| !value.is_null()) {
                Some(value) => {
                    let Some(encoded) = value.as_str() else {
                        return Ok(dispatch_error(
                            request,
                            -32602,
                            "deltaBase64 must be a string",
                        ));
                    };
                    match base64::engine::general_purpose::STANDARD.decode(encoded) {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            return Ok(dispatch_error(
                                request,
                                -32602,
                                format!("invalid deltaBase64: {error}"),
                            ));
                        }
                    }
                }
                None => Vec::new(),
            };
            if let Err(error) = state
                .codex_exec
                .write(
                    &id,
                    &bytes,
                    params
                        .get("closeStdin")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .await
            {
                return Ok(dispatch_error(request, -32602, error.to_string()));
            }
            dispatch_success(request, json!({}))
        }
        "command/exec/resize" => {
            let Some(process_id) = process_id else {
                return Ok(dispatch_error(request, -32602, "processId is required"));
            };
            let id = tietiezhi_agent_exec::SessionId::new(owner, process_id);
            let size = match terminal_size(params.get("size")) {
                Ok(size) => size,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            if let Err(error) = state.codex_exec.resize(&id, size) {
                return Ok(dispatch_error(request, -32602, error.to_string()));
            }
            dispatch_success(request, json!({}))
        }
        "command/exec/terminate" => {
            let Some(process_id) = process_id else {
                return Ok(dispatch_error(request, -32602, "processId is required"));
            };
            let id = tietiezhi_agent_exec::SessionId::new(owner, process_id);
            if let Err(error) = state.codex_exec.terminate(&id) {
                return Ok(dispatch_error(request, -32602, error.to_string()));
            }
            dispatch_success(request, json!({}))
        }
        _ => Ok(dispatch_error(request, -32601, "method not found")),
    }
}

async fn wait_streamed_command_exec(
    app: &AppHandle,
    connection_id: &str,
    process_id: &str,
    mut events: tokio::sync::broadcast::Receiver<tietiezhi_agent_exec::ExecEvent>,
    manager: &tietiezhi_agent_exec::ExecManager,
    id: &tietiezhi_agent_exec::SessionId,
) -> Result<tietiezhi_agent_exec::ExecResult, String> {
    let mut cursor = 0;
    loop {
        match events.recv().await {
            Ok(tietiezhi_agent_exec::ExecEvent::Output(chunk)) => {
                cursor = cursor.max(chunk.cursor);
                emit_command_exec_output(app, connection_id, process_id, chunk)?;
            }
            Ok(tietiezhi_agent_exec::ExecEvent::Exited(result)) => {
                let missed = manager
                    .poll(id, cursor, Duration::ZERO)
                    .await
                    .map_err(|error| error.to_string())?;
                for chunk in missed.chunks {
                    emit_command_exec_output(app, connection_id, process_id, chunk)?;
                }
                return Ok(result);
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                let missed = manager
                    .poll(id, cursor, Duration::ZERO)
                    .await
                    .map_err(|error| error.to_string())?;
                for chunk in missed.chunks {
                    cursor = cursor.max(chunk.cursor);
                    emit_command_exec_output(app, connection_id, process_id, chunk)?;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                return manager
                    .wait(id, None)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "command/exec output stream closed before exit".into());
            }
        }
    }
}

fn emit_command_exec_output(
    app: &AppHandle,
    connection_id: &str,
    process_id: &str,
    chunk: tietiezhi_agent_exec::OutputChunk,
) -> Result<(), String> {
    emit_checked_notification(
        app,
        RoutedNotification {
            recipients: vec![connection_id.into()],
            method: "command/exec/outputDelta".into(),
            params: json!({
                "processId":process_id,
                "stream":match chunk.stream {
                    tietiezhi_agent_exec::OutputStream::Stdout => "stdout",
                    tietiezhi_agent_exec::OutputStream::Stderr => "stderr",
                },
                "deltaBase64":base64::engine::general_purpose::STANDARD.encode(chunk.bytes),
                "capReached":chunk.cap_reached
            }),
        },
    )
}

async fn dispatch_thread_shell_command(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("thread/shellCommand 参数不符合 App Server V2：{error}"),
        ));
    }
    let thread_id = request
        .pointer("/params/threadId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let command = request
        .pointer("/params/command")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if command.is_empty() {
        return Ok(dispatch_error(request, -32602, "command must not be empty"));
    }
    let manager = thread_manager(app, state)?;
    let context = match manager.thread_shell_context(connection_id, thread_id) {
        Ok(context) => context,
        Err(error) => return Ok(dispatch_error(request, error.code, error.message)),
    };
    let process_handle = uuid::Uuid::new_v4().to_string();
    let id = tietiezhi_agent_exec::SessionId::new(
        format!("thread-shell/{thread_id}"),
        process_handle.clone(),
    );
    let events = match state
        .codex_exec
        .spawn(
            id.clone(),
            tietiezhi_agent_exec::ExecRequest {
                command: host_shell_argv(command),
                cwd: context.cwd,
                env: HashMap::new(),
                tty: false,
                stream_stdin: false,
                size: tietiezhi_agent_exec::TerminalSize::default(),
                output_bytes_cap: Some(tietiezhi_agent_exec::DEFAULT_OUTPUT_BYTES_CAP),
                timeout: None,
                cancellation: None,
                sandbox_policy: None,
            },
        )
        .await
    {
        Ok(events) => events,
        Err(error) => return Ok(dispatch_error(request, -32603, error.to_string())),
    };
    let app_handle = app.clone();
    let exec = state.codex_exec.clone();
    let recipients = context.recipients;
    tauri::async_runtime::spawn(async move {
        let mut events = events;
        loop {
            match events.recv().await {
                Ok(tietiezhi_agent_exec::ExecEvent::Output(chunk)) => {
                    let notification = RoutedNotification {
                        recipients: recipients.clone(),
                        method: "process/outputDelta".into(),
                        params: json!({
                            "processHandle":process_handle,
                            "stream":match chunk.stream {
                                tietiezhi_agent_exec::OutputStream::Stdout => "stdout",
                                tietiezhi_agent_exec::OutputStream::Stderr => "stderr",
                            },
                            "deltaBase64":base64::engine::general_purpose::STANDARD.encode(chunk.bytes),
                            "capReached":chunk.cap_reached
                        }),
                    };
                    let _ = emit_checked_notification(&app_handle, notification);
                }
                Ok(tietiezhi_agent_exec::ExecEvent::Exited(result)) => {
                    let notification = RoutedNotification {
                        recipients: recipients.clone(),
                        method: "process/exited".into(),
                        params: json!({
                            "processHandle":process_handle,
                            "exitCode":if result.timed_out { 124 } else { result.exit_code },
                            "stdout":"",
                            "stdoutCapReached":result.stdout_cap_reached,
                            "stderr":"",
                            "stderrCapReached":result.stderr_cap_reached
                        }),
                    };
                    let _ = emit_checked_notification(&app_handle, notification);
                    let _ = exec.remove(&id);
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    dispatch_success(request, json!({}))
}

fn terminal_size(value: Option<&Value>) -> Result<tietiezhi_agent_exec::TerminalSize, String> {
    let rows = value
        .and_then(|value| value.get("rows"))
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(24);
    let cols = value
        .and_then(|value| value.get("cols"))
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(80);
    if rows == 0 || cols == 0 {
        return Err("command/exec size rows and cols must be greater than 0".into());
    }
    Ok(tietiezhi_agent_exec::TerminalSize { rows, cols })
}

fn host_shell_argv(command: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            "powershell.exe".into(),
            "-NoProfile".into(),
            "-Command".into(),
            command.into(),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
            "-c".into(),
            command.into(),
        ]
    }
}

fn emit_checked_notification(
    app: &AppHandle,
    notification: RoutedNotification,
) -> Result<(), String> {
    serde_json::from_value::<ServerNotification>(notification.wire_message())
        .map_err(|error| format!("Codex notification payload 无效：{error}"))?;
    emit_notifications(app, &[notification])
}

async fn dispatch_account_request(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = state.codex_account.validate_request(connection_id, request) {
        return Ok(account_output(
            state.codex_account.error_output(request, error),
        ));
    }
    let result = match method {
        "account/login/start" => account_login_start(app, state, connection_id, request).await,
        "account/login/cancel" => {
            let (output, canceled) = state.codex_account.cancel_login(connection_id, request);
            if let Some(login_id) = canceled {
                cancel_account_login(state, &login_id);
            }
            Ok(account_output(output))
        }
        "account/logout" => account_logout(app, state, connection_id, request).await,
        "account/read" => match refresh_account_snapshot(app, state).await {
            Ok(()) => cached_account_output(state, connection_id, request),
            Err(error) => Err(error),
        },
        "account/rateLimits/read" => match refresh_rate_limits(app, state).await {
            Ok(()) => cached_account_output(state, connection_id, request),
            Err(error) => Err(error),
        },
        _ => cached_account_output(state, connection_id, request),
    };
    Ok(result.unwrap_or_else(|error| {
        account_output(
            state
                .codex_account
                .error_output(request, AccountRpcError::internal(error)),
        )
    }))
}

fn cached_account_output(
    state: &AppState,
    connection_id: &str,
    request: &Value,
) -> Result<DispatchOutput, String> {
    state
        .codex_account
        .dispatch_cached(connection_id, request)
        .map(account_output)
        .ok_or_else(|| {
            format!(
                "尚未实现的 Codex account 方法：{}",
                request
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )
        })
}

async fn account_login_start(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
) -> Result<DispatchOutput, String> {
    let provider = selected_provider(app)?;
    match request.pointer("/params/type").and_then(Value::as_str) {
        Some("chatgpt") => {
            if !provider.built_in {
                return Ok(account_output(state.codex_account.error_output(
                    request,
                    AccountRpcError::invalid_request(
                        "browser account login is only available for Tietiezhi Gateway",
                    ),
                )));
            }
            cancel_all_account_logins(state);
            let login_id = uuid::Uuid::new_v4().to_string();
            let attempt =
                super::gateway_auth::prepare_gateway_login(&state.http, app, provider.id.clone())
                    .await
                    .map_err(|error| format!("启动 Gateway 登录失败：{error}"))?;
            let output = state.codex_account.begin_chatgpt_login(
                connection_id,
                request,
                login_id.clone(),
                attempt.auth_url().into(),
            );
            if output.response.get("error").is_some() {
                return Ok(account_output(output));
            }
            let cancel = CancellationToken::new();
            state
                .codex_login_cancels
                .lock()
                .map_err(|_| "Codex 登录取消状态锁已损坏".to_string())?
                .insert(login_id.clone(), cancel.clone());
            let app = app.clone();
            let http = state.http.clone();
            tauri::async_runtime::spawn(async move {
                let result = tokio::select! {
                    _ = cancel.cancelled() => return,
                    result = super::gateway_auth::complete_gateway_login(&http, app.clone(), attempt) => result,
                };
                let state = app.state::<AppState>();
                let completion = match result {
                    Ok(view) => {
                        let account = view
                            .account
                            .map(gateway_account_value)
                            .ok_or_else(|| "Gateway 登录完成但没有返回账号".to_string());
                        state
                            .codex_account
                            .complete_chatgpt_login(&login_id, account)
                    }
                    Err(error) => state
                        .codex_account
                        .complete_chatgpt_login(&login_id, Err(error)),
                };
                if let Ok(notifications) = completion {
                    let routed = account_notifications(notifications);
                    let _ = emit_notifications(&app, &routed);
                }
                if let Ok(mut cancels) = state.codex_login_cancels.lock() {
                    cancels.remove(&login_id);
                };
            });
            Ok(account_output(output))
        }
        Some("apiKey") => {
            if provider.built_in {
                return Ok(account_output(state.codex_account.error_output(
                    request,
                    AccountRpcError::invalid_request(
                        "Tietiezhi Gateway credentials are managed by browser login",
                    ),
                )));
            }
            let api_key = match required_account_string(request, "/params/apiKey") {
                Ok(value) => value,
                Err(error) => {
                    return Ok(account_output(
                        state.codex_account.error_output(request, error),
                    ));
                }
            };
            crate::secrets::set_provider_key(&provider.id, &api_key)?;
            if let Ok(mut external) = state.codex_external_auth.lock() {
                external.remove(&provider.id);
            }
            Ok(account_output(
                state.codex_account.complete_immediate_login(
                    connection_id,
                    request,
                    ImmediateLogin {
                        response_type: "apiKey",
                        account: json!({"type": "apiKey"}),
                        requires_openai_auth: false,
                        auth_mode: "apikey",
                        plan_type: None,
                    },
                ),
            ))
        }
        Some("chatgptAuthTokens") => {
            if provider.built_in {
                return Ok(account_output(state.codex_account.error_output(
                    request,
                    AccountRpcError::invalid_request(
                        "Tietiezhi Gateway does not use externally supplied ChatGPT tokens",
                    ),
                )));
            }
            let access_token = match required_account_string(request, "/params/accessToken") {
                Ok(value) => value,
                Err(error) => {
                    return Ok(account_output(
                        state.codex_account.error_output(request, error),
                    ));
                }
            };
            let account_id = match required_account_string(request, "/params/chatgptAccountId") {
                Ok(value) => value,
                Err(error) => {
                    return Ok(account_output(
                        state.codex_account.error_output(request, error),
                    ));
                }
            };
            let plan_type = request
                .pointer("/params/chatgptPlanType")
                .and_then(Value::as_str)
                .map(normalized_plan_type)
                .map(str::to_owned);
            state
                .codex_external_auth
                .lock()
                .map_err(|_| "Codex 外部账号状态锁已损坏".to_string())?
                .insert(
                    provider.id.clone(),
                    ExternalAuthTokens {
                        access_token,
                        account_id,
                        plan_type: plan_type.clone(),
                    },
                );
            Ok(account_output(
                state.codex_account.complete_immediate_login(
                    connection_id,
                    request,
                    ImmediateLogin {
                        response_type: "chatgptAuthTokens",
                        account: json!({
                            "type": "chatgpt",
                            "email": null,
                            "planType": plan_type.as_deref().unwrap_or("unknown")
                        }),
                        requires_openai_auth: false,
                        auth_mode: "chatgptAuthTokens",
                        plan_type: Some(plan_type.as_deref().unwrap_or("unknown")),
                    },
                ),
            ))
        }
        _ => Ok(account_output(state.codex_account.error_output(
            request,
            AccountRpcError::invalid_request(
                "this runtime supports apiKey, chatgpt, and chatgptAuthTokens login",
            ),
        ))),
    }
}

async fn account_logout(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
) -> Result<DispatchOutput, String> {
    let provider = selected_provider(app)?;
    if provider.built_in {
        super::gateway_auth::revoke_gateway_login(&state.http, app, &provider.id).await?;
    } else {
        crate::secrets::delete_provider_key(&provider.id)?;
        state
            .codex_external_auth
            .lock()
            .map_err(|_| "Codex 外部账号状态锁已损坏".to_string())?
            .remove(&provider.id);
    }
    let (output, canceled) = state.codex_account.logout(connection_id, request);
    if let Some(login_id) = canceled {
        cancel_account_login(state, &login_id);
    }
    Ok(account_output(output))
}

async fn refresh_account_snapshot(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let provider = selected_provider(app)?;
    if provider.built_in {
        let view = super::gateway_auth::load_gateway_account(&state.http, app, provider.id.clone())
            .await?;
        let account = view.account.map(gateway_account_value);
        state
            .codex_account
            .set_account(
                account,
                true,
                view.logged_in.then_some("chatgpt"),
                view.logged_in.then_some("unknown"),
            )
            .map_err(account_rpc_error)?;
    } else {
        let external = state
            .codex_external_auth
            .lock()
            .map_err(|_| "Codex 外部账号状态锁已损坏".to_string())?
            .get(&provider.id)
            .cloned();
        let api_key = crate::secrets::get_provider_key(&provider.id)?.is_some();
        let (account, auth_mode, plan_type) = match external {
            Some(tokens) => (
                Some(json!({
                    "type": "chatgpt",
                    "email": null,
                    "planType": tokens.plan_type.as_deref().unwrap_or("unknown")
                })),
                Some("chatgptAuthTokens"),
                Some(tokens.plan_type.unwrap_or_else(|| "unknown".into())),
            ),
            None if api_key => (Some(json!({"type": "apiKey"})), Some("apikey"), None),
            None => (None, None, None),
        };
        state
            .codex_account
            .set_account(account, false, auth_mode, plan_type.as_deref())
            .map_err(account_rpc_error)?;
    }
    Ok(())
}

async fn refresh_rate_limits(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let provider = selected_provider(app)?;
    let response = if provider.built_in {
        let quota = super::gateway_auth::load_gateway_quota(&state.http, app, &provider.id).await?;
        gateway_rate_limits(&quota)
    } else {
        empty_rate_limits()
    };
    state
        .codex_account
        .set_rate_limits(response)
        .map_err(account_rpc_error)?;
    Ok(())
}

fn selected_provider(app: &AppHandle) -> Result<super::settings::Provider, String> {
    let settings = super::settings::read_settings(app)?;
    settings
        .providers
        .into_iter()
        .find(|provider| provider.id == settings.chat_provider_id)
        .ok_or_else(|| "未配置 Codex Runtime 供应商".into())
}

fn gateway_account_value(account: super::gateway_auth::GatewayAccount) -> Value {
    json!({
        "type": "chatgpt",
        "email": (!account.email.trim().is_empty()).then_some(account.email),
        "planType": "unknown"
    })
}

fn gateway_rate_limits(quota: &super::gateway_auth::GatewayQuotaView) -> Value {
    let package_remaining = quota
        .packages
        .iter()
        .map(|package| package.window_remaining.max(0))
        .sum::<i64>();
    let has_credits = quota.wallet.balance_micro > 0 || package_remaining > 0;
    let used_percent = quota
        .packages
        .iter()
        .filter(|package| package.quota_per_window > 0)
        .map(|package| {
            let used = package
                .quota_per_window
                .saturating_sub(package.window_remaining.max(0));
            ((used as f64 / package.quota_per_window as f64) * 100.0)
                .round()
                .clamp(0.0, 100.0) as i32
        })
        .max();
    let snapshot = json!({
        "limitId": "tietiezhi-gateway",
        "limitName": "Tietiezhi Gateway",
        "primary": used_percent.map(|used_percent| json!({
            "usedPercent": used_percent,
            "windowDurationMins": null,
            "resetsAt": null
        })),
        "secondary": null,
        "credits": {
            "hasCredits": has_credits,
            "unlimited": false,
            "balance": format_micro(quota.wallet.balance_micro)
        },
        "individualLimit": null,
        "spendControlReached": !has_credits,
        "planType": "unknown",
        "rateLimitReachedType": (!has_credits).then_some("rate_limit_reached")
    });
    json!({
        "rateLimits": snapshot,
        "rateLimitsByLimitId": {
            "tietiezhi-gateway": snapshot
        },
        "rateLimitResetCredits": null
    })
}

fn empty_rate_limits() -> Value {
    json!({
        "rateLimits": {
            "limitId": null,
            "limitName": null,
            "primary": null,
            "secondary": null,
            "credits": null,
            "individualLimit": null,
            "spendControlReached": null,
            "planType": null,
            "rateLimitReachedType": null
        },
        "rateLimitsByLimitId": null,
        "rateLimitResetCredits": null
    })
}

fn format_micro(value: i64) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let absolute = value.unsigned_abs();
    format!("{sign}{}.{:06}", absolute / 1_000_000, absolute % 1_000_000)
}

fn required_account_string(request: &Value, pointer: &str) -> Result<String, AccountRpcError> {
    request
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AccountRpcError::invalid(format!("{pointer} 不能为空")))
}

fn normalized_plan_type(value: &str) -> &'static str {
    match value {
        "free" => "free",
        "go" => "go",
        "plus" => "plus",
        "pro" => "pro",
        "prolite" => "prolite",
        "team" => "team",
        "self_serve_business_usage_based" => "self_serve_business_usage_based",
        "business" => "business",
        "enterprise_cbp_usage_based" => "enterprise_cbp_usage_based",
        "enterprise" => "enterprise",
        "edu" => "edu",
        _ => "unknown",
    }
}

fn cancel_account_login(state: &AppState, login_id: &str) {
    if let Ok(mut cancels) = state.codex_login_cancels.lock() {
        if let Some(cancel) = cancels.remove(login_id) {
            cancel.cancel();
        }
    }
}

fn cancel_all_account_logins(state: &AppState) {
    if let Ok(mut cancels) = state.codex_login_cancels.lock() {
        for (_, cancel) in cancels.drain() {
            cancel.cancel();
        }
    }
}

fn account_rpc_error(error: AccountRpcError) -> String {
    format!("Codex account 状态错误：{}", error.message)
}

fn account_output(output: AccountDispatchOutput) -> DispatchOutput {
    DispatchOutput {
        response: output.response,
        notifications: account_notifications(output.notifications),
    }
}

fn account_notifications(notifications: Vec<AccountNotification>) -> Vec<RoutedNotification> {
    notifications
        .into_iter()
        .map(|notification| RoutedNotification {
            recipients: notification.recipients,
            method: notification.method,
            params: notification.params,
        })
        .collect()
}

fn launch_compaction_executor(
    app: &AppHandle,
    state: &AppState,
    manager: ThreadManager,
    thread_id: String,
    turn_id: String,
) {
    let cancel = CancellationToken::new();
    if let Ok(mut cancels) = state.codex_cancels.lock() {
        if let Some((_, stale)) =
            cancels.insert(thread_id.clone(), (turn_id.clone(), cancel.clone()))
        {
            stale.cancel();
        }
    }
    let app = app.clone();
    let http = state.http.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let snapshot = manager
                .compaction_execution_snapshot(&thread_id, &turn_id)
                .map_err(core_model_error)?;
            run_compaction_snapshot(app.clone(), manager.clone(), http, snapshot, cancel.clone())
                .await
        }
        .await;
        if let Err(error) = result {
            if !cancel.is_cancelled() {
                fail_turn(&app, &manager, &thread_id, &turn_id, error);
            }
        }
        let state = app.state::<AppState>();
        if let Ok(mut cancels) = state.codex_cancels.lock() {
            if cancels
                .get(&thread_id)
                .is_some_and(|(active_turn_id, _)| active_turn_id == &turn_id)
            {
                cancels.remove(&thread_id);
            }
        };
    });
}

async fn run_compaction_snapshot(
    app: AppHandle,
    manager: ThreadManager,
    http: reqwest::Client,
    snapshot: CompactionExecutionSnapshot,
    cancel: CancellationToken,
) -> Result<(), ModelError> {
    let resolved =
        super::providers::resolve(&app, &snapshot.model_provider).map_err(ModelError::Transport)?;
    let base_url = super::api_url(&resolved.base_url, "")
        .trim_end_matches('/')
        .to_owned();
    let provider_id = resolved.id;
    let provider_name = resolved.kind;
    let mut bearer_token = app
        .state::<AppState>()
        .codex_external_auth
        .lock()
        .map_err(|_| ModelError::Consumer("Codex 外部账号状态锁已损坏".into()))?
        .get(&provider_id)
        .map(|tokens| tokens.access_token.clone())
        .or(resolved.key);
    let capability_key = format!("{provider_id}\n{base_url}");
    let wire_api = resolved.wire_api;
    let mut client = responses_client(&http, &provider_name, &base_url, bearer_token.clone());
    ensure_responses_capability(&app, &capability_key, wire_api, &client).await?;

    let mut history = compaction_prompt_history(&snapshot.history);
    let mut summary_suffix = String::new();
    let mut model_output_seen = false;
    let mut auth_refresh_attempted = false;
    let mut server_model = None;
    loop {
        let request = compaction_response_request(&snapshot, history.clone());
        let stream = client.stream(&request, |event| {
            let notifications = match event {
                ResponseEvent::Created
                | ResponseEvent::ServerReasoningIncluded(_)
                | ResponseEvent::ModelsEtag(_)
                | ResponseEvent::OutputTextDelta(_)
                | ResponseEvent::ToolCallInputDelta { .. }
                | ResponseEvent::ReasoningSummaryDelta { .. }
                | ResponseEvent::ReasoningSummaryDone { .. }
                | ResponseEvent::ReasoningContentDelta { .. }
                | ResponseEvent::ReasoningSummaryPartAdded { .. } => Vec::new(),
                ResponseEvent::Retrying { error, .. } => manager
                    .error_notification(
                        &snapshot.thread_id,
                        &snapshot.turn_id,
                        error.as_turn_error(),
                        true,
                    )
                    .map_err(core_model_error)?,
                ResponseEvent::OutputItemAdded(_) => {
                    model_output_seen = true;
                    Vec::new()
                }
                ResponseEvent::OutputItemDone(item) => {
                    model_output_seen = true;
                    if let Some(text) = assistant_response_text(&item) {
                        summary_suffix = text;
                    }
                    manager
                        .record_compaction_response_item(
                            &snapshot.thread_id,
                            &snapshot.turn_id,
                            item,
                        )
                        .map_err(core_model_error)?;
                    Vec::new()
                }
                ResponseEvent::ServerModel(model) => {
                    if server_model.as_deref() == Some(model.as_str())
                        || model.eq_ignore_ascii_case(&snapshot.model)
                    {
                        Vec::new()
                    } else {
                        server_model = Some(model.clone());
                        manager
                            .model_rerouted_notification(
                                &snapshot.thread_id,
                                &snapshot.turn_id,
                                &snapshot.model,
                                &model,
                            )
                            .map_err(core_model_error)?
                    }
                }
                ResponseEvent::ModelVerifications(verifications) => manager
                    .model_verification_notification(
                        &snapshot.thread_id,
                        &snapshot.turn_id,
                        verifications,
                    )
                    .map_err(core_model_error)?,
                ResponseEvent::TurnModerationMetadata(metadata) => manager
                    .turn_moderation_metadata_notification(
                        &snapshot.thread_id,
                        &snapshot.turn_id,
                        metadata,
                    )
                    .map_err(core_model_error)?,
                ResponseEvent::SafetyBuffering(buffering) => manager
                    .safety_buffering_notification(
                        &snapshot.thread_id,
                        &snapshot.turn_id,
                        &snapshot.model,
                        buffering.use_cases,
                        buffering.reasons,
                        buffering.show_buffering_ui,
                        buffering.faster_model,
                    )
                    .map_err(core_model_error)?,
                ResponseEvent::Completed { token_usage, .. } => {
                    if let Some(usage) = token_usage {
                        manager
                            .record_token_usage(
                                &snapshot.thread_id,
                                &snapshot.turn_id,
                                usage,
                                snapshot.model_context_window,
                            )
                            .map_err(core_model_error)?
                    } else {
                        Vec::new()
                    }
                }
            };
            emit_notifications(&app, &notifications).map_err(ModelError::Consumer)
        });
        let result = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = stream => result,
        };
        if matches!(result, Err(ModelError::Unauthorized { .. }))
            && !auth_refresh_attempted
            && !model_output_seen
        {
            if let Some(tokens) = refresh_external_auth(&app, &provider_id).await? {
                auth_refresh_attempted = true;
                bearer_token = Some(tokens.access_token);
                client = responses_client(&http, &provider_name, &base_url, bearer_token.clone());
                continue;
            }
        }
        if matches!(result, Err(ModelError::ContextWindowExceeded)) && history.len() > 1 {
            history.remove(0);
            model_output_seen = false;
            continue;
        }
        result?;
        break;
    }
    if cancel.is_cancelled() {
        return Ok(());
    }
    let notifications = manager
        .complete_compaction(&snapshot.thread_id, &snapshot.turn_id, &summary_suffix)
        .map_err(core_model_error)?;
    emit_notifications(&app, &notifications).map_err(ModelError::Consumer)
}

fn launch_turn_executor(
    app: &AppHandle,
    state: &AppState,
    manager: ThreadManager,
    thread_id: String,
    turn_id: String,
) {
    let cancel = CancellationToken::new();
    if let Ok(mut cancels) = state.codex_cancels.lock() {
        if let Some((_, stale)) =
            cancels.insert(thread_id.clone(), (turn_id.clone(), cancel.clone()))
        {
            stale.cancel();
        }
    }
    if let Ok(mut activity) = state.codex_input_activity.lock() {
        if let Some((_, stale)) = activity.insert(
            thread_id.clone(),
            (turn_id.clone(), CancellationToken::new()),
        ) {
            stale.cancel();
        }
    }
    let app = app.clone();
    let http = state.http.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_turn_executor(
            app.clone(),
            manager.clone(),
            http,
            thread_id.clone(),
            turn_id.clone(),
            cancel.clone(),
        )
        .await;
        if let Err(error) = result {
            if !cancel.is_cancelled() {
                fail_turn(&app, &manager, &thread_id, &turn_id, error);
            }
        }
        let state = app.state::<AppState>();
        if let Ok(mut cancels) = state.codex_cancels.lock() {
            if cancels
                .get(&thread_id)
                .is_some_and(|(active_turn_id, _)| active_turn_id == &turn_id)
            {
                cancels.remove(&thread_id);
            }
        };
        if let Ok(mut activity) = state.codex_input_activity.lock() {
            if activity
                .get(&thread_id)
                .is_some_and(|(active_turn_id, _)| active_turn_id == &turn_id)
            {
                activity.remove(&thread_id);
            }
        };
    });
}

async fn run_turn_executor(
    app: AppHandle,
    manager: ThreadManager,
    http: reqwest::Client,
    thread_id: String,
    turn_id: String,
    cancel: CancellationToken,
) -> Result<(), ModelError> {
    let initial = manager
        .turn_execution_snapshot(&thread_id, &turn_id)
        .map_err(core_model_error)?;
    let resolved =
        super::providers::resolve(&app, &initial.model_provider).map_err(ModelError::Transport)?;
    let base_url = super::api_url(&resolved.base_url, "")
        .trim_end_matches('/')
        .to_owned();
    let provider_id = resolved.id;
    let provider_name = resolved.kind;
    let mut bearer_token = app
        .state::<AppState>()
        .codex_external_auth
        .lock()
        .map_err(|_| ModelError::Consumer("Codex 外部账号状态锁已损坏".into()))?
        .get(&provider_id)
        .map(|tokens| tokens.access_token.clone())
        .or(resolved.key);
    let capability_key = format!("{provider_id}\n{base_url}");
    let wire_api = resolved.wire_api;
    let mut client = responses_client(&http, &provider_name, &base_url, bearer_token.clone());
    ensure_responses_capability(&app, &capability_key, wire_api, &client).await?;
    let mut projection = ResponseProjection::new(
        initial.model.clone(),
        initial.model_context_window,
        initial.cwd.clone(),
    );
    let mut can_drain_steered = false;
    let mut output_schema = None;
    let mut auth_refresh_attempted = false;
    let (tool_runtime, base_tool_specs) = turn_tool_runtime(&app, &manager, &initial).await?;
    let mut loaded_tool_specs = Vec::new();

    loop {
        let drained = manager
            .drain_turn_inputs(&thread_id, &turn_id, can_drain_steered)
            .map_err(core_model_error)?;
        emit_notifications(&app, &drained.notifications).map_err(ModelError::Consumer)?;
        can_drain_steered = true;
        if manager
            .should_auto_compact(&thread_id, &turn_id)
            .map_err(core_model_error)?
        {
            let (snapshot, notifications) = manager
                .begin_auto_compaction(&thread_id, &turn_id)
                .map_err(core_model_error)?;
            emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
            run_compaction_snapshot(
                app.clone(),
                manager.clone(),
                http.clone(),
                snapshot,
                cancel.clone(),
            )
            .await?;
        }
        let snapshot = manager
            .turn_execution_snapshot(&thread_id, &turn_id)
            .map_err(core_model_error)?;
        if let Some(schema) = drained
            .batches
            .iter()
            .rev()
            .find_map(|batch| batch.output_schema.clone())
        {
            output_schema = Some(schema);
        }
        let request = response_request(
            &snapshot,
            output_schema.clone(),
            merge_tool_specs(&base_tool_specs, &loaded_tool_specs),
        );
        let stream = client.stream(&request, |event| {
            let notifications = projection.apply(&manager, &thread_id, &turn_id, event)?;
            emit_notifications(&app, &notifications).map_err(ModelError::Consumer)
        });
        let result = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = stream => result,
        };
        if matches!(result, Err(ModelError::Unauthorized { .. }))
            && !auth_refresh_attempted
            && !projection.model_output_seen()
        {
            if let Some(tokens) = refresh_external_auth(&app, &provider_id).await? {
                auth_refresh_attempted = true;
                bearer_token = Some(tokens.access_token);
                client = responses_client(&http, &provider_name, &base_url, bearer_token.clone());
                continue;
            }
        }
        result?;
        if cancel.is_cancelled() {
            return Ok(());
        }
        let tool_calls = projection.take_tool_calls();
        if !tool_calls.is_empty() {
            let input_activity = turn_input_activity_token(&app, &thread_id, &turn_id);
            if manager
                .has_pending_turn_input(&thread_id, &turn_id)
                .map_err(core_model_error)?
            {
                input_activity.cancel();
            }
            let calls = tool_calls
                .into_iter()
                .map(|call| {
                    let timeline_item = local_tool_timeline_item(&snapshot, &call);
                    (call, timeline_item)
                })
                .collect::<Vec<_>>();
            for (_, item) in &calls {
                let Some(item) = item else {
                    continue;
                };
                let notifications = manager
                    .local_tool_item_started(&thread_id, &turn_id, item.clone())
                    .map_err(core_model_error)?;
                emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                if item.get("type").and_then(Value::as_str) == Some("fileChange") {
                    let changes = item
                        .get("changes")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let notifications = manager
                        .file_change_patch_updated(
                            &thread_id,
                            &turn_id,
                            item.get("id").and_then(Value::as_str).unwrap_or_default(),
                            changes,
                        )
                        .map_err(core_model_error)?;
                    emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                }
            }
            let executions = calls.into_iter().map(|(call, timeline_item)| {
                let runtime = tool_runtime.clone();
                let thread_id = thread_id.clone();
                let turn_id = turn_id.clone();
                let cancel = cancel.clone();
                let input_activity = input_activity.clone();
                async move {
                    let output = runtime
                        .handle_model_call_result_with_activity(
                            thread_id,
                            turn_id,
                            call.clone(),
                            cancel,
                            input_activity,
                        )
                        .await;
                    (call, timeline_item, output)
                }
            });
            for (call, timeline_item, output) in futures_util::future::join_all(executions).await {
                let metadata_item = output
                    .metadata
                    .as_ref()
                    .filter(|metadata| {
                        matches!(
                            metadata.get("kind").and_then(Value::as_str),
                            Some("fileChange" | "commandExecution")
                        )
                    })
                    .and_then(|metadata| metadata.get("item"))
                    .cloned();
                let defer_item_completion = output
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("deferItemCompletion"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if let Some(item) = metadata_item.or(timeline_item) {
                    if item.get("type").and_then(Value::as_str) == Some("fileChange") {
                        let changes = item
                            .get("changes")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let notifications = manager
                            .file_change_patch_updated(
                                &thread_id,
                                &turn_id,
                                item.get("id").and_then(Value::as_str).unwrap_or_default(),
                                changes,
                            )
                            .map_err(core_model_error)?;
                        emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                    }
                    if !defer_item_completion {
                        let notifications = manager
                            .local_tool_item_completed(&thread_id, &turn_id, item)
                            .map_err(core_model_error)?;
                        emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                    }
                }
                if let Some(diff) = output
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("turnDiff"))
                    .and_then(Value::as_str)
                {
                    let notifications = manager
                        .turn_diff_updated(&thread_id, &turn_id, diff)
                        .map_err(core_model_error)?;
                    emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                }
                if matches!(call.payload, ToolPayload::ToolSearch { .. }) {
                    if let Some(tools) = output.response_item.get("tools").and_then(Value::as_array)
                    {
                        loaded_tool_specs.extend(tools.iter().cloned());
                    }
                }
                let notifications = manager
                    .model_item_completed(&thread_id, &turn_id, output.response_item)
                    .map_err(core_model_error)?;
                emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
            }
            continue;
        }
        if projection.take_needs_follow_up() {
            continue;
        }
        match manager
            .complete_turn_if_no_pending(&thread_id, &turn_id)
            .map_err(core_model_error)?
        {
            Some(notifications) => {
                emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                return Ok(());
            }
            None => continue,
        }
    }
}

fn responses_client(
    http: &reqwest::Client,
    provider_name: &str,
    base_url: &str,
    bearer_token: Option<String>,
) -> ResponsesClient {
    ResponsesClient::new(
        http.clone(),
        tietiezhi_agent_model::Provider::openai_compatible(provider_name, base_url, bearer_token),
    )
}

async fn refresh_external_auth(
    app: &AppHandle,
    provider_id: &str,
) -> Result<Option<ExternalAuthTokens>, ModelError> {
    let state = app.state::<AppState>();
    let current = state
        .codex_external_auth
        .lock()
        .map_err(|_| ModelError::Consumer("Codex 外部账号状态锁已损坏".into()))?
        .get(provider_id)
        .cloned();
    let Some(current) = current else {
        return Ok(None);
    };
    let recipients = state
        .codex_account
        .connections()
        .map_err(|error| ModelError::Consumer(error.message))?;
    let pending = state
        .codex_account_requests
        .begin_auth_refresh(recipients, Some(current.account_id))
        .map_err(|error| ModelError::Consumer(error.message))?;
    emit_server_request(app, &pending.request).map_err(ModelError::Consumer)?;
    let request_id = pending.request.id.clone();
    let result = match tokio::time::timeout(Duration::from_secs(60), pending.receiver).await {
        Ok(Ok(result)) => result.map_err(|error| ModelError::InvalidRequest {
            message: error.message,
        })?,
        Ok(Err(_)) => {
            return Err(ModelError::Consumer("外部账号刷新响应通道已关闭".into()));
        }
        Err(_) => {
            let _ = state.codex_account_requests.cancel(&request_id);
            return Err(ModelError::InvalidRequest {
                message: "等待外部账号刷新超时".into(),
            });
        }
    };
    let access_token = result
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ModelError::Consumer("外部账号刷新缺少 accessToken".into()))?
        .to_owned();
    let account_id = result
        .get("chatgptAccountId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ModelError::Consumer("外部账号刷新缺少 chatgptAccountId".into()))?
        .to_owned();
    let plan_type = result
        .get("chatgptPlanType")
        .and_then(Value::as_str)
        .map(normalized_plan_type)
        .map(str::to_owned);
    let tokens = ExternalAuthTokens {
        access_token,
        account_id,
        plan_type,
    };
    state
        .codex_external_auth
        .lock()
        .map_err(|_| ModelError::Consumer("Codex 外部账号状态锁已损坏".into()))?
        .insert(provider_id.into(), tokens.clone());
    Ok(Some(tokens))
}

async fn ensure_responses_capability(
    app: &AppHandle,
    capability_key: &str,
    wire_api: super::settings::WireApi,
    client: &ResponsesClient,
) -> Result<(), ModelError> {
    match wire_api {
        super::settings::WireApi::Responses => return Ok(()),
        super::settings::WireApi::ChatCompletions => {
            return Err(ModelError::InvalidRequest {
                message: "当前供应商配置为仅普通聊天；Codex Agent Runtime 必须使用 Responses API"
                    .into(),
            });
        }
        super::settings::WireApi::Auto => {}
    }
    let state = app.state::<AppState>();
    let cached = state
        .codex_wire_capabilities
        .lock()
        .map_err(|_| ModelError::Consumer("供应商 capability 缓存锁已损坏".into()))?
        .get(capability_key)
        .copied();
    let supported = match cached {
        Some(supported) => supported,
        None => {
            let supported = client.supports_responses().await?;
            state
                .codex_wire_capabilities
                .lock()
                .map_err(|_| ModelError::Consumer("供应商 capability 缓存锁已损坏".into()))?
                .insert(capability_key.into(), supported);
            supported
        }
    };
    if supported {
        Ok(())
    } else {
        Err(ModelError::InvalidRequest {
            message:
                "当前供应商没有可用的 /v1/responses；请升级 Gateway，或改用支持 Responses API 的供应商"
                    .into(),
        })
    }
}

fn response_request(
    snapshot: &TurnExecutionSnapshot,
    output_schema: Option<Value>,
    tools: Vec<Value>,
) -> ResponsesApiRequest {
    let mut request = ResponsesApiRequest::text(snapshot.model.clone(), snapshot.history.clone());
    request.tools = (!tools.is_empty()).then_some(tools);
    request.reasoning = snapshot.reasoning_effort.as_ref().map(|effort| Reasoning {
        effort: Some(effort.clone()),
        summary: snapshot
            .reasoning_summary
            .as_ref()
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| Some("auto".into())),
        context: None,
    });
    request.service_tier.clone_from(&snapshot.service_tier);
    request.prompt_cache_key = Some(snapshot.thread_id.clone());
    request.text = output_schema.map(|schema| TextControls {
        verbosity: None,
        format: Some(TextFormat {
            r#type: TextFormatType::JsonSchema,
            strict: true,
            schema,
            name: "output".into(),
        }),
    });
    request
}

async fn turn_tool_runtime(
    app: &AppHandle,
    manager: &ThreadManager,
    snapshot: &TurnExecutionSnapshot,
) -> Result<(ToolCallRuntime, Vec<Value>), ModelError> {
    let context_manager = manager.clone();
    let mut handlers = vec![
        current_time_handler(),
        sleep_handler(),
        context_remaining_handler(Arc::new(move |thread_id, turn_id| {
            context_manager
                .context_tokens_remaining(thread_id, turn_id)
                .ok()
                .flatten()
        })),
        web_search_handler(),
    ];
    let settings = super::settings::read_settings(app).map_err(ModelError::Consumer)?;
    let supports_images = settings
        .providers
        .iter()
        .find(|provider| provider.id == snapshot.model_provider)
        .and_then(|provider| {
            provider
                .models
                .iter()
                .find(|model| model.id == snapshot.model)
        })
        .is_some_and(|model| {
            model
                .input_modalities
                .contains(&super::models::ModelModality::Image)
        });
    if supports_images {
        handlers.push(view_image_handler(
            snapshot.cwd.clone(),
            supports_original_image_detail(&snapshot.model),
        ));
    }
    let approval_policy =
        serde_json::from_value::<AskForApproval>(snapshot.approval_policy.clone())
            .unwrap_or_default();
    let mcp_manager = app.state::<AppState>().mcp.clone();
    mcp_manager
        .set_elicitation_allowed(
            snapshot.thread_id.clone(),
            approval_policy.allows(ApprovalCategory::McpElicitation),
        )
        .map_err(ModelError::Consumer)?;
    // macOS uses R15 Seatbelt and Windows uses the R16 Restricted Token/ACL wrapper.
    let sandbox_policy =
        tietiezhi_agent_sandbox::SandboxPolicy::from_value(snapshot.sandbox.clone())
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
    if approval_policy.allows(ApprovalCategory::RequestPermissions) {
        let permissions_app = app.clone();
        let permissions_manager = manager.clone();
        let permissions_requirement = category_approval_requirement(
            approval_policy,
            ApprovalCategory::RequestPermissions,
            "request additional permissions",
        );
        handlers.push(request_permissions_handler(
            snapshot.cwd.clone(),
            Arc::new(move |request: PermissionsApprovalRequest| {
                let app = permissions_app.clone();
                let manager = permissions_manager.clone();
                let requirement = permissions_requirement.clone();
                Box::pin(async move {
                    if let ApprovalRequirement::Forbidden { reason } = requirement {
                        return Err(tietiezhi_agent_tools::ToolError::Handler(reason));
                    }
                    let wire_permissions = permission_profile_to_v2(request.permissions.clone());
                    let key = ApprovalKey::Permissions {
                        environment_id: request.environment_id.clone(),
                        cwd: request.cwd.clone(),
                        permissions: wire_permissions.clone(),
                    };
                    let state = app.state::<AppState>();
                    if state
                        .codex_session_approvals
                        .contains_all_for(&request.thread_id, std::slice::from_ref(&key))
                    {
                        return Ok(tietiezhi_agent_approval::PermissionsApprovalResponse {
                            permissions: request.permissions,
                            scope: "session".into(),
                            strict_auto_review: None,
                        });
                    }
                    let waiting = manager
                        .set_thread_status(
                            &request.thread_id,
                            json!({"type":"active","activeFlags":["waitingOnApproval"]}),
                        )
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(format!(
                                "set permissions approval status: {error:?}"
                            ))
                        })?;
                    emit_notifications(&app, &waiting)
                        .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                    let recipients =
                        manager
                            .thread_recipients(&request.thread_id)
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(format!(
                                    "resolve permissions approval recipients: {error:?}"
                                ))
                            })?;
                    let started_at_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis()
                        .min(i64::MAX as u128) as i64;
                    let pending = state
                        .codex_approval_requests
                        .begin_permissions(
                            recipients,
                            PermissionsApprovalParams {
                                thread_id: request.thread_id.clone(),
                                turn_id: request.turn_id.clone(),
                                item_id: request.item_id,
                                environment_id: Some(request.environment_id),
                                cwd: request.cwd,
                                reason: request.reason,
                                permissions: wire_permissions,
                                started_at_ms,
                            },
                        )
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                        })?;
                    let request_id = pending.request.id.clone();
                    emit_approval_server_request(&app, &pending.request)
                        .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                    let mut response = tokio::select! {
                        result = pending.receiver => result
                            .map_err(|_| tietiezhi_agent_tools::ToolError::Handler(
                                "permissions approval channel closed".into()
                            ))?
                            .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))?,
                        () = request.cancellation.cancelled() => {
                            let _ = state.codex_approval_requests.cancel(&request_id);
                            return Err(tietiezhi_agent_tools::ToolError::Handler(
                                "permissions approval cancelled".into()
                            ));
                        }
                    };
                    if response.scope == "session" {
                        state
                            .codex_session_approvals
                            .approve_for(&request.thread_id, &[key])
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                            })?;
                    }
                    let active = manager
                        .set_thread_status(
                            &request.thread_id,
                            json!({"type":"active","activeFlags":[]}),
                        )
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(format!(
                                "restore active status: {error:?}"
                            ))
                        })?;
                    emit_notifications(&app, &active)
                        .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                    response.permissions = permission_profile_to_tool(response.permissions);
                    Ok(response)
                }) as tietiezhi_agent_tools::builtins::PermissionsApprovalFuture
            }),
        ));
    }
    let always_requires_patch_approval = approval_policy == AskForApproval::UnlessTrusted;
    let patch_escape_requirement = category_approval_requirement(
        approval_policy,
        ApprovalCategory::Sandbox,
        "apply patch outside writable sandbox roots",
    );
    let has_patch_approver = always_requires_patch_approval
        || matches!(
            patch_escape_requirement,
            ApprovalRequirement::NeedsApproval { .. }
        );
    let approval_app = app.clone();
    let approval_manager = manager.clone();
    let patch_requirement = patch_escape_requirement.clone();
    handlers.push(
        apply_patch_handler(
            snapshot.cwd.clone(),
            sandbox_policy.clone(),
            always_requires_patch_approval,
            patch_escape_requirement,
            has_patch_approver.then(|| {
                Arc::new(move |request: FileChangeApprovalRequest| {
                    let app = approval_app.clone();
                    let manager = approval_manager.clone();
                    let requirement = patch_requirement.clone();
                    Box::pin(async move {
                        if let ApprovalRequirement::Forbidden { .. } = requirement {
                            return Ok(FileChangeApprovalDecision::Decline);
                        }
                        let keys = request
                            .files
                            .iter()
                            .map(|path| ApprovalKey::FileChange {
                                environment_id: request.environment_id.clone(),
                                path: path.clone(),
                            })
                            .collect::<Vec<_>>();
                        let state = app.state::<AppState>();
                        if state
                            .codex_session_approvals
                            .contains_all_for(&request.thread_id, &keys)
                        {
                            return Ok(FileChangeApprovalDecision::AcceptForSession);
                        }
                        let waiting = manager
                            .set_thread_status(
                                &request.thread_id,
                                json!({"type":"active","activeFlags":["waitingOnApproval"]}),
                            )
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(format!(
                                    "set approval status: {error:?}"
                                ))
                            })?;
                        emit_notifications(&app, &waiting)
                            .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                        let state = app.state::<AppState>();
                        let recipients = manager
                            .thread_recipients(&request.thread_id)
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(format!(
                                    "resolve approval recipients: {error:?}"
                                ))
                            })?;
                        let started_at_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis()
                            .min(i64::MAX as u128) as i64;
                        let pending = state
                            .codex_approval_requests
                            .begin_file_change(
                                recipients,
                                FileChangeApprovalParams {
                                    thread_id: request.thread_id.clone(),
                                    turn_id: request.turn_id.clone(),
                                    item_id: request.item_id.clone(),
                                    reason: request.reason,
                                    grant_root: request.grant_root,
                                    started_at_ms,
                                },
                            )
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                            })?;
                        let request_id = pending.request.id.clone();
                        emit_approval_server_request(&app, &pending.request)
                            .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                        let decision = tokio::select! {
                            result = pending.receiver => result
                                .map_err(|_| tietiezhi_agent_tools::ToolError::Handler(
                                    "file change approval channel closed".into()
                                ))?
                                .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))?,
                            () = request.cancellation.cancelled() => {
                                let _ = state.codex_approval_requests.cancel(&request_id);
                                FileChangeApprovalDecision::Cancel
                            }
                        };
                        if decision == FileChangeApprovalDecision::AcceptForSession {
                            state
                                .codex_session_approvals
                                .approve_for(&request.thread_id, &keys)
                                .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(
                                    error.to_string()
                                ))?;
                        }
                        let active = manager
                            .set_thread_status(
                                &request.thread_id,
                                json!({"type":"active","activeFlags":[]}),
                            )
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(format!(
                                    "restore active status: {error:?}"
                                ))
                            })?;
                        emit_notifications(&app, &active)
                            .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                        Ok(decision)
                    })
                        as tietiezhi_agent_tools::builtins::FileChangeApprovalFuture
                }) as tietiezhi_agent_tools::builtins::FileChangeApprover
            }),
        )
        .map_err(|error| {
            ModelError::Consumer(format!("初始化 Codex apply_patch 失败：{error}"))
        })?,
    );
    let execpolicy_runtime = app.state::<AppState>().codex_execpolicy.clone();
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| ModelError::Consumer(format!("无法定位 ExecPolicy 配置目录：{error}")))?;
    let execpolicy_rules_path = app_data
        .join("agent-runtime")
        .join("rules")
        .join("default.rules");
    if execpolicy_rules_path.exists() {
        let loaded =
            tietiezhi_agent_execpolicy::ExecPolicyRuntime::load_files([&execpolicy_rules_path])
                .map_err(|error| ModelError::Consumer(format!("加载 ExecPolicy 失败：{error}")))?;
        execpolicy_runtime.merge(&loaded.policy());
    }
    let persisted_rules = persistent_approval_store(app, &app.state::<AppState>())
        .map_err(ModelError::Consumer)?
        .snapshot()
        .map_err(|error| ModelError::Consumer(error.to_string()))?;
    for rule in persisted_rules.rules {
        if let PersistentApprovalRule::ExecPolicy { amendment } = rule {
            execpolicy_runtime
                .add_allow_prefix(&amendment)
                .map_err(|error| ModelError::Consumer(error.to_string()))?;
        }
    }
    let runtime_approval_policy = match approval_policy {
        AskForApproval::UnlessTrusted => ExecApprovalPolicy::Untrusted,
        AskForApproval::OnRequest => ExecApprovalPolicy::OnRequest,
        AskForApproval::Never => ExecApprovalPolicy::Never,
        AskForApproval::Granular(config) => ExecApprovalPolicy::Granular {
            rules: config.rules,
            sandbox_approval: config.sandbox_approval,
        },
    };
    let policy_runtime = execpolicy_runtime.clone();
    let policy_evaluator = Arc::new(move |request: CommandPolicyRequest| {
        match policy_runtime.evaluate(
            &request.command,
            ExecEvaluationContext {
                approval_policy: runtime_approval_policy,
                sandbox_restricted: request.sandbox_restricted,
                requests_sandbox_override: request.requests_sandbox_override,
            },
        ) {
            RuntimeExecPolicyOutcome::Allow {
                bypass_sandbox,
                proposed_amendment,
            } => CommandPolicyOutcome::Allow {
                bypass_sandbox,
                proposed_amendment,
            },
            RuntimeExecPolicyOutcome::Prompt {
                reason,
                proposed_amendment,
            } => CommandPolicyOutcome::Prompt {
                reason,
                proposed_amendment,
            },
            RuntimeExecPolicyOutcome::Forbidden { reason } => {
                CommandPolicyOutcome::Forbidden { reason }
            }
        }
    }) as tietiezhi_agent_tools::builtins::CommandPolicyEvaluator;
    let command_approval_app = app.clone();
    let command_approval_manager = manager.clone();
    let command_execpolicy_runtime = execpolicy_runtime.clone();
    let command_execpolicy_rules_path = execpolicy_rules_path.clone();
    let command_approver = Some(Arc::new(move |request: CommandApprovalRequest| {
        let app = command_approval_app.clone();
        let manager = command_approval_manager.clone();
        let execpolicy_runtime = command_execpolicy_runtime.clone();
        let execpolicy_rules_path = command_execpolicy_rules_path.clone();
        Box::pin(async move {
            let keys = vec![ApprovalKey::Command {
                environment_id: request.environment_id.clone(),
                command: vec![request.command.clone()],
                cwd: request.cwd.clone(),
                tty: request.tty,
                sandbox_permissions: request.sandbox_permissions.clone(),
                additional_permissions: request.additional_permissions.clone(),
            }];
            let state = app.state::<AppState>();
            if state
                .codex_session_approvals
                .contains_all_for(&request.thread_id, &keys)
            {
                return Ok(CommandExecutionApprovalDecision::AcceptForSession);
            }
            let waiting = manager
                .set_thread_status(
                    &request.thread_id,
                    json!({"type":"active","activeFlags":["waitingOnApproval"]}),
                )
                .map_err(|error| {
                    tietiezhi_agent_tools::ToolError::Handler(format!(
                        "set command approval status: {error:?}"
                    ))
                })?;
            emit_notifications(&app, &waiting)
                .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
            let state = app.state::<AppState>();
            let recipients = manager
                .thread_recipients(&request.thread_id)
                .map_err(|error| {
                    tietiezhi_agent_tools::ToolError::Handler(format!(
                        "resolve command approval recipients: {error:?}"
                    ))
                })?;
            let started_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(i64::MAX as u128) as i64;
            let pending = state
                .codex_approval_requests
                .begin_command_execution(
                    recipients,
                    CommandExecutionApprovalParams {
                        thread_id: request.thread_id.clone(),
                        turn_id: request.turn_id.clone(),
                        item_id: request.item_id.clone(),
                        approval_id: None,
                        command: Some(request.command),
                        cwd: Some(request.cwd),
                        command_actions: None,
                        environment_id: Some(request.environment_id.clone()),
                        network_approval_context: None,
                        proposed_execpolicy_amendment: request.prefix_rule.clone(),
                        proposed_network_policy_amendments: None,
                        reason: request.reason,
                        started_at_ms,
                    },
                )
                .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))?;
            let request_id = pending.request.id.clone();
            emit_approval_server_request(&app, &pending.request)
                .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
            let decision = tokio::select! {
                result = pending.receiver => result
                    .map_err(|_| tietiezhi_agent_tools::ToolError::Handler(
                        "command approval channel closed".into()
                    ))?
                    .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))?,
                () = request.cancellation.cancelled() => {
                    let _ = state.codex_approval_requests.cancel(&request_id);
                    CommandExecutionApprovalDecision::Cancel
                }
            };
            if decision == CommandExecutionApprovalDecision::AcceptForSession {
                state
                    .codex_session_approvals
                    .approve_for(&request.thread_id, &keys)
                    .map_err(|error| {
                        tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                    })?;
            }
            match &decision {
                CommandExecutionApprovalDecision::AcceptWithExecpolicyAmendment {
                    execpolicy_amendment,
                } => {
                    execpolicy_runtime
                        .add_allow_prefix(execpolicy_amendment)
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                        })?;
                    tietiezhi_agent_execpolicy::blocking_append_allow_prefix_rule(
                        &execpolicy_rules_path,
                        execpolicy_amendment,
                    )
                    .map_err(|error| {
                        tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                    })?;
                    persistent_approval_store(&app, &state)
                        .map_err(tietiezhi_agent_tools::ToolError::Handler)?
                        .append(PersistentApprovalRule::ExecPolicy {
                            amendment: execpolicy_amendment.clone(),
                        })
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                        })?;
                }
                CommandExecutionApprovalDecision::ApplyNetworkPolicyAmendment {
                    network_policy_amendment,
                } => {
                    persistent_approval_store(&app, &state)
                        .map_err(tietiezhi_agent_tools::ToolError::Handler)?
                        .append(PersistentApprovalRule::NetworkPolicy {
                            amendment: network_policy_amendment.clone(),
                        })
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                        })?;
                }
                _ => {}
            }
            let active = manager
                .set_thread_status(
                    &request.thread_id,
                    json!({"type":"active","activeFlags":[]}),
                )
                .map_err(|error| {
                    tietiezhi_agent_tools::ToolError::Handler(format!(
                        "restore active status: {error:?}"
                    ))
                })?;
            emit_notifications(&app, &active).map_err(tietiezhi_agent_tools::ToolError::Handler)?;
            Ok(decision)
        }) as tietiezhi_agent_tools::builtins::CommandApprovalFuture
    }) as tietiezhi_agent_tools::builtins::CommandApprover);
    let observer_app = app.clone();
    let observer_manager = manager.clone();
    let observer = Arc::new(move |event: CommandRuntimeEvent| {
        let notifications = match event {
            CommandRuntimeEvent::Output {
                thread_id,
                turn_id,
                item_id,
                delta,
            } => observer_manager
                .command_execution_output_delta(&thread_id, &turn_id, &item_id, &delta),
            CommandRuntimeEvent::TerminalInteraction {
                thread_id,
                turn_id,
                item_id,
                process_id,
                stdin,
            } => observer_manager.command_execution_terminal_interaction(
                &thread_id,
                &turn_id,
                &item_id,
                &process_id,
                &stdin,
            ),
            CommandRuntimeEvent::Exited {
                thread_id,
                turn_id,
                item_id,
                command,
                cwd,
                process_id,
                result,
            } => {
                let mut aggregated_output = result.stdout;
                aggregated_output.push_str(&result.stderr);
                observer_manager.local_tool_item_completed(
                    &thread_id,
                    &turn_id,
                    json!({
                        "type":"commandExecution",
                        "id":item_id,
                        "command":command,
                        "cwd":cwd,
                        "processId":process_id,
                        "status":if result.exit_code == 0 { "completed" } else { "failed" },
                        "commandActions":[],
                        "aggregatedOutput":aggregated_output,
                        "exitCode":if result.timed_out { 124 } else { result.exit_code },
                        "durationMs":i64::try_from(result.wall_time_ms).unwrap_or(i64::MAX),
                        "source":"agent"
                    }),
                )
            }
        }
        .map_err(|error| {
            tietiezhi_agent_tools::ToolError::Handler(format!("project command event: {error:?}"))
        })?;
        emit_notifications(&observer_app, &notifications)
            .map_err(tietiezhi_agent_tools::ToolError::Handler)
    }) as tietiezhi_agent_tools::builtins::CommandObserver;
    let network_runtime = app.state::<AppState>().codex_network.clone();
    let network_app = app.clone();
    let network_manager = manager.clone();
    let network_prompts_allowed = approval_policy.allows(ApprovalCategory::Rule);
    let network_preparer = Arc::new(move |request: CommandNetworkRequest| {
        let runtime = network_runtime.clone();
        let app = network_app.clone();
        let manager = network_manager.clone();
        Box::pin(async move {
            let app_state = app.state::<AppState>();
            if let Ok(store) = persistent_approval_store(&app, &app_state) {
                let amendments = store
                    .snapshot()
                    .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))?
                    .rules
                    .into_iter()
                    .filter_map(|rule| match rule {
                        PersistentApprovalRule::NetworkPolicy { amendment } => {
                            parse_network_policy_amendment(&amendment)
                        }
                        PersistentApprovalRule::ExecPolicy { .. } => None,
                    });
                runtime.replace_persistent_rules(amendments);
            }
            let approval_app = app.clone();
            let approval_manager = manager.clone();
            let approval_runtime = runtime.clone();
            let approver = Arc::new(
                move |network: tietiezhi_agent_network::NetworkApprovalRequest| {
                    let app = approval_app.clone();
                    let manager = approval_manager.clone();
                    let runtime = approval_runtime.clone();
                    Box::pin(async move {
                        if !network_prompts_allowed {
                            return NetworkApprovalDecision::Deny;
                        }
                        let protocol = network_protocol_label(network.protocol);
                        let key = ApprovalKey::Network {
                            scheme: protocol.into(),
                            host: network.host.clone(),
                            port: Some(network.port),
                            action: "connect".into(),
                        };
                        let state = app.state::<AppState>();
                        if state
                            .codex_session_approvals
                            .contains_all_for(&network.thread_id, std::slice::from_ref(&key))
                        {
                            return NetworkApprovalDecision::AllowOnce;
                        }
                        let recipients = match manager.thread_recipients(&network.thread_id) {
                            Ok(recipients) => recipients,
                            Err(_) => return NetworkApprovalDecision::Deny,
                        };
                        let started_at_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis()
                            .min(i64::MAX as u128)
                            as i64;
                        let pending = match state.codex_approval_requests.begin_command_execution(
                            recipients,
                            CommandExecutionApprovalParams {
                                thread_id: network.thread_id.clone(),
                                turn_id: network.turn_id.clone(),
                                item_id: network.item_id.clone(),
                                approval_id: None,
                                command: Some(network.command),
                                cwd: None,
                                command_actions: None,
                                environment_id: Some("local".into()),
                                network_approval_context: Some(json!({
                                    "host":network.host,
                                    "protocol":protocol
                                })),
                                proposed_execpolicy_amendment: None,
                                proposed_network_policy_amendments: Some(vec![
                                    json!({"host":network.host,"action":"allow"}),
                                    json!({"host":network.host,"action":"deny"}),
                                ]),
                                reason: Some(network.reason),
                                started_at_ms,
                            },
                        ) {
                            Ok(pending) => pending,
                            Err(_) => return NetworkApprovalDecision::Deny,
                        };
                        if emit_approval_server_request(&app, &pending.request).is_err() {
                            return NetworkApprovalDecision::Deny;
                        }
                        match pending.receiver.await {
                            Ok(Ok(CommandExecutionApprovalDecision::Accept)) => {
                                NetworkApprovalDecision::AllowOnce
                            }
                            Ok(Ok(CommandExecutionApprovalDecision::AcceptForSession)) => {
                                let _ = state
                                    .codex_session_approvals
                                    .approve_for(&network.thread_id, &[key]);
                                NetworkApprovalDecision::AllowOnce
                            }
                            Ok(Ok(
                                CommandExecutionApprovalDecision::ApplyNetworkPolicyAmendment {
                                    network_policy_amendment,
                                },
                            )) => {
                                let Some(amendment) =
                                    parse_network_policy_amendment(&network_policy_amendment)
                                else {
                                    return NetworkApprovalDecision::Deny;
                                };
                                if let Ok(store) = persistent_approval_store(&app, &state) {
                                    let _ = store.append(PersistentApprovalRule::NetworkPolicy {
                                        amendment: network_policy_amendment,
                                    });
                                }
                                runtime.apply_persistent_amendment(amendment.clone());
                                NetworkApprovalDecision::Apply(amendment)
                            }
                            Ok(Ok(CommandExecutionApprovalDecision::Cancel)) => {
                                NetworkApprovalDecision::Cancel
                            }
                            _ => NetworkApprovalDecision::Deny,
                        }
                    }) as tietiezhi_agent_network::NetworkApprovalFuture
                },
            ) as tietiezhi_agent_network::NetworkApprover;
            runtime
                .prepare_execution(NetworkExecutionRequest {
                    thread_id: request.thread_id,
                    turn_id: request.turn_id,
                    item_id: request.item_id,
                    command: request.command,
                    policy: NetworkPolicy {
                        enabled: true,
                        mode: NetworkMode::Full,
                        domains: Default::default(),
                        allow_local_binding: false,
                    },
                    approver: Some(approver),
                })
                .await
                .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))
        }) as tietiezhi_agent_tools::builtins::NetworkPreparationFuture
    }) as tietiezhi_agent_tools::builtins::NetworkPreparer;
    handlers.extend(unified_exec_handlers(
        app.state::<AppState>().codex_exec.clone(),
        snapshot.cwd.clone(),
        sandbox_policy,
        false,
        command_approver,
        observer,
        Some(network_preparer),
        Some(policy_evaluator),
    ));
    let mcp_observer_app = app.clone();
    let mcp_observer_manager = manager.clone();
    let mcp_observer = Arc::new(move |event: tietiezhi_agent_mcp::McpToolRuntimeEvent| {
        let (thread_id, notifications) = match event {
            tietiezhi_agent_mcp::McpToolRuntimeEvent::Started {
                context,
                server,
                tool,
                arguments,
            } => {
                let thread_id = context.thread_id.clone();
                let notifications = mcp_observer_manager.local_tool_item_started(
                    &context.thread_id,
                    &context.turn_id,
                    json!({
                        "type":"mcpToolCall",
                        "id":context.item_id,
                        "server":server,
                        "tool":tool,
                        "status":"inProgress",
                        "arguments":arguments,
                        "appContext":null,
                        "pluginId":null,
                        "result":null,
                        "error":null,
                        "durationMs":null
                    }),
                );
                (thread_id, notifications)
            }
            tietiezhi_agent_mcp::McpToolRuntimeEvent::Completed {
                context,
                server,
                tool,
                arguments,
                result,
                duration_ms,
            } => {
                let thread_id = context.thread_id.clone();
                let status = if result.is_error {
                    "failed"
                } else {
                    "completed"
                };
                let error = result
                    .is_error
                    .then(|| json!({"message":result.model_text()}))
                    .unwrap_or(Value::Null);
                let result_value = json!({
                    "content":result.content,
                    "structuredContent":result.structured_content,
                    "_meta":result.meta
                });
                let notifications = mcp_observer_manager.local_tool_item_completed(
                    &context.thread_id,
                    &context.turn_id,
                    json!({
                        "type":"mcpToolCall",
                        "id":context.item_id,
                        "server":server,
                        "tool":tool,
                        "status":status,
                        "arguments":arguments,
                        "appContext":null,
                        "pluginId":null,
                        "result":result_value,
                        "error":error,
                        "durationMs":i64::try_from(duration_ms).unwrap_or(i64::MAX)
                    }),
                );
                (thread_id, notifications)
            }
            tietiezhi_agent_mcp::McpToolRuntimeEvent::Failed {
                context,
                server,
                tool,
                arguments,
                error,
                duration_ms,
            } => {
                let thread_id = context.thread_id.clone();
                let notifications = mcp_observer_manager.local_tool_item_completed(
                    &context.thread_id,
                    &context.turn_id,
                    json!({
                        "type":"mcpToolCall",
                        "id":context.item_id,
                        "server":server,
                        "tool":tool,
                        "status":"failed",
                        "arguments":arguments,
                        "appContext":null,
                        "pluginId":null,
                        "result":null,
                        "error":{"message":error},
                        "durationMs":i64::try_from(duration_ms).unwrap_or(i64::MAX)
                    }),
                );
                (thread_id, notifications)
            }
        };
        let notifications = notifications.map_err(|error| {
            tietiezhi_agent_tools::ToolError::Handler(format!(
                "project MCP tool event for {thread_id}: {error:?}"
            ))
        })?;
        emit_notifications(&mcp_observer_app, &notifications)
            .map_err(tietiezhi_agent_tools::ToolError::Handler)
    }) as tietiezhi_agent_mcp::McpToolObserver;
    for config in settings.mcp_servers.iter().filter(|config| config.enabled) {
        let config = super::tietiezhi::resolve_mcp_config_secrets(app, config)
            .map_err(ModelError::Consumer)?;
        match mcp_manager.list_tools(&config).await {
            Ok(tools) => {
                handlers.extend(tools.into_iter().map(|info| {
                    tietiezhi_agent_mcp::McpToolHandler::new(
                        mcp_manager.clone(),
                        config.clone(),
                        info,
                        Some(mcp_observer.clone()),
                    ) as Arc<dyn tietiezhi_agent_tools::ToolHandler>
                }));
            }
            Err(error) if config.required => {
                return Err(ModelError::Consumer(format!(
                    "必需的 MCP 服务器 `{}` 启动失败：{error}",
                    config.id
                )));
            }
            Err(_) => {}
        }
    }
    let registry = ToolRegistry::new(handlers, Vec::new())
        .map_err(|error| ModelError::Consumer(format!("初始化 Codex 基础工具失败：{error}")))?;
    let router = Arc::new(ToolRouter::new(registry));
    let specs = router.model_visible_wire_specs();
    Ok((ToolCallRuntime::new(router), specs))
}

fn network_protocol_label(protocol: tietiezhi_agent_network::NetworkProtocol) -> &'static str {
    match protocol {
        tietiezhi_agent_network::NetworkProtocol::Http => "http",
        tietiezhi_agent_network::NetworkProtocol::HttpsConnect => "https",
        tietiezhi_agent_network::NetworkProtocol::Socks5Tcp => "socks5Tcp",
    }
}

fn parse_network_policy_amendment(value: &Value) -> Option<NetworkPolicyAmendment> {
    let host = value.get("host")?.as_str()?.trim();
    if host.is_empty() {
        return None;
    }
    let action = match value.get("action")?.as_str()? {
        "allow" => NetworkDomainPermission::Allow,
        "deny" => NetworkDomainPermission::Deny,
        _ => return None,
    };
    Some(NetworkPolicyAmendment {
        host: host.into(),
        action,
    })
}

fn dispatch_windows_sandbox(
    connection_id: &str,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("{method} 参数不符合 App Server V2：{error}"),
        ));
    }
    match method {
        "windowsSandbox/readiness" => dispatch_success(
            request,
            json!({
                "status":if cfg!(windows) { "ready" } else { "notConfigured" }
            }),
        ),
        "windowsSandbox/setupStart" => {
            let mode = request
                .pointer("/params/mode")
                .and_then(Value::as_str)
                .unwrap_or("unelevated");
            let success = cfg!(windows);
            let cwd = request
                .pointer("/params/cwd")
                .and_then(Value::as_str)
                .map(std::path::PathBuf::from)
                .unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);
            let audit = tietiezhi_agent_sandbox::audit_windows_world_writable(
                &cwd,
                &std::env::vars().collect(),
            );
            let mut notifications = Vec::new();
            if !audit.paths.is_empty() || audit.failed_scan {
                let sample_paths = audit
                    .paths
                    .iter()
                    .take(20)
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                notifications.push(RoutedNotification {
                    recipients: vec![connection_id.into()],
                    method: "windows/worldWritableWarning".into(),
                    params: json!({
                        "samplePaths":sample_paths,
                        "extraCount":audit.paths.len().saturating_sub(20),
                        "failedScan":audit.failed_scan
                    }),
                });
            }
            notifications.push(RoutedNotification {
                recipients: vec![connection_id.into()],
                method: "windowsSandbox/setupCompleted".into(),
                params: json!({
                    "mode":mode,
                    "success":success,
                    "error":(!success).then_some(
                        "Windows sandbox setup is only available on Windows"
                    )
                }),
            });
            for notification in &notifications {
                serde_json::from_value::<ServerNotification>(notification.wire_message())
                    .map_err(|error| format!("Windows sandbox setup notification 无效：{error}"))?;
            }
            let mut output = dispatch_success(request, json!({"started":true}))?;
            output.notifications = notifications;
            Ok(output)
        }
        _ => Ok(dispatch_error(request, -32601, "method not found")),
    }
}

fn permission_profile_to_v2(mut permissions: Value) -> Value {
    if let Some(object) = permissions.as_object_mut() {
        if let Some(file_system) = object.remove("file_system") {
            object.insert("fileSystem".into(), file_system);
        }
    }
    permissions
}

fn permission_profile_to_tool(mut permissions: Value) -> Value {
    if let Some(object) = permissions.as_object_mut() {
        if let Some(file_system) = object.remove("fileSystem") {
            object.insert("file_system".into(), file_system);
        }
    }
    permissions
}

fn merge_tool_specs(base: &[Value], loaded: &[Value]) -> Vec<Value> {
    let mut result = Vec::with_capacity(base.len() + loaded.len());
    let mut seen = std::collections::HashSet::new();
    for spec in base.iter().chain(loaded) {
        let key = serde_json::to_string(spec).unwrap_or_else(|_| spec.to_string());
        if seen.insert(key) {
            result.push(spec.clone());
        }
    }
    result
}

fn local_tool_timeline_item(snapshot: &TurnExecutionSnapshot, call: &ToolCall) -> Option<Value> {
    if call.tool_name.namespace.is_none() && call.tool_name.name == "apply_patch" {
        if let ToolPayload::Custom { input } = &call.payload {
            let plan = tietiezhi_agent_patch::PatchPlan::preview(&snapshot.cwd, input).ok()?;
            return Some(json!({
                "type":"fileChange",
                "id":call.call_id,
                "changes":plan.changes(),
                "status":"inProgress"
            }));
        }
    }
    let ToolPayload::Function { arguments } = &call.payload else {
        return None;
    };
    let arguments: Value = serde_json::from_str(arguments).ok()?;
    match (
        call.tool_name.namespace.as_deref(),
        call.tool_name.name.as_str(),
    ) {
        (None, "exec_command") => {
            let command = arguments.get("cmd")?.as_str()?;
            let workdir = arguments
                .get("workdir")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(std::path::PathBuf::from)
                .map_or_else(
                    || snapshot.cwd.clone(),
                    |path| {
                        if path.is_absolute() {
                            path
                        } else {
                            snapshot.cwd.join(path)
                        }
                    },
                );
            Some(json!({
                "type":"commandExecution",
                "id":call.call_id,
                "command":command,
                "cwd":workdir.to_string_lossy(),
                "processId":null,
                "status":"inProgress",
                "commandActions":[],
                "aggregatedOutput":null,
                "exitCode":null,
                "durationMs":null,
                "source":"agent"
            }))
        }
        (Some("clock"), "sleep") => {
            let duration_ms = arguments.get("duration_ms")?.as_u64()?;
            (duration_ms > 0 && duration_ms <= 12 * 60 * 60 * 1000).then(|| {
                json!({
                    "type":"sleep",
                    "id":call.call_id,
                    "durationMs":duration_ms
                })
            })
        }
        (None, "view_image") => {
            let path = std::path::PathBuf::from(arguments.get("path")?.as_str()?);
            let path = if path.is_absolute() {
                path
            } else {
                snapshot.cwd.join(path)
            };
            path.is_file().then(|| {
                json!({
                    "type":"imageView",
                    "id":call.call_id,
                    "path":path.to_string_lossy()
                })
            })
        }
        _ => None,
    }
}

fn compaction_response_request(
    snapshot: &CompactionExecutionSnapshot,
    history: Vec<Value>,
) -> ResponsesApiRequest {
    let mut request = ResponsesApiRequest::text(snapshot.model.clone(), history);
    request.reasoning = snapshot.reasoning_effort.as_ref().map(|effort| Reasoning {
        effort: Some(effort.clone()),
        summary: snapshot
            .reasoning_summary
            .as_ref()
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| Some("auto".into())),
        context: None,
    });
    request.service_tier.clone_from(&snapshot.service_tier);
    request.prompt_cache_key = Some(snapshot.thread_id.clone());
    request
}

fn assistant_response_text(item: &Value) -> Option<String> {
    if item.get("type").and_then(Value::as_str) != Some("message")
        || item.get("role").and_then(Value::as_str) != Some("assistant")
    {
        return None;
    }
    let text = item
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter(|content| {
            matches!(
                content.get("type").and_then(Value::as_str),
                Some("output_text" | "text")
            )
        })
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    Some(text)
}

#[derive(Debug)]
struct ResponseProjection {
    requested_model: String,
    model_context_window: Option<i64>,
    server_model: Option<String>,
    current_agent_item: Option<String>,
    current_reasoning_item: Option<String>,
    reroute_emitted: bool,
    verification_emitted: bool,
    needs_follow_up: bool,
    model_output_seen: bool,
    tool_calls: Vec<ToolCall>,
    cwd: std::path::PathBuf,
    patch_inputs: HashMap<String, String>,
    patch_items_started: HashSet<String>,
}

impl ResponseProjection {
    fn new(
        requested_model: String,
        model_context_window: Option<i64>,
        cwd: std::path::PathBuf,
    ) -> Self {
        Self {
            requested_model,
            model_context_window,
            server_model: None,
            current_agent_item: None,
            current_reasoning_item: None,
            reroute_emitted: false,
            verification_emitted: false,
            needs_follow_up: false,
            model_output_seen: false,
            tool_calls: Vec::new(),
            cwd,
            patch_inputs: HashMap::new(),
            patch_items_started: HashSet::new(),
        }
    }

    fn apply(
        &mut self,
        manager: &ThreadManager,
        thread_id: &str,
        turn_id: &str,
        event: ResponseEvent,
    ) -> Result<Vec<RoutedNotification>, ModelError> {
        match event {
            ResponseEvent::Created
            | ResponseEvent::ServerReasoningIncluded(_)
            | ResponseEvent::ModelsEtag(_) => Ok(Vec::new()),
            ResponseEvent::Retrying { error, .. } => manager
                .error_notification(thread_id, turn_id, error.as_turn_error(), true)
                .map_err(core_model_error),
            ResponseEvent::OutputItemAdded(item) => {
                self.model_output_seen = true;
                self.track_item(&item);
                manager
                    .model_item_started(thread_id, turn_id, item)
                    .map_err(core_model_error)
            }
            ResponseEvent::OutputItemDone(item) => {
                self.track_completed_item(&item)?;
                manager
                    .model_item_completed(thread_id, turn_id, item)
                    .map_err(core_model_error)
            }
            ResponseEvent::OutputTextDelta(delta) => {
                self.model_output_seen = true;
                let item_id = self.current_agent_item.as_deref().ok_or_else(|| {
                    ModelError::Consumer("text delta arrived before agent message item".into())
                })?;
                manager
                    .agent_message_delta(thread_id, turn_id, item_id, &delta)
                    .map_err(core_model_error)
            }
            ResponseEvent::ReasoningSummaryPartAdded { summary_index } => {
                self.model_output_seen = true;
                let item_id = self.reasoning_item()?;
                manager
                    .reasoning_summary_part_added(thread_id, turn_id, item_id, summary_index)
                    .map_err(core_model_error)
            }
            ResponseEvent::ReasoningSummaryDelta {
                delta,
                summary_index,
            } => {
                self.model_output_seen = true;
                let item_id = self.reasoning_item()?;
                manager
                    .reasoning_summary_delta(thread_id, turn_id, item_id, summary_index, &delta)
                    .map_err(core_model_error)
            }
            ResponseEvent::ReasoningSummaryDone {
                item_id,
                text,
                summary_index,
            } => {
                self.model_output_seen = true;
                manager
                    .reasoning_summary_done(thread_id, turn_id, &item_id, summary_index, &text)
                    .map_err(core_model_error)?;
                Ok(Vec::new())
            }
            ResponseEvent::ReasoningContentDelta {
                delta,
                content_index,
            } => {
                self.model_output_seen = true;
                let item_id = self.reasoning_item()?;
                manager
                    .reasoning_text_delta(thread_id, turn_id, item_id, content_index, &delta)
                    .map_err(core_model_error)
            }
            ResponseEvent::ToolCallInputDelta {
                item_id,
                call_id,
                delta,
            } => {
                self.model_output_seen = true;
                self.apply_patch_delta(
                    manager,
                    thread_id,
                    turn_id,
                    &item_id,
                    call_id.as_deref(),
                    &delta,
                )
            }
            ResponseEvent::ServerModel(model) => {
                if self.server_model.as_deref() == Some(model.as_str()) {
                    return Ok(Vec::new());
                }
                self.server_model = Some(model.clone());
                if model.eq_ignore_ascii_case(&self.requested_model) || self.reroute_emitted {
                    return Ok(Vec::new());
                }
                self.reroute_emitted = true;
                manager
                    .model_rerouted_notification(thread_id, turn_id, &self.requested_model, &model)
                    .map_err(core_model_error)
            }
            ResponseEvent::ModelVerifications(verifications) => {
                if self.verification_emitted {
                    return Ok(Vec::new());
                }
                self.verification_emitted = true;
                manager
                    .model_verification_notification(thread_id, turn_id, verifications)
                    .map_err(core_model_error)
            }
            ResponseEvent::TurnModerationMetadata(metadata) => manager
                .turn_moderation_metadata_notification(thread_id, turn_id, metadata)
                .map_err(core_model_error),
            ResponseEvent::SafetyBuffering(buffering) => manager
                .safety_buffering_notification(
                    thread_id,
                    turn_id,
                    &self.requested_model,
                    buffering.use_cases,
                    buffering.reasons,
                    buffering.show_buffering_ui,
                    buffering.faster_model,
                )
                .map_err(core_model_error),
            ResponseEvent::Completed {
                token_usage,
                end_turn,
                ..
            } => {
                self.needs_follow_up = end_turn == Some(false);
                let Some(last) = token_usage else {
                    return Ok(Vec::new());
                };
                manager
                    .record_token_usage(thread_id, turn_id, last, self.model_context_window)
                    .map_err(core_model_error)
            }
        }
    }

    fn track_item(&mut self, item: &Value) {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            return;
        };
        match item.get("type").and_then(Value::as_str) {
            Some("message") if item.get("role").and_then(Value::as_str) == Some("assistant") => {
                self.current_agent_item = Some(id.into());
            }
            Some("reasoning") => self.current_reasoning_item = Some(id.into()),
            _ => {}
        }
    }

    fn track_completed_item(&mut self, item: &Value) -> Result<(), ModelError> {
        self.model_output_seen = true;
        self.track_item(item);
        if let Some(call) = ToolRouter::build_tool_call(item)
            .map_err(|error| ModelError::Consumer(error.to_string()))?
        {
            self.tool_calls.push(call);
        }
        Ok(())
    }

    fn apply_patch_delta(
        &mut self,
        manager: &ThreadManager,
        thread_id: &str,
        turn_id: &str,
        response_item_id: &str,
        call_id: Option<&str>,
        delta: &str,
    ) -> Result<Vec<RoutedNotification>, ModelError> {
        let input = self
            .patch_inputs
            .entry(response_item_id.to_owned())
            .or_default();
        input.push_str(delta);
        let Some(call_id) = call_id else {
            return Ok(Vec::new());
        };
        let Ok(plan) = tietiezhi_agent_patch::PatchPlan::preview(&self.cwd, input) else {
            return Ok(Vec::new());
        };
        let changes = serde_json::to_value(plan.changes())
            .map_err(|error| ModelError::Consumer(error.to_string()))?
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut notifications = Vec::new();
        if self.patch_items_started.insert(call_id.to_owned()) {
            notifications.extend(
                manager
                    .local_tool_item_started(
                        thread_id,
                        turn_id,
                        json!({
                            "type":"fileChange",
                            "id":call_id,
                            "changes":changes,
                            "status":"inProgress"
                        }),
                    )
                    .map_err(core_model_error)?,
            );
        }
        notifications.extend(
            manager
                .file_change_patch_updated(thread_id, turn_id, call_id, changes)
                .map_err(core_model_error)?,
        );
        Ok(notifications)
    }

    fn reasoning_item(&self) -> Result<&str, ModelError> {
        self.current_reasoning_item.as_deref().ok_or_else(|| {
            ModelError::Consumer("reasoning delta arrived before reasoning item".into())
        })
    }

    fn take_needs_follow_up(&mut self) -> bool {
        std::mem::take(&mut self.needs_follow_up)
    }

    fn take_tool_calls(&mut self) -> Vec<ToolCall> {
        std::mem::take(&mut self.tool_calls)
    }

    fn model_output_seen(&self) -> bool {
        self.model_output_seen
    }
}

fn core_model_error(error: tietiezhi_agent_core::RpcError) -> ModelError {
    ModelError::Consumer(format!("Codex Runtime 状态错误：{error:?}"))
}

fn fail_turn(
    app: &AppHandle,
    manager: &ThreadManager,
    thread_id: &str,
    turn_id: &str,
    error: ModelError,
) {
    if let Ok(notifications) =
        manager.error_notification(thread_id, turn_id, error.as_turn_error(), false)
    {
        let _ = emit_notifications(app, &notifications);
    }
    if let Ok(notifications) =
        manager.complete_turn(thread_id, turn_id, Some(error.as_turn_error()))
    {
        let _ = emit_notifications(app, &notifications);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        assistant_response_text, compaction_response_request, dispatch_windows_sandbox,
        empty_rate_limits, format_micro, gateway_rate_limits, local_tool_timeline_item,
        merge_tool_specs, nonempty_or_unconfigured, normalized_plan_type, permission_profile_list,
        permission_profile_to_tool, permission_profile_to_v2, response_request, ResponseEvent,
        ResponseProjection,
    };
    use crate::commands::gateway_auth::{GatewayPaymentChannels, GatewayQuotaView, GatewayWallet};
    use serde_json::json;
    use tempfile::TempDir;
    use tietiezhi_agent_context::SUMMARIZATION_PROMPT;
    use tietiezhi_agent_core::{
        CompactionExecutionSnapshot, RuntimeDefaults, ThreadManager, TurnExecutionSnapshot,
    };

    #[test]
    fn empty_runtime_selection_is_explicitly_unconfigured() {
        assert_eq!(nonempty_or_unconfigured(String::new()), "unconfigured");
        assert_eq!(nonempty_or_unconfigured("  ".into()), "unconfigured");
        assert_eq!(nonempty_or_unconfigured("gpt-test".into()), "gpt-test");
    }

    #[test]
    fn response_projection_tracks_turn_scoped_server_state() {
        let mut projection =
            ResponseProjection::new("gpt-requested".into(), Some(272_000), ".".into());
        assert_eq!(projection.requested_model, "gpt-requested");
        assert!(!projection.reroute_emitted);
        assert!(!projection.verification_emitted);
        assert!(!projection.model_output_seen());
        projection.needs_follow_up = true;
        assert!(projection.take_needs_follow_up());
        assert!(!projection.take_needs_follow_up());
        projection
            .track_completed_item(&json!({
                "type":"function_call",
                "id":"fc_1",
                "name":"sleep",
                "namespace":"clock",
                "arguments":"{\"duration_ms\":1}",
                "call_id":"call_1"
            }))
            .unwrap();
        let calls = projection.take_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].tool_name.namespace.as_deref(), Some("clock"));
        assert_eq!(calls[0].tool_name.name, "sleep");
    }

    #[test]
    fn streamed_apply_patch_input_publishes_file_change_preview() {
        let temp = TempDir::new().unwrap();
        let cwd = temp.path().join("workspace");
        std::fs::create_dir(&cwd).unwrap();
        let manager = ThreadManager::open(
            temp.path().join("state"),
            temp.path().join("threads"),
            RuntimeDefaults {
                model: "gpt-test".into(),
                model_provider: "test".into(),
                cwd: cwd.clone(),
                ..RuntimeDefaults::default()
            },
        )
        .unwrap();
        let started = manager.dispatch(
            "desktop",
            json!({"id":1,"method":"thread/start","params":{}}),
        );
        let thread_id = started.response["result"]["thread"]["id"].as_str().unwrap();
        let turn = manager.dispatch(
            "desktop",
            json!({
                "id":2,
                "method":"turn/start",
                "params":{
                    "threadId":thread_id,
                    "input":[{"type":"text","text":"edit","textElements":[]}]
                }
            }),
        );
        let turn_id = turn.response["result"]["turn"]["id"].as_str().unwrap();
        let mut projection = ResponseProjection::new("gpt-test".into(), None, cwd.clone());
        let notifications = projection
            .apply(
                &manager,
                thread_id,
                turn_id,
                ResponseEvent::ToolCallInputDelta {
                    item_id: "output_1".into(),
                    call_id: Some("call_patch".into()),
                    delta: "*** Begin Patch\n*** Add File: preview.txt\n+preview\n*** End Patch"
                        .into(),
                },
            )
            .unwrap();
        assert_eq!(
            notifications
                .iter()
                .map(|notification| notification.method.as_str())
                .collect::<Vec<_>>(),
            ["item/started", "item/fileChange/patchUpdated"]
        );
        assert_eq!(notifications[1].params["changes"][0]["path"], "preview.txt");
        assert!(!cwd.join("preview.txt").exists());
    }

    #[test]
    fn responses_request_includes_deduplicated_tool_specs() {
        let snapshot = TurnExecutionSnapshot {
            thread_id: "018f16f7-58ca-7f59-bb7f-6626b6630f6a".into(),
            turn_id: "018f16f7-58ca-7f59-bb7f-6626b6630f6b".into(),
            cwd: std::path::PathBuf::from("/tmp/project"),
            model: "gpt-5.6-sol".into(),
            model_provider: "gateway".into(),
            approval_policy: json!("on-request"),
            sandbox: json!({"type":"workspaceWrite"}),
            reasoning_effort: Some("high".into()),
            reasoning_summary: None,
            service_tier: Some("priority".into()),
            history: vec![json!({"type":"message","role":"user","content":[]})],
            model_context_window: Some(272_000),
            active_context_tokens: 100,
            auto_compact_token_limit: None,
        };
        let base = vec![
            json!({"type":"function","name":"view_image"}),
            json!({"type":"web_search"}),
        ];
        let loaded = vec![
            json!({"type":"function","name":"view_image"}),
            json!({"type":"function","name":"deferred"}),
        ];
        let tools = merge_tool_specs(&base, &loaded);
        let request = response_request(&snapshot, None, tools.clone());
        assert_eq!(tools.len(), 3);
        assert_eq!(request.tools, Some(tools));
        assert!(request.parallel_tool_calls);
        let sleep = local_tool_timeline_item(
            &snapshot,
            &tietiezhi_agent_tools::ToolCall {
                tool_name: tietiezhi_agent_tools::ToolName::namespaced("clock", "sleep"),
                call_id: "call_sleep".into(),
                payload: tietiezhi_agent_tools::ToolPayload::Function {
                    arguments: "{\"duration_ms\":25}".into(),
                },
            },
        )
        .unwrap();
        assert_eq!(sleep["type"], "sleep");
        assert_eq!(sleep["durationMs"], 25);
        let command = local_tool_timeline_item(
            &snapshot,
            &tietiezhi_agent_tools::ToolCall {
                tool_name: tietiezhi_agent_tools::ToolName::plain("exec_command"),
                call_id: "call_exec".into(),
                payload: tietiezhi_agent_tools::ToolPayload::Function {
                    arguments: "{\"cmd\":\"printf ok\",\"workdir\":\"subdir\"}".into(),
                },
            },
        )
        .unwrap();
        assert_eq!(command["type"], "commandExecution");
        assert_eq!(command["status"], "inProgress");
        assert_eq!(command["command"], "printf ok");
    }

    #[test]
    fn compaction_request_uses_private_summary_history_and_extracts_assistant_text() {
        let history = vec![
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"goal"}]}),
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":SUMMARIZATION_PROMPT.trim_end()}]}),
        ];
        let snapshot = CompactionExecutionSnapshot {
            thread_id: "018f16f7-58ca-7f59-bb7f-6626b6630f6a".into(),
            turn_id: "018f16f7-58ca-7f59-bb7f-6626b6630f6b".into(),
            item_id: "item-compact".into(),
            model: "gpt-5.6-sol".into(),
            model_provider: "gateway".into(),
            reasoning_effort: Some("high".into()),
            reasoning_summary: None,
            service_tier: Some("priority".into()),
            history: Vec::new(),
            automatic: true,
            model_context_window: Some(272_000),
        };
        let request = compaction_response_request(&snapshot, history.clone());
        assert_eq!(request.input, history);
        assert_eq!(
            request.prompt_cache_key.as_deref(),
            Some(snapshot.thread_id.as_str())
        );
        assert_eq!(request.service_tier.as_deref(), Some("priority"));
        assert_eq!(
            assistant_response_text(&json!({
                "type":"message",
                "role":"assistant",
                "content":[
                    {"type":"output_text","text":"first"},
                    {"type":"output_text","text":"second"}
                ]
            }))
            .as_deref(),
            Some("first\nsecond")
        );
        assert!(assistant_response_text(&json!({"type":"reasoning"})).is_none());
    }

    #[test]
    fn gateway_quota_maps_to_protocol_rate_limit_without_losing_micro_units() {
        let quota = GatewayQuotaView {
            wallet: GatewayWallet {
                balance_micro: 12_345_678,
                frozen_micro: 0,
                total_topup_micro: 0,
                total_spend_micro: 0,
            },
            packages: Vec::new(),
            recent_consumption: Vec::new(),
            payment_channels: GatewayPaymentChannels {
                alipay: true,
                wechat: false,
            },
        };
        let response = gateway_rate_limits(&quota);
        assert_eq!(response["rateLimits"]["credits"]["balance"], "12.345678");
        assert_eq!(response["rateLimits"]["credits"]["hasCredits"], true);
        assert_eq!(
            response["rateLimitsByLimitId"]["tietiezhi-gateway"],
            response["rateLimits"]
        );
        assert_eq!(format_micro(-1), "-0.000001");
        assert!(
            serde_json::from_value::<tietiezhi_agent_protocol::GetAccountRateLimitsResponse>(
                response
            )
            .is_ok()
        );
    }

    #[test]
    fn empty_limits_and_plan_types_stay_protocol_valid() {
        assert!(
            serde_json::from_value::<tietiezhi_agent_protocol::GetAccountRateLimitsResponse>(
                empty_rate_limits()
            )
            .is_ok()
        );
        assert_eq!(normalized_plan_type("team"), "team");
        assert_eq!(normalized_plan_type("future-plan"), "unknown");
    }

    #[test]
    fn unified_exec_requests_and_notifications_match_v2() {
        for request in [
            json!({"id":1,"method":"command/exec","params":{"command":["printf","ok"],"tty":false,"streamStdin":false,"streamStdoutStderr":false,"disableOutputCap":false,"disableTimeout":false}}),
            json!({"id":2,"method":"command/exec/write","params":{"processId":"p1","deltaBase64":"b2sK","closeStdin":false}}),
            json!({"id":3,"method":"command/exec/resize","params":{"processId":"p1","size":{"rows":24,"cols":80}}}),
            json!({"id":4,"method":"command/exec/terminate","params":{"processId":"p1"}}),
            json!({"id":5,"method":"thread/shellCommand","params":{"threadId":"01900000-0000-7000-8000-000000000001","command":"printf ok"}}),
        ] {
            assert!(
                serde_json::from_value::<tietiezhi_agent_protocol::ClientRequest>(request).is_ok()
            );
        }
        for notification in [
            json!({"method":"command/exec/outputDelta","params":{"processId":"p1","stream":"stdout","deltaBase64":"b2s=","capReached":false}}),
            json!({"method":"item/commandExecution/outputDelta","params":{"threadId":"01900000-0000-7000-8000-000000000001","turnId":"01900000-0000-7000-8000-000000000002","itemId":"exec_1","delta":"ok"}}),
            json!({"method":"item/commandExecution/terminalInteraction","params":{"threadId":"01900000-0000-7000-8000-000000000001","turnId":"01900000-0000-7000-8000-000000000002","itemId":"exec_1","processId":"1","stdin":"input\n"}}),
            json!({"method":"process/outputDelta","params":{"processHandle":"p1","stream":"stderr","deltaBase64":"ZXJy","capReached":false}}),
            json!({"method":"process/exited","params":{"processHandle":"p1","exitCode":0,"stdout":"","stdoutCapReached":false,"stderr":"","stderrCapReached":false}}),
        ] {
            assert!(
                serde_json::from_value::<tietiezhi_agent_protocol::ServerNotification>(
                    notification
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn permission_profile_catalog_matches_v2_pagination() {
        let first = permission_profile_list(&json!({
            "id":1,
            "method":"permissionProfile/list",
            "params":{"limit":2}
        }))
        .unwrap();
        assert_eq!(
            first.response["result"]["data"].as_array().unwrap().len(),
            2
        );
        assert_eq!(first.response["result"]["nextCursor"], "2");
        assert_eq!(first.response["result"]["data"][0]["id"], ":read-only");
        let second = permission_profile_list(&json!({
            "id":2,
            "method":"permissionProfile/list",
            "params":{"cursor":"2"}
        }))
        .unwrap();
        assert_eq!(
            second.response["result"]["data"][0]["id"],
            ":danger-full-access"
        );
        assert!(second.response["result"]["nextCursor"].is_null());
    }

    #[test]
    fn permission_profiles_convert_between_tool_and_v2_shapes() {
        let tool = json!({
            "file_system":{"read":["/tmp/input"]},
            "network":{"enabled":true}
        });
        let wire = permission_profile_to_v2(tool.clone());
        assert!(wire.get("fileSystem").is_some());
        assert!(wire.get("file_system").is_none());
        assert_eq!(permission_profile_to_tool(wire), tool);
    }

    #[test]
    fn windows_sandbox_lifecycle_matches_v2() {
        let readiness = dispatch_windows_sandbox(
            "connection",
            &json!({
                "id":1,
                "method":"windowsSandbox/readiness",
                "params":{}
            }),
            "windowsSandbox/readiness",
        )
        .unwrap();
        assert_eq!(
            readiness.response["result"]["status"],
            if cfg!(windows) {
                "ready"
            } else {
                "notConfigured"
            }
        );
        let setup = dispatch_windows_sandbox(
            "connection",
            &json!({
                "id":2,
                "method":"windowsSandbox/setupStart",
                "params":{"mode":"unelevated","cwd":null}
            }),
            "windowsSandbox/setupStart",
        )
        .unwrap();
        assert_eq!(setup.response["result"]["started"], true);
        let completed = setup
            .notifications
            .iter()
            .find(|notification| notification.method == "windowsSandbox/setupCompleted")
            .unwrap();
        assert_eq!(completed.recipients, ["connection"]);
    }
}
