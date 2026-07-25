//! Fault-injection and soak-test primitives for the source-level Codex Runtime.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FaultPoint {
    BeforeWrite,
    DuringWrite,
    BeforeSync,
    BeforeRename,
    TransportDisconnect,
    ToolTimeout,
    ProcessCancellation,
}

#[derive(Debug, Clone, Default)]
pub struct FaultInjector {
    armed: Arc<Mutex<BTreeSet<FaultPoint>>>,
}

impl FaultInjector {
    pub fn arm(&self, fault: FaultPoint) {
        self.armed
            .lock()
            .expect("fault injector lock poisoned")
            .insert(fault);
    }

    pub fn take(&self, fault: FaultPoint) -> bool {
        self.armed
            .lock()
            .expect("fault injector lock poisoned")
            .remove(&fault)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoakConfig {
    pub duration_seconds: u64,
    pub tool_calls_per_cycle: usize,
}

impl SoakConfig {
    pub fn from_environment() -> Self {
        Self {
            duration_seconds: std::env::var("TIETIEZHI_SOAK_SECONDS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(60)
                .max(1),
            tool_calls_per_cycle: std::env::var("TIETIEZHI_SOAK_TOOL_CALLS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(128)
                .max(1),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoakReport {
    pub elapsed_ms: u64,
    pub cycles: u64,
    pub tool_calls: u64,
    pub leaked_process_sessions: usize,
}

pub struct SoakTimer {
    started: Instant,
    deadline: Instant,
}

impl SoakTimer {
    pub fn new(duration: Duration) -> Self {
        let started = Instant::now();
        Self {
            started,
            deadline: started + duration,
        }
    }

    pub fn should_continue(&self) -> bool {
        Instant::now() < self.deadline
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fault_points_are_one_shot_and_deterministic() {
        let faults = FaultInjector::default();
        faults.arm(FaultPoint::BeforeRename);
        assert!(faults.take(FaultPoint::BeforeRename));
        assert!(!faults.take(FaultPoint::BeforeRename));
    }

    #[test]
    fn soak_config_has_safe_nonzero_defaults() {
        let config = SoakConfig::from_environment();
        assert!(config.duration_seconds > 0);
        assert!(config.tool_calls_per_cycle > 0);
    }
}
