//! Codex-compatible Apps catalog and connector tool metadata.
//!
//! The catalog follows App Server V2 from Codex `rust-v0.145.0`. Hosted
//! connector execution remains a host concern; this crate owns discovery,
//! validation, pagination and the public metadata projection.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const DEVICE_APP_ID: &str = "tietiezhi.devices";
pub const DEVICE_TOOL_NAMESPACE: &str = "tietiezhi_devices";
pub const DEVICE_LIST_TOOL_NAME: &str = "list";
pub const DEVICE_TOOL_NAME: &str = "invoke";
pub const APP_READ_MAX_IDS: usize = 100;
const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 100;

#[derive(Debug, Clone, Default)]
pub struct AppCatalog {
    apps: BTreeMap<String, AppDefinition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub install_url: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub developer: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub icon_url_dark: Option<String>,
    #[serde(default)]
    pub distribution_channel: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub accessible: bool,
    #[serde(default)]
    pub plugin_display_names: Vec<String>,
    #[serde(default)]
    pub tools: Vec<AppToolDefinition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppToolDefinition {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default = "object_schema")]
    pub input_schema: Value,
    #[serde(default)]
    pub output_schema: Option<Value>,
    #[serde(default)]
    pub annotations: ToolAnnotations,
    #[serde(default = "default_true")]
    pub model_visible: bool,
    #[serde(default)]
    pub synthetic: bool,
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAnnotations {
    #[serde(default)]
    pub read_only_hint: Option<bool>,
    #[serde(default)]
    pub destructive_hint: Option<bool>,
    #[serde(default)]
    pub idempotent_hint: Option<bool>,
    #[serde(default)]
    pub open_world_hint: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppListPage {
    pub data: Vec<Value>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppReadResult {
    pub apps: Vec<Value>,
    pub missing_app_ids: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn object_schema() -> Value {
    json!({"type":"object","properties":{},"additionalProperties":true})
}

impl AppCatalog {
    pub fn load(plugin_sources: &[PathBuf]) -> Result<Self, String> {
        let mut catalog = Self::default();
        catalog.insert(device_app())?;
        for path in plugin_sources {
            for app in read_plugin_apps(path)? {
                catalog.insert(app)?;
            }
        }
        Ok(catalog)
    }

    pub fn from_apps(apps: impl IntoIterator<Item = AppDefinition>) -> Result<Self, String> {
        let mut catalog = Self::default();
        for app in apps {
            catalog.insert(app)?;
        }
        Ok(catalog)
    }

    pub fn insert(&mut self, mut app: AppDefinition) -> Result<(), String> {
        validate_app(&app)?;
        app.plugin_display_names.sort();
        app.plugin_display_names.dedup();
        if self.apps.insert(app.id.clone(), app).is_some() {
            return Err("duplicate app id".into());
        }
        Ok(())
    }

    pub fn definitions(&self) -> impl Iterator<Item = &AppDefinition> {
        self.apps.values()
    }

    pub fn definition(&self, app_id: &str) -> Option<&AppDefinition> {
        self.apps.get(app_id)
    }

    pub fn list(&self, cursor: Option<&str>, limit: Option<u32>) -> Result<AppListPage, String> {
        let start = cursor
            .map(|cursor| {
                cursor
                    .parse::<usize>()
                    .map_err(|_| format!("invalid cursor: {cursor}"))
            })
            .transpose()?
            .unwrap_or(0);
        if start > self.apps.len() {
            return Err(format!("invalid cursor: {start}"));
        }
        let limit = usize::try_from(limit.unwrap_or(DEFAULT_PAGE_SIZE as u32))
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE);
        let data = self
            .apps
            .values()
            .skip(start)
            .take(limit)
            .map(app_info)
            .collect::<Vec<_>>();
        let next = start.saturating_add(data.len());
        Ok(AppListPage {
            data,
            next_cursor: (next < self.apps.len()).then(|| next.to_string()),
        })
    }

    pub fn read(&self, app_ids: &[String], include_tools: bool) -> Result<AppReadResult, String> {
        if app_ids.len() > APP_READ_MAX_IDS {
            return Err(format!(
                "app/read accepts at most {APP_READ_MAX_IDS} appIds"
            ));
        }
        let mut seen = HashSet::new();
        let mut apps = Vec::new();
        let mut missing_app_ids = Vec::new();
        for app_id in app_ids {
            if !seen.insert(app_id.as_str()) {
                continue;
            }
            match self.apps.get(app_id) {
                Some(app) => apps.push(connector_metadata(app, include_tools)),
                None => missing_app_ids.push(app_id.clone()),
            }
        }
        Ok(AppReadResult {
            apps,
            missing_app_ids,
        })
    }

    pub fn installed(&self) -> Vec<Value> {
        self.apps
            .values()
            .map(|app| {
                let callable = app.enabled
                    && app.accessible
                    && app
                        .tools
                        .iter()
                        .any(|tool| tool.model_visible && !tool.synthetic);
                json!({
                    "id":app.id,
                    "runtimeName":app.name,
                    "enabled":app.enabled,
                    "callable":callable
                })
            })
            .collect()
    }
}

pub fn device_app() -> AppDefinition {
    AppDefinition {
        id: DEVICE_APP_ID.into(),
        name: "Tietiezhi Device Fabric".into(),
        description: Some(
            "Inspect and invoke explicitly exposed capabilities on this installation and paired devices."
                .into(),
        ),
        install_url: None,
        category: Some("devices".into()),
        developer: Some("Tietiezhi".into()),
        website: None,
        icon_url: None,
        icon_url_dark: None,
        distribution_channel: Some("builtIn".into()),
        enabled: true,
        accessible: true,
        plugin_display_names: Vec::new(),
        tools: vec![
            AppToolDefinition {
                name: DEVICE_LIST_TOOL_NAME.into(),
                title: Some("List connected devices".into()),
                description:
                    "List this installation and paired devices with their exact capability names."
                        .into(),
                input_schema: json!({
                    "type":"object",
                    "properties":{},
                    "additionalProperties":false
                }),
                output_schema: Some(json!({"type":"array","items":{"type":"object"}})),
                annotations: ToolAnnotations {
                    read_only_hint: Some(true),
                    destructive_hint: Some(false),
                    idempotent_hint: Some(true),
                    open_world_hint: Some(true),
                },
                model_visible: true,
                synthetic: false,
                namespace: Some(DEVICE_TOOL_NAMESPACE.into()),
            },
            AppToolDefinition {
                name: DEVICE_TOOL_NAME.into(),
                title: Some("Invoke device capability".into()),
                description: "Invoke one advertised capability on an exact device. Read-only capabilities include system.ping, system.status, core.health and core.devices; all other capabilities require explicit approval.".into(),
                input_schema: json!({
                    "type":"object",
                    "properties":{
                        "device_id":{"type":"string","description":"Exact id returned by the device catalog, or local."},
                        "capability":{"type":"string","description":"Exact advertised capability name."},
                        "input":{"type":"object","description":"Capability-specific JSON input.","additionalProperties":true}
                    },
                    "required":["device_id","capability"],
                    "additionalProperties":false
                }),
                output_schema: Some(json!({
                    "type":"object",
                    "properties":{
                        "requestId":{"type":"string"},
                        "deviceId":{"type":"string"},
                        "capability":{"type":"string"},
                        "ok":{"type":"boolean"},
                        "output":{},
                        "message":{"type":"string"},
                        "durationMs":{"type":"integer"}
                    },
                    "required":["requestId","deviceId","capability","ok","output","message","durationMs"],
                    "additionalProperties":false
                })),
                annotations: ToolAnnotations {
                    read_only_hint: Some(false),
                    destructive_hint: Some(true),
                    idempotent_hint: Some(false),
                    open_world_hint: Some(true),
                },
                model_visible: true,
                synthetic: false,
                namespace: Some(DEVICE_TOOL_NAMESPACE.into()),
            },
        ],
    }
}

pub fn is_read_only_device_capability(capability: &str) -> bool {
    matches!(
        capability,
        "system.ping" | "system.status" | "core.health" | "core.devices"
    )
}

fn read_plugin_apps(path: &Path) -> Result<Vec<AppDefinition>, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("read plugin apps {}: {error}", path.display()))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse plugin apps {}: {error}", path.display()))?;
    let entries = value
        .as_array()
        .cloned()
        .or_else(|| value.get("apps").and_then(Value::as_array).cloned())
        .ok_or_else(|| format!("plugin apps {} must be an array", path.display()))?;
    let plugin_name = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .unwrap_or("plugin")
        .to_owned();
    entries
        .into_iter()
        .map(|entry| {
            let mut app: AppDefinition = serde_json::from_value(entry)
                .map_err(|error| format!("parse plugin app {}: {error}", path.display()))?;
            if app.distribution_channel.is_none() {
                app.distribution_channel = Some("plugin".into());
            }
            app.plugin_display_names.push(plugin_name.clone());
            Ok(app)
        })
        .collect()
}

fn validate_app(app: &AppDefinition) -> Result<(), String> {
    if app.id.trim().is_empty() || app.name.trim().is_empty() {
        return Err("app id and name are required".into());
    }
    let mut names = HashSet::new();
    for tool in &app.tools {
        if tool.name.trim().is_empty() {
            return Err(format!("app {} has an empty tool name", app.id));
        }
        if !names.insert((tool.namespace.as_deref(), tool.name.as_str())) {
            return Err(format!("app {} has duplicate tool {}", app.id, tool.name));
        }
        if !tool.input_schema.is_object()
            || tool.input_schema.get("type").and_then(Value::as_str) != Some("object")
        {
            return Err(format!(
                "app {} tool {} inputSchema must be an object schema",
                app.id, tool.name
            ));
        }
    }
    Ok(())
}

fn app_info(app: &AppDefinition) -> Value {
    json!({
        "id":app.id,
        "name":app.name,
        "description":app.description,
        "logoUrl":app.icon_url,
        "logoUrlDark":app.icon_url_dark,
        "iconAssets":Value::Null,
        "iconDarkAssets":Value::Null,
        "distributionChannel":app.distribution_channel,
        "branding":{
            "category":app.category,
            "developer":app.developer,
            "website":app.website,
            "privacyPolicy":Value::Null,
            "termsOfService":Value::Null,
            "isDiscoverableApp":true
        },
        "appMetadata":{
            "categories":app.category.as_ref().map(|category|vec![category]),
            "developer":app.developer,
            "firstPartyRequiresInstall":false,
            "firstPartyType":if app.distribution_channel.as_deref()==Some("builtIn"){Some("builtIn")}else{None},
            "review":Value::Null,
            "screenshots":Value::Null,
            "seoDescription":app.description,
            "showInComposerWhenUnlinked":true,
            "subCategories":Value::Null,
            "version":Value::Null,
            "versionId":Value::Null,
            "versionNotes":Value::Null
        },
        "labels":Value::Null,
        "installUrl":app.install_url,
        "isAccessible":app.accessible,
        "isEnabled":app.enabled,
        "pluginDisplayNames":app.plugin_display_names
    })
}

fn connector_metadata(app: &AppDefinition, include_tools: bool) -> Value {
    json!({
        "id":app.id,
        "name":app.name,
        "description":app.description,
        "iconUrl":app.icon_url,
        "iconUrlDark":app.icon_url_dark,
        "distributionChannel":app.distribution_channel,
        "installUrl":app.install_url,
        "pluginDisplayNames":app.plugin_display_names,
        "toolSummaries":include_tools.then(|| app.tools.iter().filter(|tool|tool.model_visible).map(|tool|json!({
            "name":tool.name,
            "title":tool.title,
            "description":tool.description
        })).collect::<Vec<_>>())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tietiezhi_agent_protocol::{AppsInstalledResponse, AppsListResponse, AppsReadResponse};

    #[test]
    fn built_in_device_app_projects_to_exact_v2_shapes() {
        let catalog = AppCatalog::load(&[]).unwrap();
        let page = catalog.list(None, None).unwrap();
        serde_json::from_value::<AppsListResponse>(json!({
            "data":page.data,
            "nextCursor":page.next_cursor
        }))
        .unwrap();
        serde_json::from_value::<AppsReadResponse>(json!({
            "apps":catalog.read(&[DEVICE_APP_ID.into()], true).unwrap().apps,
            "missingAppIds":[]
        }))
        .unwrap();
        serde_json::from_value::<AppsInstalledResponse>(json!({
            "apps":catalog.installed()
        }))
        .unwrap();
    }

    #[test]
    fn list_cursor_and_limit_are_deterministic() {
        let catalog = AppCatalog::from_apps([test_app("c"), test_app("a"), test_app("b")]).unwrap();
        let first = catalog.list(None, Some(2)).unwrap();
        assert_eq!(first.data[0]["id"], "a");
        assert_eq!(first.data[1]["id"], "b");
        assert_eq!(first.next_cursor.as_deref(), Some("2"));
        let second = catalog.list(first.next_cursor.as_deref(), Some(2)).unwrap();
        assert_eq!(second.data[0]["id"], "c");
        assert_eq!(second.next_cursor, None);
        assert!(catalog.list(Some("nope"), None).is_err());
    }

    #[test]
    fn read_deduplicates_and_preserves_request_order() {
        let catalog = AppCatalog::from_apps([test_app("a"), test_app("b")]).unwrap();
        let read = catalog
            .read(
                &["b".into(), "missing".into(), "b".into(), "a".into()],
                true,
            )
            .unwrap();
        assert_eq!(read.apps[0]["id"], "b");
        assert_eq!(read.apps[1]["id"], "a");
        assert_eq!(read.missing_app_ids, vec!["missing"]);
        assert!(catalog
            .read(
                &(0..=APP_READ_MAX_IDS)
                    .map(|index| index.to_string())
                    .collect::<Vec<_>>(),
                false
            )
            .is_err());
    }

    #[test]
    fn plugin_sources_preserve_tools_annotations_and_provenance() {
        let root = tempfile::tempdir().unwrap();
        let plugin = root.path().join("calendar-plugin");
        fs::create_dir_all(&plugin).unwrap();
        let path = plugin.join("apps.json");
        fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({"apps":[{
                "id":"calendar",
                "name":"Calendar",
                "description":"Manage events",
                "tools":[{
                    "name":"list_events",
                    "description":"List events",
                    "inputSchema":{"type":"object","properties":{}},
                    "annotations":{"readOnlyHint":true,"openWorldHint":true}
                }]
            }]}))
            .unwrap(),
        )
        .unwrap();
        let catalog = AppCatalog::load(&[path]).unwrap();
        let app = catalog.definition("calendar").unwrap();
        assert_eq!(app.plugin_display_names, vec!["calendar-plugin"]);
        assert_eq!(app.tools[0].annotations.read_only_hint, Some(true));
        assert_eq!(app.distribution_channel.as_deref(), Some("plugin"));
    }

    #[test]
    fn rejects_duplicate_ids_and_invalid_tool_schemas() {
        assert!(AppCatalog::from_apps([test_app("a"), test_app("a")]).is_err());
        let mut app = test_app("bad");
        app.tools[0].input_schema = json!({"type":"string"});
        assert!(AppCatalog::from_apps([app]).is_err());
    }

    #[test]
    fn installed_excludes_synthetic_or_disabled_tools() {
        let mut app = test_app("disabled");
        app.enabled = false;
        let mut synthetic = test_app("synthetic");
        synthetic.tools[0].synthetic = true;
        let catalog = AppCatalog::from_apps([app, synthetic]).unwrap();
        assert_eq!(catalog.installed()[0]["callable"], false);
        assert_eq!(catalog.installed()[1]["callable"], false);
    }

    #[test]
    fn read_only_device_capabilities_are_explicit() {
        assert!(is_read_only_device_capability("system.status"));
        assert!(is_read_only_device_capability("core.devices"));
        assert!(!is_read_only_device_capability("app.focus"));
        assert!(!is_read_only_device_capability("filesystem.write"));
    }

    fn test_app(id: &str) -> AppDefinition {
        AppDefinition {
            id: id.into(),
            name: id.into(),
            description: None,
            install_url: None,
            category: None,
            developer: None,
            website: None,
            icon_url: None,
            icon_url_dark: None,
            distribution_channel: Some("plugin".into()),
            enabled: true,
            accessible: true,
            plugin_display_names: Vec::new(),
            tools: vec![AppToolDefinition {
                name: "run".into(),
                title: None,
                description: String::new(),
                input_schema: object_schema(),
                output_schema: None,
                annotations: ToolAnnotations::default(),
                model_visible: true,
                synthetic: false,
                namespace: None,
            }],
        }
    }
}
