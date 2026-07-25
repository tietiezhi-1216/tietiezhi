//! App Server V2 account state and wire lifecycle.
//!
//! Product-specific OAuth, keyring, quota, and provider HTTP calls stay in the
//! desktop host. This crate owns protocol validation, login identity, cached
//! account views, and global account notifications.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tietiezhi_agent_protocol::server_request::ChatgptAuthTokensRefreshResponse;
use tietiezhi_agent_protocol::{
    CancelLoginAccountResponse, ClientRequest, ConsumeAccountRateLimitResetCreditResponse,
    GetAccountRateLimitsResponse, GetAccountResponse, GetAccountTokenUsageResponse,
    GetWorkspaceMessagesResponse, JSONRPCRequest, JSONRPCResponse, LoginAccountResponse,
    LogoutAccountResponse, ServerNotification, ServerRequest,
};
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountNotification {
    pub recipients: Vec<String>,
    pub method: String,
    pub params: Value,
}

impl AccountNotification {
    pub fn wire_message(&self) -> Value {
        json!({"method": self.method, "params": self.params})
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountDispatchOutput {
    pub response: Value,
    pub notifications: Vec<AccountNotification>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountServerRequest {
    pub recipients: Vec<String>,
    pub id: Value,
    pub method: String,
    pub params: Value,
}

impl AccountServerRequest {
    pub fn wire_message(&self) -> Value {
        json!({
            "id": self.id,
            "method": self.method,
            "params": self.params
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl AccountRpcError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
            data: None,
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: -32600,
            message: message.into(),
            data: None,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: -32603,
            message: message.into(),
            data: None,
        }
    }
}

pub type AccountResult<T> = Result<T, AccountRpcError>;

#[derive(Debug, Clone)]
struct AccountState {
    connections: HashSet<String>,
    active_login_id: Option<String>,
    auth_mode: Option<String>,
    account: Value,
    rate_limits: Value,
    usage: Value,
    workspace_messages: Value,
}

impl Default for AccountState {
    fn default() -> Self {
        Self {
            connections: HashSet::new(),
            active_login_id: None,
            auth_mode: None,
            account: json!({
                "account": null,
                "requiresOpenaiAuth": true
            }),
            rate_limits: json!({
                "rateLimits": {},
                "rateLimitsByLimitId": null,
                "rateLimitResetCredits": null
            }),
            usage: json!({
                "summary": {},
                "dailyUsageBuckets": null
            }),
            workspace_messages: json!({
                "featureEnabled": false,
                "messages": []
            }),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct AccountRuntime {
    state: Arc<Mutex<AccountState>>,
}

pub struct ImmediateLogin<'a> {
    pub response_type: &'a str,
    pub account: Value,
    pub requires_openai_auth: bool,
    pub auth_mode: &'a str,
    pub plan_type: Option<&'a str>,
}

pub struct PendingAuthRefresh {
    pub request: AccountServerRequest,
    pub receiver: oneshot::Receiver<AccountResult<Value>>,
}

#[derive(Debug, Default)]
struct ServerRequestState {
    pending: HashMap<String, oneshot::Sender<AccountResult<Value>>>,
}

#[derive(Debug, Default)]
pub struct AccountServerRequestBroker {
    next_id: AtomicU64,
    state: Mutex<ServerRequestState>,
}

impl AccountServerRequestBroker {
    pub fn begin_auth_refresh(
        &self,
        recipients: Vec<String>,
        previous_account_id: Option<String>,
    ) -> AccountResult<PendingAuthRefresh> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let request = AccountServerRequest {
            recipients,
            id: json!(id),
            method: "account/chatgptAuthTokens/refresh".into(),
            params: json!({
                "reason": "unauthorized",
                "previousAccountId": previous_account_id
            }),
        };
        serde_json::from_value::<ServerRequest>(request.wire_message()).map_err(protocol_error)?;
        let (sender, receiver) = oneshot::channel();
        self.state
            .lock()
            .map_err(|_| AccountRpcError::internal("server request state lock poisoned"))?
            .pending
            .insert(id.to_string(), sender);
        Ok(PendingAuthRefresh { request, receiver })
    }

    pub fn resolve(&self, response: &Value) -> AccountResult<bool> {
        serde_json::from_value::<JSONRPCResponse>(response.clone()).map_err(protocol_error)?;
        let id = response
            .get("id")
            .map(request_id_key)
            .ok_or_else(|| AccountRpcError::invalid("server response id is required"))?;
        let sender = self
            .state
            .lock()
            .map_err(|_| AccountRpcError::internal("server request state lock poisoned"))?
            .pending
            .remove(&id);
        let Some(sender) = sender else {
            return Ok(false);
        };
        let result = if let Some(result) = response.get("result") {
            serde_json::from_value::<ChatgptAuthTokensRefreshResponse>(result.clone())
                .map(|_| result.clone())
                .map_err(protocol_error)
        } else {
            let message = response
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("external auth refresh failed");
            Err(AccountRpcError::invalid_request(message))
        };
        let _ = sender.send(result);
        Ok(true)
    }

    pub fn cancel(&self, id: &Value) -> AccountResult<bool> {
        Ok(self
            .state
            .lock()
            .map_err(|_| AccountRpcError::internal("server request state lock poisoned"))?
            .pending
            .remove(&request_id_key(id))
            .is_some())
    }
}

impl AccountRuntime {
    pub fn handles(method: &str) -> bool {
        method.starts_with("account/")
    }

    pub fn register_connection(&self, connection_id: &str) -> AccountResult<()> {
        if connection_id.trim().is_empty() {
            return Err(AccountRpcError::invalid("connectionId must not be empty"));
        }
        self.state()?.connections.insert(connection_id.into());
        Ok(())
    }

    pub fn validate_request(&self, connection_id: &str, request: &Value) -> AccountResult<()> {
        self.register_connection(connection_id)?;
        validate_client_request(request)
    }

    pub fn connections(&self) -> AccountResult<Vec<String>> {
        let state = self.state()?;
        Ok(sorted_connections(&state))
    }

    pub fn dispatch_cached(
        &self,
        connection_id: &str,
        request: &Value,
    ) -> Option<AccountDispatchOutput> {
        let method = request.get("method").and_then(Value::as_str)?;
        let result = match method {
            "account/read" => {
                self.cached_response::<GetAccountResponse>(connection_id, request, |state| {
                    state.account.clone()
                })
            }
            "account/rateLimits/read" => self.cached_response::<GetAccountRateLimitsResponse>(
                connection_id,
                request,
                |state| state.rate_limits.clone(),
            ),
            "account/usage/read" => self.cached_response::<GetAccountTokenUsageResponse>(
                connection_id,
                request,
                |state| state.usage.clone(),
            ),
            "account/workspaceMessages/read" => self
                .cached_response::<GetWorkspaceMessagesResponse>(connection_id, request, |state| {
                    state.workspace_messages.clone()
                }),
            "account/rateLimitResetCredit/consume" => self
                .register_connection(connection_id)
                .and_then(|_| validate_client_request(request))
                .and_then(|_| {
                    validate_reset_credit_request(request)?;
                    let state = self.state()?;
                    require_chatgpt_auth(&state, "rate limit reset credits")?;
                    drop(state);
                    self.output::<ConsumeAccountRateLimitResetCreditResponse>(
                        request,
                        json!({"outcome": "noCredit"}),
                        Vec::new(),
                    )
                }),
            "account/sendAddCreditsNudgeEmail" => self
                .register_connection(connection_id)
                .and_then(|_| validate_client_request(request))
                .and_then(|_| {
                    let state = self.state()?;
                    require_chatgpt_auth(&state, "notify workspace owner")?;
                    Err(AccountRpcError::invalid_request(
                        "the configured account backend does not support add-credits email",
                    ))
                }),
            _ => return None,
        };
        Some(result.unwrap_or_else(|error| error_output(request, error)))
    }

    pub fn begin_chatgpt_login(
        &self,
        connection_id: &str,
        request: &Value,
        login_id: String,
        auth_url: String,
    ) -> AccountDispatchOutput {
        let result = self
            .register_connection(connection_id)
            .and_then(|_| validate_client_request(request))
            .and_then(|_| {
                if request.pointer("/params/type").and_then(Value::as_str) != Some("chatgpt") {
                    return Err(AccountRpcError::invalid(
                        "Gateway browser login requires type=chatgpt",
                    ));
                }
                self.state()?.active_login_id = Some(login_id.clone());
                self.output::<LoginAccountResponse>(
                    request,
                    json!({
                        "type": "chatgpt",
                        "loginId": login_id,
                        "authUrl": auth_url
                    }),
                    Vec::new(),
                )
            });
        result.unwrap_or_else(|error| error_output(request, error))
    }

    pub fn complete_immediate_login(
        &self,
        connection_id: &str,
        request: &Value,
        login: ImmediateLogin<'_>,
    ) -> AccountDispatchOutput {
        let result = self
            .register_connection(connection_id)
            .and_then(|_| validate_client_request(request))
            .and_then(|_| {
                let response = self.output::<LoginAccountResponse>(
                    request,
                    json!({"type": login.response_type}),
                    Vec::new(),
                )?;
                let mut notifications = vec![checked_notification(
                    self.connections()?,
                    "account/login/completed",
                    json!({
                        "loginId": null,
                        "success": true,
                        "error": null
                    }),
                )?];
                notifications.extend(self.set_account_locked(
                    login.account,
                    login.requires_openai_auth,
                    Some(login.auth_mode),
                    login.plan_type,
                )?);
                Ok(AccountDispatchOutput {
                    response: response.response,
                    notifications,
                })
            });
        result.unwrap_or_else(|error| error_output(request, error))
    }

    pub fn cancel_login(
        &self,
        connection_id: &str,
        request: &Value,
    ) -> (AccountDispatchOutput, Option<String>) {
        let result = self
            .register_connection(connection_id)
            .and_then(|_| validate_client_request(request))
            .and_then(|_| {
                let requested = required_string(request, "/params/loginId")?;
                let mut state = self.state()?;
                let canceled = (state.active_login_id.as_deref() == Some(requested.as_str()))
                    .then(|| state.active_login_id.take())
                    .flatten();
                drop(state);
                let status = if canceled.is_some() {
                    "canceled"
                } else {
                    "notFound"
                };
                self.output::<CancelLoginAccountResponse>(
                    request,
                    json!({"status": status}),
                    Vec::new(),
                )
                .map(|output| (output, canceled))
            });
        result.unwrap_or_else(|error| (error_output(request, error), None))
    }

    pub fn complete_chatgpt_login(
        &self,
        login_id: &str,
        result: Result<Value, String>,
    ) -> AccountResult<Vec<AccountNotification>> {
        let mut state = self.state()?;
        if state.active_login_id.as_deref() != Some(login_id) {
            return Ok(Vec::new());
        }
        state.active_login_id = None;
        let recipients = sorted_connections(&state);
        let completion = match result {
            Ok(account) => {
                state.account = json!({
                    "account": account,
                    "requiresOpenaiAuth": true
                });
                state.auth_mode = Some("chatgpt".into());
                let mut notifications = vec![checked_notification(
                    recipients.clone(),
                    "account/login/completed",
                    json!({
                        "loginId": login_id,
                        "success": true,
                        "error": null
                    }),
                )?];
                notifications.push(checked_notification(
                    recipients,
                    "account/updated",
                    json!({"authMode": "chatgpt", "planType": "unknown"}),
                )?);
                notifications
            }
            Err(error) => vec![checked_notification(
                recipients,
                "account/login/completed",
                json!({
                    "loginId": login_id,
                    "success": false,
                    "error": error
                }),
            )?],
        };
        Ok(completion)
    }

    pub fn logout(
        &self,
        connection_id: &str,
        request: &Value,
    ) -> (AccountDispatchOutput, Option<String>) {
        let result = self
            .register_connection(connection_id)
            .and_then(|_| validate_client_request(request))
            .and_then(|_| {
                let mut state = self.state()?;
                let canceled = state.active_login_id.take();
                state.auth_mode = None;
                state.account = json!({
                    "account": null,
                    "requiresOpenaiAuth": true
                });
                let recipients = sorted_connections(&state);
                drop(state);
                let notification = checked_notification(
                    recipients,
                    "account/updated",
                    json!({"authMode": null, "planType": null}),
                )?;
                self.output::<LogoutAccountResponse>(request, json!({}), vec![notification])
                    .map(|output| (output, canceled))
            });
        result.unwrap_or_else(|error| (error_output(request, error), None))
    }

    pub fn set_account(
        &self,
        account: Option<Value>,
        requires_openai_auth: bool,
        auth_mode: Option<&str>,
        plan_type: Option<&str>,
    ) -> AccountResult<Vec<AccountNotification>> {
        self.set_account_locked(
            account.unwrap_or(Value::Null),
            requires_openai_auth,
            auth_mode,
            plan_type,
        )
    }

    pub fn set_rate_limits(&self, response: Value) -> AccountResult<Vec<AccountNotification>> {
        serde_json::from_value::<GetAccountRateLimitsResponse>(response.clone())
            .map_err(protocol_error)?;
        let mut state = self.state()?;
        state.rate_limits = response.clone();
        let recipients = sorted_connections(&state);
        drop(state);
        Ok(vec![checked_notification(
            recipients,
            "account/rateLimits/updated",
            json!({"rateLimits": response["rateLimits"]}),
        )?])
    }

    pub fn set_usage(&self, response: Value) -> AccountResult<()> {
        serde_json::from_value::<GetAccountTokenUsageResponse>(response.clone())
            .map_err(protocol_error)?;
        self.state()?.usage = response;
        Ok(())
    }

    pub fn set_workspace_messages(&self, response: Value) -> AccountResult<()> {
        serde_json::from_value::<GetWorkspaceMessagesResponse>(response.clone())
            .map_err(protocol_error)?;
        self.state()?.workspace_messages = response;
        Ok(())
    }

    pub fn error_output(&self, request: &Value, error: AccountRpcError) -> AccountDispatchOutput {
        error_output(request, error)
    }

    fn cached_response<T>(
        &self,
        connection_id: &str,
        request: &Value,
        read: impl FnOnce(&AccountState) -> Value,
    ) -> AccountResult<AccountDispatchOutput>
    where
        T: serde::de::DeserializeOwned,
    {
        self.register_connection(connection_id)?;
        validate_client_request(request)?;
        let state = self.state()?;
        let result = read(&state);
        drop(state);
        self.output::<T>(request, result, Vec::new())
    }

    fn set_account_locked(
        &self,
        account: Value,
        requires_openai_auth: bool,
        auth_mode: Option<&str>,
        plan_type: Option<&str>,
    ) -> AccountResult<Vec<AccountNotification>> {
        let response = json!({
            "account": account,
            "requiresOpenaiAuth": requires_openai_auth
        });
        serde_json::from_value::<GetAccountResponse>(response.clone()).map_err(protocol_error)?;
        let mut state = self.state()?;
        state.account = response;
        state.auth_mode = auth_mode.map(str::to_owned);
        let recipients = sorted_connections(&state);
        drop(state);
        Ok(vec![checked_notification(
            recipients,
            "account/updated",
            json!({"authMode": auth_mode, "planType": plan_type}),
        )?])
    }

    fn output<T>(
        &self,
        request: &Value,
        result: Value,
        notifications: Vec<AccountNotification>,
    ) -> AccountResult<AccountDispatchOutput>
    where
        T: serde::de::DeserializeOwned,
    {
        serde_json::from_value::<T>(result.clone()).map_err(protocol_error)?;
        let response = json!({
            "id": request.get("id").cloned().unwrap_or(Value::Null),
            "result": result
        });
        serde_json::from_value::<JSONRPCResponse>(response.clone()).map_err(protocol_error)?;
        Ok(AccountDispatchOutput {
            response,
            notifications,
        })
    }

    fn state(&self) -> AccountResult<MutexGuard<'_, AccountState>> {
        self.state
            .lock()
            .map_err(|_| AccountRpcError::internal("account state lock poisoned"))
    }
}

fn validate_client_request(request: &Value) -> AccountResult<()> {
    serde_json::from_value::<JSONRPCRequest>(request.clone()).map_err(protocol_error)?;
    serde_json::from_value::<ClientRequest>(request.clone()).map_err(protocol_error)?;
    Ok(())
}

fn required_string(request: &Value, pointer: &str) -> AccountResult<String> {
    request
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AccountRpcError::invalid(format!("{pointer} must be a non-empty string")))
}

fn validate_reset_credit_request(request: &Value) -> AccountResult<()> {
    if request
        .pointer("/params/idempotencyKey")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(AccountRpcError::invalid_request(
            "idempotencyKey must not be empty",
        ));
    }
    if request
        .pointer("/params/creditId")
        .is_some_and(|value| value.as_str().is_some_and(str::is_empty))
    {
        return Err(AccountRpcError::invalid_request(
            "creditId must not be empty",
        ));
    }
    Ok(())
}

fn require_chatgpt_auth(state: &AccountState, operation: &str) -> AccountResult<()> {
    match state.auth_mode.as_deref() {
        None => Err(AccountRpcError::invalid_request(format!(
            "codex account authentication required to {operation}"
        ))),
        Some("chatgpt" | "chatgptAuthTokens") => Ok(()),
        Some(_) => Err(AccountRpcError::invalid_request(format!(
            "chatgpt authentication required to {operation}"
        ))),
    }
}

fn request_id_key(id: &Value) -> String {
    match id {
        Value::String(value) => value.clone(),
        _ => id.to_string(),
    }
}

fn checked_notification(
    recipients: Vec<String>,
    method: &str,
    params: Value,
) -> AccountResult<AccountNotification> {
    let notification = AccountNotification {
        recipients,
        method: method.into(),
        params,
    };
    serde_json::from_value::<ServerNotification>(notification.wire_message())
        .map_err(protocol_error)?;
    Ok(notification)
}

fn sorted_connections(state: &AccountState) -> Vec<String> {
    let mut recipients = state.connections.iter().cloned().collect::<Vec<_>>();
    recipients.sort();
    recipients
}

fn protocol_error(error: impl std::fmt::Display) -> AccountRpcError {
    AccountRpcError::internal(format!("invalid App Server V2 account payload: {error}"))
}

fn error_output(request: &Value, error: AccountRpcError) -> AccountDispatchOutput {
    let mut payload = json!({
        "code": error.code,
        "message": error.message
    });
    if let Some(data) = error.data {
        payload["data"] = data;
    }
    AccountDispatchOutput {
        response: json!({
            "id": request.get("id").cloned().unwrap_or(Value::Null),
            "error": payload
        }),
        notifications: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: u64, method: &str, params: Value) -> Value {
        json!({"id": id, "method": method, "params": params})
    }

    #[test]
    fn cached_account_surfaces_are_protocol_exact() {
        let runtime = AccountRuntime::default();
        for (id, method) in [
            (1, "account/read"),
            (2, "account/rateLimits/read"),
            (3, "account/usage/read"),
            (4, "account/workspaceMessages/read"),
        ] {
            let output = runtime
                .dispatch_cached("desktop", &request(id, method, json!({})))
                .unwrap();
            assert!(output.response.get("error").is_none(), "{output:?}");
        }
    }

    #[test]
    fn browser_login_replaces_active_attempt_and_completes_globally() {
        let runtime = AccountRuntime::default();
        let first = runtime.begin_chatgpt_login(
            "one",
            &request(
                1,
                "account/login/start",
                json!({"type": "chatgpt", "codexStreamlinedLogin": false, "useHostedLoginSuccessPage": false}),
            ),
            "login-1".into(),
            "https://gateway.example.test/login".into(),
        );
        assert_eq!(first.response["result"]["loginId"], "login-1");
        runtime.register_connection("two").unwrap();
        let second = runtime.begin_chatgpt_login(
            "one",
            &request(
                2,
                "account/login/start",
                json!({"type": "chatgpt", "codexStreamlinedLogin": false, "useHostedLoginSuccessPage": false}),
            ),
            "login-2".into(),
            "https://gateway.example.test/login".into(),
        );
        assert_eq!(second.response["result"]["loginId"], "login-2");
        assert!(runtime
            .complete_chatgpt_login(
                "login-1",
                Ok(json!({
                    "type": "chatgpt",
                    "email": "old@example.test",
                    "planType": "unknown"
                }))
            )
            .unwrap()
            .is_empty());
        let notifications = runtime
            .complete_chatgpt_login(
                "login-2",
                Ok(json!({
                    "type": "chatgpt",
                    "email": "user@example.test",
                    "planType": "unknown"
                })),
            )
            .unwrap();
        assert_eq!(notifications.len(), 2);
        assert_eq!(notifications[0].recipients, vec!["one", "two"]);
        assert_eq!(notifications[0].method, "account/login/completed");
        assert_eq!(notifications[1].method, "account/updated");
    }

    #[test]
    fn cancel_login_is_id_scoped_and_idempotent() {
        let runtime = AccountRuntime::default();
        let start = request(
            1,
            "account/login/start",
            json!({"type": "chatgpt", "codexStreamlinedLogin": false, "useHostedLoginSuccessPage": false}),
        );
        runtime.begin_chatgpt_login(
            "desktop",
            &start,
            "login-1".into(),
            "https://gateway.example.test/login".into(),
        );
        let (wrong, canceled) = runtime.cancel_login(
            "desktop",
            &request(2, "account/login/cancel", json!({"loginId": "wrong"})),
        );
        assert_eq!(wrong.response["result"]["status"], "notFound");
        assert!(canceled.is_none());
        let (right, canceled) = runtime.cancel_login(
            "desktop",
            &request(3, "account/login/cancel", json!({"loginId": "login-1"})),
        );
        assert_eq!(right.response["result"]["status"], "canceled");
        assert_eq!(canceled.as_deref(), Some("login-1"));
    }

    #[test]
    fn rate_limit_snapshot_emits_sparse_global_update() {
        let runtime = AccountRuntime::default();
        runtime.register_connection("desktop").unwrap();
        let snapshot = json!({
            "rateLimits": {
                "limitId": "gateway",
                "credits": {
                    "hasCredits": true,
                    "unlimited": false,
                    "balance": "10"
                }
            },
            "rateLimitsByLimitId": null,
            "rateLimitResetCredits": null
        });
        let notifications = runtime.set_rate_limits(snapshot.clone()).unwrap();
        assert_eq!(notifications[0].method, "account/rateLimits/updated");
        assert_eq!(
            notifications[0].params["rateLimits"],
            snapshot["rateLimits"]
        );
    }

    #[test]
    fn immediate_login_emits_completion_before_account_update() {
        let runtime = AccountRuntime::default();
        let output = runtime.complete_immediate_login(
            "desktop",
            &request(
                1,
                "account/login/start",
                json!({"type": "apiKey", "apiKey": "secret"}),
            ),
            ImmediateLogin {
                response_type: "apiKey",
                account: json!({"type": "apiKey"}),
                requires_openai_auth: false,
                auth_mode: "apikey",
                plan_type: None,
            },
        );
        assert_eq!(output.response["result"]["type"], "apiKey");
        assert_eq!(output.notifications.len(), 2);
        assert_eq!(output.notifications[0].method, "account/login/completed");
        assert_eq!(output.notifications[0].params["loginId"], Value::Null);
        assert_eq!(output.notifications[1].method, "account/updated");
    }

    #[test]
    fn unsupported_account_side_effect_returns_json_rpc_error() {
        let runtime = AccountRuntime::default();
        let output = runtime
            .dispatch_cached(
                "desktop",
                &request(
                    1,
                    "account/sendAddCreditsNudgeEmail",
                    json!({"creditType": "credits"}),
                ),
            )
            .unwrap();
        assert_eq!(output.response["error"]["code"], -32600);
        assert_eq!(
            output.response["error"]["message"],
            "codex account authentication required to notify workspace owner"
        );
    }

    #[test]
    fn reset_credit_validates_input_and_reports_gateway_has_no_credit() {
        let runtime = AccountRuntime::default();
        let missing_key = runtime
            .dispatch_cached(
                "desktop",
                &request(
                    1,
                    "account/rateLimitResetCredit/consume",
                    json!({"idempotencyKey": ""}),
                ),
            )
            .unwrap();
        assert_eq!(missing_key.response["error"]["code"], -32600);

        runtime.complete_immediate_login(
            "desktop",
            &request(
                2,
                "account/login/start",
                json!({
                    "type": "chatgptAuthTokens",
                    "accessToken": "access",
                    "chatgptAccountId": "account",
                    "chatgptPlanType": "team"
                }),
            ),
            ImmediateLogin {
                response_type: "chatgptAuthTokens",
                account: json!({
                    "type": "chatgpt",
                    "email": null,
                    "planType": "team"
                }),
                requires_openai_auth: false,
                auth_mode: "chatgptAuthTokens",
                plan_type: Some("team"),
            },
        );
        let output = runtime
            .dispatch_cached(
                "desktop",
                &request(
                    3,
                    "account/rateLimitResetCredit/consume",
                    json!({"idempotencyKey": "attempt-1"}),
                ),
            )
            .unwrap();
        assert_eq!(output.response["result"]["outcome"], "noCredit");
    }

    #[tokio::test]
    async fn external_auth_refresh_is_correlated_and_protocol_validated() {
        let broker = AccountServerRequestBroker::default();
        let pending = broker
            .begin_auth_refresh(vec!["desktop".into()], Some("workspace-1".into()))
            .unwrap();
        assert_eq!(pending.request.method, "account/chatgptAuthTokens/refresh");
        assert_eq!(pending.request.params["previousAccountId"], "workspace-1");
        let id = pending.request.id.clone();
        assert!(broker
            .resolve(&json!({
                "id": id,
                "result": {
                    "accessToken": "new-token",
                    "chatgptAccountId": "workspace-1",
                    "chatgptPlanType": "team"
                }
            }))
            .unwrap());
        let result = pending.receiver.await.unwrap().unwrap();
        assert_eq!(result["accessToken"], "new-token");
        assert!(!broker
            .resolve(&json!({
                "id": id,
                "result": {
                    "accessToken": "duplicate",
                    "chatgptAccountId": "workspace-1",
                    "chatgptPlanType": null
                }
            }))
            .unwrap());
    }
}
