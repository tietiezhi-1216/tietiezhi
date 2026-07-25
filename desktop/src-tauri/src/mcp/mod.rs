use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tietiezhi_agent_core::RoutedNotification;
use tietiezhi_agent_mcp::{McpElicitation, McpElicitationResponse, McpHost, McpProgress};
use tietiezhi_agent_protocol::{ServerNotification, ServerRequest};

use crate::AppState;

pub use tietiezhi_agent_mcp::{
    namespaced, parse_namespaced, ElicitationBroker, McpManager, McpServerConfig, McpServerStatus,
    McpTransport,
};

const CODEX_NOTIFICATION_EVENT: &str = "codex-v2-notification";
const CODEX_SERVER_REQUEST_EVENT: &str = "codex-v2-server-request";

#[derive(Clone)]
pub struct DesktopMcpHost {
    app: AppHandle,
    broker: Arc<ElicitationBroker>,
}

impl DesktopMcpHost {
    pub fn install(app: &AppHandle) -> Result<(), String> {
        let state = app.state::<AppState>();
        state.mcp.set_host(Arc::new(Self {
            app: app.clone(),
            broker: state.codex_mcp_requests.clone(),
        }))
    }

    fn recipients(&self, thread_id: Option<&str>) -> Vec<String> {
        let state = self.app.state::<AppState>();
        let manager = state
            .codex_core
            .lock()
            .ok()
            .and_then(|manager| manager.clone());
        match (manager, thread_id) {
            (Some(manager), Some(thread_id)) => {
                manager.thread_recipients(thread_id).unwrap_or_default()
            }
            (Some(manager), None) => manager.connection_recipients().unwrap_or_default(),
            (None, _) => Vec::new(),
        }
    }

    fn emit_notification(&self, method: &str, params: Value, thread_id: Option<&str>) {
        let notification = RoutedNotification {
            recipients: self.recipients(thread_id),
            method: method.into(),
            params,
        };
        if serde_json::from_value::<ServerNotification>(notification.wire_message()).is_ok() {
            let _ = self.app.emit(CODEX_NOTIFICATION_EVENT, notification);
        }
    }
}

impl McpHost for DesktopMcpHost {
    fn progress(&self, progress: McpProgress) {
        let thread_id = progress.context.thread_id.clone();
        self.emit_notification(
            "item/mcpToolCall/progress",
            json!({
                "threadId": progress.context.thread_id,
                "turnId": progress.context.turn_id,
                "itemId": progress.context.item_id,
                "message": progress.message
            }),
            Some(&thread_id),
        );
    }

    fn startup_status(&self, server: &str, status: &str, error: Option<&str>) {
        self.emit_notification(
            "mcpServer/startupStatus/updated",
            json!({
                "threadId": Value::Null,
                "name": server,
                "status": status,
                "error": error,
                "failureReason": if error.is_some_and(|value| value.contains("OAuth")) {
                    json!("reauthenticationRequired")
                } else {
                    Value::Null
                }
            }),
            None,
        );
    }

    fn oauth_completed(
        &self,
        server: &str,
        thread_id: Option<&str>,
        success: bool,
        error: Option<&str>,
    ) {
        self.emit_notification(
            "mcpServer/oauthLogin/completed",
            json!({
                "name": server,
                "threadId": thread_id,
                "success": success,
                "error": error
            }),
            thread_id,
        );
    }

    fn elicit(
        &self,
        request: McpElicitation,
    ) -> tietiezhi_agent_mcp::HostFuture<McpElicitationResponse> {
        let recipients = self.recipients(Some(&request.context.thread_id));
        let pending = self.broker.begin(recipients, request);
        let app = self.app.clone();
        Box::pin(async move {
            let Ok(pending) = pending else {
                return McpElicitationResponse {
                    action: "decline".into(),
                    content: None,
                    meta: None,
                };
            };
            if serde_json::from_value::<ServerRequest>(pending.request.wire_message()).is_err()
                || app
                    .emit(CODEX_SERVER_REQUEST_EVENT, &pending.request)
                    .is_err()
            {
                return McpElicitationResponse {
                    action: "decline".into(),
                    content: None,
                    meta: None,
                };
            }
            pending
                .receiver
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(McpElicitationResponse {
                    action: "cancel".into(),
                    content: None,
                    meta: None,
                })
        })
    }
}
