use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDocument {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub revision: u32,
    pub nodes: Vec<AutomationNode>,
    pub edges: Vec<AutomationEdge>,
    pub settings: AutomationSettings,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationNode {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub type_version: u32,
    pub name: String,
    pub position: AutomationPosition,
    pub disabled: bool,
    pub config: Value,
    pub inputs: BTreeMap<String, ValueBinding>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AutomationPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationEdge {
    pub id: String,
    pub source_node_id: String,
    pub source_port: String,
    pub target_node_id: String,
    pub target_port: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ValueBinding {
    Literal {
        value: Value,
    },
    TriggerInput {
        path: String,
    },
    NodeOutput {
        node_id: String,
        path: String,
    },
    SecretRef {
        credential_id: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        key: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSettings {
    pub timezone: String,
    pub max_duration_ms: u64,
    pub max_concurrency: u32,
    pub on_missed_schedule: MissedSchedulePolicy,
    #[serde(default)]
    pub project_root: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MissedSchedulePolicy {
    Skip,
    RunLatest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub revision: u32,
    pub node_count: usize,
    pub trigger_type: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub archived_at: u64,
    #[serde(default)]
    pub published_revision: u32,
    #[serde(default = "default_paused")]
    pub paused: bool,
    #[serde(default)]
    pub last_run_at: u64,
    #[serde(default)]
    pub next_run_at: u64,
    #[serde(default)]
    pub last_run_status: String,
}

fn default_paused() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub revision: u32,
    pub trigger: String,
    pub status: AutomationRunStatus,
    pub input: Value,
    pub thread_id: String,
    pub turn_id: String,
    pub workspace_path: String,
    pub started_at: u64,
    pub finished_at: u64,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutomationRunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationValidationIssue {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<String>,
}
