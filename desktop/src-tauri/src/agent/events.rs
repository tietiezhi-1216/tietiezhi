use serde::Serialize;
use serde_json::Value;

/// Events streamed to the frontend over the tauri IPC channel. Tag values are
/// camelCase, which keeps the original lowercase `delta`/`done`/`error`
/// spelling intact for existing consumers (dictation polish).
#[derive(Debug, Clone, Serialize)]
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
            summary: "summary".into(),
            estimated_tokens_before: 210_000,
            estimated_tokens_after: 4_000,
            context_window: 262_144,
        })
        .unwrap();
        assert_eq!(v["type"], "contextCompacted");
        assert_eq!(v["estimatedTokensBefore"], 210_000);
    }
}
