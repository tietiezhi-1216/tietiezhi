//! Runtime event identity and ordering primitives.
//!
//! Codex models observable work as Thread -> Turn -> Item. This crate keeps
//! those identifiers mandatory on every incremental event while remaining
//! independent from any transport such as Tauri IPC.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope<T> {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub sequence: u64,
    pub emitted_at_ms: u64,
    #[serde(flatten)]
    pub payload: T,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventIdentityError {
    field: &'static str,
}

impl EventIdentityError {
    fn empty(field: &'static str) -> Self {
        Self { field }
    }
}

impl fmt::Display for EventIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} must not be empty", self.field)
    }
}

impl std::error::Error for EventIdentityError {}

#[derive(Debug)]
pub struct EventSequencer {
    thread_id: String,
    turn_id: String,
    next_sequence: u64,
}

impl EventSequencer {
    pub fn new(
        thread_id: impl Into<String>,
        turn_id: impl Into<String>,
    ) -> Result<Self, EventIdentityError> {
        let thread_id = thread_id.into();
        let turn_id = turn_id.into();
        if thread_id.trim().is_empty() {
            return Err(EventIdentityError::empty("threadId"));
        }
        if turn_id.trim().is_empty() {
            return Err(EventIdentityError::empty("turnId"));
        }
        Ok(Self {
            thread_id,
            turn_id,
            next_sequence: 1,
        })
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }

    pub fn wrap<T>(
        &mut self,
        item_id: impl Into<String>,
        payload: T,
    ) -> Result<EventEnvelope<T>, EventIdentityError> {
        let item_id = item_id.into();
        if item_id.trim().is_empty() {
            return Err(EventIdentityError::empty("itemId"));
        }
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        Ok(EventEnvelope {
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            item_id,
            sequence,
            emitted_at_ms: now_ms(),
            payload,
        })
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "camelCase")]
    enum Payload {
        Delta { content: String },
    }

    #[test]
    fn every_event_has_nonempty_thread_turn_and_item_ids() {
        assert!(EventSequencer::new("", "turn-1").is_err());
        assert!(EventSequencer::new("thread-1", "").is_err());
        let mut events = EventSequencer::new("thread-1", "turn-1").unwrap();
        assert!(
            events
                .wrap(
                    "",
                    Payload::Delta {
                        content: "x".into()
                    }
                )
                .is_err()
        );
    }

    #[test]
    fn sequence_is_monotonic_and_payload_is_flattened() {
        let mut events = EventSequencer::new("thread-1", "turn-1").unwrap();
        let first = events
            .wrap(
                "item-1",
                Payload::Delta {
                    content: "a".into(),
                },
            )
            .unwrap();
        let second = events
            .wrap(
                "item-1",
                Payload::Delta {
                    content: "b".into(),
                },
            )
            .unwrap();
        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        let value = serde_json::to_value(first).unwrap();
        assert_eq!(value["threadId"], "thread-1");
        assert_eq!(value["turnId"], "turn-1");
        assert_eq!(value["itemId"], "item-1");
        assert_eq!(value["type"], "delta");
        assert_eq!(value["content"], "a");
    }
}
