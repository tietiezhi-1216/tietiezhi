//! Reverse JSON-RPC approval broker compatible with Codex App Server V2.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tietiezhi_agent_protocol::{JSONRPCResponse, ServerRequest};
use tokio::sync::oneshot;

/// Codex approval policy. The externally tagged `granular` representation is
/// intentionally identical to App Server V2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AskForApproval {
    #[serde(rename = "untrusted")]
    UnlessTrusted,
    #[serde(alias = "on-failure")]
    #[default]
    OnRequest,
    Granular(GranularApprovalConfig),
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GranularApprovalConfig {
    pub sandbox_approval: bool,
    pub rules: bool,
    #[serde(default)]
    pub skill_approval: bool,
    #[serde(default)]
    pub request_permissions: bool,
    pub mcp_elicitations: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalCategory {
    Sandbox,
    Rule,
    Skill,
    RequestPermissions,
    McpElicitation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxAvailability {
    /// The operation must run under a restricted filesystem policy.
    Restricted,
    /// The selected profile is danger-full-access.
    Unrestricted,
    /// Isolation is supplied by the execution environment rather than Codex.
    External,
    /// The requested platform sandbox has not been installed yet.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalRequirement {
    Skip { bypass_sandbox: bool },
    NeedsApproval { reason: Option<String> },
    Forbidden { reason: String },
}

impl AskForApproval {
    pub fn allows(self, category: ApprovalCategory) -> bool {
        match self {
            Self::Never => false,
            Self::UnlessTrusted | Self::OnRequest => true,
            Self::Granular(config) => match category {
                ApprovalCategory::Sandbox => config.sandbox_approval,
                ApprovalCategory::Rule => config.rules,
                ApprovalCategory::Skill => config.skill_approval,
                ApprovalCategory::RequestPermissions => config.request_permissions,
                ApprovalCategory::McpElicitation => config.mcp_elicitations,
            },
        }
    }
}

/// Source-compatible default policy stage. ExecPolicy can pass
/// `trusted_read_only=true` once R18 has classified a command.
pub fn default_exec_approval_requirement(
    policy: AskForApproval,
    sandbox: SandboxAvailability,
    trusted_read_only: bool,
) -> ApprovalRequirement {
    if policy == AskForApproval::Never {
        return ApprovalRequirement::Skip {
            bypass_sandbox: false,
        };
    }
    if policy == AskForApproval::UnlessTrusted && trusted_read_only {
        return ApprovalRequirement::Skip {
            bypass_sandbox: false,
        };
    }

    let needs_approval = match policy {
        AskForApproval::UnlessTrusted => true,
        AskForApproval::OnRequest | AskForApproval::Granular(_) => matches!(
            sandbox,
            SandboxAvailability::Restricted | SandboxAvailability::Unavailable
        ),
        AskForApproval::Never => false,
    };
    if needs_approval && !policy.allows(ApprovalCategory::Sandbox) {
        ApprovalRequirement::Forbidden {
            reason: "approval policy disallowed sandbox approval prompt".into(),
        }
    } else if needs_approval {
        ApprovalRequirement::NeedsApproval { reason: None }
    } else {
        ApprovalRequirement::Skip {
            bypass_sandbox: false,
        }
    }
}

pub fn category_approval_requirement(
    policy: AskForApproval,
    category: ApprovalCategory,
    reason: impl Into<String>,
) -> ApprovalRequirement {
    if policy == AskForApproval::Never {
        return ApprovalRequirement::Forbidden {
            reason: "approval policy is never".into(),
        };
    }
    if policy.allows(category) {
        ApprovalRequirement::NeedsApproval {
            reason: Some(reason.into()),
        }
    } else {
        ApprovalRequirement::Forbidden {
            reason: format!("approval policy disallowed {category:?} prompt"),
        }
    }
}

/// Exact, session-local approval keys. They deliberately include execution
/// context so approving one shell command never grants all future shell calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ApprovalKey {
    Command {
        environment_id: String,
        command: Vec<String>,
        cwd: String,
        tty: bool,
        sandbox_permissions: String,
        additional_permissions: Option<Value>,
    },
    FileChange {
        environment_id: String,
        path: String,
    },
    Permissions {
        environment_id: String,
        cwd: String,
        permissions: Value,
    },
    Mcp {
        server: String,
        tool: String,
        arguments: Value,
    },
    Network {
        scheme: String,
        host: String,
        port: Option<u16>,
        action: String,
    },
}

#[derive(Clone, Default)]
pub struct SessionApprovalStore {
    approved: std::sync::Arc<Mutex<HashMap<String, ()>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PersistentApprovalRule {
    ExecPolicy { amendment: Vec<String> },
    NetworkPolicy { amendment: Value },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistentApprovalRules {
    #[serde(default = "approval_rules_version")]
    pub version: u32,
    #[serde(default)]
    pub rules: Vec<PersistentApprovalRule>,
}

fn approval_rules_version() -> u32 {
    1
}

#[derive(Clone)]
pub struct PersistentApprovalStore {
    path: PathBuf,
    state: std::sync::Arc<Mutex<PersistentApprovalRules>>,
}

impl PersistentApprovalStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, ApprovalError> {
        let path = path.into();
        let state = if path.exists() {
            let bytes = fs::read(&path).map_err(io_approval_error)?;
            serde_json::from_slice(&bytes).map_err(|error| ApprovalError::new(error.to_string()))?
        } else {
            PersistentApprovalRules {
                version: approval_rules_version(),
                rules: Vec::new(),
            }
        };
        Ok(Self {
            path,
            state: std::sync::Arc::new(Mutex::new(state)),
        })
    }

    pub fn append(&self, rule: PersistentApprovalRule) -> Result<bool, ApprovalError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ApprovalError::new("persistent approval store lock poisoned"))?;
        if state.rules.contains(&rule) {
            return Ok(false);
        }
        state.rules.push(rule);
        atomic_write_json(&self.path, &*state)?;
        Ok(true)
    }

    pub fn snapshot(&self) -> Result<PersistentApprovalRules, ApprovalError> {
        self.state
            .lock()
            .map_err(|_| ApprovalError::new("persistent approval store lock poisoned"))
            .map(|state| state.clone())
    }
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<(), ApprovalError> {
    let parent = path
        .parent()
        .ok_or_else(|| ApprovalError::new("approval rule path has no parent"))?;
    fs::create_dir_all(parent).map_err(io_approval_error)?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| ApprovalError::new(error.to_string()))?;
    fs::write(&temporary, bytes).map_err(io_approval_error)?;
    fs::rename(&temporary, path).map_err(io_approval_error)
}

fn io_approval_error(error: std::io::Error) -> ApprovalError {
    ApprovalError::new(error.to_string())
}

impl SessionApprovalStore {
    pub fn contains_all(&self, keys: &[ApprovalKey]) -> bool {
        self.contains_all_for("", keys)
    }

    pub fn contains_all_for(&self, session_id: &str, keys: &[ApprovalKey]) -> bool {
        if keys.is_empty() {
            return false;
        }
        let Ok(approved) = self.approved.lock() else {
            return false;
        };
        keys.iter().all(|key| {
            serde_json::to_string(key)
                .ok()
                .map(|key| format!("{session_id}\u{0}{key}"))
                .is_some_and(|key| approved.contains_key(&key))
        })
    }

    pub fn approve_for_session(&self, keys: &[ApprovalKey]) -> Result<(), ApprovalError> {
        self.approve_for("", keys)
    }

    pub fn approve_for(&self, session_id: &str, keys: &[ApprovalKey]) -> Result<(), ApprovalError> {
        let mut approved = self
            .approved
            .lock()
            .map_err(|_| ApprovalError::new("approval cache lock poisoned"))?;
        for key in keys {
            let key = serde_json::to_string(key)
                .map_err(|error| ApprovalError::new(error.to_string()))?;
            approved.insert(format!("{session_id}\u{0}{key}"), ());
        }
        Ok(())
    }

    pub fn clear_session(&self, session_id: &str) -> Result<(), ApprovalError> {
        let prefix = format!("{session_id}\u{0}");
        self.approved
            .lock()
            .map_err(|_| ApprovalError::new("approval cache lock poisoned"))?
            .retain(|key, _| !key.starts_with(&prefix));
        Ok(())
    }

    pub fn clear(&self) -> Result<(), ApprovalError> {
        self.approved
            .lock()
            .map_err(|_| ApprovalError::new("approval cache lock poisoned"))?
            .clear();
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutedServerRequest {
    pub recipients: Vec<String>,
    pub id: Value,
    pub method: String,
    pub params: Value,
}

impl RoutedServerRequest {
    pub fn wire_message(&self) -> Value {
        json!({"id": self.id, "method": self.method, "params": self.params})
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileChangeApprovalDecision {
    #[serde(rename = "accept")]
    Accept,
    #[serde(rename = "acceptForSession")]
    AcceptForSession,
    #[serde(rename = "decline")]
    Decline,
    #[serde(rename = "cancel")]
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandExecutionApprovalDecision {
    Accept,
    AcceptForSession,
    AcceptWithExecpolicyAmendment { execpolicy_amendment: Vec<String> },
    ApplyNetworkPolicyAmendment { network_policy_amendment: Value },
    Decline,
    Cancel,
}

#[derive(Debug)]
pub struct PendingFileChangeApproval {
    pub request: RoutedServerRequest,
    pub receiver: oneshot::Receiver<Result<FileChangeApprovalDecision, ApprovalError>>,
}

#[derive(Debug)]
pub struct PendingCommandExecutionApproval {
    pub request: RoutedServerRequest,
    pub receiver: oneshot::Receiver<Result<CommandExecutionApprovalDecision, ApprovalError>>,
}

#[derive(Debug)]
pub struct PendingPermissionsApproval {
    pub request: RoutedServerRequest,
    pub receiver: oneshot::Receiver<Result<PermissionsApprovalResponse, ApprovalError>>,
}

#[derive(Debug)]
pub struct PendingUserInput {
    pub request: RoutedServerRequest,
    pub receiver: oneshot::Receiver<Result<Value, ApprovalError>>,
}

#[derive(Debug)]
pub struct PendingLegacyApproval {
    pub request: RoutedServerRequest,
    pub receiver: oneshot::Receiver<Result<Value, ApprovalError>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChangeApprovalParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub reason: Option<String>,
    pub grant_root: Option<String>,
    pub started_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommandExecutionApprovalParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub approval_id: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub command_actions: Option<Vec<Value>>,
    pub environment_id: Option<String>,
    pub network_approval_context: Option<Value>,
    pub proposed_execpolicy_amendment: Option<Vec<String>>,
    pub proposed_network_policy_amendments: Option<Vec<Value>>,
    pub reason: Option<String>,
    pub started_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PermissionsApprovalParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub environment_id: Option<String>,
    pub cwd: String,
    pub reason: Option<String>,
    pub permissions: Value,
    pub started_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UserInputRequestParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub questions: Vec<Value>,
    pub auto_resolution_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsApprovalResponse {
    pub permissions: Value,
    #[serde(default = "default_permission_scope")]
    pub scope: String,
    #[serde(default)]
    pub strict_auto_review: Option<bool>,
}

fn default_permission_scope() -> String {
    "turn".into()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalError {
    pub message: String,
}

impl ApprovalError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ApprovalError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ApprovalError {}

#[derive(Default)]
pub struct ServerRequestBroker {
    next_id: AtomicU64,
    pending: Mutex<PendingMap>,
}

enum ApprovalSender {
    FileChange(oneshot::Sender<Result<FileChangeApprovalDecision, ApprovalError>>),
    CommandExecution(oneshot::Sender<Result<CommandExecutionApprovalDecision, ApprovalError>>),
    Permissions(oneshot::Sender<Result<PermissionsApprovalResponse, ApprovalError>>),
    UserInput(oneshot::Sender<Result<Value, ApprovalError>>),
    Legacy(oneshot::Sender<Result<Value, ApprovalError>>),
}
struct PendingApproval {
    thread_id: Option<String>,
    sender: ApprovalSender,
}
type PendingMap = HashMap<String, PendingApproval>;

impl ServerRequestBroker {
    pub fn begin_file_change(
        &self,
        recipients: Vec<String>,
        params: FileChangeApprovalParams,
    ) -> Result<PendingFileChangeApproval, ApprovalError> {
        let id = format!(
            "approval-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let request = RoutedServerRequest {
            recipients,
            id: json!(id),
            method: "item/fileChange/requestApproval".into(),
            params: json!({
                "threadId": params.thread_id,
                "turnId": params.turn_id,
                "itemId": params.item_id,
                "startedAtMs": params.started_at_ms,
                "reason": params.reason,
                "grantRoot": params.grant_root
            }),
        };
        serde_json::from_value::<ServerRequest>(request.wire_message())
            .map_err(|error| ApprovalError::new(error.to_string()))?;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| ApprovalError::new("approval request state lock poisoned"))?
            .insert(
                id,
                PendingApproval {
                    thread_id: Some(params.thread_id),
                    sender: ApprovalSender::FileChange(sender),
                },
            );
        Ok(PendingFileChangeApproval { request, receiver })
    }

    pub fn begin_command_execution(
        &self,
        recipients: Vec<String>,
        params: CommandExecutionApprovalParams,
    ) -> Result<PendingCommandExecutionApproval, ApprovalError> {
        let id = format!(
            "approval-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let request = RoutedServerRequest {
            recipients,
            id: json!(id),
            method: "item/commandExecution/requestApproval".into(),
            params: json!({
                "threadId": params.thread_id,
                "turnId": params.turn_id,
                "itemId": params.item_id,
                "approvalId": params.approval_id,
                "startedAtMs": params.started_at_ms,
                "command": params.command,
                "cwd": params.cwd,
                "commandActions": params.command_actions,
                "environmentId": params.environment_id,
                "networkApprovalContext": params.network_approval_context,
                "proposedExecpolicyAmendment": params.proposed_execpolicy_amendment,
                "proposedNetworkPolicyAmendments": params.proposed_network_policy_amendments,
                "reason": params.reason
            }),
        };
        serde_json::from_value::<ServerRequest>(request.wire_message())
            .map_err(|error| ApprovalError::new(error.to_string()))?;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| ApprovalError::new("approval request state lock poisoned"))?
            .insert(
                id,
                PendingApproval {
                    thread_id: Some(params.thread_id),
                    sender: ApprovalSender::CommandExecution(sender),
                },
            );
        Ok(PendingCommandExecutionApproval { request, receiver })
    }

    pub fn begin_permissions(
        &self,
        recipients: Vec<String>,
        params: PermissionsApprovalParams,
    ) -> Result<PendingPermissionsApproval, ApprovalError> {
        let id = format!(
            "approval-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let request = RoutedServerRequest {
            recipients,
            id: json!(id),
            method: "item/permissions/requestApproval".into(),
            params: json!({
                "threadId": params.thread_id,
                "turnId": params.turn_id,
                "itemId": params.item_id,
                "environmentId": params.environment_id,
                "cwd": params.cwd,
                "reason": params.reason,
                "permissions": params.permissions,
                "startedAtMs": params.started_at_ms
            }),
        };
        serde_json::from_value::<ServerRequest>(request.wire_message())
            .map_err(|error| ApprovalError::new(error.to_string()))?;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| ApprovalError::new("approval request state lock poisoned"))?
            .insert(
                id,
                PendingApproval {
                    thread_id: Some(params.thread_id),
                    sender: ApprovalSender::Permissions(sender),
                },
            );
        Ok(PendingPermissionsApproval { request, receiver })
    }

    pub fn begin_user_input(
        &self,
        recipients: Vec<String>,
        params: UserInputRequestParams,
    ) -> Result<PendingUserInput, ApprovalError> {
        let id = format!(
            "user-input-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let request = RoutedServerRequest {
            recipients,
            id: json!(id),
            method: "item/tool/requestUserInput".into(),
            params: json!({
                "threadId":params.thread_id,
                "turnId":params.turn_id,
                "itemId":params.item_id,
                "questions":params.questions,
                "autoResolutionMs":params.auto_resolution_ms
            }),
        };
        serde_json::from_value::<ServerRequest>(request.wire_message())
            .map_err(|error| ApprovalError::new(error.to_string()))?;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| ApprovalError::new("approval request state lock poisoned"))?
            .insert(
                id,
                PendingApproval {
                    thread_id: Some(params.thread_id),
                    sender: ApprovalSender::UserInput(sender),
                },
            );
        Ok(PendingUserInput { request, receiver })
    }

    pub fn begin_legacy(
        &self,
        recipients: Vec<String>,
        method: &str,
        params: Value,
    ) -> Result<PendingLegacyApproval, ApprovalError> {
        if !matches!(method, "applyPatchApproval" | "execCommandApproval") {
            return Err(ApprovalError::new("unsupported legacy approval method"));
        }
        let id = format!(
            "approval-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let thread_id = params
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let request = RoutedServerRequest {
            recipients,
            id: json!(id),
            method: method.into(),
            params,
        };
        serde_json::from_value::<ServerRequest>(request.wire_message())
            .map_err(|error| ApprovalError::new(error.to_string()))?;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| ApprovalError::new("approval request state lock poisoned"))?
            .insert(
                id,
                PendingApproval {
                    thread_id,
                    sender: ApprovalSender::Legacy(sender),
                },
            );
        Ok(PendingLegacyApproval { request, receiver })
    }

    pub fn resolve(&self, response: &Value) -> Result<bool, ApprovalError> {
        serde_json::from_value::<JSONRPCResponse>(response.clone())
            .map_err(|error| ApprovalError::new(error.to_string()))?;
        let id = response
            .get("id")
            .map(request_id_key)
            .ok_or_else(|| ApprovalError::new("server response id is required"))?;
        let sender = self
            .pending
            .lock()
            .map_err(|_| ApprovalError::new("approval request state lock poisoned"))?
            .remove(&id);
        let Some(pending) = sender else {
            return Ok(false);
        };
        match pending.sender {
            ApprovalSender::FileChange(sender) => {
                let result = parse_result::<FileChangeApprovalResponse>(
                    response,
                    "file change approval failed",
                )
                .map(|response| response.decision);
                let _ = sender.send(result);
            }
            ApprovalSender::CommandExecution(sender) => {
                let result = parse_result::<CommandExecutionApprovalResponse>(
                    response,
                    "command execution approval failed",
                )
                .map(|response| response.decision);
                let _ = sender.send(result);
            }
            ApprovalSender::Permissions(sender) => {
                let result = parse_result::<PermissionsApprovalResponse>(
                    response,
                    "permissions approval failed",
                );
                let _ = sender.send(result);
            }
            ApprovalSender::UserInput(sender) => {
                let result = response
                    .get("result")
                    .cloned()
                    .ok_or_else(|| ApprovalError::new("user input request failed"))
                    .and_then(|result| {
                        serde_json::from_value::<
                            tietiezhi_agent_protocol::ToolRequestUserInputResponse,
                        >(result.clone())
                        .map(|_| result)
                        .map_err(|error| ApprovalError::new(error.to_string()))
                    });
                let _ = sender.send(result);
            }
            ApprovalSender::Legacy(sender) => {
                let result = response
                    .get("result")
                    .cloned()
                    .ok_or_else(|| ApprovalError::new("legacy approval failed"))
                    .and_then(|result| {
                        result
                            .get("decision")
                            .cloned()
                            .ok_or_else(|| ApprovalError::new("legacy decision is required"))
                    });
                let _ = sender.send(result);
            }
        }
        Ok(true)
    }

    pub fn cancel(&self, id: &Value) -> Result<bool, ApprovalError> {
        Ok(self
            .pending
            .lock()
            .map_err(|_| ApprovalError::new("approval request state lock poisoned"))?
            .remove(&request_id_key(id))
            .is_some())
    }

    /// Returns the exact Thread scope for a pending reverse request without
    /// consuming it. Remote-control transports use this to prevent a paired
    /// client from answering an approval belonging to another Thread.
    pub fn pending_thread_id(&self, id: &Value) -> Result<Option<String>, ApprovalError> {
        Ok(self
            .pending
            .lock()
            .map_err(|_| ApprovalError::new("approval request state lock poisoned"))?
            .get(&request_id_key(id))
            .and_then(|pending| pending.thread_id.clone()))
    }
}

#[derive(Deserialize)]
struct FileChangeApprovalResponse {
    decision: FileChangeApprovalDecision,
}

#[derive(Deserialize)]
struct CommandExecutionApprovalResponse {
    decision: CommandExecutionApprovalDecision,
}

fn parse_result<T: for<'de> Deserialize<'de>>(
    response: &Value,
    fallback: &str,
) -> Result<T, ApprovalError> {
    match response.get("result") {
        Some(result) => serde_json::from_value(result.clone())
            .map_err(|error| ApprovalError::new(error.to_string())),
        None => Err(ApprovalError::new(
            response
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or(fallback),
        )),
    }
}

fn request_id_key(id: &Value) -> String {
    id.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn file_change_request_matches_v2_and_routes_four_decisions() {
        for decision in [
            ("accept", FileChangeApprovalDecision::Accept),
            (
                "acceptForSession",
                FileChangeApprovalDecision::AcceptForSession,
            ),
            ("decline", FileChangeApprovalDecision::Decline),
            ("cancel", FileChangeApprovalDecision::Cancel),
        ]
        .into_iter()
        {
            let broker = ServerRequestBroker::default();
            let pending = broker
                .begin_file_change(
                    vec!["desktop".into()],
                    FileChangeApprovalParams {
                        thread_id: "01900000-0000-7000-8000-000000000001".into(),
                        turn_id: "01900000-0000-7000-8000-000000000002".into(),
                        item_id: "call_1".into(),
                        reason: Some("write files".into()),
                        grant_root: None,
                        started_at_ms: 42,
                    },
                )
                .unwrap();
            assert_eq!(pending.request.method, "item/fileChange/requestApproval");
            assert_eq!(pending.request.params["startedAtMs"], 42);
            assert!(
                serde_json::from_value::<ServerRequest>(pending.request.wire_message()).is_ok()
            );
            assert!(
                broker
                    .resolve(&json!({"id": pending.request.id, "result": {"decision": decision.0}}))
                    .unwrap()
            );
            assert_eq!(pending.receiver.await.unwrap().unwrap(), decision.1);
        }
    }

    #[test]
    fn unknown_response_is_not_consumed() {
        let broker = ServerRequestBroker::default();
        assert!(
            !broker
                .resolve(&json!({"id": 999, "result": {"decision":"accept"}}))
                .unwrap()
        );
    }

    #[tokio::test]
    async fn user_input_request_matches_v2_and_routes_answers() {
        let broker = ServerRequestBroker::default();
        let pending = broker
            .begin_user_input(
                vec!["desktop".into()],
                UserInputRequestParams {
                    thread_id: "01900000-0000-7000-8000-000000000001".into(),
                    turn_id: "01900000-0000-7000-8000-000000000002".into(),
                    item_id: "call_1".into(),
                    questions: vec![json!({
                        "id":"strategy",
                        "header":"Strategy",
                        "question":"How should this proceed?",
                        "isOther":true,
                        "isSecret":false,
                        "options":[
                            {"label":"Direct","description":"Continue immediately."},
                            {"label":"Plan","description":"Review the plan first."}
                        ]
                    })],
                    auto_resolution_ms: Some(60_000),
                },
            )
            .unwrap();
        assert_eq!(pending.request.method, "item/tool/requestUserInput");
        assert!(serde_json::from_value::<ServerRequest>(pending.request.wire_message()).is_ok());
        let response = json!({
            "id":pending.request.id,
            "result":{"answers":{"strategy":{"answers":["Direct"]}}}
        });
        assert!(broker.resolve(&response).unwrap());
        assert_eq!(
            pending.receiver.await.unwrap().unwrap(),
            response["result"].clone()
        );
    }

    #[tokio::test]
    async fn command_request_matches_v2_and_routes_all_decisions() {
        let decisions = [
            json!("accept"),
            json!("acceptForSession"),
            json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["git","status"]}}),
            json!({"applyNetworkPolicyAmendment":{"network_policy_amendment":{"host":"example.com","action":"allow"}}}),
            json!("decline"),
            json!("cancel"),
        ];
        for decision in decisions {
            let broker = ServerRequestBroker::default();
            let pending = broker
                .begin_command_execution(
                    vec!["desktop".into()],
                    CommandExecutionApprovalParams {
                        thread_id: "01900000-0000-7000-8000-000000000001".into(),
                        turn_id: "01900000-0000-7000-8000-000000000002".into(),
                        item_id: "call_1".into(),
                        approval_id: None,
                        command: Some("git status".into()),
                        cwd: Some("/tmp/project".into()),
                        command_actions: None,
                        environment_id: Some("local".into()),
                        network_approval_context: None,
                        proposed_execpolicy_amendment: None,
                        proposed_network_policy_amendments: None,
                        reason: Some("inspect repository".into()),
                        started_at_ms: 42,
                    },
                )
                .unwrap();
            assert_eq!(
                pending.request.method,
                "item/commandExecution/requestApproval"
            );
            assert!(
                serde_json::from_value::<ServerRequest>(pending.request.wire_message()).is_ok()
            );
            assert!(
                broker
                    .resolve(&json!({"id": pending.request.id, "result": {"decision": decision}}))
                    .unwrap()
            );
            pending.receiver.await.unwrap().unwrap();
        }
    }

    #[test]
    fn pending_approval_exposes_exact_thread_scope_without_consuming_request() {
        let broker = ServerRequestBroker::default();
        let pending = broker
            .begin_command_execution(
                vec!["desktop".into()],
                CommandExecutionApprovalParams {
                    thread_id: "thread-a".into(),
                    turn_id: "turn-a".into(),
                    item_id: "item-a".into(),
                    approval_id: None,
                    started_at_ms: 1,
                    command: Some("git status".into()),
                    cwd: Some("/tmp".into()),
                    command_actions: Some(Vec::new()),
                    environment_id: None,
                    network_approval_context: None,
                    proposed_execpolicy_amendment: None,
                    proposed_network_policy_amendments: None,
                    reason: None,
                },
            )
            .unwrap();
        assert_eq!(
            broker.pending_thread_id(&pending.request.id).unwrap(),
            Some("thread-a".into())
        );
        assert_eq!(
            broker.pending_thread_id(&pending.request.id).unwrap(),
            Some("thread-a".into())
        );
    }

    #[test]
    fn policy_modes_match_codex_default_sandbox_decisions() {
        let granular = serde_json::from_value::<AskForApproval>(json!({
            "granular":{
                "sandbox_approval":true,
                "rules":false,
                "skill_approval":true,
                "request_permissions":true,
                "mcp_elicitations":false
            }
        }))
        .unwrap();
        assert!(granular.allows(ApprovalCategory::Sandbox));
        assert!(!granular.allows(ApprovalCategory::Rule));
        assert!(granular.allows(ApprovalCategory::RequestPermissions));
        assert_eq!(
            default_exec_approval_requirement(
                AskForApproval::OnRequest,
                SandboxAvailability::Restricted,
                false
            ),
            ApprovalRequirement::NeedsApproval { reason: None }
        );
        assert_eq!(
            default_exec_approval_requirement(
                AskForApproval::OnRequest,
                SandboxAvailability::External,
                false
            ),
            ApprovalRequirement::Skip {
                bypass_sandbox: false
            }
        );
        assert_eq!(
            default_exec_approval_requirement(
                AskForApproval::UnlessTrusted,
                SandboxAvailability::Restricted,
                true
            ),
            ApprovalRequirement::Skip {
                bypass_sandbox: false
            }
        );
        assert_eq!(
            default_exec_approval_requirement(
                AskForApproval::Granular(GranularApprovalConfig {
                    sandbox_approval: false,
                    rules: true,
                    skill_approval: false,
                    request_permissions: false,
                    mcp_elicitations: true,
                }),
                SandboxAvailability::Restricted,
                false
            ),
            ApprovalRequirement::Forbidden {
                reason: "approval policy disallowed sandbox approval prompt".into()
            }
        );
    }

    #[test]
    fn approval_cache_is_exact_and_session_only() {
        let store = SessionApprovalStore::default();
        let first = ApprovalKey::Command {
            environment_id: "local".into(),
            command: vec!["git".into(), "status".into()],
            cwd: "/tmp/a".into(),
            tty: false,
            sandbox_permissions: "useDefault".into(),
            additional_permissions: None,
        };
        let different_cwd = ApprovalKey::Command {
            environment_id: "local".into(),
            command: vec!["git".into(), "status".into()],
            cwd: "/tmp/b".into(),
            tty: false,
            sandbox_permissions: "useDefault".into(),
            additional_permissions: None,
        };
        assert!(!store.contains_all(std::slice::from_ref(&first)));
        store
            .approve_for_session(std::slice::from_ref(&first))
            .unwrap();
        assert!(store.contains_all(std::slice::from_ref(&first)));
        assert!(!store.contains_all(&[different_cwd]));
        store.clear().unwrap();
        assert!(!store.contains_all(&[first]));
    }

    #[test]
    fn session_cache_does_not_cross_threads() {
        let store = SessionApprovalStore::default();
        let key = ApprovalKey::FileChange {
            environment_id: "local".into(),
            path: "/tmp/a".into(),
        };
        store
            .approve_for("thread-a", std::slice::from_ref(&key))
            .unwrap();
        assert!(store.contains_all_for("thread-a", std::slice::from_ref(&key)));
        assert!(!store.contains_all_for("thread-b", &[key]));
    }

    #[test]
    fn persistent_amendments_are_atomic_and_deduplicated() {
        let root = std::env::temp_dir().join(format!(
            "tietiezhi-approval-{}-{}",
            std::process::id(),
            crate::tests::unique_test_id()
        ));
        let path = root.join("rules.json");
        let store = PersistentApprovalStore::open(&path).unwrap();
        let rule = PersistentApprovalRule::ExecPolicy {
            amendment: vec!["git".into(), "status".into()],
        };
        assert!(store.append(rule.clone()).unwrap());
        assert!(!store.append(rule.clone()).unwrap());
        drop(store);
        let reopened = PersistentApprovalStore::open(&path).unwrap();
        assert_eq!(reopened.snapshot().unwrap().rules, vec![rule]);
        let _ = fs::remove_dir_all(root);
    }

    fn unique_test_id() -> u64 {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    #[test]
    fn file_cache_accepts_only_approved_subset() {
        let store = SessionApprovalStore::default();
        let a = ApprovalKey::FileChange {
            environment_id: "local".into(),
            path: "/tmp/a".into(),
        };
        let b = ApprovalKey::FileChange {
            environment_id: "local".into(),
            path: "/tmp/b".into(),
        };
        store.approve_for_session(&[a.clone(), b.clone()]).unwrap();
        assert!(store.contains_all(&[a]));
        assert!(store.contains_all(&[b]));
    }

    #[tokio::test]
    async fn permissions_request_matches_v2_and_defaults_scope() {
        let broker = ServerRequestBroker::default();
        let pending = broker
            .begin_permissions(
                vec!["desktop".into()],
                PermissionsApprovalParams {
                    thread_id: "01900000-0000-7000-8000-000000000001".into(),
                    turn_id: "01900000-0000-7000-8000-000000000002".into(),
                    item_id: "call_1".into(),
                    environment_id: Some("local".into()),
                    cwd: "/tmp/project".into(),
                    reason: Some("read generated files".into()),
                    permissions: json!({"fileSystem":{"read":["/tmp/generated"]}}),
                    started_at_ms: 42,
                },
            )
            .unwrap();
        assert_eq!(pending.request.method, "item/permissions/requestApproval");
        assert!(
            broker
                .resolve(&json!({
                    "id": pending.request.id,
                    "result":{"permissions":{"fileSystem":{"read":["/tmp/generated"]}}}
                }))
                .unwrap()
        );
        let response = pending.receiver.await.unwrap().unwrap();
        assert_eq!(response.scope, "turn");
    }

    #[tokio::test]
    async fn legacy_approval_methods_stay_wire_compatible() {
        let broker = ServerRequestBroker::default();
        let pending = broker
            .begin_legacy(
                vec!["desktop".into()],
                "execCommandApproval",
                json!({
                    "conversationId":"01900000-0000-7000-8000-000000000001",
                    "callId":"call_1",
                    "command":["git","status"],
                    "cwd":"/tmp/project",
                    "parsedCmd":[]
                }),
            )
            .unwrap();
        assert!(
            broker
                .resolve(&json!({
                    "id":pending.request.id,
                    "result":{"decision":"approved_for_session"}
                }))
                .unwrap()
        );
        assert_eq!(
            pending.receiver.await.unwrap().unwrap(),
            json!("approved_for_session")
        );
    }
}
