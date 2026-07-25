//! Codex-compatible project instruction discovery and world-state rendering.
//!
//! This is a source-level adaptation of OpenAI Codex `rust-v0.145.0`.
//! It neither invokes nor embeds the upstream executable.

use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const DEFAULT_AGENTS_MD_FILENAME: &str = "AGENTS.md";
pub const LOCAL_AGENTS_MD_FILENAME: &str = "AGENTS.override.md";
pub const DEFAULT_PROJECT_DOC_MAX_BYTES: usize = 32 * 1024;
pub const WORLD_STATE_METADATA_KEY: &str = "_tietiezhiWorldState";

const REPLACEMENT_NOTICE: &str =
    "These AGENTS.md instructions replace all previously provided AGENTS.md instructions.";
const REMOVAL_NOTICE: &str = "The previously provided AGENTS.md instructions no longer apply.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionConfig {
    pub max_bytes: usize,
    pub fallback_filenames: Vec<String>,
    pub project_root_markers: Vec<String>,
}

impl Default for ProjectInstructionConfig {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_PROJECT_DOC_MAX_BYTES,
            fallback_filenames: Vec::new(),
            project_root_markers: vec![".git".into()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionEntry {
    pub path: PathBuf,
    pub contents: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProjectInstructions {
    pub cwd: PathBuf,
    pub project_root: PathBuf,
    pub entries: Vec<ProjectInstructionEntry>,
}

impl LoadedProjectInstructions {
    pub fn text(&self) -> String {
        self.entries
            .iter()
            .map(|entry| entry.contents.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    pub fn rendered(&self) -> String {
        format!(
            "# AGENTS.md instructions for {}\n\n<INSTRUCTIONS>\n{}\n</INSTRUCTIONS>",
            self.cwd.display(),
            self.text()
        )
    }

    pub fn sources(&self) -> impl Iterator<Item = &Path> {
        self.entries.iter().map(|entry| entry.path.as_path())
    }
}

pub fn discover_project_root(cwd: &Path, project_root_markers: &[String]) -> io::Result<PathBuf> {
    let cwd = absolute_directory(cwd)?;
    if project_root_markers.is_empty() {
        return Ok(cwd);
    }
    for directory in cwd.ancestors() {
        if project_root_markers
            .iter()
            .filter(|marker| valid_local_filename(marker))
            .any(|marker| directory.join(marker).exists())
        {
            return Ok(directory.to_path_buf());
        }
    }
    Ok(cwd)
}

pub fn load_project_instructions(
    cwd: &Path,
    config: &ProjectInstructionConfig,
) -> io::Result<Option<LoadedProjectInstructions>> {
    let cwd = absolute_directory(cwd)?;
    let project_root = discover_project_root(&cwd, &config.project_root_markers)?;
    if config.max_bytes == 0 {
        return Ok(None);
    }
    let candidates = candidate_filenames(config);
    let mut directories = Vec::new();
    let mut cursor = cwd.as_path();
    loop {
        directories.push(cursor.to_path_buf());
        if cursor == project_root {
            break;
        }
        let Some(parent) = cursor.parent() else {
            break;
        };
        cursor = parent;
    }
    directories.reverse();

    let mut remaining = config.max_bytes;
    let mut entries = Vec::new();
    for directory in directories {
        if remaining == 0 {
            break;
        }
        let path = candidates
            .iter()
            .map(|name| directory.join(name))
            .find(|path| fs::metadata(path).is_ok_and(|metadata| metadata.is_file()));
        let Some(path) = path else {
            continue;
        };
        let mut file = fs::File::open(&path)?;
        let mut data = Vec::new();
        file.by_ref()
            .take(u64::try_from(remaining).unwrap_or(u64::MAX))
            .read_to_end(&mut data)?;
        remaining = remaining.saturating_sub(data.len());
        let contents = String::from_utf8_lossy(&data).into_owned();
        if !contents.trim().is_empty() {
            entries.push(ProjectInstructionEntry { path, contents });
        }
    }
    Ok((!entries.is_empty()).then_some(LoadedProjectInstructions {
        cwd,
        project_root,
        entries,
    }))
}

fn absolute_directory(path: &Path) -> io::Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let metadata = fs::metadata(&path)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("project cwd is not a directory: {}", path.display()),
        ));
    }
    Ok(path)
}

fn candidate_filenames(config: &ProjectInstructionConfig) -> Vec<&str> {
    let mut names = vec![LOCAL_AGENTS_MD_FILENAME, DEFAULT_AGENTS_MD_FILENAME];
    for name in &config.fallback_filenames {
        if valid_local_filename(name) && !names.contains(&name.as_str()) {
            names.push(name);
        }
    }
    names
}

fn valid_local_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\'])
        && Path::new(name).components().count() == 1
        && matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        )
}

#[derive(Debug, Clone)]
pub struct WorldStateInput {
    pub cwd: PathBuf,
    pub shell: Option<String>,
    pub current_date: String,
    pub timezone: String,
    pub approval_policy: Value,
    pub sandbox_policy: Value,
    pub tool_names: Vec<String>,
    pub collaboration_mode: String,
    pub collaboration_mode_instructions: Option<String>,
    pub developer_instructions: Option<String>,
    pub project_instructions: Option<LoadedProjectInstructions>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorldStateUpdate {
    pub snapshot: Value,
    pub response_items: Vec<Value>,
}

pub fn build_world_state(
    turn_id: &str,
    input: WorldStateInput,
    previous: Option<&Value>,
) -> WorldStateUpdate {
    let agents = input
        .project_instructions
        .as_ref()
        .map(|loaded| {
            json!({
                "directory":loaded.cwd,
                "text":loaded.text(),
                "sources":loaded.sources().map(|path| path.to_path_buf()).collect::<Vec<_>>()
            })
        })
        .unwrap_or_else(|| json!({"directory":null,"text":null,"sources":[]}));
    let mut tool_names = input.tool_names;
    tool_names.sort();
    tool_names.dedup();
    let snapshot = json!({
        "agents_md":agents,
        "developer_instructions":{"text":input.developer_instructions},
        "permissions":{
            "approvalPolicy":input.approval_policy,
            "sandboxPolicy":input.sandbox_policy
        },
        "environments":{
            "cwd":input.cwd,
            "shell":input.shell,
            "currentDate":input.current_date,
            "timezone":input.timezone
        },
        "tools":{"names":tool_names},
        "collaboration_mode":{
            "mode":input.collaboration_mode,
            "instructions":input.collaboration_mode_instructions
        }
    });
    let response_items = render_world_state_items(turn_id, &snapshot, previous);
    WorldStateUpdate {
        snapshot,
        response_items,
    }
}

pub fn render_world_state_items(
    turn_id: &str,
    current: &Value,
    previous: Option<&Value>,
) -> Vec<Value> {
    let mut developer = Vec::new();
    let mut user = Vec::new();
    render_agents_diff(
        previous.and_then(|value| value.get("agents_md")),
        current.get("agents_md"),
        &mut user,
    );
    render_developer_instructions_diff(
        previous.and_then(|value| value.pointer("/developer_instructions/text")),
        current.pointer("/developer_instructions/text"),
        &mut developer,
    );
    for (section, renderer) in [
        ("permissions", render_permissions as fn(&Value) -> String),
        ("tools", render_tools),
        ("collaboration_mode", render_collaboration_mode),
    ] {
        let current_section = current.get(section).unwrap_or(&Value::Null);
        if previous.and_then(|value| value.get(section)) != Some(current_section) {
            developer.push(renderer(current_section));
        }
    }
    let environment = current.get("environments").unwrap_or(&Value::Null);
    if previous.and_then(|value| value.get("environments")) != Some(environment) {
        user.push(render_environment(environment));
    }
    [
        message_item(turn_id, "developer", developer),
        message_item(turn_id, "user", user),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn render_agents_diff(previous: Option<&Value>, current: Option<&Value>, output: &mut Vec<String>) {
    let previous_text = previous
        .and_then(|value| value.get("text"))
        .and_then(Value::as_str);
    let current_text = current
        .and_then(|value| value.get("text"))
        .and_then(Value::as_str);
    if previous_text == current_text {
        return;
    }
    match current_text {
        Some(text) => {
            let directory = current
                .and_then(|value| value.get("directory"))
                .and_then(Value::as_str)
                .unwrap_or(".");
            let body = format!(
                "# AGENTS.md instructions for {directory}\n\n<INSTRUCTIONS>\n{text}\n</INSTRUCTIONS>"
            );
            output.push(if previous_text.is_some() {
                format!("{REPLACEMENT_NOTICE}\n\n{body}")
            } else {
                body
            });
        }
        None if previous_text.is_some() => output.push(REMOVAL_NOTICE.into()),
        None => {}
    }
}

fn render_developer_instructions_diff(
    previous: Option<&Value>,
    current: Option<&Value>,
    output: &mut Vec<String>,
) {
    let previous = previous
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let current = current
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if previous == current {
        return;
    }
    match current {
        Some(text) => output.push(format!(
            "<developer_instructions>\n{text}\n</developer_instructions>"
        )),
        None if previous.is_some() => output.push(
            "<developer_instructions>The previous developer instructions no longer apply.</developer_instructions>"
                .into(),
        ),
        None => {}
    }
}

fn render_permissions(value: &Value) -> String {
    format!(
        "<permissions_context>\n  <approval_policy>{}</approval_policy>\n  <sandbox_policy>{}</sandbox_policy>\n</permissions_context>",
        xml_escape(&value.get("approvalPolicy").cloned().unwrap_or(Value::Null).to_string()),
        xml_escape(&value.get("sandboxPolicy").cloned().unwrap_or(Value::Null).to_string())
    )
}

fn render_tools(value: &Value) -> String {
    let names = value
        .get("names")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(xml_escape)
        .collect::<Vec<_>>()
        .join("\n    ");
    format!("<available_tools>\n    {names}\n</available_tools>")
}

fn render_collaboration_mode(value: &Value) -> String {
    let mode = value
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let instructions = value
        .get("instructions")
        .and_then(Value::as_str)
        .unwrap_or_default();
    format!(
        "<collaboration_mode mode=\"{}\">\n{}\n</collaboration_mode>",
        xml_escape(mode),
        instructions
    )
}

fn render_environment(value: &Value) -> String {
    let value_text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(xml_escape)
            .unwrap_or_default()
    };
    format!(
        "<environment_context>\n  <cwd>{}</cwd>\n  <shell>{}</shell>\n  <current_date>{}</current_date>\n  <timezone>{}</timezone>\n</environment_context>",
        value_text("cwd"),
        value_text("shell"),
        value_text("currentDate"),
        value_text("timezone")
    )
}

fn message_item(turn_id: &str, role: &str, sections: Vec<String>) -> Option<Value> {
    (!sections.is_empty()).then(|| {
        let mut item = json!({
            "type":"message",
            "role":role,
            "content":sections.into_iter().map(|text| json!({
                "type":"input_text",
                "text":text
            })).collect::<Vec<_>>()
        });
        item.as_object_mut()
            .expect("message item is an object")
            .insert(WORLD_STATE_METADATA_KEY.into(), json!({"turnId":turn_id}));
        item
    })
}

/// Moves persisted world-state context immediately before the user message for
/// the same turn. Rollouts append context after accepting the turn so this
/// normalization restores the model-visible ordering used by Codex.
pub fn normalize_world_state_history(history: &mut Vec<Value>) {
    let mut cursor = 0;
    while cursor < history.len() {
        let Some(turn_id) = history[cursor]
            .get(WORLD_STATE_METADATA_KEY)
            .and_then(|metadata| metadata.get("turnId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            cursor += 1;
            continue;
        };

        let mut end = cursor + 1;
        while end < history.len()
            && history[end]
                .get(WORLD_STATE_METADATA_KEY)
                .and_then(|metadata| metadata.get("turnId"))
                .and_then(Value::as_str)
                == Some(turn_id.as_str())
        {
            end += 1;
        }

        if let Some(user_index) = (0..cursor).rev().find(|index| {
            history[*index].get("role").and_then(Value::as_str) == Some("user")
                && history[*index].get(WORLD_STATE_METADATA_KEY).is_none()
        }) {
            let items = history.drain(cursor..end).collect::<Vec<_>>();
            let count = items.len();
            history.splice(user_index..user_index, items);
            cursor = user_index + count + 1;
        } else {
            cursor = end;
        }
    }
}

pub fn strip_internal_world_state_metadata(history: &[Value]) -> Vec<Value> {
    history
        .iter()
        .cloned()
        .map(|mut item| {
            if let Some(object) = item.as_object_mut() {
                object.remove(WORLD_STATE_METADATA_KEY);
            }
            item
        })
        .collect()
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn discovery_walks_from_nearest_project_root_to_cwd() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        let nested = root.path().join("crates/app");
        fs::create_dir_all(&nested).unwrap();
        fs::write(root.path().join("AGENTS.md"), "root").unwrap();
        fs::write(root.path().join("crates/AGENTS.md"), "crates").unwrap();
        fs::write(nested.join("AGENTS.md"), "app").unwrap();
        let loaded = load_project_instructions(&nested, &ProjectInstructionConfig::default())
            .unwrap()
            .unwrap();
        assert_eq!(loaded.project_root, root.path());
        assert_eq!(loaded.text(), "root\n\ncrates\n\napp");
        assert_eq!(loaded.entries.len(), 3);
    }

    #[test]
    fn override_wins_per_directory_and_fallback_is_last() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join("AGENTS.md"), "base").unwrap();
        fs::write(root.path().join("AGENTS.override.md"), "override").unwrap();
        let nested = root.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("GUIDE.md"), "fallback").unwrap();
        let config = ProjectInstructionConfig {
            fallback_filenames: vec!["../escape".into(), r"..\escape".into(), "GUIDE.md".into()],
            ..ProjectInstructionConfig::default()
        };
        let loaded = load_project_instructions(&nested, &config)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.text(), "override\n\nfallback");
    }

    #[test]
    fn byte_budget_is_shared_and_invalid_utf8_is_lossy() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join("AGENTS.md"), b"abc\xff").unwrap();
        let nested = root.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("AGENTS.md"), "def").unwrap();
        let loaded = load_project_instructions(
            &nested,
            &ProjectInstructionConfig {
                max_bytes: 6,
                ..ProjectInstructionConfig::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(loaded.entries[0].contents, "abc�");
        assert_eq!(loaded.entries[1].contents, "de");
    }

    #[test]
    fn no_marker_and_empty_marker_list_consider_only_cwd() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("AGENTS.md"), "parent").unwrap();
        let nested = root.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("AGENTS.md"), "child").unwrap();
        let loaded = load_project_instructions(&nested, &ProjectInstructionConfig::default())
            .unwrap()
            .unwrap();
        assert_eq!(loaded.text(), "child");
        let loaded = load_project_instructions(
            &nested,
            &ProjectInstructionConfig {
                project_root_markers: Vec::new(),
                ..ProjectInstructionConfig::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(loaded.text(), "child");
    }

    #[test]
    fn world_state_initial_diff_replacement_and_removal_are_model_visible() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("AGENTS.md"), "first").unwrap();
        let loaded = load_project_instructions(
            root.path(),
            &ProjectInstructionConfig {
                project_root_markers: Vec::new(),
                ..ProjectInstructionConfig::default()
            },
        )
        .unwrap();
        let initial = build_world_state(
            "turn-1",
            WorldStateInput {
                cwd: root.path().into(),
                shell: Some("/bin/zsh".into()),
                current_date: "2026-07-25".into(),
                timezone: "Asia/Shanghai".into(),
                approval_policy: json!("on-request"),
                sandbox_policy: json!({"type":"workspaceWrite"}),
                tool_names: vec!["exec_command".into(), "exec_command".into()],
                collaboration_mode: "default".into(),
                collaboration_mode_instructions: None,
                developer_instructions: Some("developer".into()),
                project_instructions: loaded,
            },
            None,
        );
        assert_eq!(initial.response_items.len(), 2);
        assert_eq!(initial.snapshot["tools"]["names"], json!(["exec_command"]));
        assert!(initial.response_items[0].to_string().contains("developer"));
        assert!(initial.response_items[1].to_string().contains("first"));
        let removed = build_world_state(
            "turn-2",
            WorldStateInput {
                cwd: root.path().into(),
                shell: Some("/bin/zsh".into()),
                current_date: "2026-07-25".into(),
                timezone: "Asia/Shanghai".into(),
                approval_policy: json!("on-request"),
                sandbox_policy: json!({"type":"workspaceWrite"}),
                tool_names: vec!["exec_command".into()],
                collaboration_mode: "default".into(),
                collaboration_mode_instructions: None,
                developer_instructions: None,
                project_instructions: None,
            },
            Some(&initial.snapshot),
        );
        let text = removed
            .response_items
            .iter()
            .map(Value::to_string)
            .collect::<String>();
        assert!(text.contains(REMOVAL_NOTICE));
        assert!(text.contains("previous developer instructions no longer apply"));
        assert!(strip_internal_world_state_metadata(&removed.response_items)
            .iter()
            .all(|item| item.get(WORLD_STATE_METADATA_KEY).is_none()));
    }

    #[test]
    fn xml_context_escapes_paths_and_values() {
        let update = build_world_state(
            "turn",
            WorldStateInput {
                cwd: PathBuf::from("/tmp/a&b"),
                shell: Some("<shell>".into()),
                current_date: "2026-07-25".into(),
                timezone: "A\"B".into(),
                approval_policy: json!("never"),
                sandbox_policy: json!({"type":"readOnly"}),
                tool_names: vec!["a<b".into()],
                collaboration_mode: "default".into(),
                collaboration_mode_instructions: None,
                developer_instructions: None,
                project_instructions: None,
            },
            None,
        );
        let text = update
            .response_items
            .iter()
            .map(Value::to_string)
            .collect::<String>();
        assert!(text.contains("a&amp;b"));
        assert!(text.contains("&lt;shell&gt;"));
        assert!(text.contains("A&quot;B"));
    }

    #[test]
    fn world_state_context_is_normalized_before_its_user_message() {
        let mut history = vec![
            json!({"type":"message","role":"user","content":[]}),
            json!({
                "type":"message",
                "role":"developer",
                "content":[],
                "_tietiezhiWorldState":{"turnId":"turn-1"}
            }),
            json!({
                "type":"message",
                "role":"user",
                "content":[],
                "_tietiezhiWorldState":{"turnId":"turn-1"}
            }),
            json!({"type":"message","role":"assistant","content":[]}),
        ];
        normalize_world_state_history(&mut history);
        assert_eq!(
            history
                .iter()
                .map(|item| {
                    item.get(WORLD_STATE_METADATA_KEY)
                        .and_then(|metadata| metadata.get("turnId"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>(),
            vec![Some("turn-1"), Some("turn-1"), None, None]
        );
    }
}
