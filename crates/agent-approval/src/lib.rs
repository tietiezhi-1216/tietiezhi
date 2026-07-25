//! Reverse JSON-RPC approval broker compatible with Codex App Server V2.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tietiezhi_agent_protocol::{JSONRPCResponse, ServerRequest};
use tokio::sync::oneshot;

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
    pub reason: Option<String>,
    pub started_at_ms: i64,
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
}
type PendingMap = HashMap<String, ApprovalSender>;

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
            .insert(id, ApprovalSender::FileChange(sender));
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
                "reason": params.reason
            }),
        };
        serde_json::from_value::<ServerRequest>(request.wire_message())
            .map_err(|error| ApprovalError::new(error.to_string()))?;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| ApprovalError::new("approval request state lock poisoned"))?
            .insert(id, ApprovalSender::CommandExecution(sender));
        Ok(PendingCommandExecutionApproval { request, receiver })
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
        let Some(sender) = sender else {
            return Ok(false);
        };
        match sender {
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
}
