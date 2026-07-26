use std::collections::{HashMap, HashSet, VecDeque};
use std::process::{Command, Stdio};

use uuid::Uuid;

use super::model::{AutomationDocument, AutomationValidationIssue, ValueBinding};

const TRIGGER_TYPES: &[&str] = &["manualTrigger", "scheduleTrigger"];
const BUILTIN_TYPES: &[&str] = &[
    "manualTrigger",
    "scheduleTrigger",
    "model",
    "agent",
    "skill",
    "mcpTool",
    "builtinTool",
    "code",
    "condition",
    "merge",
    "approval",
    "output",
];

pub fn validate(document: &AutomationDocument, publish: bool) -> Vec<AutomationValidationIssue> {
    let mut issues = Vec::new();

    if document.schema_version != 1 {
        issues.push(issue("schema_version", "仅支持 Automation schemaVersion 1"));
    }
    if Uuid::parse_str(&document.id).is_err() {
        issues.push(issue("invalid_id", "Automation ID 必须是有效 UUID"));
    }
    if document.name.trim().is_empty() || document.name.chars().count() > 80 {
        issues.push(issue("invalid_name", "名称不能为空且不能超过 80 个字符"));
    }
    if document.description.chars().count() > 500 {
        issues.push(issue("invalid_description", "描述不能超过 500 个字符"));
    }
    if document.settings.timezone.trim().is_empty() {
        issues.push(issue("invalid_timezone", "时区不能为空"));
    }
    if !(1_000..=86_400_000).contains(&document.settings.max_duration_ms) {
        issues.push(issue(
            "invalid_max_duration",
            "最大执行时间必须在 1 秒到 24 小时之间",
        ));
    }
    if !(1..=64).contains(&document.settings.max_concurrency) {
        issues.push(issue(
            "invalid_concurrency",
            "最大并发数必须在 1 到 64 之间",
        ));
    }
    if let Some(project_root) = document
        .settings
        .project_root
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let path = std::path::Path::new(project_root);
        if !path.is_absolute() || !path.is_dir() {
            issues.push(issue(
                "invalid_project_root",
                "项目目录必须是已存在的绝对目录",
            ));
        } else if publish && !is_git_work_tree(path) {
            issues.push(issue(
                "project_root_not_git",
                "发布到项目目录的 Automation 必须指向 Git 仓库根目录或其工作目录",
            ));
        }
    }

    let mut node_ids = HashSet::new();
    for node in &document.nodes {
        if node.id.trim().is_empty() || !node_ids.insert(node.id.as_str()) {
            issues.push(node_issue(
                "duplicate_node_id",
                "节点 ID 不能为空且不能重复",
                &node.id,
            ));
        }
        if node.name.trim().is_empty() || node.name.chars().count() > 80 {
            issues.push(node_issue(
                "invalid_node_name",
                "节点名称不能为空且不能超过 80 个字符",
                &node.id,
            ));
        }
        if node.type_version == 0 {
            issues.push(node_issue(
                "invalid_node_version",
                "节点类型版本必须大于 0",
                &node.id,
            ));
        }
        if !BUILTIN_TYPES.contains(&node.kind.as_str()) && !node.kind.starts_with("custom.") {
            issues.push(node_issue(
                "unknown_node_type",
                "节点类型不存在或尚未安装",
                &node.id,
            ));
        }
        if !node.config.is_object() {
            issues.push(node_issue(
                "invalid_node_config",
                "节点配置必须是 JSON 对象",
                &node.id,
            ));
        }
        if !node.position.x.is_finite() || !node.position.y.is_finite() {
            issues.push(node_issue(
                "invalid_position",
                "节点位置必须是有限数字",
                &node.id,
            ));
        }
        for binding in node.inputs.values() {
            if let ValueBinding::NodeOutput { node_id, .. } = binding {
                if node_id == &node.id {
                    issues.push(node_issue(
                        "self_binding",
                        "节点输入不能引用自身输出",
                        &node.id,
                    ));
                } else if !document
                    .nodes
                    .iter()
                    .any(|candidate| &candidate.id == node_id)
                {
                    issues.push(node_issue(
                        "missing_binding_node",
                        "节点输入引用了不存在的上游节点",
                        &node.id,
                    ));
                }
            }
        }
    }

    let mut edge_ids = HashSet::new();
    for edge in &document.edges {
        if edge.id.trim().is_empty() || !edge_ids.insert(edge.id.as_str()) {
            issues.push(edge_issue(
                "duplicate_edge_id",
                "连线 ID 不能为空且不能重复",
                &edge.id,
            ));
        }
        if edge.source_node_id == edge.target_node_id {
            issues.push(edge_issue("self_edge", "节点不能连接到自身", &edge.id));
        }
        if !node_ids.contains(edge.source_node_id.as_str())
            || !node_ids.contains(edge.target_node_id.as_str())
        {
            issues.push(edge_issue(
                "dangling_edge",
                "连线引用了不存在的节点",
                &edge.id,
            ));
        }
        if edge.source_port.trim().is_empty() || edge.target_port.trim().is_empty() {
            issues.push(edge_issue(
                "invalid_edge_port",
                "连线端口不能为空",
                &edge.id,
            ));
        }
    }

    if has_cycle(document) {
        issues.push(issue("cycle", "工作流不能包含任意图环"));
    }

    if publish {
        let triggers = document
            .nodes
            .iter()
            .filter(|node| !node.disabled && TRIGGER_TYPES.contains(&node.kind.as_str()))
            .count();
        if triggers != 1 {
            issues.push(issue(
                "trigger_count",
                "发布版本必须且只能包含一个启用的触发器",
            ));
        }
        if !document
            .nodes
            .iter()
            .any(|node| !node.disabled && node.kind == "output")
        {
            issues.push(issue("missing_output", "发布版本至少需要一个输出节点"));
        }
        for node in document
            .nodes
            .iter()
            .filter(|node| !node.disabled && node.kind == "approval")
        {
            issues.push(node_issue(
                "interactive_approval_forbidden",
                "无人值守 Automation 不能包含人工审批节点；需要审批的工具会在 approvalPolicy=never 下失败",
                &node.id,
            ));
        }
        for node in document
            .nodes
            .iter()
            .filter(|node| !node.disabled && node.kind == "scheduleTrigger")
        {
            if node
                .config
                .get("cron")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|value| value.trim().is_empty())
            {
                issues.push(node_issue(
                    "missing_cron",
                    "定时触发器必须配置 Cron 表达式",
                    &node.id,
                ));
            }
        }
    }

    issues
}

fn is_git_work_tree(path: &std::path::Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true"
        })
}

fn has_cycle(document: &AutomationDocument) -> bool {
    let mut indegree: HashMap<&str, usize> = document
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), 0))
        .collect();
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();

    for edge in &document.edges {
        if !indegree.contains_key(edge.source_node_id.as_str()) {
            continue;
        }
        let Some(target) = indegree.get_mut(edge.target_node_id.as_str()) else {
            continue;
        };
        *target += 1;
        outgoing
            .entry(edge.source_node_id.as_str())
            .or_default()
            .push(edge.target_node_id.as_str());
    }

    let mut queue: VecDeque<&str> = indegree
        .iter()
        .filter_map(|(id, degree)| (*degree == 0).then_some(*id))
        .collect();
    let mut visited = 0;
    while let Some(id) = queue.pop_front() {
        visited += 1;
        for target in outgoing.get(id).into_iter().flatten() {
            if let Some(degree) = indegree.get_mut(target) {
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(target);
                }
            }
        }
    }
    visited != document.nodes.len()
}

fn issue(code: &str, message: &str) -> AutomationValidationIssue {
    AutomationValidationIssue {
        code: code.into(),
        message: message.into(),
        node_id: None,
        edge_id: None,
    }
}

fn node_issue(code: &str, message: &str, node_id: &str) -> AutomationValidationIssue {
    AutomationValidationIssue {
        code: code.into(),
        message: message.into(),
        node_id: Some(node_id.into()),
        edge_id: None,
    }
}

fn edge_issue(code: &str, message: &str, edge_id: &str) -> AutomationValidationIssue {
    AutomationValidationIssue {
        code: code.into(),
        message: message.into(),
        node_id: None,
        edge_id: Some(edge_id.into()),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::*;
    use crate::automation::model::{
        AutomationEdge, AutomationNode, AutomationPosition, AutomationSettings,
        MissedSchedulePolicy,
    };

    fn node(id: &str, kind: &str) -> AutomationNode {
        AutomationNode {
            id: id.into(),
            kind: kind.into(),
            type_version: 1,
            name: id.into(),
            position: AutomationPosition { x: 0.0, y: 0.0 },
            disabled: false,
            config: json!({}),
            inputs: BTreeMap::new(),
        }
    }

    fn edge(id: &str, source: &str, target: &str) -> AutomationEdge {
        AutomationEdge {
            id: id.into(),
            source_node_id: source.into(),
            source_port: "output".into(),
            target_node_id: target.into(),
            target_port: "input".into(),
        }
    }

    fn document() -> AutomationDocument {
        AutomationDocument {
            schema_version: 1,
            id: Uuid::new_v4().to_string(),
            name: "测试流程".into(),
            description: String::new(),
            revision: 0,
            nodes: vec![node("trigger", "manualTrigger"), node("output", "output")],
            edges: vec![edge("edge", "trigger", "output")],
            settings: AutomationSettings {
                timezone: "Asia/Shanghai".into(),
                max_duration_ms: 300_000,
                max_concurrency: 4,
                on_missed_schedule: MissedSchedulePolicy::Skip,
                project_root: None,
            },
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn valid_publishable_document_has_no_issues() {
        assert!(validate(&document(), true).is_empty());
    }

    #[test]
    fn draft_can_be_incomplete_but_publish_cannot() {
        let mut value = document();
        value.nodes.retain(|node| node.kind != "output");
        value.edges.clear();
        assert!(validate(&value, false).is_empty());
        assert!(validate(&value, true)
            .iter()
            .any(|issue| issue.code == "missing_output"));
    }

    #[test]
    fn cycle_is_rejected() {
        let mut value = document();
        value.edges.push(edge("back", "output", "trigger"));
        assert!(validate(&value, false)
            .iter()
            .any(|issue| issue.code == "cycle"));
    }

    #[test]
    fn duplicate_and_dangling_ids_are_rejected() {
        let mut value = document();
        value.nodes.push(node("output", "agent"));
        value.edges.push(edge("missing", "ghost", "output"));
        let issues = validate(&value, false);
        assert!(issues.iter().any(|issue| issue.code == "duplicate_node_id"));
        assert!(issues.iter().any(|issue| issue.code == "dangling_edge"));
    }

    #[test]
    fn node_config_must_be_an_object() {
        let mut value = document();
        value.nodes[0].config = json!(["not", "an", "object"]);
        assert!(validate(&value, false)
            .iter()
            .any(|issue| issue.code == "invalid_node_config"));
    }

    #[test]
    fn publish_requires_git_when_project_root_is_set() {
        let directory = tempfile::tempdir().unwrap();
        let mut value = document();
        value.settings.project_root = Some(directory.path().to_string_lossy().into_owned());
        assert!(validate(&value, true)
            .iter()
            .any(|issue| issue.code == "project_root_not_git"));

        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(directory.path())
            .status()
            .unwrap();
        assert!(!validate(&value, true)
            .iter()
            .any(|issue| issue.code == "project_root_not_git"));
    }
}
