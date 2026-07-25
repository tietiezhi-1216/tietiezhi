use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Per-agent permission mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    /// Every mutating operation needs frontend approval.
    Ask,
    /// Smart review: reads and workspace-confined writes auto-allow; shell,
    /// network, and unknown tools ask until the Codex sandbox is implemented.
    Auto,
    /// Everything allowed.
    Full,
}

impl PermissionMode {
    pub fn parse(s: &str) -> Self {
        match s {
            "full" => Self::Full,
            "ask" => Self::Ask,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

impl Decision {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "accept" | "allow" => Some(Self::Accept),
            "acceptForSession" | "allowAlways" => Some(Self::AcceptForSession),
            "decline" | "deny" => Some(Self::Decline),
            "cancel" => Some(Self::Cancel),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalScope {
    pub key: String,
    pub label: String,
}

/// Build the narrowest temporary approval scope the legacy runtime can enforce.
/// This is containment until the Codex sandbox and execpolicy land in R14-R18.
pub fn approval_scope(tool: &str, args: &Value) -> ApprovalScope {
    match tool {
        "bash" => {
            let command = args
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            ApprovalScope {
                key: format!("bash\0{command}"),
                label: format!("命令：{command}"),
            }
        }
        "write_file" | "edit_file" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or_default();
            ApprovalScope {
                key: format!("{tool}\0{path}"),
                label: format!("路径：{path}"),
            }
        }
        "fetch" => {
            let url = args.get("url").and_then(Value::as_str).unwrap_or_default();
            let origin = reqwest::Url::parse(url)
                .ok()
                .map(|url| url.origin().ascii_serialization())
                .unwrap_or_else(|| url.to_string());
            ApprovalScope {
                key: format!("fetch\0{origin}"),
                label: format!("网络来源：{origin}"),
            }
        }
        "device_call" => {
            let device = args
                .get("device_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let capability = args
                .get("capability")
                .and_then(Value::as_str)
                .unwrap_or_default();
            ApprovalScope {
                key: format!("device_call\0{device}\0{capability}"),
                label: format!("设备能力：{device} / {capability}"),
            }
        }
        _ => {
            let arguments = serde_json::to_string(args).unwrap_or_else(|_| "{}".into());
            ApprovalScope {
                key: format!("{tool}\0{arguments}"),
                label: format!("工具与参数：{tool} {arguments}"),
            }
        }
    }
}

/// Routes permission answers from the `permission_respond` command back to the
/// agent loop blocked inside `wait`. Session grants are cached by exact approval
/// scope, never by the broad tool name.
#[derive(Default)]
pub struct PermissionBroker {
    pending: Mutex<HashMap<String, oneshot::Sender<Decision>>>,
    session_allows: Mutex<HashMap<u32, HashSet<String>>>,
}

const WAIT_TIMEOUT: Duration = Duration::from_secs(300);

impl PermissionBroker {
    pub fn register(&self, id: &str) -> oneshot::Receiver<Decision> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.to_string(), tx);
        rx
    }

    pub fn respond(&self, id: &str, decision: Decision) -> Result<(), String> {
        match self.pending.lock().unwrap().remove(id) {
            Some(tx) => {
                let _ = tx.send(decision);
                Ok(())
            }
            // Late/duplicate answers are harmless.
            None => Ok(()),
        }
    }

    pub fn is_session_allowed(&self, request_id: u32, scope_key: &str) -> bool {
        self.session_allows
            .lock()
            .unwrap()
            .get(&request_id)
            .map(|s| s.contains(scope_key))
            .unwrap_or(false)
    }

    pub fn allow_for_session(&self, request_id: u32, scope_key: &str) {
        self.session_allows
            .lock()
            .unwrap()
            .entry(request_id)
            .or_default()
            .insert(scope_key.to_string());
    }

    pub fn end_session(&self, request_id: u32) {
        self.session_allows.lock().unwrap().remove(&request_id);
    }

    /// Block until the frontend answers, the stream is cancelled, or the wait
    /// times out (treated as decline). Cleans the pending entry on every path.
    pub async fn wait(
        &self,
        id: &str,
        rx: oneshot::Receiver<Decision>,
        cancel: &CancellationToken,
    ) -> Decision {
        let decision = tokio::select! {
            d = rx => d.unwrap_or(Decision::Decline),
            _ = cancel.cancelled() => Decision::Cancel,
            _ = tokio::time::sleep(WAIT_TIMEOUT) => Decision::Decline,
        };
        self.pending.lock().unwrap().remove(id);
        decision
    }
}

/// Whether a tool call needs approval under the given mode. Returns `false`
/// when the call may proceed directly.
pub fn needs_approval(mode: PermissionMode, tool: &str) -> bool {
    match mode {
        PermissionMode::Full => false,
        PermissionMode::Ask => !crate::tools::is_read_only(tool),
        PermissionMode::Auto => match tool {
            // Until the OS sandbox lands, every shell and network action must
            // cross the approval boundary. Heuristics are not a sandbox.
            "bash" | "fetch" => true,
            // Writes are already jailed to the workspace by path resolution,
            // so in auto mode they may proceed.
            "write_file" | "edit_file" => false,
            _ if crate::tools::is_read_only(tool) => false,
            // Unknown (MCP) tools: ask to be safe.
            _ => true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn full_mode_allows_everything() {
        assert!(!needs_approval(PermissionMode::Full, "bash"));
    }

    #[test]
    fn ask_mode_gates_mutations_but_not_reads() {
        assert!(needs_approval(PermissionMode::Ask, "write_file"));
        assert!(needs_approval(PermissionMode::Ask, "bash"));
        assert!(needs_approval(PermissionMode::Ask, "fetch"));
        assert!(!needs_approval(PermissionMode::Ask, "read_file"));
        assert!(!needs_approval(PermissionMode::Ask, "grep"));
    }

    #[test]
    fn auto_mode_requires_shell_and_network_approval_without_a_sandbox() {
        let m = PermissionMode::Auto;
        assert!(needs_approval(m, "bash"));
        assert!(needs_approval(m, "fetch"));
    }

    #[test]
    fn auto_mode_allows_workspace_writes_and_asks_unknown_tools() {
        let m = PermissionMode::Auto;
        assert!(!needs_approval(m, "write_file"));
        assert!(needs_approval(m, "mcp__srv__delete_all"));
    }

    #[test]
    fn approval_scopes_are_narrow_and_stable() {
        let first = approval_scope("bash", &json!({"command":"cargo test"}));
        let same = approval_scope("bash", &json!({"command":"cargo test"}));
        let other = approval_scope("bash", &json!({"command":"git push"}));
        assert_eq!(first.key, same.key);
        assert_ne!(first.key, other.key);

        let first = approval_scope("fetch", &json!({"url":"https://example.com/a"}));
        let same_origin = approval_scope("fetch", &json!({"url":"https://example.com/b"}));
        let other_origin = approval_scope("fetch", &json!({"url":"https://api.example.com/a"}));
        assert_eq!(first.key, same_origin.key);
        assert_ne!(first.key, other_origin.key);
    }

    #[test]
    fn legacy_decision_names_remain_wire_compatible() {
        assert_eq!(Decision::parse("allow"), Some(Decision::Accept));
        assert_eq!(
            Decision::parse("allowAlways"),
            Some(Decision::AcceptForSession)
        );
        assert_eq!(Decision::parse("deny"), Some(Decision::Decline));
    }

    #[tokio::test]
    async fn broker_roundtrip_and_session_cache() {
        let broker = PermissionBroker::default();
        let rx = broker.register("req-1");
        broker.respond("req-1", Decision::AcceptForSession).unwrap();
        let cancel = CancellationToken::new();
        assert_eq!(
            broker.wait("req-1", rx, &cancel).await,
            Decision::AcceptForSession
        );

        let approved = approval_scope("bash", &json!({"command":"cargo test"}));
        let different = approval_scope("bash", &json!({"command":"git push"}));
        broker.allow_for_session(7, &approved.key);
        assert!(broker.is_session_allowed(7, &approved.key));
        assert!(!broker.is_session_allowed(7, &different.key));
        broker.end_session(7);
        assert!(!broker.is_session_allowed(7, &approved.key));
    }

    #[tokio::test]
    async fn broker_wait_cancellation_cancels() {
        let broker = PermissionBroker::default();
        let rx = broker.register("req-2");
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(broker.wait("req-2", rx, &cancel).await, Decision::Cancel);
    }
}
