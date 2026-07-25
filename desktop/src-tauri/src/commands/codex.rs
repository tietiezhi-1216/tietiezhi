use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tietiezhi_agent_core::{
    DispatchOutput, RoutedNotification, RuntimeDefaults, ThreadManager, TurnExecutionSnapshot,
};
use tietiezhi_agent_model::{
    ModelError, Reasoning, ResponseEvent, ResponsesApiRequest, ResponsesClient, TextControls,
    TextFormat, TextFormatType,
};
use tokio_util::sync::CancellationToken;

use crate::AppState;

const CODEX_NOTIFICATION_EVENT: &str = "codex-v2-notification";

fn runtime_defaults(app: &AppHandle) -> Result<RuntimeDefaults, String> {
    let settings = super::settings::read_settings(app)?;
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

fn cancel_thread(state: &AppState, thread_id: &str, expected_turn_id: Option<&str>) {
    if let Ok(cancels) = state.codex_cancels.lock() {
        if let Some((turn_id, cancel)) = cancels.get(thread_id) {
            if expected_turn_id.is_none_or(|expected| expected == turn_id) {
                cancel.cancel();
            }
        }
    }
}

/// Dispatch one App Server V2 request without embedding an upstream binary.
///
/// The request itself remains synchronous so JSON-RPC acceptance and lifecycle
/// notifications preserve their order. A successful `turn/start` launches the
/// source-native Responses executor on Tauri's async runtime.
#[tauri::command]
pub fn codex_v2_request(
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
    }
    Ok(output)
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
    let provider =
        tietiezhi_agent_model::Provider::openai_compatible(resolved.kind, base_url, resolved.key);
    let client = ResponsesClient::new(http, provider);
    let mut projection = ResponseProjection::new(initial.model.clone());
    let mut can_drain_steered = false;
    let mut output_schema = None;

    loop {
        let drained = manager
            .drain_turn_inputs(&thread_id, &turn_id, can_drain_steered)
            .map_err(core_model_error)?;
        emit_notifications(&app, &drained.notifications).map_err(ModelError::Consumer)?;
        can_drain_steered = true;
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
        let request = response_request(&snapshot, output_schema.clone());
        let stream = client.stream(&request, |event| {
            let notifications = projection.apply(&manager, &thread_id, &turn_id, event)?;
            emit_notifications(&app, &notifications).map_err(ModelError::Consumer)
        });
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = stream => result?,
        }
        if cancel.is_cancelled() {
            return Ok(());
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

fn response_request(
    snapshot: &TurnExecutionSnapshot,
    output_schema: Option<Value>,
) -> ResponsesApiRequest {
    let mut request = ResponsesApiRequest::text(snapshot.model.clone(), snapshot.history.clone());
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

#[derive(Debug)]
struct ResponseProjection {
    requested_model: String,
    server_model: Option<String>,
    current_agent_item: Option<String>,
    current_reasoning_item: Option<String>,
    reroute_emitted: bool,
    verification_emitted: bool,
    needs_follow_up: bool,
}

impl ResponseProjection {
    fn new(requested_model: String) -> Self {
        Self {
            requested_model,
            server_model: None,
            current_agent_item: None,
            current_reasoning_item: None,
            reroute_emitted: false,
            verification_emitted: false,
            needs_follow_up: false,
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
                self.track_item(&item);
                manager
                    .model_item_started(thread_id, turn_id, item)
                    .map_err(core_model_error)
            }
            ResponseEvent::OutputItemDone(item) => {
                self.track_item(&item);
                manager
                    .model_item_completed(thread_id, turn_id, item)
                    .map_err(core_model_error)
            }
            ResponseEvent::OutputTextDelta(delta) => {
                let item_id = self.current_agent_item.as_deref().ok_or_else(|| {
                    ModelError::Consumer("text delta arrived before agent message item".into())
                })?;
                manager
                    .agent_message_delta(thread_id, turn_id, item_id, &delta)
                    .map_err(core_model_error)
            }
            ResponseEvent::ReasoningSummaryPartAdded { summary_index } => {
                let item_id = self.reasoning_item()?;
                manager
                    .reasoning_summary_part_added(thread_id, turn_id, item_id, summary_index)
                    .map_err(core_model_error)
            }
            ResponseEvent::ReasoningSummaryDelta {
                delta,
                summary_index,
            } => {
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
                manager
                    .reasoning_summary_done(thread_id, turn_id, &item_id, summary_index, &text)
                    .map_err(core_model_error)?;
                Ok(Vec::new())
            }
            ResponseEvent::ReasoningContentDelta {
                delta,
                content_index,
            } => {
                let item_id = self.reasoning_item()?;
                manager
                    .reasoning_text_delta(thread_id, turn_id, item_id, content_index, &delta)
                    .map_err(core_model_error)
            }
            ResponseEvent::ToolCallInputDelta { .. } => Ok(Vec::new()),
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
                    .record_token_usage(thread_id, turn_id, last, None)
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

    fn reasoning_item(&self) -> Result<&str, ModelError> {
        self.current_reasoning_item.as_deref().ok_or_else(|| {
            ModelError::Consumer("reasoning delta arrived before reasoning item".into())
        })
    }

    fn take_needs_follow_up(&mut self) -> bool {
        std::mem::take(&mut self.needs_follow_up)
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
    use super::{nonempty_or_unconfigured, ResponseProjection};

    #[test]
    fn empty_runtime_selection_is_explicitly_unconfigured() {
        assert_eq!(nonempty_or_unconfigured(String::new()), "unconfigured");
        assert_eq!(nonempty_or_unconfigured("  ".into()), "unconfigured");
        assert_eq!(nonempty_or_unconfigured("gpt-test".into()), "gpt-test");
    }

    #[test]
    fn response_projection_tracks_turn_scoped_server_state() {
        let mut projection = ResponseProjection::new("gpt-requested".into());
        assert_eq!(projection.requested_model, "gpt-requested");
        assert!(!projection.reroute_emitted);
        assert!(!projection.verification_emitted);
        projection.needs_follow_up = true;
        assert!(projection.take_needs_follow_up());
        assert!(!projection.take_needs_follow_up());
    }
}
