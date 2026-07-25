use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tietiezhi_agent_events::{EventEnvelope, EventSequencer};
use tietiezhi_agent_state::RolloutAppender;

/// Events streamed to the frontend over the tauri IPC channel. Tag values are
/// camelCase, which keeps the original lowercase `delta`/`done`/`error`
/// spelling intact for existing consumers (dictation polish).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChatEvent {
    Started {
        model: String,
    },
    Delta {
        content: String,
    },
    /// A chunk of the model's reasoning / chain-of-thought. Rendered collapsed
    /// above the answer and kept out of the reply text and the transcript.
    Reasoning {
        content: String,
    },
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
        total_tokens: u64,
        /// Prompt tokens served from the provider's cache (0 when unknown or
        /// unsupported). Surfaced in the message details panel.
        cached_tokens: u64,
    },
    ToolCallStart {
        id: String,
        name: String,
        args: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
    ToolProgress {
        id: String,
        output: String,
        elapsed_ms: u64,
        truncated: bool,
    },
    ToolResult {
        id: String,
        output: String,
        is_error: bool,
        duration_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        timed_out: bool,
        cancelled: bool,
        truncated: bool,
    },
    PermissionRequest {
        id: String,
        tool: String,
        description: String,
        scope: String,
        args: Value,
    },
    Retrying {
        attempt: u8,
        max_retries: u8,
        delay_ms: u64,
        reason: String,
    },
    ContextCompactionStarted {
        automatic: bool,
        estimated_tokens: u64,
        context_window: u64,
    },
    ContextCompacted {
        automatic: bool,
        during_turn: bool,
        summary: String,
        estimated_tokens_before: u64,
        estimated_tokens_after: u64,
        context_window: u64,
    },
    ContextUsage {
        estimated_tokens: u64,
        context_window: u64,
        compact_at_tokens: u64,
    },
    Done {
        cancelled: bool,
    },
    Error {
        message: String,
        detail: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        retryable: bool,
        retries: u8,
    },
}

pub type ScopedChatEvent = EventEnvelope<ChatEvent>;

#[derive(Debug)]
struct AdapterState {
    sequencer: EventSequencer,
    turn_item_id: String,
    agent_message_item_id: Option<String>,
    reasoning_item_id: Option<String>,
    context_item_id: Option<String>,
    current_tool_item_id: Option<String>,
}

impl AdapterState {
    fn new(thread_id: String) -> Result<Self, String> {
        let turn_id = format!("turn_{}", uuid::Uuid::new_v4());
        let sequencer =
            EventSequencer::new(thread_id, turn_id).map_err(|error| error.to_string())?;
        Ok(Self {
            sequencer,
            turn_item_id: new_item_id(),
            agent_message_item_id: None,
            reasoning_item_id: None,
            context_item_id: None,
            current_tool_item_id: None,
        })
    }

    fn item_id_for(&mut self, event: &ChatEvent) -> String {
        match event {
            ChatEvent::Delta { .. } => self
                .agent_message_item_id
                .get_or_insert_with(new_item_id)
                .clone(),
            ChatEvent::Reasoning { .. } => self
                .reasoning_item_id
                .get_or_insert_with(new_item_id)
                .clone(),
            ChatEvent::Usage { .. } => self
                .agent_message_item_id
                .clone()
                .unwrap_or_else(|| self.turn_item_id.clone()),
            ChatEvent::ToolCallStart { id, .. } => {
                self.current_tool_item_id = Some(id.clone());
                id.clone()
            }
            ChatEvent::ToolProgress { id, .. } | ChatEvent::ToolResult { id, .. } => id.clone(),
            ChatEvent::PermissionRequest { id, .. } => self
                .current_tool_item_id
                .clone()
                .unwrap_or_else(|| id.clone()),
            ChatEvent::ContextCompactionStarted { .. }
            | ChatEvent::ContextCompacted { .. }
            | ChatEvent::ContextUsage { .. } => {
                self.context_item_id.get_or_insert_with(new_item_id).clone()
            }
            ChatEvent::Started { .. }
            | ChatEvent::Retrying { .. }
            | ChatEvent::Done { .. }
            | ChatEvent::Error { .. } => self.turn_item_id.clone(),
        }
    }

    fn wrap(&mut self, event: ChatEvent) -> ScopedChatEvent {
        let item_id = self.item_id_for(&event);
        let clear_tool = matches!(&event, ChatEvent::ToolResult { id, .. }
            if self.current_tool_item_id.as_deref() == Some(id.as_str()));
        let clear_context = matches!(&event, ChatEvent::ContextCompacted { .. });
        let envelope = self
            .sequencer
            .wrap(item_id, event)
            .expect("adapter always creates a non-empty item id");
        if clear_tool {
            self.current_tool_item_id = None;
        }
        if clear_context {
            self.context_item_id = None;
        }
        envelope
    }
}

fn new_item_id() -> String {
    format!("item_{}", uuid::Uuid::new_v4())
}

/// Migration adapter from the legacy flat event payload to the Codex
/// Thread/Turn/Item event identity required by the new timeline.
#[derive(Clone)]
pub struct ChatEventEmitter {
    channel: Channel<ScopedChatEvent>,
    state: Arc<Mutex<AdapterState>>,
    rollout: Option<RolloutAppender>,
}

impl ChatEventEmitter {
    pub fn new(channel: Channel<ScopedChatEvent>, thread_id: String) -> Result<Self, String> {
        Self::build(channel, thread_id, None)
    }

    pub fn with_rollout(
        channel: Channel<ScopedChatEvent>,
        thread_id: String,
        rollout: RolloutAppender,
    ) -> Result<Self, String> {
        Self::build(channel, thread_id, Some(rollout))
    }

    fn build(
        channel: Channel<ScopedChatEvent>,
        thread_id: String,
        rollout: Option<RolloutAppender>,
    ) -> Result<Self, String> {
        Ok(Self {
            channel,
            state: Arc::new(Mutex::new(AdapterState::new(thread_id)?)),
            rollout,
        })
    }

    pub fn send(&self, event: ChatEvent) -> tauri::Result<()> {
        let event = self.state.lock().unwrap().wrap(event);
        if let Some(rollout) = &self.rollout {
            let terminal = matches!(
                &event.payload,
                ChatEvent::Done { .. } | ChatEvent::Error { .. }
            );
            let value = serde_json::to_value(&event).map_err(persistence_error)?;
            rollout.append_event(value).map_err(persistence_error)?;
            if terminal {
                rollout.sync_data().map_err(persistence_error)?;
            }
        }
        self.channel.send(event)
    }
}

fn persistence_error(error: impl std::fmt::Display) -> tauri::Error {
    tauri::Error::Io(std::io::Error::other(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_tags_unchanged() {
        let v = serde_json::to_value(ChatEvent::Delta {
            content: "x".into(),
        })
        .unwrap();
        assert_eq!(v, json!({"type":"delta","content":"x"}));
        let v = serde_json::to_value(ChatEvent::Done { cancelled: false }).unwrap();
        assert_eq!(v, json!({"type":"done","cancelled":false}));
    }

    #[test]
    fn new_tags_are_camel_case() {
        let v = serde_json::to_value(ChatEvent::Usage {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
            cached_tokens: 4,
        })
        .unwrap();
        assert_eq!(
            v,
            json!({"type":"usage","promptTokens":12,"completionTokens":8,"totalTokens":20,"cachedTokens":4})
        );

        let v = serde_json::to_value(ChatEvent::ToolResult {
            id: "1".into(),
            output: "ok".into(),
            is_error: false,
            duration_ms: 42,
            exit_code: Some(0),
            timed_out: false,
            cancelled: false,
            truncated: false,
        })
        .unwrap();
        assert_eq!(
            v,
            json!({
                "type":"toolResult",
                "id":"1",
                "output":"ok",
                "isError":false,
                "durationMs":42,
                "exitCode":0,
                "timedOut":false,
                "cancelled":false,
                "truncated":false
            })
        );

        let v = serde_json::to_value(ChatEvent::Retrying {
            attempt: 2,
            max_retries: 5,
            delay_ms: 1_600,
            reason: "服务暂时不可用（503）".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            json!({
                "type":"retrying",
                "attempt":2,
                "maxRetries":5,
                "delayMs":1600,
                "reason":"服务暂时不可用（503）"
            })
        );

        let v = serde_json::to_value(ChatEvent::ContextCompacted {
            automatic: true,
            during_turn: false,
            summary: "summary".into(),
            estimated_tokens_before: 210_000,
            estimated_tokens_after: 4_000,
            context_window: 262_144,
        })
        .unwrap();
        assert_eq!(v["type"], "contextCompacted");
        assert_eq!(v["estimatedTokensBefore"], 210_000);
        assert_eq!(v["duringTurn"], false);
    }

    #[test]
    fn migration_adapter_assigns_stable_item_ids_and_monotonic_sequence() {
        let mut adapter = AdapterState::new("thread-1".into()).unwrap();
        let first = adapter.wrap(ChatEvent::Delta {
            content: "a".into(),
        });
        let second = adapter.wrap(ChatEvent::Delta {
            content: "b".into(),
        });
        let tool_start = adapter.wrap(ChatEvent::ToolCallStart {
            id: "call-1".into(),
            name: "bash".into(),
            args: json!({"command":"pwd"}),
            timeout_ms: None,
        });
        let tool_result = adapter.wrap(ChatEvent::ToolResult {
            id: "call-1".into(),
            output: "ok".into(),
            is_error: false,
            duration_ms: 1,
            exit_code: Some(0),
            timed_out: false,
            cancelled: false,
            truncated: false,
        });

        assert_eq!(first.thread_id, "thread-1");
        assert!(!first.turn_id.is_empty());
        assert_eq!(first.item_id, second.item_id);
        assert_eq!(second.sequence, first.sequence + 1);
        assert_eq!(tool_start.item_id, "call-1");
        assert_eq!(tool_result.item_id, "call-1");
    }
}
