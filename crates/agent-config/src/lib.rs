//! Codex-compatible project instruction discovery and world-state rendering.
//!
//! This is a source-level adaptation of OpenAI Codex `rust-v0.145.0`.
//! It neither invokes nor embeds the upstream executable.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

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
        Read::by_ref(&mut file)
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
    pub skill_metadata: Vec<Value>,
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
        "skills":{"metadata":input.skill_metadata},
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
        ("skills", render_skills),
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

fn render_skills(value: &Value) -> String {
    let metadata = value
        .get("metadata")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    format!(
        "<available_skills>\n{}\n</available_skills>",
        xml_escape(&Value::Array(metadata).to_string())
    )
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

#[derive(Debug, Clone)]
pub struct ConfigPaths {
    pub user_config: PathBuf,
    pub system_config: PathBuf,
    pub requirements: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ConfigRuntime {
    paths: ConfigPaths,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConfigDispatch {
    pub result: Value,
    pub warnings: Vec<ConfigWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigWarning {
    pub summary: String,
    pub details: Option<String>,
    pub path: Option<PathBuf>,
}

#[derive(Debug)]
pub enum ConfigError {
    Io(io::Error),
    Invalid(String),
    Conflict { expected: String, actual: String },
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Invalid(message) => formatter.write_str(message),
            Self::Conflict { expected, actual } => write!(
                formatter,
                "config version conflict: expected {expected}, actual {actual}"
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

impl From<io::Error> for ConfigError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl ConfigRuntime {
    pub fn new(paths: ConfigPaths) -> Self {
        Self { paths }
    }

    pub fn handles(method: &str) -> bool {
        matches!(
            method,
            "config/read"
                | "config/value/write"
                | "config/batchWrite"
                | "configRequirements/read"
                | "config/mcpServer/reload"
                | "experimentalFeature/list"
                | "experimentalFeature/enablement/set"
        )
    }

    pub fn dispatch(&self, method: &str, params: &Value) -> Result<ConfigDispatch, ConfigError> {
        match method {
            "config/read" => self.read(params),
            "config/value/write" => {
                let edit = json!({
                    "keyPath": required_config_string(params, "keyPath")?,
                    "value": params.get("value").cloned().unwrap_or(Value::Null),
                    "mergeStrategy": required_config_string(params, "mergeStrategy")?
                });
                self.write(
                    &[edit],
                    params.get("filePath").and_then(Value::as_str),
                    params.get("expectedVersion").and_then(Value::as_str),
                )
            }
            "config/batchWrite" => {
                let edits = params
                    .get("edits")
                    .and_then(Value::as_array)
                    .ok_or_else(|| ConfigError::Invalid("edits must be an array".into()))?;
                self.write(
                    edits,
                    params.get("filePath").and_then(Value::as_str),
                    params.get("expectedVersion").and_then(Value::as_str),
                )
            }
            "configRequirements/read" => Ok(ConfigDispatch {
                result: json!({"requirements": self.read_requirements()?.map(|value| normalize_requirements(&value))}),
                warnings: Vec::new(),
            }),
            "config/mcpServer/reload" => Ok(ConfigDispatch {
                result: json!({}),
                warnings: Vec::new(),
            }),
            "experimentalFeature/list" => self.experimental_features(params),
            "experimentalFeature/enablement/set" => self.set_experimental_features(params),
            _ => Err(ConfigError::Invalid(format!(
                "unsupported config method: {method}"
            ))),
        }
    }

    fn read(&self, params: &Value) -> Result<ConfigDispatch, ConfigError> {
        let cwd = params.get("cwd").and_then(Value::as_str).map(PathBuf::from);
        if cwd.as_ref().is_some_and(|path| !path.is_absolute()) {
            return Err(ConfigError::Invalid("cwd must be absolute".into()));
        }
        let include_layers = params
            .get("includeLayers")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut layers = Vec::new();
        self.push_file_layer(
            &mut layers,
            &self.paths.system_config,
            json!({"type":"system","file":self.paths.system_config}),
        )?;
        self.push_file_layer(
            &mut layers,
            &self.paths.user_config,
            json!({"type":"user","file":self.paths.user_config,"profile":null}),
        )?;
        if let Some(profile) = layers
            .last()
            .and_then(|layer: &Value| layer.pointer("/config/profile"))
            .and_then(Value::as_str)
            .map(str::to_owned)
        {
            if let Some(config) = layers
                .last()
                .and_then(|layer| layer.pointer(&format!("/config/profiles/{profile}")))
                .cloned()
            {
                layers.push(config_layer(
                    json!({"type":"user","file":self.paths.user_config,"profile":profile}),
                    config,
                    "profile",
                ));
            }
        }
        if let Some(cwd) = cwd.as_deref() {
            for folder in project_codex_folders(cwd)? {
                self.push_file_layer(
                    &mut layers,
                    &folder.join("config.toml"),
                    json!({"type":"project","dotCodexFolder":folder}),
                )?;
            }
        }

        let mut effective = Value::Object(Default::default());
        let mut origins = BTreeMap::new();
        for layer in &layers {
            let config = layer.get("config").cloned().unwrap_or(Value::Null);
            merge_json(&mut effective, &config);
            if let (Some(source), Some(version)) = (
                layer.get("name"),
                layer.get("version").and_then(Value::as_str),
            ) {
                record_origins(
                    &config,
                    "",
                    &json!({"name":source,"version":version}),
                    &mut origins,
                );
            }
        }
        let requirements = self.read_requirements()?;
        let mut warnings = Vec::new();
        if let Some(requirements) = requirements.as_ref() {
            enforce_requirements(
                &mut effective,
                requirements,
                &self.paths.requirements,
                &mut warnings,
            );
        }
        Ok(ConfigDispatch {
            result: json!({
                "config": normalize_config(&effective),
                "origins": origins,
                "layers": include_layers.then_some(layers)
            }),
            warnings,
        })
    }

    fn write(
        &self,
        edits: &[Value],
        file_path: Option<&str>,
        expected_version: Option<&str>,
    ) -> Result<ConfigDispatch, ConfigError> {
        let path = file_path
            .map(PathBuf::from)
            .unwrap_or_else(|| self.paths.user_config.clone());
        if !path.is_absolute() {
            return Err(ConfigError::Invalid(
                "config file path must be absolute".into(),
            ));
        }
        let bytes = fs::read(&path).unwrap_or_default();
        let current_version = fingerprint(&bytes);
        if let Some(expected) = expected_version {
            if expected != current_version {
                return Err(ConfigError::Conflict {
                    expected: expected.into(),
                    actual: current_version,
                });
            }
        }
        let mut config = parse_toml_bytes(&bytes, &path)?;
        for edit in edits {
            let key_path = required_config_string(edit, "keyPath")?;
            let strategy = required_config_string(edit, "mergeStrategy")?;
            if !matches!(strategy.as_str(), "replace" | "upsert") {
                return Err(ConfigError::Invalid(format!(
                    "invalid merge strategy: {strategy}"
                )));
            }
            set_key_path(
                &mut config,
                &key_path,
                edit.get("value").cloned().unwrap_or(Value::Null),
                strategy == "upsert",
            )?;
        }
        let toml = json_to_toml_string(&config)?;
        atomic_write(&path, toml.as_bytes())?;
        let version = fingerprint(toml.as_bytes());
        Ok(ConfigDispatch {
            result: json!({
                "status":"ok",
                "version":version,
                "filePath":path,
                "overriddenMetadata":null
            }),
            warnings: Vec::new(),
        })
    }

    fn push_file_layer(
        &self,
        layers: &mut Vec<Value>,
        path: &Path,
        source: Value,
    ) -> Result<(), ConfigError> {
        if !path.is_file() {
            return Ok(());
        }
        let bytes = fs::read(path)?;
        let config = parse_toml_bytes(&bytes, path)?;
        layers.push(config_layer(source, config, &fingerprint(&bytes)));
        Ok(())
    }

    fn read_requirements(&self) -> Result<Option<Value>, ConfigError> {
        if !self.paths.requirements.is_file() {
            return Ok(None);
        }
        let bytes = fs::read(&self.paths.requirements)?;
        parse_toml_bytes(&bytes, &self.paths.requirements).map(Some)
    }

    fn experimental_features(&self, params: &Value) -> Result<ConfigDispatch, ConfigError> {
        let read = self.read(&json!({}))?;
        let config = &read.result["config"];
        let mut features = experimental_catalog()
            .into_iter()
            .map(
                |(name, stage, default_enabled, display_name, description)| {
                    let enabled = config
                        .pointer(&format!("/features/{name}"))
                        .and_then(Value::as_bool)
                        .unwrap_or(default_enabled);
                    json!({
                        "name":name,
                        "stage":stage,
                        "displayName":display_name,
                        "description":description,
                        "announcement":null,
                        "enabled":enabled,
                        "defaultEnabled":default_enabled
                    })
                },
            )
            .collect::<Vec<_>>();
        let offset = params
            .get("cursor")
            .and_then(Value::as_str)
            .map(|cursor| {
                cursor
                    .parse::<usize>()
                    .map_err(|_| ConfigError::Invalid("invalid feature cursor".into()))
            })
            .transpose()?
            .unwrap_or(0);
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(25)
            .clamp(1, 100);
        let next = (offset + limit < features.len()).then(|| (offset + limit).to_string());
        features = features.into_iter().skip(offset).take(limit).collect();
        Ok(ConfigDispatch {
            result: json!({"data":features,"nextCursor":next}),
            warnings: read.warnings,
        })
    }

    fn set_experimental_features(&self, params: &Value) -> Result<ConfigDispatch, ConfigError> {
        let enablement = params
            .get("enablement")
            .and_then(Value::as_object)
            .ok_or_else(|| ConfigError::Invalid("enablement must be an object".into()))?;
        let known = experimental_catalog()
            .into_iter()
            .map(|feature| feature.0)
            .collect::<Vec<_>>();
        let mut edits = Vec::new();
        for (name, value) in enablement {
            if !known.contains(&name.as_str()) {
                return Err(ConfigError::Invalid(format!(
                    "unknown experimental feature: {name}"
                )));
            }
            let enabled = value.as_bool().ok_or_else(|| {
                ConfigError::Invalid(format!("feature {name} enablement must be boolean"))
            })?;
            edits.push(json!({
                "keyPath":format!("features.{name}"),
                "value":enabled,
                "mergeStrategy":"replace"
            }));
        }
        if !edits.is_empty() {
            self.write(&edits, None, None)?;
        }
        Ok(ConfigDispatch {
            result: json!({"enablement":enablement}),
            warnings: Vec::new(),
        })
    }
}

fn config_layer(source: Value, config: Value, version: &str) -> Value {
    json!({
        "name":source,
        "version":version,
        "config":config,
        "disabledReason":null
    })
}

fn parse_toml_bytes(bytes: &[u8], path: &Path) -> Result<Value, ConfigError> {
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|error| ConfigError::Invalid(format!("{}: {error}", path.display())))?;
    let value = toml::from_str::<toml::Value>(text)
        .map_err(|error| ConfigError::Invalid(format!("{}: {error}", path.display())))?;
    serde_json::to_value(value)
        .map_err(|error| ConfigError::Invalid(format!("{}: {error}", path.display())))
}

fn json_to_toml_string(value: &Value) -> Result<String, ConfigError> {
    let value = serde_json::from_value::<toml::Value>(value.clone())
        .map_err(|error| ConfigError::Invalid(format!("config is not TOML-compatible: {error}")))?;
    toml::to_string_pretty(&value)
        .map_err(|error| ConfigError::Invalid(format!("serialize config: {error}")))
}

fn project_codex_folders(cwd: &Path) -> io::Result<Vec<PathBuf>> {
    let root = discover_project_root(cwd, &[".git".into()])?;
    let mut directories = cwd
        .ancestors()
        .take_while(|path| *path != root)
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    directories.push(root);
    directories.reverse();
    Ok(directories
        .into_iter()
        .map(|directory| directory.join(".codex"))
        .collect())
}

fn merge_json(base: &mut Value, overlay: &Value) {
    match (base, overlay) {
        (Value::Object(base), Value::Object(overlay)) => {
            for (key, value) in overlay {
                merge_json(base.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (base, overlay) => base.clone_from(overlay),
    }
}

fn set_key_path(
    root: &mut Value,
    key_path: &str,
    value: Value,
    upsert: bool,
) -> Result<(), ConfigError> {
    let keys = key_path.split('.').collect::<Vec<_>>();
    if keys.is_empty()
        || keys
            .iter()
            .any(|key| key.is_empty() || *key == "__proto__" || *key == "constructor")
    {
        return Err(ConfigError::Invalid(format!(
            "invalid key path: {key_path}"
        )));
    }
    let mut cursor = root;
    for key in &keys[..keys.len() - 1] {
        if !cursor.is_object() {
            *cursor = json!({});
        }
        cursor = cursor
            .as_object_mut()
            .expect("cursor was normalized to object")
            .entry(*key)
            .or_insert_with(|| json!({}));
    }
    let key = keys[keys.len() - 1];
    let object = cursor
        .as_object_mut()
        .ok_or_else(|| ConfigError::Invalid(format!("parent is not an object: {key_path}")))?;
    if value.is_null() {
        object.remove(key);
        return Ok(());
    }
    if upsert {
        if let Some(current) = object.get_mut(key) {
            merge_json(current, &value);
        } else {
            object.insert(key.into(), value);
        }
    } else {
        object.insert(key.into(), value);
    }
    Ok(())
}

fn record_origins(
    value: &Value,
    prefix: &str,
    source: &Value,
    origins: &mut BTreeMap<String, Value>,
) {
    if let Value::Object(object) = value {
        for (key, value) in object {
            let path = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            record_origins(value, &path, source, origins);
        }
    } else if !prefix.is_empty() {
        origins.insert(prefix.into(), source.clone());
    }
}

fn normalize_config(value: &Value) -> Value {
    let mut config = value.as_object().cloned().unwrap_or_default();
    for key in [
        "model",
        "review_model",
        "model_context_window",
        "model_auto_compact_token_limit",
        "model_auto_compact_token_limit_scope",
        "model_provider",
        "approval_policy",
        "approvals_reviewer",
        "sandbox_mode",
        "sandbox_workspace_write",
        "forced_chatgpt_workspace_id",
        "forced_login_method",
        "web_search",
        "tools",
        "instructions",
        "developer_instructions",
        "compact_prompt",
        "model_reasoning_effort",
        "model_reasoning_summary",
        "model_verbosity",
        "service_tier",
        "analytics",
        "desktop",
    ] {
        config.entry(key).or_insert(Value::Null);
    }
    Value::Object(config)
}

fn normalize_requirements(value: &Value) -> Value {
    let mut requirements = value.as_object().cloned().unwrap_or_default();
    for key in [
        "allowedApprovalPolicies",
        "allowedSandboxModes",
        "allowedWindowsSandboxImplementations",
        "allowedPermissionProfiles",
        "defaultPermissions",
        "allowedWebSearchModes",
        "allowManagedHooksOnly",
        "allowAppshots",
        "allowRemoteControl",
        "computerUse",
        "featureRequirements",
        "enforceResidency",
        "models",
    ] {
        requirements.entry(key).or_insert(Value::Null);
    }
    Value::Object(requirements)
}

fn enforce_requirements(
    config: &mut Value,
    requirements: &Value,
    path: &Path,
    warnings: &mut Vec<ConfigWarning>,
) {
    for (config_key, requirement_key) in [
        ("approval_policy", "allowedApprovalPolicies"),
        ("sandbox_mode", "allowedSandboxModes"),
        ("web_search", "allowedWebSearchModes"),
    ] {
        let allowed = requirements
            .get(requirement_key)
            .and_then(Value::as_array)
            .filter(|values| !values.is_empty());
        let Some(allowed) = allowed else {
            continue;
        };
        let current = config.get(config_key).cloned().unwrap_or(Value::Null);
        if !allowed.contains(&current) {
            let replacement = allowed[0].clone();
            config[config_key] = replacement.clone();
            warnings.push(ConfigWarning {
                summary: format!("{config_key} was constrained by requirements"),
                details: Some(format!(
                    "requested {current}; effective value is {replacement}"
                )),
                path: Some(path.to_path_buf()),
            });
        }
    }
    if let Some(required) = requirements
        .get("featureRequirements")
        .and_then(Value::as_object)
    {
        for (name, enabled) in required {
            config["features"][name] = enabled.clone();
        }
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "config path has no parent"))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile_path(path);
    let mut suffix = 0_u32;
    while temporary.exists() {
        suffix = suffix.saturating_add(1);
        temporary = path.with_extension(format!("tmp-{}-{suffix}", std::process::id()));
    }
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn tempfile_path(path: &Path) -> PathBuf {
    path.with_extension(format!("tmp-{}", std::process::id()))
}

fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn required_config_string(value: &Value, key: &str) -> Result<String, ConfigError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ConfigError::Invalid(format!("{key} must be a non-empty string")))
}

fn experimental_catalog() -> Vec<(&'static str, &'static str, bool, Value, Value)> {
    vec![
        (
            "multi_agent",
            "beta",
            false,
            json!("Multi-agent"),
            json!("Run bounded subagents inside the same thread graph."),
        ),
        (
            "hooks",
            "beta",
            false,
            json!("Hooks"),
            json!("Run managed lifecycle hooks."),
        ),
        (
            "plugins",
            "beta",
            false,
            json!("Plugins"),
            json!("Load locally installed Codex plugins."),
        ),
        (
            "remote_control",
            "underDevelopment",
            false,
            Value::Null,
            Value::Null,
        ),
    ]
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
                skill_metadata: Vec::new(),
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
                skill_metadata: Vec::new(),
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
                skill_metadata: Vec::new(),
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

    #[test]
    fn config_layers_track_origins_profiles_and_project_precedence() {
        let root = tempdir().unwrap();
        let system = root.path().join("system.toml");
        let user = root.path().join("home/config.toml");
        let requirements = root.path().join("requirements.toml");
        fs::write(&system, "model = \"system\"\napproval_policy = \"never\"\n").unwrap();
        fs::create_dir_all(user.parent().unwrap()).unwrap();
        fs::write(
            &user,
            "model = \"user\"\nprofile = \"work\"\n[profiles.work]\nmodel = \"profile\"\n",
        )
        .unwrap();
        let project = root.path().join("project");
        let nested = project.join("nested");
        fs::create_dir_all(nested.join(".codex")).unwrap();
        fs::create_dir(project.join(".git")).unwrap();
        fs::create_dir(project.join(".codex")).unwrap();
        fs::write(project.join(".codex/config.toml"), "model = \"project\"\n").unwrap();
        fs::write(nested.join(".codex/config.toml"), "model = \"nested\"\n").unwrap();
        fs::write(&requirements, "allowedApprovalPolicies = [\"untrusted\"]\n").unwrap();
        let runtime = ConfigRuntime::new(ConfigPaths {
            user_config: user,
            system_config: system,
            requirements,
        });
        let output = runtime
            .dispatch("config/read", &json!({"cwd":nested,"includeLayers":true}))
            .unwrap();
        assert_eq!(output.result["config"]["model"], "nested");
        assert_eq!(output.result["config"]["approval_policy"], "untrusted");
        assert_eq!(output.result["origins"]["model"]["name"]["type"], "project");
        assert_eq!(output.result["layers"].as_array().unwrap().len(), 5);
        assert_eq!(output.warnings.len(), 1);
    }

    #[test]
    fn config_writes_are_atomic_versioned_and_cas_guarded() {
        let root = tempdir().unwrap();
        let user = root.path().join("config.toml");
        let runtime = ConfigRuntime::new(ConfigPaths {
            user_config: user.clone(),
            system_config: root.path().join("system.toml"),
            requirements: root.path().join("requirements.toml"),
        });
        let written = runtime
            .dispatch(
                "config/batchWrite",
                &json!({
                    "edits":[
                        {"keyPath":"model","value":"gpt","mergeStrategy":"replace"},
                        {"keyPath":"tools.web_search","value":true,"mergeStrategy":"upsert"}
                    ]
                }),
            )
            .unwrap();
        assert_eq!(written.result["status"], "ok");
        let version = written.result["version"].as_str().unwrap();
        assert!(fs::read_to_string(&user).unwrap().contains("web_search"));
        let conflict = runtime.dispatch(
            "config/value/write",
            &json!({
                "keyPath":"model",
                "value":"other",
                "mergeStrategy":"replace",
                "expectedVersion":"stale"
            }),
        );
        assert!(matches!(conflict, Err(ConfigError::Conflict { .. })));
        let updated = runtime
            .dispatch(
                "config/value/write",
                &json!({
                    "keyPath":"model",
                    "value":"other",
                    "mergeStrategy":"replace",
                    "expectedVersion":version
                }),
            )
            .unwrap();
        assert_ne!(updated.result["version"], version);
    }

    #[test]
    fn experimental_features_are_paginated_and_persisted() {
        let root = tempdir().unwrap();
        let runtime = ConfigRuntime::new(ConfigPaths {
            user_config: root.path().join("config.toml"),
            system_config: root.path().join("system.toml"),
            requirements: root.path().join("requirements.toml"),
        });
        runtime
            .dispatch(
                "experimentalFeature/enablement/set",
                &json!({"enablement":{"hooks":true}}),
            )
            .unwrap();
        let first = runtime
            .dispatch("experimentalFeature/list", &json!({"limit":2}))
            .unwrap();
        assert_eq!(first.result["data"].as_array().unwrap().len(), 2);
        assert_eq!(first.result["nextCursor"], "2");
        let all = runtime
            .dispatch("experimentalFeature/list", &json!({}))
            .unwrap();
        assert!(all.result["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|feature| feature["name"] == "hooks" && feature["enabled"] == true));
    }
}
