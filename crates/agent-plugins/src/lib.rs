//! Codex-compatible local plugin and marketplace runtime.
//!
//! The implementation is aligned with OpenAI Codex `rust-v0.145.0` and keeps
//! package management in-process. It never invokes or embeds the Codex binary.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::process::Command;
use uuid::Uuid;

const MARKETPLACE_MANIFESTS: &[&str] = &[
    ".agents/plugins/marketplace.json",
    ".agents/plugins/api_marketplace.json",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
];

const METHODS: &[&str] = &[
    "marketplace/add",
    "marketplace/remove",
    "marketplace/upgrade",
    "plugin/install",
    "plugin/installed",
    "plugin/list",
    "plugin/read",
    "plugin/share/checkout",
    "plugin/share/delete",
    "plugin/share/list",
    "plugin/share/save",
    "plugin/share/updateTargets",
    "plugin/skill/read",
    "plugin/uninstall",
];

#[derive(Debug, Clone)]
pub struct PluginPaths {
    pub root: PathBuf,
    pub personal_marketplace: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct PluginActivation {
    pub skill_roots: Vec<PathBuf>,
    pub hook_paths: Vec<PathBuf>,
    pub mcp_servers: Vec<PluginMcpSource>,
    pub apps: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct PluginMcpSource {
    pub plugin_id: String,
    pub path: Option<PathBuf>,
    pub inline: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct PluginDispatch {
    pub result: Value,
    pub changed: bool,
}

#[derive(Debug, Clone)]
pub struct PluginRuntime {
    inner: Arc<PluginRuntimeInner>,
}

#[derive(Debug)]
struct PluginRuntimeInner {
    paths: PluginPaths,
    lock: Mutex<()>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginStore {
    #[serde(default)]
    marketplaces: BTreeMap<String, MarketplaceRecord>,
    #[serde(default)]
    installed: BTreeMap<String, InstalledRecord>,
    #[serde(default)]
    shares: BTreeMap<String, ShareRecord>,
    #[serde(default)]
    enabled_overrides: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceRecord {
    name: String,
    root: PathBuf,
    manifest_path: PathBuf,
    source: String,
    owned: bool,
    #[serde(default)]
    ref_name: Option<String>,
    #[serde(default)]
    sparse_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledRecord {
    plugin_id: String,
    plugin_name: String,
    marketplace_name: String,
    root: PathBuf,
    version: Option<String>,
    enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareRecord {
    remote_plugin_id: String,
    root: PathBuf,
    source_path: PathBuf,
    discoverability: String,
    #[serde(default)]
    targets: Vec<Value>,
    version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceFile {
    name: String,
    #[serde(default)]
    interface: Option<Value>,
    #[serde(default)]
    plugins: Vec<MarketplacePlugin>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketplacePlugin {
    name: String,
    source: Value,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    interface: Option<Value>,
    #[serde(default)]
    install_policy: Option<String>,
    #[serde(default)]
    auth_policy: Option<String>,
}

#[derive(Debug, Clone)]
struct ResolvedPlugin {
    marketplace: MarketplaceRecord,
    entry: MarketplacePlugin,
    source_root: PathBuf,
    manifest: PluginManifest,
}

#[derive(Debug, Clone)]
struct PluginManifest {
    name: String,
    version: Option<String>,
    description: Option<String>,
    keywords: Vec<String>,
    skills: Vec<PathBuf>,
    hooks: Vec<PathBuf>,
    inline_hooks: Vec<Value>,
    mcp_path: Option<PathBuf>,
    mcp_inline: Option<Value>,
    apps: Option<PathBuf>,
    interface: Option<Value>,
}

impl PluginRuntime {
    pub fn new(paths: PluginPaths) -> Result<Self, String> {
        fs::create_dir_all(paths.root.join("installed"))
            .map_err(|error| format!("create plugin install root: {error}"))?;
        fs::create_dir_all(paths.root.join("marketplaces"))
            .map_err(|error| format!("create marketplace root: {error}"))?;
        fs::create_dir_all(paths.root.join("rollback"))
            .map_err(|error| format!("create plugin rollback root: {error}"))?;
        fs::create_dir_all(paths.root.join("shares"))
            .map_err(|error| format!("create plugin share root: {error}"))?;
        Ok(Self {
            inner: Arc::new(PluginRuntimeInner {
                paths,
                lock: Mutex::new(()),
            }),
        })
    }

    pub fn handles(method: &str) -> bool {
        METHODS.contains(&method)
    }

    pub async fn dispatch(&self, method: &str, params: &Value) -> Result<PluginDispatch, String> {
        match method {
            "marketplace/add" => self.marketplace_add(params).await,
            "marketplace/remove" => self.marketplace_remove(params),
            "marketplace/upgrade" => self.marketplace_upgrade(params).await,
            "plugin/install" => self.plugin_install(params),
            "plugin/installed" => self.plugin_list(params, true),
            "plugin/list" => self.plugin_list(params, false),
            "plugin/read" => self.plugin_read(params),
            "plugin/uninstall" => self.plugin_uninstall(params),
            "plugin/skill/read" => self.plugin_skill_read(params),
            "plugin/share/list" => self.share_list(),
            "plugin/share/save" => self.share_save(params),
            "plugin/share/checkout" => self.share_checkout(params),
            "plugin/share/delete" => self.share_delete(params),
            "plugin/share/updateTargets" => self.share_update_targets(params),
            _ => Err(format!("unsupported plugin method: {method}")),
        }
    }

    pub fn activation(&self) -> Result<PluginActivation, String> {
        let _guard = self.lock()?;
        let mut store = self.load_store()?;
        let mut activation = PluginActivation::default();
        let mut changed = false;
        for record in store.installed.values_mut() {
            if !record.enabled {
                continue;
            }
            let manifest = match load_plugin_manifest(&record.root) {
                Ok(manifest) => manifest,
                Err(_) => {
                    record.enabled = false;
                    changed = true;
                    continue;
                }
            };
            activation.skill_roots.extend(manifest.skills);
            activation.hook_paths.extend(manifest.hooks);
            for (index, inline) in manifest.inline_hooks.into_iter().enumerate() {
                let path = record
                    .root
                    .join(".codex-plugin")
                    .join(format!("generated-hooks-{index}.json"));
                atomic_write_json(&path, &inline)?;
                activation.hook_paths.push(path);
            }
            if manifest.mcp_path.is_some() || manifest.mcp_inline.is_some() {
                activation.mcp_servers.push(PluginMcpSource {
                    plugin_id: record.plugin_id.clone(),
                    path: manifest.mcp_path,
                    inline: manifest.mcp_inline,
                });
            }
            if let Some(apps) = manifest.apps {
                activation.apps.push(apps);
            }
        }
        if changed {
            self.save_store(&store)?;
        }
        dedup_paths(&mut activation.skill_roots);
        dedup_paths(&mut activation.hook_paths);
        dedup_paths(&mut activation.apps);
        Ok(activation)
    }

    pub fn set_enabled(&self, plugin_id: &str, enabled: bool) -> Result<(), String> {
        let _guard = self.lock()?;
        validate_plugin_id(plugin_id)?;
        let mut store = self.load_store()?;
        store.enabled_overrides.insert(plugin_id.into(), enabled);
        if let Some(record) = store.installed.get_mut(plugin_id) {
            record.enabled = enabled;
        }
        self.save_store(&store)
    }

    async fn marketplace_add(&self, params: &Value) -> Result<PluginDispatch, String> {
        let source = required_string(params, "source")?;
        let ref_name = optional_string(params, "refName");
        let sparse_paths = params
            .get("sparsePaths")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "sparsePaths must contain strings".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let (root, owned) = if let Some(path) = local_source_path(&source) {
            let root = path
                .canonicalize()
                .map_err(|error| format!("resolve marketplace source: {error}"))?;
            (root, false)
        } else {
            let checkout = self
                .inner
                .paths
                .root
                .join("marketplaces")
                .join(safe_segment(&source));
            if checkout.exists() {
                fs::remove_dir_all(&checkout)
                    .map_err(|error| format!("clear marketplace checkout: {error}"))?;
            }
            let mut command = Command::new("git");
            command.args(["clone", "--depth", "1"]);
            if let Some(reference) = ref_name.as_deref() {
                command.args(["--branch", reference]);
            }
            if !sparse_paths.is_empty() {
                command.arg("--filter=blob:none").arg("--sparse");
            }
            command.arg(&source).arg(&checkout);
            run_git(command, "clone marketplace").await?;
            if !sparse_paths.is_empty() {
                let mut sparse = Command::new("git");
                sparse
                    .arg("-C")
                    .arg(&checkout)
                    .args(["sparse-checkout", "set"]);
                sparse.args(&sparse_paths);
                run_git(sparse, "configure sparse marketplace checkout").await?;
            }
            (checkout, true)
        };
        let (manifest_path, marketplace) = load_marketplace(&root)?;
        let _guard = self.lock()?;
        let mut store = self.load_store()?;
        let already_added = store.marketplaces.contains_key(&marketplace.name);
        store.marketplaces.insert(
            marketplace.name.clone(),
            MarketplaceRecord {
                name: marketplace.name.clone(),
                root: root.clone(),
                manifest_path,
                source,
                owned,
                ref_name,
                sparse_paths,
            },
        );
        self.save_store(&store)?;
        Ok(PluginDispatch {
            result: json!({
                "marketplaceName":marketplace.name,
                "installedRoot":root,
                "alreadyAdded":already_added
            }),
            changed: !already_added,
        })
    }

    fn marketplace_remove(&self, params: &Value) -> Result<PluginDispatch, String> {
        let name = required_string(params, "marketplaceName")?;
        let _guard = self.lock()?;
        let mut store = self.load_store()?;
        let removed = store.marketplaces.remove(&name);
        if let Some(record) = &removed {
            if record.owned
                && record
                    .root
                    .starts_with(self.inner.paths.root.join("marketplaces"))
            {
                let _ = fs::remove_dir_all(&record.root);
            }
        }
        self.save_store(&store)?;
        let changed = removed.is_some();
        Ok(PluginDispatch {
            result: json!({
                "marketplaceName":name,
                "installedRoot":removed.as_ref().map(|record| record.root.clone())
            }),
            changed,
        })
    }

    async fn marketplace_upgrade(&self, params: &Value) -> Result<PluginDispatch, String> {
        let selected = optional_string(params, "marketplaceName");
        let records = {
            let _guard = self.lock()?;
            let store = self.load_store()?;
            store
                .marketplaces
                .values()
                .filter(|record| selected.as_ref().is_none_or(|name| name == &record.name))
                .cloned()
                .collect::<Vec<_>>()
        };
        let mut upgraded_roots = Vec::new();
        let mut errors = Vec::new();
        for record in &records {
            if !record.owned || !record.root.join(".git").exists() {
                continue;
            }
            let backup = self.inner.paths.root.join("rollback").join(format!(
                "marketplace-{}-{}",
                record.name,
                Uuid::now_v7()
            ));
            copy_tree(&record.root, &backup)?;
            let mut command = Command::new("git");
            command
                .arg("-C")
                .arg(&record.root)
                .args(["pull", "--ff-only"]);
            match run_git(command, "upgrade marketplace").await {
                Ok(()) => match load_marketplace(&record.root) {
                    Ok((_, manifest)) if manifest.name == record.name => {
                        upgraded_roots.push(record.root.clone());
                        let _ = fs::remove_dir_all(backup);
                    }
                    Ok(_) | Err(_) => {
                        let _ = fs::remove_dir_all(&record.root);
                        let _ = fs::rename(&backup, &record.root);
                        errors.push(json!({
                            "marketplaceName":record.name,
                            "message":"upgraded marketplace manifest is invalid"
                        }));
                    }
                },
                Err(error) => {
                    let _ = fs::remove_dir_all(&record.root);
                    let _ = fs::rename(&backup, &record.root);
                    errors.push(json!({
                        "marketplaceName":record.name,
                        "message":error
                    }));
                }
            }
        }
        Ok(PluginDispatch {
            result: json!({
                "selectedMarketplaces":records.iter().map(|record|record.name.clone()).collect::<Vec<_>>(),
                "upgradedRoots":upgraded_roots,
                "errors":errors
            }),
            changed: !records.is_empty(),
        })
    }

    fn plugin_install(&self, params: &Value) -> Result<PluginDispatch, String> {
        let name = required_string(params, "pluginName")?;
        let marketplace = self.resolve_marketplace_param(params)?;
        let resolved = self.resolve_plugin(&marketplace, &name)?;
        let plugin_id = format!("{}@{}", resolved.entry.name, marketplace.name);
        validate_plugin_id(&plugin_id)?;
        let version = resolved
            .manifest
            .version
            .clone()
            .or(resolved.entry.version.clone());
        let destination = self
            .inner
            .paths
            .root
            .join("installed")
            .join(safe_segment(&plugin_id));
        let staging = self
            .inner
            .paths
            .root
            .join("installed")
            .join(format!(".staging-{}", Uuid::now_v7()));
        copy_tree(&resolved.source_root, &staging)?;
        load_plugin_manifest(&staging)?;
        let _guard = self.lock()?;
        let mut store = self.load_store()?;
        if destination.exists() {
            let backup = self.inner.paths.root.join("rollback").join(format!(
                "{}-{}",
                safe_segment(&plugin_id),
                Uuid::now_v7()
            ));
            fs::rename(&destination, backup)
                .map_err(|error| format!("backup installed plugin: {error}"))?;
        }
        fs::rename(&staging, &destination)
            .map_err(|error| format!("activate plugin install: {error}"))?;
        let enabled = store
            .enabled_overrides
            .get(&plugin_id)
            .copied()
            .unwrap_or(true);
        store.installed.insert(
            plugin_id.clone(),
            InstalledRecord {
                plugin_id,
                plugin_name: name,
                marketplace_name: marketplace.name,
                root: destination,
                version,
                enabled,
            },
        );
        self.save_store(&store)?;
        Ok(PluginDispatch {
            result: json!({
                "authPolicy":resolved.entry.auth_policy.as_deref().unwrap_or("ON_INSTALL"),
                "appsNeedingAuth":[]
            }),
            changed: true,
        })
    }

    fn plugin_uninstall(&self, params: &Value) -> Result<PluginDispatch, String> {
        let plugin_id = required_string(params, "pluginId")?;
        validate_plugin_id(&plugin_id)?;
        let _guard = self.lock()?;
        let mut store = self.load_store()?;
        let record = store
            .installed
            .remove(&plugin_id)
            .ok_or_else(|| format!("plugin is not installed: {plugin_id}"))?;
        if record
            .root
            .starts_with(self.inner.paths.root.join("installed"))
        {
            fs::remove_dir_all(&record.root)
                .map_err(|error| format!("remove installed plugin: {error}"))?;
        }
        self.save_store(&store)?;
        Ok(PluginDispatch {
            result: json!({}),
            changed: true,
        })
    }

    fn plugin_list(&self, _params: &Value, installed_only: bool) -> Result<PluginDispatch, String> {
        let _guard = self.lock()?;
        let store = self.load_store()?;
        let mut marketplaces = Vec::new();
        let mut errors = Vec::new();
        for record in store.marketplaces.values() {
            match self.marketplace_entry(record, &store, installed_only) {
                Ok(entry)
                    if !installed_only
                        || entry["plugins"].as_array().is_some_and(|v| !v.is_empty()) =>
                {
                    marketplaces.push(entry)
                }
                Ok(_) => {}
                Err(error) => errors.push(json!({
                    "marketplacePath":record.manifest_path,
                    "message":error
                })),
            }
        }
        Ok(PluginDispatch {
            result: if installed_only {
                json!({"marketplaces":marketplaces,"marketplaceLoadErrors":errors})
            } else {
                json!({
                    "marketplaces":marketplaces,
                    "marketplaceLoadErrors":errors,
                    "featuredPluginIds":[]
                })
            },
            changed: false,
        })
    }

    fn plugin_read(&self, params: &Value) -> Result<PluginDispatch, String> {
        let name = required_string(params, "pluginName")?;
        let marketplace = self.resolve_marketplace_param(params)?;
        let _guard = self.lock()?;
        let store = self.load_store()?;
        let resolved = self.resolve_plugin(&marketplace, &name)?;
        Ok(PluginDispatch {
            result: json!({"plugin":plugin_detail(&resolved, &store)?}),
            changed: false,
        })
    }

    fn plugin_skill_read(&self, params: &Value) -> Result<PluginDispatch, String> {
        let marketplace_name = required_string(params, "remoteMarketplaceName")?;
        let plugin_name = required_string(params, "remotePluginId")?;
        let skill_name = required_string(params, "skillName")?;
        validate_segment(&skill_name, "skill name")?;
        let _guard = self.lock()?;
        let store = self.load_store()?;
        let marketplace = store
            .marketplaces
            .get(&marketplace_name)
            .ok_or_else(|| format!("marketplace not found: {marketplace_name}"))?;
        let resolved = self.resolve_plugin(marketplace, &plugin_name)?;
        let contents = resolved
            .manifest
            .skills
            .iter()
            .find(|path| path.file_name().and_then(|name| name.to_str()) == Some(&skill_name))
            .map(|path| path.join("SKILL.md"))
            .filter(|path| path.is_file())
            .map(fs::read_to_string)
            .transpose()
            .map_err(|error| format!("read plugin skill: {error}"))?;
        Ok(PluginDispatch {
            result: json!({"contents":contents}),
            changed: false,
        })
    }

    fn share_save(&self, params: &Value) -> Result<PluginDispatch, String> {
        let source = PathBuf::from(required_string(params, "pluginPath")?);
        let source = source
            .canonicalize()
            .map_err(|error| format!("resolve shared plugin: {error}"))?;
        let manifest = load_plugin_manifest(&source)?;
        let remote_id = optional_string(params, "remotePluginId")
            .unwrap_or_else(|| format!("plugin_{}", Uuid::now_v7().simple()));
        validate_segment(&remote_id, "remote plugin id")?;
        let destination = self.inner.paths.root.join("shares").join(&remote_id);
        let staging = self
            .inner
            .paths
            .root
            .join("shares")
            .join(format!(".staging-{}", Uuid::now_v7()));
        copy_tree(&source, &staging)?;
        if destination.exists() {
            let backup = self
                .inner
                .paths
                .root
                .join("rollback")
                .join(format!("share-{remote_id}-{}", Uuid::now_v7()));
            fs::rename(&destination, backup)
                .map_err(|error| format!("backup shared plugin: {error}"))?;
        }
        fs::rename(staging, &destination)
            .map_err(|error| format!("activate shared plugin: {error}"))?;
        let discoverability = params
            .get("discoverability")
            .and_then(Value::as_str)
            .unwrap_or("PRIVATE");
        validate_discoverability(discoverability)?;
        let targets = params
            .get("shareTargets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let _guard = self.lock()?;
        let mut store = self.load_store()?;
        store.shares.insert(
            remote_id.clone(),
            ShareRecord {
                remote_plugin_id: remote_id.clone(),
                root: destination,
                source_path: source,
                discoverability: discoverability.into(),
                targets,
                version: manifest.version,
            },
        );
        self.save_store(&store)?;
        Ok(PluginDispatch {
            result: json!({
                "remotePluginId":remote_id,
                "shareUrl":format!("tietiezhi://plugins/share/{remote_id}")
            }),
            changed: true,
        })
    }

    fn share_list(&self) -> Result<PluginDispatch, String> {
        let _guard = self.lock()?;
        let store = self.load_store()?;
        let data = store
            .shares
            .values()
            .map(|share| {
                let manifest = load_plugin_manifest(&share.root)?;
                Ok(json!({
                    "plugin":shared_summary(share, &manifest),
                    "localPluginPath":share.source_path
                }))
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(PluginDispatch {
            result: json!({"data":data}),
            changed: false,
        })
    }

    fn share_checkout(&self, params: &Value) -> Result<PluginDispatch, String> {
        let remote_id = required_string(params, "remotePluginId")?;
        validate_segment(&remote_id, "remote plugin id")?;
        let _guard = self.lock()?;
        let store = self.load_store()?;
        let share = store
            .shares
            .get(&remote_id)
            .ok_or_else(|| format!("shared plugin not found: {remote_id}"))?;
        let manifest = load_plugin_manifest(&share.root)?;
        let personal_root = self
            .inner
            .paths
            .personal_marketplace
            .parent()
            .ok_or_else(|| "personal marketplace path has no parent".to_string())?
            .join("plugins")
            .join(safe_segment(&manifest.name));
        let staging = personal_root.with_extension(format!("staging-{}", Uuid::now_v7()));
        copy_tree(&share.root, &staging)?;
        if personal_root.exists() {
            fs::remove_dir_all(&personal_root)
                .map_err(|error| format!("replace personal plugin: {error}"))?;
        }
        if let Some(parent) = personal_root.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create personal plugin root: {error}"))?;
        }
        fs::rename(staging, &personal_root)
            .map_err(|error| format!("activate personal plugin: {error}"))?;
        update_personal_marketplace(
            &self.inner.paths.personal_marketplace,
            &manifest.name,
            &personal_root,
        )?;
        let marketplace_name = "personal-plugins";
        Ok(PluginDispatch {
            result: json!({
                "remotePluginId":remote_id,
                "pluginId":format!("{}@{marketplace_name}",manifest.name),
                "pluginName":manifest.name,
                "pluginPath":personal_root,
                "marketplaceName":marketplace_name,
                "marketplacePath":self.inner.paths.personal_marketplace,
                "remoteVersion":share.version
            }),
            changed: true,
        })
    }

    fn share_delete(&self, params: &Value) -> Result<PluginDispatch, String> {
        let remote_id = required_string(params, "remotePluginId")?;
        validate_segment(&remote_id, "remote plugin id")?;
        let _guard = self.lock()?;
        let mut store = self.load_store()?;
        let share = store
            .shares
            .remove(&remote_id)
            .ok_or_else(|| format!("shared plugin not found: {remote_id}"))?;
        if share.root.starts_with(self.inner.paths.root.join("shares")) {
            fs::remove_dir_all(share.root)
                .map_err(|error| format!("delete shared plugin: {error}"))?;
        }
        self.save_store(&store)?;
        Ok(PluginDispatch {
            result: json!({}),
            changed: true,
        })
    }

    fn share_update_targets(&self, params: &Value) -> Result<PluginDispatch, String> {
        let remote_id = required_string(params, "remotePluginId")?;
        let discoverability = required_string(params, "discoverability")?;
        validate_discoverability(&discoverability)?;
        let targets = params
            .get("shareTargets")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| "shareTargets must be an array".to_string())?;
        let principals = targets
            .iter()
            .map(target_to_principal)
            .collect::<Result<Vec<_>, _>>()?;
        let _guard = self.lock()?;
        let mut store = self.load_store()?;
        let share = store
            .shares
            .get_mut(&remote_id)
            .ok_or_else(|| format!("shared plugin not found: {remote_id}"))?;
        share.discoverability = discoverability.clone();
        share.targets = targets;
        self.save_store(&store)?;
        Ok(PluginDispatch {
            result: json!({
                "principals":principals,
                "discoverability":discoverability
            }),
            changed: true,
        })
    }

    fn marketplace_entry(
        &self,
        record: &MarketplaceRecord,
        store: &PluginStore,
        installed_only: bool,
    ) -> Result<Value, String> {
        let (_, marketplace) = load_marketplace(&record.root)?;
        let plugins = marketplace
            .plugins
            .iter()
            .filter_map(|entry| {
                let resolved = self.resolve_plugin(record, &entry.name).ok()?;
                let id = format!("{}@{}", entry.name, record.name);
                let installed = store.installed.get(&id);
                if installed_only && installed.is_none() {
                    return None;
                }
                Some(plugin_summary(&resolved, installed, None))
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "name":record.name,
            "path":record.manifest_path,
            "interface":marketplace.interface.map(|interface|json!({
                "displayName":interface.get("displayName").and_then(Value::as_str)
            })).unwrap_or(Value::Null),
            "plugins":plugins
        }))
    }

    fn resolve_marketplace_param(&self, params: &Value) -> Result<MarketplaceRecord, String> {
        let store = self.load_store()?;
        if let Some(name) = optional_string(params, "remoteMarketplaceName") {
            return store
                .marketplaces
                .get(&name)
                .cloned()
                .ok_or_else(|| format!("marketplace not found: {name}"));
        }
        let path = optional_string(params, "marketplacePath")
            .ok_or_else(|| "marketplacePath or remoteMarketplaceName is required".to_string())?;
        let path = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| format!("resolve marketplace path: {error}"))?;
        store
            .marketplaces
            .values()
            .find(|record| {
                record
                    .manifest_path
                    .canonicalize()
                    .is_ok_and(|manifest| manifest == path)
                    || record.root.canonicalize().is_ok_and(|root| root == path)
            })
            .cloned()
            .ok_or_else(|| format!("marketplace is not registered: {}", path.display()))
    }

    fn resolve_plugin(
        &self,
        marketplace: &MarketplaceRecord,
        name: &str,
    ) -> Result<ResolvedPlugin, String> {
        validate_segment(name, "plugin name")?;
        let (_, file) = load_marketplace(&marketplace.root)?;
        let mut entry = file
            .plugins
            .into_iter()
            .find(|plugin| plugin.name == name)
            .ok_or_else(|| format!("plugin not found: {name}@{}", marketplace.name))?;
        let source_root = resolve_plugin_source(&marketplace.manifest_path, &entry.source)?;
        entry.interface = normalize_interface(&source_root, entry.interface.as_ref())?;
        let manifest = load_plugin_manifest(&source_root)?;
        Ok(ResolvedPlugin {
            marketplace: marketplace.clone(),
            entry,
            source_root,
            manifest,
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.inner
            .lock
            .lock()
            .map_err(|_| "plugin state lock is poisoned".to_string())
    }

    fn state_path(&self) -> PathBuf {
        self.inner.paths.root.join("state.json")
    }

    fn load_store(&self) -> Result<PluginStore, String> {
        let path = self.state_path();
        if !path.is_file() {
            return Ok(PluginStore::default());
        }
        let bytes = fs::read(&path).map_err(|error| format!("read plugin state: {error}"))?;
        serde_json::from_slice(&bytes).map_err(|error| format!("parse plugin state: {error}"))
    }

    fn save_store(&self, store: &PluginStore) -> Result<(), String> {
        atomic_write_json(&self.state_path(), store)
    }
}

fn load_marketplace(root_or_manifest: &Path) -> Result<(PathBuf, MarketplaceFile), String> {
    let manifest = if root_or_manifest.is_file() {
        root_or_manifest.to_path_buf()
    } else {
        MARKETPLACE_MANIFESTS
            .iter()
            .map(|relative| root_or_manifest.join(relative))
            .find(|path| path.is_file())
            .ok_or_else(|| {
                format!(
                    "marketplace root does not contain a supported manifest: {}",
                    root_or_manifest.display()
                )
            })?
    };
    let bytes =
        fs::read(&manifest).map_err(|error| format!("read marketplace manifest: {error}"))?;
    let file: MarketplaceFile = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse marketplace manifest: {error}"))?;
    validate_segment(&file.name, "marketplace name")?;
    let mut names = BTreeSet::new();
    for plugin in &file.plugins {
        validate_segment(&plugin.name, "plugin name")?;
        if !names.insert(&plugin.name) {
            return Err(format!("duplicate plugin in marketplace: {}", plugin.name));
        }
    }
    Ok((manifest, file))
}

fn load_plugin_manifest(root: &Path) -> Result<PluginManifest, String> {
    let path = root.join(".codex-plugin").join("plugin.json");
    let bytes = fs::read(&path)
        .map_err(|error| format!("read plugin manifest {}: {error}", path.display()))?;
    let raw: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse plugin manifest {}: {error}", path.display()))?;
    let object = raw
        .as_object()
        .ok_or_else(|| "plugin manifest must be an object".to_string())?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .or_else(|| root.file_name().and_then(|name| name.to_str()))
        .ok_or_else(|| "plugin name is required".to_string())?
        .to_owned();
    validate_segment(&name, "plugin name")?;
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let description = object
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let keywords = string_array(object.get("keywords"))?;
    let skills = manifest_paths(root, object.get("skills"), "skills")?;
    let (hooks, inline_hooks) = manifest_hooks(root, object.get("hooks"))?;
    let (mcp_path, mcp_inline) = manifest_mcp(root, object.get("mcpServers"))?;
    let apps = manifest_path(root, object.get("apps"), "apps")?;
    let interface = normalize_interface(root, object.get("interface"))?;
    Ok(PluginManifest {
        name,
        version,
        description,
        keywords,
        skills,
        hooks,
        inline_hooks,
        mcp_path,
        mcp_inline,
        apps,
        interface,
    })
}

fn manifest_paths(root: &Path, value: Option<&Value>, field: &str) -> Result<Vec<PathBuf>, String> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(path)) => Ok(vec![resolve_manifest_path(root, path, field)?]),
        Some(Value::Array(paths)) => paths
            .iter()
            .map(|path| {
                let path = path
                    .as_str()
                    .ok_or_else(|| format!("{field} paths must be strings"))?;
                resolve_manifest_path(root, path, field)
            })
            .collect(),
        Some(_) => Err(format!("{field} must be a path or path array")),
    }
}

fn manifest_path(
    root: &Path,
    value: Option<&Value>,
    field: &str,
) -> Result<Option<PathBuf>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(path)) => resolve_manifest_path(root, path, field).map(Some),
        Some(_) => Err(format!("{field} must be a path")),
    }
}

fn manifest_hooks(
    root: &Path,
    value: Option<&Value>,
) -> Result<(Vec<PathBuf>, Vec<Value>), String> {
    match value {
        None | Some(Value::Null) => Ok((Vec::new(), Vec::new())),
        Some(Value::String(_)) | Some(Value::Array(_))
            if value.is_some_and(|value| {
                value.is_string()
                    || value
                        .as_array()
                        .is_some_and(|items| items.iter().all(Value::is_string))
            }) =>
        {
            Ok((manifest_paths(root, value, "hooks")?, Vec::new()))
        }
        Some(Value::Object(_)) => Ok((Vec::new(), vec![value.unwrap().clone()])),
        Some(Value::Array(values)) if values.iter().all(Value::is_object) => {
            Ok((Vec::new(), values.clone()))
        }
        Some(_) => Err("hooks must be paths or inline Hook objects".into()),
    }
}

fn manifest_mcp(
    root: &Path,
    value: Option<&Value>,
) -> Result<(Option<PathBuf>, Option<Value>), String> {
    match value {
        None | Some(Value::Null) => Ok((None, None)),
        Some(Value::String(path)) => {
            Ok((Some(resolve_manifest_path(root, path, "mcpServers")?), None))
        }
        Some(Value::Object(_)) => Ok((None, value.cloned())),
        Some(_) => Err("mcpServers must be a path or object".into()),
    }
}

fn resolve_manifest_path(root: &Path, relative: &str, field: &str) -> Result<PathBuf, String> {
    if !relative.starts_with("./") {
        return Err(format!("{field} path must start with ./"));
    }
    let relative = Path::new(&relative[2..]);
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!("{field} path escapes plugin root"));
    }
    let path = root.join(relative);
    if !path.exists() {
        return Err(format!("{field} path does not exist: {}", path.display()));
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("resolve plugin root: {error}"))?;
    let path = path
        .canonicalize()
        .map_err(|error| format!("resolve {field} path: {error}"))?;
    if !path.starts_with(root) {
        return Err(format!("{field} path escapes plugin root"));
    }
    Ok(path)
}

fn normalize_interface(root: &Path, value: Option<&Value>) -> Result<Option<Value>, String> {
    let Some(object) = value.and_then(Value::as_object) else {
        return Ok(None);
    };
    let default_prompt = match object.get("defaultPrompt") {
        Some(Value::String(prompt)) => Some(vec![prompt.clone()]),
        Some(Value::Array(prompts)) => Some(
            prompts
                .iter()
                .filter_map(Value::as_str)
                .take(3)
                .map(|prompt| prompt.chars().take(128).collect::<String>())
                .collect(),
        ),
        _ => None,
    };
    let asset = |key: &str| -> Result<Value, String> {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(|path| {
                resolve_manifest_path(root, path, key)
                    .and_then(|path| serde_json::to_value(path).map_err(|error| error.to_string()))
            })
            .transpose()
            .map(|value| value.unwrap_or(Value::Null))
    };
    let screenshots = object
        .get("screenshots")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|path| {
            resolve_manifest_path(root, path, "screenshots")
                .and_then(|path| serde_json::to_value(path).map_err(|error| error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(json!({
        "displayName":optional_object_string(object,"displayName"),
        "shortDescription":optional_object_string(object,"shortDescription"),
        "longDescription":optional_object_string(object,"longDescription"),
        "developerName":optional_object_string(object,"developerName"),
        "category":optional_object_string(object,"category"),
        "capabilities":string_array(object.get("capabilities"))?,
        "websiteUrl":optional_object_string(object,"websiteUrl").or_else(||optional_object_string(object,"websiteURL")),
        "privacyPolicyUrl":optional_object_string(object,"privacyPolicyUrl").or_else(||optional_object_string(object,"privacyPolicyURL")),
        "termsOfServiceUrl":optional_object_string(object,"termsOfServiceUrl").or_else(||optional_object_string(object,"termsOfServiceURL")),
        "defaultPrompt":default_prompt,
        "brandColor":optional_object_string(object,"brandColor"),
        "composerIcon":asset("composerIcon")?,
        "composerIconUrl":Value::Null,
        "logo":asset("logo")?,
        "logoDark":asset("logoDark")?,
        "logoUrl":Value::Null,
        "logoUrlDark":Value::Null,
        "screenshots":screenshots,
        "screenshotUrls":[]
    })))
}

fn plugin_summary(
    resolved: &ResolvedPlugin,
    installed: Option<&InstalledRecord>,
    share: Option<&ShareRecord>,
) -> Value {
    let id = format!("{}@{}", resolved.entry.name, resolved.marketplace.name);
    json!({
        "id":id,
        "remotePluginId":share.map(|share|share.remote_plugin_id.clone()),
        "version":resolved.manifest.version.clone().or(resolved.entry.version.clone()),
        "localVersion":installed.and_then(|record|record.version.clone()),
        "name":resolved.entry.name,
        "shareContext":share.map(share_context),
        "source":{"type":"local","path":resolved.source_root},
        "installed":installed.is_some(),
        "enabled":installed.is_some_and(|record|record.enabled),
        "installPolicy":resolved.entry.install_policy.as_deref().unwrap_or("AVAILABLE"),
        "installPolicySource":Value::Null,
        "mustShowInstallationInterstitial":Value::Null,
        "authPolicy":resolved.entry.auth_policy.as_deref().unwrap_or("ON_INSTALL"),
        "availability":"AVAILABLE",
        "interface":resolved.manifest.interface.clone().or(resolved.entry.interface.clone()),
        "keywords":if resolved.manifest.keywords.is_empty() {
            resolved.entry.keywords.clone()
        } else {
            resolved.manifest.keywords.clone()
        }
    })
}

fn plugin_detail(resolved: &ResolvedPlugin, store: &PluginStore) -> Result<Value, String> {
    let id = format!("{}@{}", resolved.entry.name, resolved.marketplace.name);
    let skills = resolved
        .manifest
        .skills
        .iter()
        .map(skill_summary)
        .collect::<Result<Vec<_>, _>>()?;
    let hooks = hook_summaries(&resolved.manifest)?;
    let apps = app_summaries(resolved.manifest.apps.as_deref())?;
    let mcp_servers =
        if resolved.manifest.mcp_path.is_some() || resolved.manifest.mcp_inline.is_some() {
            vec!["plugin".to_string()]
        } else {
            Vec::new()
        };
    Ok(json!({
        "marketplaceName":resolved.marketplace.name,
        "marketplacePath":resolved.marketplace.manifest_path,
        "summary":plugin_summary(resolved,store.installed.get(&id),None),
        "shareUrl":Value::Null,
        "description":resolved.manifest.description.clone().or(resolved.entry.description.clone()),
        "skills":skills,
        "hooks":hooks,
        "apps":apps,
        "appTemplates":[],
        "mcpServers":mcp_servers,
        "scheduledTasks":Value::Null
    }))
}

fn skill_summary(path: &PathBuf) -> Result<Value, String> {
    let skill_file = path.join("SKILL.md");
    let text = fs::read_to_string(&skill_file)
        .map_err(|error| format!("read skill {}: {error}", skill_file.display()))?;
    let (name, description) = skill_frontmatter(&text).unwrap_or_else(|| {
        (
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("skill")
                .to_owned(),
            String::new(),
        )
    });
    Ok(json!({
        "name":name,
        "description":description,
        "shortDescription":Value::Null,
        "interface":Value::Null,
        "path":path,
        "enabled":true
    }))
}

fn skill_frontmatter(text: &str) -> Option<(String, String)> {
    let body = text.strip_prefix("---\n")?;
    let end = body.find("\n---")?;
    let mut name = None;
    let mut description = None;
    for line in body[..end].lines() {
        if let Some(value) = line.strip_prefix("name:") {
            name = Some(value.trim().trim_matches('"').to_owned());
        } else if let Some(value) = line.strip_prefix("description:") {
            description = Some(value.trim().trim_matches('"').to_owned());
        }
    }
    Some((name?, description.unwrap_or_default()))
}

fn hook_summaries(manifest: &PluginManifest) -> Result<Vec<Value>, String> {
    let mut summaries = Vec::new();
    for (source_index, path) in manifest.hooks.iter().enumerate() {
        let value: Value = serde_json::from_slice(
            &fs::read(path).map_err(|error| format!("read hook file: {error}"))?,
        )
        .map_err(|error| format!("parse hook file: {error}"))?;
        append_hook_summaries(&mut summaries, &value, source_index);
    }
    for (source_index, value) in manifest.inline_hooks.iter().enumerate() {
        append_hook_summaries(&mut summaries, value, source_index + manifest.hooks.len());
    }
    Ok(summaries)
}

fn append_hook_summaries(summaries: &mut Vec<Value>, value: &Value, source_index: usize) {
    let Some(hooks) = value.get("hooks").and_then(Value::as_object) else {
        return;
    };
    for (event, groups) in hooks {
        if event.is_empty() {
            continue;
        }
        let event_name = event[..1].to_ascii_lowercase() + &event[1..];
        let count = groups
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|group| group.get("hooks").and_then(Value::as_array))
            .map(Vec::len)
            .sum::<usize>();
        for index in 0..count {
            summaries.push(json!({
                "key":format!("{source_index}:{event}:{index}"),
                "eventName":event_name
            }));
        }
    }
}

fn app_summaries(path: Option<&Path>) -> Result<Vec<Value>, String> {
    let Some(path) = path else {
        return Ok(Vec::new());
    };
    let value: Value = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("read plugin apps: {error}"))?,
    )
    .map_err(|error| format!("parse plugin apps: {error}"))?;
    let entries = value
        .as_array()
        .cloned()
        .or_else(|| value.get("apps").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    Ok(entries
        .into_iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?;
            let name = entry.get("name").and_then(Value::as_str).unwrap_or(id);
            Some(json!({
                "id":id,
                "name":name,
                "description":entry.get("description").cloned().unwrap_or(Value::Null),
                "installUrl":entry.get("installUrl").cloned().unwrap_or(Value::Null),
                "category":entry.get("category").cloned().unwrap_or(Value::Null)
            }))
        })
        .collect())
}

fn shared_summary(share: &ShareRecord, manifest: &PluginManifest) -> Value {
    json!({
        "id":format!("{}@shared-with-me",manifest.name),
        "remotePluginId":share.remote_plugin_id,
        "version":share.version,
        "localVersion":Value::Null,
        "name":manifest.name,
        "shareContext":share_context(share),
        "source":{"type":"remote"},
        "installed":false,
        "enabled":false,
        "installPolicy":"AVAILABLE",
        "installPolicySource":Value::Null,
        "mustShowInstallationInterstitial":Value::Null,
        "authPolicy":"ON_INSTALL",
        "availability":"AVAILABLE",
        "interface":manifest.interface,
        "keywords":manifest.keywords
    })
}

fn share_context(share: &ShareRecord) -> Value {
    json!({
        "remotePluginId":share.remote_plugin_id,
        "remoteVersion":share.version,
        "discoverability":share.discoverability,
        "shareUrl":format!("tietiezhi://plugins/share/{}",share.remote_plugin_id),
        "creatorAccountUserId":Value::Null,
        "creatorName":Value::Null,
        "sharePrincipals":share.targets.iter().filter_map(|target|target_to_principal(target).ok()).collect::<Vec<_>>()
    })
}

fn target_to_principal(target: &Value) -> Result<Value, String> {
    let kind = target
        .get("principalType")
        .and_then(Value::as_str)
        .ok_or_else(|| "share target principalType is required".to_string())?;
    if !matches!(kind, "user" | "group" | "workspace") {
        return Err(format!("unsupported principalType: {kind}"));
    }
    let id = target
        .get("principalId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "share target principalId is required".to_string())?;
    let role = target
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("reader");
    if !matches!(role, "reader" | "editor") {
        return Err(format!("unsupported share role: {role}"));
    }
    Ok(json!({
        "principalType":kind,
        "principalId":id,
        "role":role,
        "name":id
    }))
}

fn resolve_plugin_source(manifest_path: &Path, source: &Value) -> Result<PathBuf, String> {
    let source = match source {
        Value::String(path) => path.as_str(),
        Value::Object(object) => object
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "only local marketplace plugin sources are installable".to_string())?,
        _ => return Err("invalid marketplace plugin source".into()),
    };
    let parent = manifest_path
        .parent()
        .ok_or_else(|| "marketplace manifest has no parent".to_string())?;
    let path = parent.join(source);
    let parent = parent
        .canonicalize()
        .map_err(|error| format!("resolve marketplace root: {error}"))?;
    let path = path
        .canonicalize()
        .map_err(|error| format!("resolve plugin source: {error}"))?;
    if !path.starts_with(&parent) {
        return Err("plugin source escapes marketplace root".into());
    }
    Ok(path)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!(
            "plugin source is not a directory: {}",
            source.display()
        ));
    }
    if destination.exists() {
        fs::remove_dir_all(destination)
            .map_err(|error| format!("clear staging directory: {error}"))?;
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("create staging directory: {error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("read plugin directory: {error}"))? {
        let entry = entry.map_err(|error| format!("read plugin entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect plugin entry: {error}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "plugin package contains unsupported symlink: {}",
                entry.path().display()
            ));
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target).map_err(|error| format!("copy plugin file: {error}"))?;
        }
    }
    Ok(())
}

fn update_personal_marketplace(path: &Path, plugin_name: &str, root: &Path) -> Result<(), String> {
    let mut value = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_else(|| json!({"name":"personal-plugins","plugins":[]}));
    let plugins = value
        .get_mut("plugins")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "personal marketplace plugins must be an array".to_string())?;
    plugins.retain(|plugin| plugin.get("name").and_then(Value::as_str) != Some(plugin_name));
    let parent = path
        .parent()
        .ok_or_else(|| "personal marketplace path has no parent".to_string())?;
    let relative = root
        .strip_prefix(parent)
        .map_err(|_| "personal plugin must be inside marketplace directory".to_string())?;
    plugins.push(json!({
        "name":plugin_name,
        "source":relative.to_string_lossy()
    }));
    atomic_write_json(path, &value)
}

async fn run_git(mut command: Command, context: &str) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = command
        .output()
        .await
        .map_err(|error| format!("{context}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{context}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn local_source_path(source: &str) -> Option<PathBuf> {
    source
        .strip_prefix("file://")
        .map(PathBuf::from)
        .or_else(|| {
            let path = PathBuf::from(source);
            path.is_absolute().then_some(path)
        })
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| format!("create state directory: {error}"))?;
    let temporary = parent.join(format!(".plugin-state-{}.tmp", Uuid::now_v7()));
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| format!("serialize state: {error}"))?;
    fs::write(&temporary, bytes).map_err(|error| format!("write state: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("replace state: {error}"))
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("{key} is required"))
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn optional_object_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_array(value: Option<&Value>) -> Result<Vec<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "array values must be strings".to_string())
            })
            .collect(),
        Some(_) => Err("value must be a string array".into()),
    }
}

fn validate_plugin_id(value: &str) -> Result<(), String> {
    let (plugin, marketplace) = value
        .rsplit_once('@')
        .ok_or_else(|| "plugin id must be <plugin>@<marketplace>".to_string())?;
    validate_segment(plugin, "plugin name")?;
    validate_segment(marketplace, "marketplace name")
}

fn validate_segment(value: &str, kind: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("invalid {kind}: {value}"));
    }
    Ok(())
}

fn validate_discoverability(value: &str) -> Result<(), String> {
    if matches!(value, "LISTED" | "UNLISTED" | "PRIVATE") {
        Ok(())
    } else {
        Err(format!("invalid plugin discoverability: {value}"))
    }
}

fn safe_segment(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn dedup_paths(paths: &mut Vec<PathBuf>) {
    paths.sort();
    paths.dedup();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> (PluginRuntime, PathBuf) {
        let marketplace_root = root.join("marketplace");
        let plugin_root = marketplace_root
            .join(".agents/plugins")
            .join("plugins/demo");
        fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
        fs::create_dir_all(plugin_root.join("skills/demo")).unwrap();
        fs::create_dir_all(plugin_root.join("hooks")).unwrap();
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            br##"{
              "name":"demo","version":"1.2.3","description":"Demo plugin",
              "skills":["./skills/demo"],"hooks":"./hooks/hooks.json",
              "mcpServers":"./.mcp.json",
              "interface":{"displayName":"Demo","brandColor":"#112233"}
            }"##,
        )
        .unwrap();
        fs::write(
            plugin_root.join(".mcp.json"),
            r#"{"mcpServers":{"demo":{"type":"stdio","command":"true"}}}"#,
        )
        .unwrap();
        fs::write(
            plugin_root.join("skills/demo/SKILL.md"),
            "---\nname: demo\ndescription: Demo skill\n---\nBody\n",
        )
        .unwrap();
        fs::write(
            plugin_root.join("hooks/hooks.json"),
            r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"true"}]}]}}"#,
        )
        .unwrap();
        let manifest = marketplace_root.join(".agents/plugins/marketplace.json");
        fs::write(
            &manifest,
            r#"{"name":"test","plugins":[{"name":"demo","source":"plugins/demo"}]}"#,
        )
        .unwrap();
        let runtime = PluginRuntime::new(PluginPaths {
            root: root.join("runtime"),
            personal_marketplace: root.join("home/.agents/plugins/marketplace.json"),
        })
        .unwrap();
        (runtime, marketplace_root)
    }

    #[tokio::test]
    async fn marketplace_install_list_read_and_uninstall_roundtrip() {
        let root = tempfile::tempdir().unwrap();
        let (runtime, marketplace) = fixture(root.path());
        let added = runtime
            .dispatch(
                "marketplace/add",
                &json!({"source":marketplace.to_string_lossy()}),
            )
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::MarketplaceAddResponse>(&added.result);
        assert_eq!(added.result["marketplaceName"], "test");
        let upgraded = runtime
            .dispatch("marketplace/upgrade", &json!({"marketplaceName":"test"}))
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::MarketplaceUpgradeResponse>(&upgraded.result);
        let installed = runtime
            .dispatch(
                "plugin/install",
                &json!({
                    "marketplacePath":added.result["installedRoot"],
                    "pluginName":"demo"
                }),
            )
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::PluginInstallResponse>(&installed.result);
        assert_eq!(installed.result["authPolicy"], "ON_INSTALL");
        let list = runtime.dispatch("plugin/list", &json!({})).await.unwrap();
        assert_wire::<tietiezhi_agent_protocol::PluginListResponse>(&list.result);
        assert_eq!(
            list.result["marketplaces"][0]["plugins"][0]["installed"],
            true
        );
        let installed_list = runtime
            .dispatch("plugin/installed", &json!({}))
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::PluginInstalledResponse>(&installed_list.result);
        let read = runtime
            .dispatch(
                "plugin/read",
                &json!({"remoteMarketplaceName":"test","pluginName":"demo"}),
            )
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::PluginReadResponse>(&read.result);
        assert_eq!(read.result["plugin"]["skills"][0]["name"], "demo");
        let skill = runtime
            .dispatch(
                "plugin/skill/read",
                &json!({
                    "remoteMarketplaceName":"test",
                    "remotePluginId":"demo",
                    "skillName":"demo"
                }),
            )
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::PluginSkillReadResponse>(&skill.result);
        let activation = runtime.activation().unwrap();
        assert_eq!(activation.skill_roots.len(), 1);
        assert_eq!(activation.hook_paths.len(), 1);
        assert_eq!(activation.mcp_servers.len(), 1);
        runtime.set_enabled("demo@test", false).unwrap();
        assert!(runtime.activation().unwrap().skill_roots.is_empty());
        runtime.set_enabled("demo@test", true).unwrap();
        assert_eq!(runtime.activation().unwrap().skill_roots.len(), 1);
        let uninstalled = runtime
            .dispatch("plugin/uninstall", &json!({"pluginId":"demo@test"}))
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::PluginUninstallResponse>(&uninstalled.result);
        assert!(runtime.activation().unwrap().skill_roots.is_empty());
        let removed = runtime
            .dispatch("marketplace/remove", &json!({"marketplaceName":"test"}))
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::MarketplaceRemoveResponse>(&removed.result);
    }

    #[tokio::test]
    async fn share_save_checkout_targets_and_delete_are_atomic() {
        let root = tempfile::tempdir().unwrap();
        let (runtime, marketplace) = fixture(root.path());
        let plugin = marketplace.join(".agents/plugins/plugins/demo");
        let saved = runtime
            .dispatch(
                "plugin/share/save",
                &json!({"pluginPath":plugin,"discoverability":"PRIVATE"}),
            )
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::PluginShareSaveResponse>(&saved.result);
        let remote_id = saved.result["remotePluginId"].as_str().unwrap();
        let listed = runtime
            .dispatch("plugin/share/list", &json!({}))
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::PluginShareListResponse>(&listed.result);
        let updated = runtime
            .dispatch(
                "plugin/share/updateTargets",
                &json!({
                    "remotePluginId":remote_id,
                    "discoverability":"UNLISTED",
                    "shareTargets":[{
                        "principalType":"user",
                        "principalId":"alice",
                        "role":"editor"
                    }]
                }),
            )
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::PluginShareUpdateTargetsResponse>(&updated.result);
        assert_eq!(updated.result["principals"][0]["name"], "alice");
        let checkout = runtime
            .dispatch(
                "plugin/share/checkout",
                &json!({"remotePluginId":remote_id}),
            )
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::PluginShareCheckoutResponse>(&checkout.result);
        assert!(Path::new(checkout.result["pluginPath"].as_str().unwrap()).is_dir());
        let deleted = runtime
            .dispatch("plugin/share/delete", &json!({"remotePluginId":remote_id}))
            .await
            .unwrap();
        assert_wire::<tietiezhi_agent_protocol::PluginShareDeleteResponse>(&deleted.result);
        assert!(runtime
            .dispatch("plugin/share/list", &json!({}))
            .await
            .unwrap()
            .result["data"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn manifest_paths_cannot_escape_or_follow_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let plugin = root.path().join("plugin");
        fs::create_dir_all(plugin.join(".codex-plugin")).unwrap();
        fs::write(
            plugin.join(".codex-plugin/plugin.json"),
            r#"{"name":"bad","skills":"../outside"}"#,
        )
        .unwrap();
        assert!(load_plugin_manifest(&plugin).is_err());
    }

    fn assert_wire<T>(value: &Value)
    where
        T: serde::de::DeserializeOwned,
    {
        serde_json::from_value::<T>(value.clone()).unwrap();
    }
}
