use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tietiezhi_agent_account::{
    AccountDispatchOutput, AccountNotification, AccountRpcError, AccountServerRequest,
    ImmediateLogin,
};
use tietiezhi_agent_context::compaction_prompt_history;
use tietiezhi_agent_core::{
    CompactionExecutionSnapshot, DispatchOutput, RoutedNotification, RuntimeDefaults,
    ThreadManager, TurnExecutionSnapshot,
};
use tietiezhi_agent_model::{
    list_online_models, supports_original_image_detail, ModelError, OnlineModel, Reasoning,
    ResponseEvent, ResponsesApiRequest, ResponsesClient, TextControls, TextFormat, TextFormatType,
};
use tietiezhi_agent_protocol::{ClientRequest, JSONRPCRequest, JSONRPCResponse, ModelListResponse};
use tietiezhi_agent_tools::builtins::{
    context_remaining_handler, current_time_handler, sleep_handler, view_image_handler,
    web_search_handler,
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

#[tauri::command]
pub fn codex_v2_server_response(
    state: State<'_, AppState>,
    response: Value,
) -> Result<bool, String> {
    state
        .codex_account_requests
        .resolve(&response)
        .map_err(account_rpc_error)
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
    let mut projection =
        ResponseProjection::new(initial.model.clone(), initial.model_context_window);
    let mut can_drain_steered = false;
    let mut output_schema = None;
    let mut auth_refresh_attempted = false;
    let (tool_runtime, base_tool_specs) = turn_tool_runtime(&app, &manager, &initial)?;
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
            }
            let executions = calls.into_iter().map(|(call, timeline_item)| {
                let runtime = tool_runtime.clone();
                let thread_id = thread_id.clone();
                let turn_id = turn_id.clone();
                let cancel = cancel.clone();
                let input_activity = input_activity.clone();
                async move {
                    let output = runtime
                        .handle_model_call_with_activity(
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
                if let Some(item) = timeline_item {
                    let notifications = manager
                        .local_tool_item_completed(&thread_id, &turn_id, item)
                        .map_err(core_model_error)?;
                    emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                }
                if matches!(call.payload, ToolPayload::ToolSearch { .. }) {
                    if let Some(tools) = output.get("tools").and_then(Value::as_array) {
                        loaded_tool_specs.extend(tools.iter().cloned());
                    }
                }
                let notifications = manager
                    .model_item_completed(&thread_id, &turn_id, output)
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

fn turn_tool_runtime(
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
    let registry = ToolRegistry::new(handlers, Vec::new())
        .map_err(|error| ModelError::Consumer(format!("初始化 Codex 基础工具失败：{error}")))?;
    let router = Arc::new(ToolRouter::new(registry));
    let specs = router.model_visible_wire_specs();
    Ok((ToolCallRuntime::new(router), specs))
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
    let ToolPayload::Function { arguments } = &call.payload else {
        return None;
    };
    let arguments: Value = serde_json::from_str(arguments).ok()?;
    match (
        call.tool_name.namespace.as_deref(),
        call.tool_name.name.as_str(),
    ) {
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
}

impl ResponseProjection {
    fn new(requested_model: String, model_context_window: Option<i64>) -> Self {
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
            ResponseEvent::ToolCallInputDelta { .. } => {
                self.model_output_seen = true;
                Ok(Vec::new())
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
        assistant_response_text, compaction_response_request, empty_rate_limits, format_micro,
        gateway_rate_limits, local_tool_timeline_item, merge_tool_specs, nonempty_or_unconfigured,
        normalized_plan_type, response_request, ResponseProjection,
    };
    use crate::commands::gateway_auth::{GatewayPaymentChannels, GatewayQuotaView, GatewayWallet};
    use serde_json::json;
    use tietiezhi_agent_context::SUMMARIZATION_PROMPT;
    use tietiezhi_agent_core::{CompactionExecutionSnapshot, TurnExecutionSnapshot};

    #[test]
    fn empty_runtime_selection_is_explicitly_unconfigured() {
        assert_eq!(nonempty_or_unconfigured(String::new()), "unconfigured");
        assert_eq!(nonempty_or_unconfigured("  ".into()), "unconfigured");
        assert_eq!(nonempty_or_unconfigured("gpt-test".into()), "gpt-test");
    }

    #[test]
    fn response_projection_tracks_turn_scoped_server_state() {
        let mut projection = ResponseProjection::new("gpt-requested".into(), Some(272_000));
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
    fn responses_request_includes_deduplicated_tool_specs() {
        let snapshot = TurnExecutionSnapshot {
            thread_id: "018f16f7-58ca-7f59-bb7f-6626b6630f6a".into(),
            turn_id: "018f16f7-58ca-7f59-bb7f-6626b6630f6b".into(),
            cwd: std::path::PathBuf::from("/tmp/project"),
            model: "gpt-5.6-sol".into(),
            model_provider: "gateway".into(),
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
}
