//! Codex-compatible skill discovery, metadata catalog, and lazy body loader.
//!
//! Source-level adaptation of OpenAI Codex `rust-v0.145.0`; no upstream
//! executable is invoked or embedded.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tietiezhi_agent_config::discover_project_root;
use tietiezhi_agent_tools::{
    ToolError, ToolExposure, ToolFuture, ToolHandler, ToolInvocation, ToolName, ToolOutput,
    ToolPayload, ToolSpec,
};
use walkdir::WalkDir;

const SKILL_FILE: &str = "SKILL.md";
const METADATA_FILE: &str = "SKILL.json";
const MAX_SKILL_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct SkillsPaths {
    pub user_codex_root: PathBuf,
    pub user_agents_root: PathBuf,
    pub system_root: PathBuf,
    pub state_file: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SkillsRuntime {
    inner: Arc<SkillsInner>,
}

#[derive(Debug)]
struct SkillsInner {
    paths: SkillsPaths,
    extra_roots: Mutex<Vec<PathBuf>>,
    fingerprints: Mutex<BTreeMap<PathBuf, u128>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkillsDispatch {
    pub result: Value,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<Value>,
    pub path: PathBuf,
    pub scope: String,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
struct SkillRoot {
    path: PathBuf,
    scope: &'static str,
}

type SkillScan = (Vec<SkillMetadata>, Vec<Value>, BTreeMap<PathBuf, u128>);

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillConfigState {
    #[serde(default)]
    paths: BTreeMap<String, bool>,
    #[serde(default)]
    names: BTreeMap<String, bool>,
}

#[derive(Debug, Deserialize)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    #[serde(default)]
    metadata: FrontmatterMetadata,
}

#[derive(Debug, Default, Deserialize)]
struct FrontmatterMetadata {
    #[serde(default, rename = "short-description")]
    short_description: Option<String>,
}

impl SkillsRuntime {
    pub fn new(paths: SkillsPaths) -> Self {
        Self {
            inner: Arc::new(SkillsInner {
                paths,
                extra_roots: Mutex::new(Vec::new()),
                fingerprints: Mutex::new(BTreeMap::new()),
            }),
        }
    }

    pub fn handles(method: &str) -> bool {
        matches!(
            method,
            "skills/list" | "skills/config/write" | "skills/extraRoots/set"
        )
    }

    pub fn dispatch(
        &self,
        method: &str,
        params: &Value,
        default_cwd: &Path,
    ) -> Result<SkillsDispatch, String> {
        match method {
            "skills/list" => {
                let cwds = params
                    .get("cwds")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .map(|value| {
                                value
                                    .as_str()
                                    .map(PathBuf::from)
                                    .ok_or_else(|| "skills/list cwd must be a string".to_string())
                            })
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .transpose()?
                    .filter(|values| !values.is_empty())
                    .unwrap_or_else(|| vec![default_cwd.to_path_buf()]);
                let mut data = Vec::with_capacity(cwds.len());
                let mut observed = BTreeMap::new();
                for cwd in cwds {
                    if !cwd.is_absolute() {
                        data.push(json!({
                            "cwd":cwd,
                            "skills":[],
                            "errors":[{"path":cwd,"message":"cwd must be absolute"}]
                        }));
                        continue;
                    }
                    let (skills, errors, fingerprints) = self.scan(&cwd)?;
                    observed.extend(fingerprints);
                    data.push(json!({"cwd":cwd,"skills":skills,"errors":errors}));
                }
                let changed = self.update_fingerprints(observed)?;
                Ok(SkillsDispatch {
                    result: json!({"data":data}),
                    changed,
                })
            }
            "skills/extraRoots/set" => {
                let roots = params
                    .get("extraRoots")
                    .and_then(Value::as_array)
                    .ok_or_else(|| "extraRoots must be an array".to_string())?
                    .iter()
                    .map(|value| {
                        let path = value
                            .as_str()
                            .map(PathBuf::from)
                            .ok_or_else(|| "extra root must be a string".to_string())?;
                        if !path.is_absolute() {
                            return Err("extra root must be absolute".into());
                        }
                        Ok(path)
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                *self
                    .inner
                    .extra_roots
                    .lock()
                    .map_err(|_| "skills extra roots lock poisoned")? = roots;
                self.inner
                    .fingerprints
                    .lock()
                    .map_err(|_| "skills fingerprint lock poisoned")?
                    .clear();
                Ok(SkillsDispatch {
                    result: json!({}),
                    changed: true,
                })
            }
            "skills/config/write" => {
                let path = params
                    .get("path")
                    .and_then(Value::as_str)
                    .map(PathBuf::from);
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .map(str::to_owned);
                if path.is_some() == name.is_some() {
                    return Err("skills/config/write requires exactly one of path or name".into());
                }
                if path.as_ref().is_some_and(|path| !path.is_absolute()) {
                    return Err("skill path must be absolute".into());
                }
                let enabled = params
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| "enabled must be boolean".to_string())?;
                let mut state = self.read_state()?;
                if let Some(path) = path {
                    state.paths.insert(canonical_identity(&path), enabled);
                }
                if let Some(name) = name {
                    state.names.insert(name, enabled);
                }
                self.write_state(&state)?;
                self.inner
                    .fingerprints
                    .lock()
                    .map_err(|_| "skills fingerprint lock poisoned")?
                    .clear();
                Ok(SkillsDispatch {
                    result: json!({"effectiveEnabled":enabled}),
                    changed: true,
                })
            }
            _ => Err(format!("unsupported skills method: {method}")),
        }
    }

    pub fn enabled_skills(&self, cwd: &Path) -> Result<Vec<SkillMetadata>, String> {
        let (skills, _, _) = self.scan(cwd)?;
        Ok(skills.into_iter().filter(|skill| skill.enabled).collect())
    }

    pub fn load_body(&self, cwd: &Path, name: &str) -> Result<String, String> {
        let skills = self.enabled_skills(cwd)?;
        let matches = skills
            .iter()
            .filter(|skill| skill.name == name)
            .collect::<Vec<_>>();
        let skill = match matches.as_slice() {
            [] => return Err(format!("skill is not available: {name}")),
            [skill] => *skill,
            _ => {
                return Err(format!(
                    "skill name is ambiguous; use a path selector: {name}"
                ));
            }
        };
        fs::read_to_string(&skill.path)
            .map_err(|error| format!("read {}: {error}", skill.path.display()))
    }

    pub fn handler(&self, cwd: PathBuf) -> Result<Option<Arc<dyn ToolHandler>>, String> {
        let skills = self.enabled_skills(&cwd)?;
        if skills.is_empty() {
            return Ok(None);
        }
        Ok(Some(Arc::new(SkillHandler {
            runtime: self.clone(),
            cwd,
            names: skills.into_iter().map(|skill| skill.name).collect(),
        })))
    }

    fn scan(&self, cwd: &Path) -> Result<SkillScan, String> {
        let state = self.read_state()?;
        let roots = self.roots(cwd)?;
        let mut skills = Vec::new();
        let mut errors = Vec::new();
        let mut fingerprints = BTreeMap::new();
        let mut seen_paths = BTreeSet::new();
        for root in roots {
            if !root.path.is_dir() {
                continue;
            }
            for entry in WalkDir::new(&root.path)
                .follow_links(false)
                .max_depth(6)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file() && entry.file_name() == SKILL_FILE)
            {
                let path = entry.path().to_path_buf();
                let identity = canonical_identity(&path);
                if !seen_paths.insert(identity.clone()) {
                    continue;
                }
                match parse_skill_metadata(&path, root.scope, &state) {
                    Ok(skill) => {
                        fingerprints.insert(path.clone(), file_fingerprint(&path));
                        let metadata_path = path.with_file_name(METADATA_FILE);
                        if metadata_path.is_file() {
                            fingerprints
                                .insert(metadata_path.clone(), file_fingerprint(&metadata_path));
                        }
                        skills.push(skill);
                    }
                    Err(message) => errors.push(json!({"path":path,"message":message})),
                }
            }
        }
        skills.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then_with(|| left.path.cmp(&right.path))
        });
        Ok((skills, errors, fingerprints))
    }

    fn roots(&self, cwd: &Path) -> Result<Vec<SkillRoot>, String> {
        let project_root =
            discover_project_root(cwd, &[".git".into()]).map_err(|error| error.to_string())?;
        let mut project_dirs = cwd
            .ancestors()
            .take_while(|path| *path != project_root)
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        project_dirs.push(project_root);
        let mut roots = vec![
            SkillRoot {
                path: self.inner.paths.system_root.clone(),
                scope: "admin",
            },
            SkillRoot {
                path: self.inner.paths.user_codex_root.clone(),
                scope: "user",
            },
            SkillRoot {
                path: self.inner.paths.user_codex_root.join(".system"),
                scope: "system",
            },
            SkillRoot {
                path: self.inner.paths.user_agents_root.clone(),
                scope: "user",
            },
        ];
        project_dirs.reverse();
        roots.extend(project_dirs.into_iter().flat_map(|directory| {
            [
                SkillRoot {
                    path: directory.join(".codex/skills"),
                    scope: "repo",
                },
                SkillRoot {
                    path: directory.join(".agents/skills"),
                    scope: "repo",
                },
            ]
        }));
        roots.extend(
            self.inner
                .extra_roots
                .lock()
                .map_err(|_| "skills extra roots lock poisoned")?
                .iter()
                .cloned()
                .map(|path| SkillRoot {
                    path,
                    scope: "user",
                }),
        );
        Ok(roots)
    }

    fn read_state(&self) -> Result<SkillConfigState, String> {
        if !self.inner.paths.state_file.is_file() {
            return Ok(SkillConfigState::default());
        }
        serde_json::from_slice(
            &fs::read(&self.inner.paths.state_file).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
    }

    fn write_state(&self, state: &SkillConfigState) -> Result<(), String> {
        let parent = self
            .inner
            .paths
            .state_file
            .parent()
            .ok_or_else(|| "skills state path has no parent".to_string())?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary = self.inner.paths.state_file.with_extension("json.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        fs::rename(&temporary, &self.inner.paths.state_file).map_err(|error| error.to_string())
    }

    fn update_fingerprints(&self, current: BTreeMap<PathBuf, u128>) -> Result<bool, String> {
        let mut previous = self
            .inner
            .fingerprints
            .lock()
            .map_err(|_| "skills fingerprint lock poisoned")?;
        let changed = !previous.is_empty() && *previous != current;
        *previous = current;
        Ok(changed)
    }
}

fn parse_skill_metadata(
    path: &Path,
    scope: &str,
    state: &SkillConfigState,
) -> Result<SkillMetadata, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_SKILL_FILE_BYTES {
        return Err("SKILL.md exceeds 1 MiB".into());
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let frontmatter = frontmatter(&text)?;
    let name = frontmatter
        .name
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            path.parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .map(str::to_owned)
        })
        .ok_or_else(|| "skill name is missing".to_string())?;
    let description = frontmatter
        .description
        .filter(|description| !description.trim().is_empty())
        .ok_or_else(|| "skill description is missing".to_string())?;
    let metadata_file = path.with_file_name(METADATA_FILE);
    let metadata = if metadata_file.is_file() {
        serde_json::from_slice::<Value>(&fs::read(&metadata_file).map_err(|e| e.to_string())?)
            .map_err(|error| format!("{}: {error}", metadata_file.display()))?
    } else {
        Value::Null
    };
    let identity = canonical_identity(path);
    let enabled = state
        .paths
        .get(&identity)
        .or_else(|| state.names.get(&name))
        .copied()
        .unwrap_or(true);
    Ok(SkillMetadata {
        name,
        description,
        short_description: frontmatter.metadata.short_description,
        interface: metadata.get("interface").cloned(),
        dependencies: metadata.get("dependencies").cloned(),
        path: path.to_path_buf(),
        scope: scope.into(),
        enabled,
    })
}

fn frontmatter(text: &str) -> Result<Frontmatter, String> {
    let body = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or_else(|| "SKILL.md frontmatter is missing".to_string())?;
    let end = body
        .find("\n---")
        .ok_or_else(|| "SKILL.md frontmatter is not terminated".to_string())?;
    serde_yaml::from_str(&body[..end]).map_err(|error| error.to_string())
}

fn canonical_identity(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn file_fingerprint(path: &Path) -> u128 {
    let Ok(metadata) = fs::metadata(path) else {
        return 0;
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    modified ^ u128::from(metadata.len())
}

struct SkillHandler {
    runtime: SkillsRuntime,
    cwd: PathBuf,
    names: Vec<String>,
}

impl ToolHandler for SkillHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("skill")
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec::function(
            self.tool_name(),
            "Load the full instructions for one available skill.",
            json!({
                "type":"object",
                "properties":{"name":{"type":"string","enum":self.names}},
                "required":["name"],
                "additionalProperties":false
            }),
        )
    }

    fn exposure(&self) -> ToolExposure {
        ToolExposure::ModelVisible
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            let ToolPayload::Function { arguments } = &invocation.call.payload else {
                return Err(ToolError::InvalidCall(
                    "skill requires function arguments".into(),
                ));
            };
            let arguments: Value = serde_json::from_str(arguments)
                .map_err(|error| ToolError::InvalidCall(error.to_string()))?;
            let name = arguments
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::InvalidCall("name is required".into()))?;
            let content = self
                .runtime
                .load_body(&self.cwd, name)
                .map_err(ToolError::Handler)?;
            Ok(ToolOutput::success(json!({
                "name":name,
                "content":content
            })))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn runtime(root: &Path) -> SkillsRuntime {
        SkillsRuntime::new(SkillsPaths {
            user_codex_root: root.join("codex-skills"),
            user_agents_root: root.join("agent-skills"),
            system_root: root.join("system-skills"),
            state_file: root.join("state/skills.json"),
        })
    }

    fn write_skill(root: &Path, name: &str, description: &str, body: &str) -> PathBuf {
        let directory = root.join(name);
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(SKILL_FILE);
        fs::write(
            &path,
            format!("---\nname: {name}\ndescription: {description}\n---\n{body}"),
        )
        .unwrap();
        path
    }

    #[test]
    fn scopes_precedence_metadata_and_lazy_body_are_preserved() {
        let root = tempdir().unwrap();
        let runtime = runtime(root.path());
        let user = write_skill(
            &root.path().join("agent-skills"),
            "user-skill",
            "user",
            "secret body",
        );
        fs::write(
            user.with_file_name(METADATA_FILE),
            r##"{"interface":{"displayName":"User"},"dependencies":{"tools":[]}}"##,
        )
        .unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        fs::create_dir(project.join(".git")).unwrap();
        let nested = project.join("nested");
        fs::create_dir_all(nested.join(".codex/skills")).unwrap();
        write_skill(
            &nested.join(".codex/skills"),
            "repo-skill",
            "repo",
            "repo body",
        );
        let listed = runtime
            .dispatch("skills/list", &json!({"cwds":[nested]}), root.path())
            .unwrap();
        let skills = listed.result["data"][0]["skills"].as_array().unwrap();
        assert_eq!(skills.len(), 2);
        assert!(skills.iter().any(|skill| skill["scope"] == "repo"));
        assert_eq!(
            skills
                .iter()
                .find(|skill| skill["name"] == "user-skill")
                .unwrap()["interface"]["displayName"],
            "User"
        );
        assert_eq!(
            runtime.load_body(&project, "user-skill").unwrap(),
            "---\nname: user-skill\ndescription: user\n---\nsecret body"
        );
    }

    #[test]
    fn config_and_extra_roots_emit_invalidation_and_filter_handler() {
        let root = tempdir().unwrap();
        let runtime = runtime(root.path());
        let extra = root.path().join("extra");
        let skill = write_skill(&extra, "extra", "extra skill", "body");
        let changed = runtime
            .dispatch(
                "skills/extraRoots/set",
                &json!({"extraRoots":[extra]}),
                root.path(),
            )
            .unwrap();
        assert!(changed.changed);
        assert!(runtime.handler(root.path().into()).unwrap().is_some());
        let disabled = runtime
            .dispatch(
                "skills/config/write",
                &json!({"path":skill,"enabled":false}),
                root.path(),
            )
            .unwrap();
        assert!(disabled.changed);
        assert_eq!(disabled.result["effectiveEnabled"], false);
        assert!(runtime.handler(root.path().into()).unwrap().is_none());
    }

    #[test]
    fn modified_skill_is_reported_as_changed_on_next_scan() {
        let root = tempdir().unwrap();
        let runtime = runtime(root.path());
        let path = write_skill(&root.path().join("agent-skills"), "watch", "watch", "one");
        assert!(
            !runtime
                .dispatch("skills/list", &json!({}), root.path())
                .unwrap()
                .changed
        );
        fs::write(
            path,
            "---\nname: watch\ndescription: watch\n---\na longer body",
        )
        .unwrap();
        assert!(
            runtime
                .dispatch("skills/list", &json!({}), root.path())
                .unwrap()
                .changed
        );
    }
}
