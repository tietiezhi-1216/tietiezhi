use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use walkdir::{DirEntry, WalkDir};

use crate::agent::loop_::AgentEnv;
use crate::mcp::{McpServerConfig, McpTransport};
use crate::permission::PermissionMode;
use crate::{secrets, skills, AppState};

const CONFIG_VERSION: u32 = 1;
const MAX_CONFIG_PROMPT_BYTES: usize = 64 * 1024;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TIMELINE_BYTES: u64 = 24 * 1024 * 1024;
const MAX_TIMELINE_MESSAGES: usize = 200;
const MAX_LISTED_FILES: usize = 500;
const PROTECTED_FILES: &[&str] = &["SOUL.md", "USER.md", "MEMORY.md"];
const ALLOWED_TOOLS: &[&str] = &[
    "read_file",
    "write_file",
    "edit_file",
    "list_dir",
    "glob",
    "grep",
    "fetch",
    "skill",
    "device_call",
];
const DEFAULT_TOOLS: &[&str] = &[
    "read_file",
    "write_file",
    "edit_file",
    "list_dir",
    "glob",
    "grep",
    "skill",
    "device_call",
];
const BUILTIN_PROMPT: &str = "你是铁铁汁，一个长期陪伴用户的个人 Agent。保持自然、简洁、诚实，不使用产品宣传语。优先理解用户当前真正想完成的事；无法确认的信息要明确说明，不编造记忆、设备状态或执行结果。";

const SOUL_TEMPLATE: &str = r#"# 铁铁汁

这里定义铁铁汁稳定的身份、语气和行为边界。

- 自然、直接，不说空泛的宣传语。
- 记住用户明确要求长期保留的信息。
- 执行操作前确认目标，不伪造执行结果。
"#;

const USER_TEMPLATE: &str = r#"# 关于我

在这里记录希望铁铁汁长期了解的个人偏好、称呼和工作习惯。

## 称呼

## 偏好

## 常用设备与工作流
"#;

const MEMORY_TEMPLATE: &str = r#"# 长期记忆

这里保存跨会话仍然有价值的事实、决定和偏好。

## 重要事实

## 长期决定

## 待持续关注
"#;

const SECRETS_INDEX_TEMPLATE: &str = r#"# 密钥库

这里保存密钥的用途和引用，不保存真实密钥值。

在 MCP 环境变量或 HTTP 请求头中使用 `${secret:name}`。Tietiezhi 只会在 Rust 执行层解析引用，真实值保存在操作系统安全存储中，不会进入提示词或会话记录。
"#;
const SECRET_METADATA_START: &str = "<!-- tietiezhi-secret-metadata\n";
const SECRET_METADATA_END: &str = "\n-->";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TietiezhiConfig {
    pub version: u32,
    pub system_prompt: String,
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub tools: Vec<String>,
    pub permission_mode: String,
    pub memory_enabled: bool,
}

impl Default for TietiezhiConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            system_prompt: String::new(),
            skills: Vec::new(),
            mcp_servers: Vec::new(),
            tools: DEFAULT_TOOLS
                .iter()
                .map(|tool| (*tool).to_string())
                .collect(),
            permission_mode: "ask".into(),
            memory_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TietiezhiAttachment {
    pub id: String,
    #[serde(default)]
    pub kind: Option<String>,
    pub name: String,
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub text_content: Option<String>,
    #[serde(default)]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TietiezhiTimelineMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<TietiezhiAttachment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TietiezhiFileEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified_at: u64,
    pub protected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TietiezhiHomeOverview {
    pub path: String,
    pub file_count: usize,
    pub memory_file_count: usize,
    pub total_size: u64,
    pub timeline_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TietiezhiSecretMeta {
    pub name: String,
    pub label: String,
    pub description: String,
    pub updated_at: u64,
    pub has_value: bool,
    pub reference: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretFileMetadata {
    name: String,
    label: String,
    description: String,
    updated_at: u64,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位配置目录：{error}"))?;
    Ok(dir.join("tietiezhi.json"))
}

pub(crate) fn home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位数据目录：{error}"))?
        .join("tietiezhi");
    ensure_home(&home)?;
    Ok(home)
}

fn ensure_home(home: &Path) -> Result<(), String> {
    std::fs::create_dir_all(home).map_err(|error| format!("创建铁铁汁 Home 失败：{error}"))?;
    for directory in ["memory", "notes", "uploads", "secrets", "sessions"] {
        std::fs::create_dir_all(home.join(directory))
            .map_err(|error| format!("创建铁铁汁目录失败：{error}"))?;
    }
    let marker = home.join(".tietiezhi-home");
    if !marker.exists() {
        std::fs::write(&marker, "managed by Tietiezhi\n")
            .map_err(|error| format!("初始化铁铁汁 Home 标记失败：{error}"))?;
    }
    for (name, content) in [
        ("SOUL.md", SOUL_TEMPLATE),
        ("USER.md", USER_TEMPLATE),
        ("MEMORY.md", MEMORY_TEMPLATE),
    ] {
        let path = home.join(name);
        if !path.exists() {
            std::fs::write(&path, content)
                .map_err(|error| format!("初始化 {name} 失败：{error}"))?;
        }
    }
    let secrets_index = home.join("secrets").join("SECRETS.md");
    if !secrets_index.exists() {
        std::fs::write(&secrets_index, SECRETS_INDEX_TEMPLATE)
            .map_err(|error| format!("初始化密钥索引失败：{error}"))?;
    }
    Ok(())
}

fn normalize_config(mut config: TietiezhiConfig) -> Result<TietiezhiConfig, String> {
    if config.system_prompt.len() > MAX_CONFIG_PROMPT_BYTES {
        return Err("系统指令不能超过 64 KB".into());
    }
    config.version = CONFIG_VERSION;
    config.system_prompt = config.system_prompt.trim().to_string();
    config.skills = unique_nonempty(config.skills);
    config.mcp_servers = unique_nonempty(config.mcp_servers);
    config.tools = unique_nonempty(config.tools)
        .into_iter()
        .filter(|tool| ALLOWED_TOOLS.contains(&tool.as_str()))
        .collect();
    if config.tools.is_empty() {
        config.tools.push("device_call".into());
    }
    if !matches!(config.permission_mode.as_str(), "ask" | "auto" | "full") {
        return Err("权限模式无效".into());
    }
    Ok(config)
}

fn unique_nonempty(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

pub(crate) fn read_config(app: &AppHandle) -> Result<TietiezhiConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        let config = TietiezhiConfig::default();
        write_config(app, &config)?;
        return Ok(config);
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|error| format!("读取铁铁汁配置失败：{error}"))?;
    let config: TietiezhiConfig =
        serde_json::from_str(&raw).map_err(|error| format!("铁铁汁配置损坏：{error}"))?;
    normalize_config(config)
}

fn write_config(app: &AppHandle, config: &TietiezhiConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    }
    let raw = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(path, raw).map_err(|error| format!("保存铁铁汁配置失败：{error}"))
}

fn is_visible_entry(entry: &DirEntry) -> bool {
    entry.depth() == 0
        || (entry.file_name() != "sessions" && entry.file_name() != ".tietiezhi-home")
}

fn relative_path(home: &Path, path: &Path) -> String {
    path.strip_prefix(home)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn modified_at(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn is_protected(relative: &str) -> bool {
    PROTECTED_FILES.contains(&relative)
        || relative == ".tietiezhi-home"
        || relative.starts_with("secrets/")
}

fn list_files_in(home: &Path) -> Result<Vec<TietiezhiFileEntry>, String> {
    let mut files = Vec::new();
    for entry in WalkDir::new(home)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(is_visible_entry)
        .flatten()
        .take(MAX_LISTED_FILES)
    {
        let relative = relative_path(home, entry.path());
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        files.push(TietiezhiFileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            protected: is_protected(&relative),
            path: relative,
            is_directory: metadata.is_dir(),
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
            modified_at: modified_at(&metadata),
        });
    }
    files.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(files)
}

fn resolve_home_path(home: &Path, relative: &str) -> Result<PathBuf, String> {
    let raw = relative.trim();
    if Path::new(raw).has_root() {
        return Err("只能使用铁铁汁 Home 内的相对路径".into());
    }
    let trimmed = raw.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(home.to_path_buf());
    }
    let path = Path::new(trimmed);
    let mut resolved = home.to_path_buf();
    let mut first = true;
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                if first && part == "sessions" {
                    return Err("sessions 是系统管理目录".into());
                }
                resolved.push(part);
                if resolved.exists()
                    && std::fs::symlink_metadata(&resolved)
                        .map(|metadata| metadata.file_type().is_symlink())
                        .unwrap_or(false)
                {
                    return Err("不允许通过软链接访问铁铁汁 Home 外部".into());
                }
                first = false;
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("文件路径不能包含上级目录".into());
            }
        }
    }
    Ok(resolved)
}

fn read_bounded(path: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(path).map_err(|error| format!("读取文件失败：{error}"))?;
    if !metadata.is_file() {
        return Err("请选择文本文件".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("控制中心只能编辑不超过 1 MB 的文本文件".into());
    }
    std::fs::read_to_string(path).map_err(|_| "文件不是有效的 UTF-8 文本".into())
}

fn prompt_document(home: &Path, name: &str) -> String {
    let path = home.join(name);
    read_bounded(&path)
        .ok()
        .map(|content| {
            let bounded: String = content.chars().take(12_000).collect();
            format!("<{name}>\n{bounded}\n</{name}>")
        })
        .unwrap_or_default()
}

fn validate_secret_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        });
    if valid {
        Ok(())
    } else {
        Err("密钥名称只能包含小写字母、数字、- 和 _，且不能超过 64 个字符".into())
    }
}

fn secret_file_path(home: &Path, name: &str) -> Result<PathBuf, String> {
    validate_secret_name(name)?;
    Ok(home.join("secrets").join(format!("{name}.md")))
}

fn parse_secret_metadata(content: &str) -> Option<SecretFileMetadata> {
    let raw = content
        .strip_prefix(SECRET_METADATA_START)?
        .split_once(SECRET_METADATA_END)?
        .0;
    serde_json::from_str(raw).ok()
}

fn list_secret_metadata(home: &Path) -> Result<Vec<SecretFileMetadata>, String> {
    let directory = home.join("secrets");
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(directory)
        .map_err(|error| format!("读取密钥目录失败：{error}"))?
        .flatten()
    {
        if !entry.path().is_file() || entry.file_name() == "SECRETS.md" {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Some(metadata) = parse_secret_metadata(&content) else {
            continue;
        };
        let file_matches = entry
            .path()
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem == metadata.name);
        if file_matches && validate_secret_name(&metadata.name).is_ok() {
            entries.push(metadata);
        }
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

fn secret_document(metadata: &SecretFileMetadata) -> Result<String, String> {
    let metadata_json = serde_json::to_string(metadata).map_err(|error| error.to_string())?;
    Ok(format!(
        "{SECRET_METADATA_START}{metadata_json}{SECRET_METADATA_END}\n\n\
         # {}\n\n\
         - 引用：`${{secret:{}}}`\n\
         - 存储：操作系统安全存储\n\
         - 最后更新：{}\n\n\
         {}\n",
        metadata.label, metadata.name, metadata.updated_at, metadata.description
    ))
}

fn markdown_cell(value: &str) -> String {
    value.replace(['\r', '\n'], " ").replace('|', "\\|")
}

fn write_secret_index(home: &Path, metadata: &[SecretFileMetadata]) -> Result<(), String> {
    let mut content = format!("{SECRETS_INDEX_TEMPLATE}\n\n");
    if metadata.is_empty() {
        content.push_str("当前没有已登记的密钥。\n");
    } else {
        content.push_str("| 名称 | 引用 | 用途 |\n| --- | --- | --- |\n");
        for item in metadata {
            content.push_str(&format!(
                "| {} | `${{secret:{}}}` | {} |\n",
                markdown_cell(&item.label),
                item.name,
                markdown_cell(&item.description)
            ));
        }
    }
    std::fs::write(home.join("secrets").join("SECRETS.md"), content)
        .map_err(|error| format!("更新密钥索引失败：{error}"))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn substitute_secret_references(
    input: &str,
    mut lookup: impl FnMut(&str) -> Result<Option<String>, String>,
) -> Result<String, String> {
    const PREFIX: &str = "${secret:";
    let mut remaining = input;
    let mut output = String::with_capacity(input.len());
    while let Some(start) = remaining.find(PREFIX) {
        output.push_str(&remaining[..start]);
        let reference = &remaining[start + PREFIX.len()..];
        let Some(end) = reference.find('}') else {
            output.push_str(&remaining[start..]);
            return Ok(output);
        };
        let name = &reference[..end];
        validate_secret_name(name)?;
        let value = lookup(name)?.ok_or_else(|| format!("密钥引用未配置：${{secret:{name}}}"))?;
        output.push_str(&value);
        remaining = &reference[end + 1..];
    }
    output.push_str(remaining);
    Ok(output)
}

pub(crate) fn resolve_secret_references(_app: &AppHandle, input: &str) -> Result<String, String> {
    substitute_secret_references(input, secrets::get_tietiezhi_secret)
}

pub(crate) fn resolve_json_secret_references(
    app: &AppHandle,
    value: &mut serde_json::Value,
) -> Result<(), String> {
    match value {
        serde_json::Value::String(text) => {
            *text = resolve_secret_references(app, text)?;
        }
        serde_json::Value::Array(items) => {
            for item in items {
                resolve_json_secret_references(app, item)?;
            }
        }
        serde_json::Value::Object(fields) => {
            for value in fields.values_mut() {
                resolve_json_secret_references(app, value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn redact_tietiezhi_secret_values(app: &AppHandle, input: &str) -> String {
    let Ok(home) = home_dir(app) else {
        return input.to_string();
    };
    let Ok(metadata) = list_secret_metadata(&home) else {
        return input.to_string();
    };
    let mut redacted = input.to_string();
    for item in metadata {
        let Ok(Some(value)) = secrets::get_tietiezhi_secret(&item.name) else {
            continue;
        };
        if !value.is_empty() {
            redacted = redacted.replace(&value, &format!("${{secret:{}}}", item.name));
        }
    }
    redacted
}

pub(crate) fn resolve_mcp_config_secrets(
    app: &AppHandle,
    config: &McpServerConfig,
) -> Result<McpServerConfig, String> {
    let mut resolved = config.clone();
    match &mut resolved.transport {
        McpTransport::Stdio { env, .. } => {
            for value in env.values_mut() {
                *value = resolve_secret_references(app, value)?;
            }
        }
        McpTransport::Http { headers, .. } => {
            for value in headers.values_mut() {
                *value = resolve_secret_references(app, value)?;
            }
        }
    }
    Ok(resolved)
}

pub(crate) fn resolve_env(
    app: &AppHandle,
    device_id: &str,
    device_name: &str,
) -> Result<AgentEnv, String> {
    let config = read_config(app)?;
    let settings = super::settings::read_settings(app)?;
    let home = home_dir(app)?;

    let skill_list = skills::list(app, &settings.skills_disabled)?;
    let available_skills: Vec<String> = skill_list
        .iter()
        .filter(|skill| skill.enabled && config.skills.contains(&skill.name))
        .map(|skill| skill.name.clone())
        .collect();
    let skill_summary = skill_list
        .iter()
        .filter(|skill| available_skills.contains(&skill.name))
        .map(|skill| format!("- {}：{}", skill.name, skill.description))
        .collect::<Vec<_>>()
        .join("\n");
    let mcp_configs = settings
        .mcp_servers
        .iter()
        .filter(|server| server.enabled && config.mcp_servers.contains(&server.id))
        .map(|server| resolve_mcp_config_secrets(app, server))
        .collect::<Result<Vec<_>, _>>()?;

    let identity = if config.system_prompt.is_empty() {
        BUILTIN_PROMPT
    } else {
        &config.system_prompt
    };
    let memory_context = if config.memory_enabled {
        [
            prompt_document(&home, "SOUL.md"),
            prompt_document(&home, "USER.md"),
            prompt_document(&home, "MEMORY.md"),
        ]
        .into_iter()
        .filter(|document| !document.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
    } else {
        String::new()
    };
    let skills_context = if skill_summary.is_empty() {
        "本轮没有分配可用 Skill。".to_string()
    } else {
        format!("当前分配的 Skills 如下。需要时先调用 skill 读取完整说明：\n{skill_summary}")
    };
    let system_prompt = format!(
        "{identity}\n\n\
         铁铁汁 Home 是当前唯一工作目录。SOUL.md、USER.md、MEMORY.md 和 memory/ 用于用户可控的长期资料；notes/ 保存普通笔记，uploads/ 保存导入文件。所有工具路径都使用相对 Home 的路径。只有值得跨会话保留且用户允许的信息才写入 MEMORY.md，不要把每轮对话都当作记忆。\n\n\
         {memory_context}\n\n\
         {skills_context}\n\n\
         secrets/ 只包含密钥名称、用途和 ${{secret:name}} 引用，不包含真实值。不要要求读取或输出真实密钥；执行层会在获准的 MCP 或设备调用中解析引用。\n\n\
         当前用户选择的目标设备是“{device_name}”，设备 ID 必须原样使用：{device_id}。用户明确要求查看或操作设备时调用 device_call；不要编造设备状态或声称未执行的操作已经完成。普通交流无需调用设备工具。"
    );

    Ok(AgentEnv {
        system_prompt,
        allowed_tools: config.tools,
        available_skills,
        permission_mode: PermissionMode::parse(&config.permission_mode),
        mcp_configs,
        workspace: home,
    })
}

#[tauri::command]
pub fn get_tietiezhi_config(app: AppHandle) -> Result<TietiezhiConfig, String> {
    let _ = home_dir(&app)?;
    read_config(&app)
}

#[tauri::command]
pub fn save_tietiezhi_config(
    app: AppHandle,
    config: TietiezhiConfig,
) -> Result<TietiezhiConfig, String> {
    let config = normalize_config(config)?;
    write_config(&app, &config)?;
    Ok(config)
}

#[tauri::command]
pub fn list_tietiezhi_files(app: AppHandle) -> Result<Vec<TietiezhiFileEntry>, String> {
    let home = home_dir(&app)?;
    list_files_in(&home)
}

#[tauri::command]
pub fn list_tietiezhi_secrets(app: AppHandle) -> Result<Vec<TietiezhiSecretMeta>, String> {
    let home = home_dir(&app)?;
    list_secret_metadata(&home)?
        .into_iter()
        .map(|metadata| {
            let has_value = secrets::get_tietiezhi_secret(&metadata.name)?.is_some();
            Ok(TietiezhiSecretMeta {
                reference: format!("${{secret:{}}}", metadata.name),
                name: metadata.name,
                label: metadata.label,
                description: metadata.description,
                updated_at: metadata.updated_at,
                has_value,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn upsert_tietiezhi_secret(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    label: String,
    description: String,
    value: Option<String>,
) -> Result<TietiezhiSecretMeta, String> {
    let name = name.trim().to_string();
    validate_secret_name(&name)?;
    let label = label.trim().replace(['\r', '\n'], " ");
    if label.is_empty() || label.chars().count() > 80 {
        return Err("密钥显示名称不能为空且不能超过 80 个字符".into());
    }
    let description = description.trim().to_string();
    if description.chars().count() > 500 {
        return Err("密钥用途不能超过 500 个字符".into());
    }
    if value.as_deref().is_some_and(str::is_empty) {
        return Err("密钥值不能为空".into());
    }

    let home = home_dir(&app)?;
    let had_value = secrets::get_tietiezhi_secret(&name)?.is_some();
    if !had_value && value.is_none() {
        return Err("新密钥需要填写密钥值".into());
    }
    let metadata = SecretFileMetadata {
        name: name.clone(),
        label: label.clone(),
        description: description.clone(),
        updated_at: now_millis(),
    };
    std::fs::write(secret_file_path(&home, &name)?, secret_document(&metadata)?)
        .map_err(|error| format!("保存密钥说明失败：{error}"))?;
    if let Some(value) = value {
        secrets::set_tietiezhi_secret(&name, &value)?;
    }
    let all_metadata = list_secret_metadata(&home)?;
    write_secret_index(&home, &all_metadata)?;
    let settings = super::settings::read_settings(&app)?;
    for server in &settings.mcp_servers {
        state.mcp.stop(&server.id).await;
    }
    Ok(TietiezhiSecretMeta {
        name: name.clone(),
        label,
        description,
        updated_at: metadata.updated_at,
        has_value: true,
        reference: format!("${{secret:{name}}}"),
    })
}

#[tauri::command]
pub fn reveal_tietiezhi_secret(name: String) -> Result<String, String> {
    validate_secret_name(&name)?;
    secrets::get_tietiezhi_secret(&name)?.ok_or_else(|| "密钥值不存在，请重新保存".into())
}

#[tauri::command]
pub async fn delete_tietiezhi_secret(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    validate_secret_name(&name)?;
    let home = home_dir(&app)?;
    secrets::delete_tietiezhi_secret(&name)?;
    let path = secret_file_path(&home, &name)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| format!("删除密钥说明失败：{error}"))?;
    }
    let metadata = list_secret_metadata(&home)?;
    write_secret_index(&home, &metadata)?;
    let settings = super::settings::read_settings(&app)?;
    for server in &settings.mcp_servers {
        state.mcp.stop(&server.id).await;
    }
    Ok(())
}

#[tauri::command]
pub fn read_tietiezhi_file(app: AppHandle, path: String) -> Result<String, String> {
    let home = home_dir(&app)?;
    read_bounded(&resolve_home_path(&home, &path)?)
}

#[tauri::command]
pub fn write_tietiezhi_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("控制中心只能保存不超过 1 MB 的文本文件".into());
    }
    let home = home_dir(&app)?;
    let resolved = resolve_home_path(&home, &path)?;
    let relative = relative_path(&home, &resolved);
    if relative == ".tietiezhi-home" {
        return Err("铁铁汁 Home 标记由系统管理".into());
    }
    if relative.starts_with("secrets/") {
        return Err("密钥说明由密钥库管理，请在“密钥库”面板中修改".into());
    }
    if resolved == home {
        return Err("请输入文件名".into());
    }
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    std::fs::write(resolved, content).map_err(|error| format!("保存文件失败：{error}"))
}

#[tauri::command]
pub fn delete_tietiezhi_file(app: AppHandle, path: String) -> Result<(), String> {
    let home = home_dir(&app)?;
    let resolved = resolve_home_path(&home, &path)?;
    let relative = relative_path(&home, &resolved);
    if is_protected(&relative) {
        return Err("核心记忆文件不能删除，可以清空或编辑内容".into());
    }
    if resolved.is_dir() {
        std::fs::remove_dir(&resolved).map_err(|error| format!("删除空目录失败：{error}"))
    } else {
        std::fs::remove_file(&resolved).map_err(|error| format!("删除文件失败：{error}"))
    }
}

#[tauri::command]
pub fn tietiezhi_home_overview(app: AppHandle) -> Result<TietiezhiHomeOverview, String> {
    let home = home_dir(&app)?;
    let files = list_files_in(&home)?;
    let timeline_count = load_timeline_from(&home)?.len();
    Ok(TietiezhiHomeOverview {
        path: home.to_string_lossy().into_owned(),
        file_count: files.iter().filter(|entry| !entry.is_directory).count(),
        memory_file_count: files
            .iter()
            .filter(|entry| {
                !entry.is_directory
                    && (entry.path == "MEMORY.md" || entry.path.starts_with("memory/"))
            })
            .count(),
        total_size: files.iter().map(|entry| entry.size).sum(),
        timeline_count,
    })
}

#[tauri::command]
pub fn reveal_tietiezhi_home(app: AppHandle) -> Result<(), String> {
    let home = home_dir(&app)?;
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = crate::process::background_command("open");
        command.arg(&home);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = crate::process::background_command("explorer");
        command.arg(&home);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = crate::process::background_command("xdg-open");
        command.arg(&home);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开铁铁汁 Home 失败：{error}"))
}

fn timeline_path(home: &Path) -> PathBuf {
    home.join("sessions").join("main.json")
}

fn load_timeline_from(home: &Path) -> Result<Vec<TietiezhiTimelineMessage>, String> {
    let path = timeline_path(home);
    if !path.exists() {
        return Ok(Vec::new());
    }
    if std::fs::metadata(&path)
        .map(|metadata| metadata.len() > MAX_TIMELINE_BYTES)
        .unwrap_or(false)
    {
        return Err("铁铁汁会话文件超过 24 MB，请先备份后清理".into());
    }
    let raw =
        std::fs::read_to_string(path).map_err(|error| format!("读取铁铁汁会话失败：{error}"))?;
    let messages: Vec<TietiezhiTimelineMessage> =
        serde_json::from_str(&raw).map_err(|error| format!("铁铁汁会话文件损坏：{error}"))?;
    Ok(messages
        .into_iter()
        .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
        .rev()
        .take(MAX_TIMELINE_MESSAGES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect())
}

#[tauri::command]
pub fn load_tietiezhi_timeline(app: AppHandle) -> Result<Vec<TietiezhiTimelineMessage>, String> {
    load_timeline_from(&home_dir(&app)?)
}

#[tauri::command]
pub fn save_tietiezhi_timeline(
    app: AppHandle,
    messages: Vec<TietiezhiTimelineMessage>,
) -> Result<(), String> {
    let home = home_dir(&app)?;
    let messages = messages
        .into_iter()
        .filter(|message| {
            !message.id.trim().is_empty()
                && matches!(message.role.as_str(), "user" | "assistant")
                && message.content.len() <= MAX_FILE_BYTES as usize
                && message.attachments.len() <= 12
                && message.attachments.iter().all(|attachment| {
                    attachment
                        .text_content
                        .as_ref()
                        .map(|content| content.len() <= MAX_FILE_BYTES as usize)
                        .unwrap_or(true)
                })
        })
        .rev()
        .take(MAX_TIMELINE_MESSAGES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let raw = serde_json::to_string_pretty(&messages).map_err(|error| error.to_string())?;
    if raw.len() as u64 > MAX_TIMELINE_BYTES {
        return Err("铁铁汁会话记录超过 24 MB，请减少大型文本附件".into());
    }
    std::fs::write(timeline_path(&home), raw)
        .map_err(|error| format!("保存铁铁汁会话失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_rejects_unknown_tools_and_keeps_nonempty_allowlist() {
        let config = normalize_config(TietiezhiConfig {
            tools: vec!["bash".into(), "not-real".into()],
            ..TietiezhiConfig::default()
        })
        .unwrap();
        assert_eq!(config.tools, vec!["device_call"]);
    }

    #[test]
    fn path_resolution_rejects_escape_and_system_session() {
        let home = Path::new("/tmp/tietiezhi");
        assert!(resolve_home_path(home, "../settings.json").is_err());
        assert!(resolve_home_path(home, "/etc/passwd").is_err());
        assert!(resolve_home_path(home, "sessions/main.json").is_err());
        assert_eq!(
            resolve_home_path(home, "notes/today.md").unwrap(),
            home.join("notes/today.md")
        );
    }

    #[test]
    fn secret_references_keep_a_stable_explicit_shape() {
        assert!(validate_secret_name("github_token").is_ok());
        assert!(validate_secret_name("GitHub Token").is_err());
        assert!(validate_secret_name("../token").is_err());
        let metadata = SecretFileMetadata {
            name: "github_token".into(),
            label: "GitHub Token".into(),
            description: "发布代码".into(),
            updated_at: 42,
        };
        let document = secret_document(&metadata).unwrap();
        assert!(document.contains("${secret:github_token}"));
        assert_eq!(
            parse_secret_metadata(&document).unwrap().name,
            "github_token"
        );
        let resolved = substitute_secret_references(
            "Bearer ${secret:github_token}; ${secret:region}",
            |name| {
                Ok(Some(
                    match name {
                        "github_token" => "secret-value",
                        "region" => "cn",
                        _ => return Ok(None),
                    }
                    .into(),
                ))
            },
        )
        .unwrap();
        assert_eq!(resolved, "Bearer secret-value; cn");
        assert!(substitute_secret_references("${secret:missing}", |_| Ok(None)).is_err());
    }
}
