//! Codex-compatible model history, compaction, token-budget, and world-state primitives.
//!
//! The behavior in this crate is a source-level adaptation of the pinned
//! OpenAI Codex `rust-v0.145.0` implementation. It neither invokes nor embeds
//! the upstream executable.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

pub const SUMMARIZATION_PROMPT: &str = include_str!("../prompts/compact.md");
pub const SUMMARY_PREFIX: &str = include_str!("../prompts/summary-prefix.md");
pub const COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000;
const APPROX_BYTES_PER_TOKEN: usize = 4;

#[derive(Debug, Clone, PartialEq)]
pub enum ContextRecord {
    SessionMeta(Value),
    ResponseItem(Value),
    Compacted(Value),
    WorldState(Value),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextReconstruction {
    pub history: Vec<Value>,
    pub world_state_baseline: Option<Value>,
    pub window: CompactWindow,
    pub active_context_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompactWindow {
    pub window_number: u64,
    pub first_window_id: Uuid,
    pub previous_window_id: Option<Uuid>,
    pub window_id: Uuid,
    pub prefill_input_tokens: Option<i64>,
}

impl Default for CompactWindow {
    fn default() -> Self {
        Self::new()
    }
}

impl CompactWindow {
    pub fn new() -> Self {
        let window_id = Uuid::now_v7();
        Self {
            window_number: 0,
            first_window_id: window_id,
            previous_window_id: None,
            window_id,
            prefill_input_tokens: None,
        }
    }

    pub fn advance(&mut self) {
        self.window_number = self.window_number.saturating_add(1);
        self.previous_window_id = Some(self.window_id);
        self.window_id = Uuid::now_v7();
        self.prefill_input_tokens = None;
    }

    pub fn ensure_server_prefill(&mut self, input_tokens: i64) {
        if self.prefill_input_tokens.is_none() {
            self.prefill_input_tokens = Some(input_tokens.max(0));
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompactionResult {
    pub message: String,
    pub replacement_history: Vec<Value>,
    pub compacted_item: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextWindowStatus {
    pub active_context_tokens: i64,
    pub auto_compact_token_limit: Option<i64>,
    pub full_context_window_limit: Option<i64>,
    pub tokens_remaining: Option<i64>,
    pub token_limit_reached: bool,
}

pub fn model_context_window(model: &str) -> Option<i64> {
    const PINNED_MODELS: &[&str] = &[
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.2",
        "codex-auto-review",
    ];
    PINNED_MODELS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(model))
        .then_some(272_000)
}

pub fn context_window_status(
    active_context_tokens: i64,
    context_window: Option<i64>,
    configured_auto_compact_limit: Option<i64>,
) -> ContextWindowStatus {
    let active_context_tokens = active_context_tokens.max(0);
    let derived_limit = context_window.map(|window| window.saturating_mul(9) / 10);
    let auto_compact_token_limit = match (configured_auto_compact_limit, derived_limit) {
        (Some(configured), Some(derived)) => Some(configured.min(derived)),
        (Some(configured), None) => Some(configured),
        (None, derived) => derived,
    };
    let tokens_remaining = [auto_compact_token_limit, context_window]
        .into_iter()
        .flatten()
        .map(|limit| limit.saturating_sub(active_context_tokens).max(0))
        .min();
    let token_limit_reached = auto_compact_token_limit
        .is_some_and(|limit| active_context_tokens >= limit)
        || context_window.is_some_and(|limit| active_context_tokens >= limit);
    ContextWindowStatus {
        active_context_tokens,
        auto_compact_token_limit,
        full_context_window_limit: context_window,
        tokens_remaining,
        token_limit_reached,
    }
}

pub fn compaction_prompt_history(history: &[Value]) -> Vec<Value> {
    let mut input = history.to_vec();
    input.push(user_text_item(SUMMARIZATION_PROMPT.trim_end()));
    input
}

pub fn complete_compaction(
    history: &[Value],
    summary_suffix: &str,
    window: &mut CompactWindow,
) -> CompactionResult {
    let summary_text = format!("{}\n{}", SUMMARY_PREFIX.trim_end(), summary_suffix);
    let replacement_history = build_compacted_history(history, &summary_text);
    window.advance();
    let compacted_item = json!({
        "message": summary_text,
        "replacement_history": replacement_history,
        "window_number": window.window_number,
        "first_window_id": window.first_window_id.to_string(),
        "previous_window_id": window.previous_window_id.map(|id| id.to_string()),
        "window_id": window.window_id.to_string()
    });
    CompactionResult {
        message: compacted_item["message"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        replacement_history,
        compacted_item,
    }
}

pub fn reconstruct(records: impl IntoIterator<Item = ContextRecord>) -> ContextReconstruction {
    let mut history = Vec::new();
    let mut world_state_baseline = None;
    let mut window = CompactWindow::new();
    for record in records {
        match record {
            ContextRecord::SessionMeta(meta) => {
                if window.window_number == 0
                    && let Some(id) = meta
                        .pointer("/context_window/window_id")
                        .or_else(|| meta.pointer("/contextWindow/windowId"))
                        .and_then(Value::as_str)
                        .and_then(|id| Uuid::parse_str(id).ok())
                        .filter(|id| id.get_version_num() == 7)
                {
                    window.first_window_id = id;
                    window.previous_window_id = None;
                    window.window_id = id;
                }
            }
            ContextRecord::ResponseItem(item) => history.push(item),
            ContextRecord::Compacted(compacted) => {
                history = compacted
                    .get("replacement_history")
                    .or_else(|| compacted.get("replacementHistory"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| {
                        let message = compacted
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        build_compacted_history(&history, message)
                    });
                restore_window(&mut window, &compacted);
                world_state_baseline = None;
            }
            ContextRecord::WorldState(item) => {
                let full = item.get("full").and_then(Value::as_bool).unwrap_or(false);
                let state = item.get("state").cloned().unwrap_or(Value::Null);
                if full {
                    world_state_baseline = state.is_object().then_some(state);
                } else if let Some(baseline) = world_state_baseline.as_mut() {
                    apply_merge_patch(baseline, &state);
                }
            }
        }
    }
    let active_context_tokens = estimate_history_tokens(&history);
    ContextReconstruction {
        history,
        world_state_baseline,
        window,
        active_context_tokens,
    }
}

pub fn world_state_rollout(previous: Option<&Value>, current: &Value) -> Option<Value> {
    if !current.is_object() {
        return None;
    }
    match previous {
        None => Some(json!({"full": true, "state": current})),
        Some(previous) => create_merge_patch(previous, current)
            .map(|patch| json!({"full": false, "state": patch})),
    }
}

pub fn apply_world_state_rollout(baseline: &mut Option<Value>, item: &Value) {
    let full = item.get("full").and_then(Value::as_bool).unwrap_or(false);
    let state = item.get("state").cloned().unwrap_or(Value::Null);
    if full {
        *baseline = state.is_object().then_some(state);
    } else if let Some(baseline) = baseline {
        apply_merge_patch(baseline, &state);
    }
}

pub fn build_compacted_history(history: &[Value], summary_text: &str) -> Vec<Value> {
    build_compacted_history_with_limit(history, summary_text, COMPACT_USER_MESSAGE_MAX_TOKENS)
}

pub fn estimate_history_tokens(history: &[Value]) -> i64 {
    history
        .iter()
        .map(|item| {
            serde_json::to_string(item)
                .map(|text| approx_token_count(&text))
                .unwrap_or(0)
        })
        .fold(0usize, usize::saturating_add)
        .try_into()
        .unwrap_or(i64::MAX)
}

pub fn approx_token_count(text: &str) -> usize {
    text.len()
        .saturating_add(APPROX_BYTES_PER_TOKEN.saturating_sub(1))
        / APPROX_BYTES_PER_TOKEN
}

pub fn truncate_middle_with_token_budget(text: &str, max_tokens: usize) -> String {
    if text.is_empty() {
        return String::new();
    }
    let max_bytes = max_tokens.saturating_mul(APPROX_BYTES_PER_TOKEN);
    if max_tokens > 0 && text.len() <= max_bytes {
        return text.to_owned();
    }
    if max_bytes == 0 {
        return format!("…{} tokens truncated…", approx_token_count(text));
    }
    let left_budget = max_bytes / 2;
    let right_budget = max_bytes - left_budget;
    let prefix_end = char_boundary_before(text, left_budget);
    let suffix_start = char_boundary_after(text, text.len().saturating_sub(right_budget));
    let removed = text
        .len()
        .saturating_sub(prefix_end + text.len().saturating_sub(suffix_start));
    format!(
        "{}…{} tokens truncated…{}",
        &text[..prefix_end],
        removed.saturating_add(3) / 4,
        &text[suffix_start..]
    )
}

fn build_compacted_history_with_limit(
    history: &[Value],
    summary_text: &str,
    max_tokens: usize,
) -> Vec<Value> {
    let user_messages = collect_user_messages(history);
    let mut selected = Vec::new();
    let mut remaining = max_tokens;
    for (text, metadata) in user_messages.into_iter().rev() {
        if remaining == 0 {
            break;
        }
        let tokens = approx_token_count(&text);
        if tokens <= remaining {
            selected.push((text, metadata));
            remaining = remaining.saturating_sub(tokens);
        } else {
            selected.push((
                truncate_middle_with_token_budget(&text, remaining),
                metadata,
            ));
            break;
        }
    }
    selected.reverse();
    let mut compacted = selected
        .into_iter()
        .map(|(text, metadata)| {
            let mut item = user_text_item(&text);
            if let Some(metadata) = metadata {
                item["internal_chat_message_metadata_passthrough"] = metadata;
            }
            item
        })
        .collect::<Vec<_>>();
    compacted.push(user_text_item(if summary_text.is_empty() {
        "(no summary available)"
    } else {
        summary_text
    }));
    compacted
}

fn collect_user_messages(history: &[Value]) -> Vec<(String, Option<Value>)> {
    history
        .iter()
        .filter(|item| {
            item.get("type").and_then(Value::as_str) == Some("message")
                && item.get("role").and_then(Value::as_str) == Some("user")
        })
        .filter_map(|item| {
            let text = content_text(item.get("content")?)?;
            (!is_summary_message(&text)).then(|| {
                (
                    text,
                    item.get("internal_chat_message_metadata_passthrough")
                        .filter(|value| !value.is_null())
                        .cloned(),
                )
            })
        })
        .collect()
}

fn is_summary_message(message: &str) -> bool {
    message.starts_with(SUMMARY_PREFIX.trim_end())
}

fn content_text(content: &Value) -> Option<String> {
    let pieces = content
        .as_array()?
        .iter()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("input_text" | "output_text" | "text")
            )
        })
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    (!pieces.is_empty()).then(|| pieces.join("\n"))
}

fn user_text_item(text: &str) -> Value {
    json!({
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": text}]
    })
}

fn restore_window(window: &mut CompactWindow, item: &Value) {
    let value = |snake: &str, camel: &str| item.get(snake).or_else(|| item.get(camel));
    let Some(number) = value("window_number", "windowNumber").and_then(Value::as_u64) else {
        return;
    };
    let Some(first) = value("first_window_id", "firstWindowId")
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok())
        .filter(|id| id.get_version_num() == 7)
    else {
        return;
    };
    let Some(current) = value("window_id", "windowId")
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok())
        .filter(|id| id.get_version_num() == 7)
    else {
        return;
    };
    window.window_number = number;
    window.first_window_id = first;
    window.previous_window_id = value("previous_window_id", "previousWindowId")
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok())
        .filter(|id| id.get_version_num() == 7);
    window.window_id = current;
    window.prefill_input_tokens = None;
}

fn create_merge_patch(previous: &Value, current: &Value) -> Option<Value> {
    if previous == current {
        return None;
    }
    let Value::Object(current) = current else {
        return Some(current.clone());
    };
    let previous = previous.as_object();
    let mut patch = Map::new();
    if let Some(previous) = previous {
        for key in previous.keys() {
            if !current.contains_key(key) {
                patch.insert(key.clone(), Value::Null);
            }
        }
    }
    for (key, current_value) in current {
        let Some(previous_value) = previous.and_then(|previous| previous.get(key)) else {
            patch.insert(key.clone(), current_value.clone());
            continue;
        };
        if let Some(value_patch) = create_merge_patch(previous_value, current_value) {
            patch.insert(key.clone(), value_patch);
        }
    }
    Some(Value::Object(patch))
}

fn apply_merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(patch) = patch else {
        target.clone_from(patch);
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    if let Value::Object(target) = target {
        for (key, value) in patch {
            if value.is_null() {
                target.remove(key);
            } else {
                apply_merge_patch(target.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
    }
}

fn char_boundary_before(text: &str, target: usize) -> usize {
    if target >= text.len() {
        return text.len();
    }
    let mut index = target;
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn char_boundary_after(text: &str, target: usize) -> usize {
    if target >= text.len() {
        return text.len();
    }
    let mut index = target;
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_history_keeps_recent_user_messages_and_summary_last() {
        let history = vec![
            user_text_item("old"),
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}),
            user_text_item("new"),
        ];
        let result = complete_compaction(&history, "handoff", &mut CompactWindow::new());
        assert_eq!(result.replacement_history.len(), 3);
        assert_eq!(
            result.replacement_history.last().unwrap()["content"][0]["text"],
            format!("{}\nhandoff", SUMMARY_PREFIX.trim_end())
        );
        assert_eq!(result.compacted_item["window_number"], 1);
    }

    #[test]
    fn compaction_limit_truncates_oldest_selected_message_in_the_middle() {
        let history = vec![user_text_item(&"x".repeat(100)), user_text_item("latest")];
        let compacted = build_compacted_history_with_limit(&history, "summary", 8);
        assert_eq!(compacted.len(), 3);
        assert!(
            compacted[0]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("tokens truncated")
        );
        assert_eq!(compacted[1]["content"][0]["text"], "latest");
    }

    #[test]
    fn reconstruction_uses_latest_replacement_and_later_items() {
        let replacement = vec![user_text_item("summary")];
        let reconstructed = reconstruct([
            ContextRecord::ResponseItem(user_text_item("discarded")),
            ContextRecord::Compacted(json!({
                "message":"summary",
                "replacement_history": replacement,
                "window_number":1,
                "first_window_id":"018f16f7-58ca-7f59-bb7f-6626b6630f6a",
                "previous_window_id":"018f16f7-58ca-7f59-bb7f-6626b6630f6a",
                "window_id":"018f16f7-58ca-7f59-bb7f-6626b6630f6b"
            })),
            ContextRecord::ResponseItem(user_text_item("later")),
        ]);
        assert_eq!(reconstructed.history.len(), 2);
        assert_eq!(reconstructed.history[0]["content"][0]["text"], "summary");
        assert_eq!(reconstructed.history[1]["content"][0]["text"], "later");
        assert_eq!(reconstructed.window.window_number, 1);
    }

    #[test]
    fn world_state_uses_rfc_7386_full_and_patch_records() {
        let first = json!({"environment":{"cwd":"/a","shell":"zsh"},"agents":{"text":"old"}});
        let second = json!({"environment":{"cwd":"/b","shell":"zsh"}});
        let full = world_state_rollout(None, &first).unwrap();
        let patch = world_state_rollout(Some(&first), &second).unwrap();
        assert_eq!(full, json!({"full":true,"state":first}));
        assert_eq!(
            patch,
            json!({"full":false,"state":{"environment":{"cwd":"/b"},"agents":null}})
        );
        let mut baseline = None;
        apply_world_state_rollout(&mut baseline, &full);
        apply_world_state_rollout(&mut baseline, &patch);
        assert_eq!(baseline, Some(second));
    }

    #[test]
    fn context_window_matches_codex_ninety_percent_threshold() {
        let status = context_window_status(244_800, Some(272_000), None);
        assert_eq!(status.auto_compact_token_limit, Some(244_800));
        assert_eq!(status.tokens_remaining, Some(0));
        assert!(status.token_limit_reached);
    }
}
