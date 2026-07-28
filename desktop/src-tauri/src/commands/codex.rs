use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use chrono::Local;
use futures_util::stream::{FuturesUnordered, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tietiezhi_agent_account::{
    AccountDispatchOutput, AccountNotification, AccountRpcError, AccountServerRequest,
    ImmediateLogin,
};
use tietiezhi_agent_approval::{
    category_approval_requirement, ApprovalCategory, ApprovalKey, ApprovalRequirement,
    AskForApproval, CommandExecutionApprovalDecision, CommandExecutionApprovalParams,
    FileChangeApprovalDecision, FileChangeApprovalParams, PermissionsApprovalParams,
    PersistentApprovalRule, PersistentApprovalStore, RoutedServerRequest as ApprovalServerRequest,
    UserInputRequestParams,
};
use tietiezhi_agent_apps::{
    device_app, is_read_only_device_capability, AppCatalog, AppToolDefinition,
    DEVICE_LIST_TOOL_NAME, DEVICE_TOOL_NAME, DEVICE_TOOL_NAMESPACE,
};
use tietiezhi_agent_collab::{
    AgentStatus as CollabAgentStatus, CollaborationConfig, CollaborationError, CollaborationHost,
    CollaborationRuntime, CollaborationTools, ForkTurns, HostFuture, MailboxMessage, SpawnRequest,
    SpawnedAgent,
};
use tietiezhi_agent_config::{
    build_world_state, load_project_instructions, strip_internal_world_state_metadata, ConfigPaths,
    ConfigRuntime, ProjectInstructionConfig, WorldStateInput,
};
use tietiezhi_agent_context::compaction_prompt_history;
use tietiezhi_agent_core::{
    CompactionExecutionSnapshot, DispatchOutput, MemoryRolloutCandidate as CoreMemoryCandidate,
    RoutedNotification, RuntimeDefaults, SubagentThreadConfig, ThreadManager,
    TurnExecutionSnapshot,
};
use tietiezhi_agent_execpolicy::{
    ApprovalPolicy as ExecApprovalPolicy, EvaluationContext as ExecEvaluationContext,
    ExecPolicyOutcome as RuntimeExecPolicyOutcome,
};
use tietiezhi_agent_hooks::{
    HookDispatch, HookEngine, HookEventName, HookPaths, HookRequest, HookSource,
    PermissionDecision as HookPermissionDecision,
};
use tietiezhi_agent_memory::{
    build_consolidation_prompt, build_stage_one_input, consolidation_output_schema,
    stage_one_output_schema, strip_and_parse_memory_citation, MemoriesConfig, MemoryRuntime,
    RolloutCandidate, SearchMatchMode, ThreadMemoryMode, STAGE_ONE_SYSTEM_PROMPT,
};
use tietiezhi_agent_model::{
    list_online_models, supports_original_image_detail, ModelError, OnlineModel, Reasoning,
    ResponseEvent, ResponsesApiRequest, ResponsesClient, TextControls, TextFormat, TextFormatType,
};
use tietiezhi_agent_network::{
    NetworkApprovalDecision, NetworkDomainPermission, NetworkExecutionRequest, NetworkMode,
    NetworkPolicy, NetworkPolicyAmendment,
};
use tietiezhi_agent_observability::{
    DoctorInput, DoctorReport, FeedbackUpload, MetricsSnapshot, Observability, ObservabilityConfig,
    RoutedServerRequest as OperationsServerRequest, StructuredEvent,
};
use tietiezhi_agent_plugins::{PluginActivation, PluginMcpSource, PluginPaths, PluginRuntime};
use tietiezhi_agent_protocol::{
    AppsInstalledResponse, AppsListResponse, AppsReadResponse, ClientNotification, ClientRequest,
    ExternalAgentConfigDetectResponse, ExternalAgentConfigImportHistoriesReadResponse,
    ExternalAgentConfigImportResponse, JSONRPCRequest, JSONRPCResponse,
    ListMcpServerStatusResponse, MarketplaceAddResponse, MarketplaceRemoveResponse,
    MarketplaceUpgradeResponse, McpResourceReadResponse, McpServerOauthLoginResponse,
    McpServerToolCallResponse, ModelListResponse, ModelProviderCapabilitiesReadResponse,
    PermissionProfileListResponse, PluginInstallResponse, PluginInstalledResponse,
    PluginListResponse, PluginReadResponse, PluginShareCheckoutResponse, PluginShareDeleteResponse,
    PluginShareListResponse, PluginShareSaveResponse, PluginShareUpdateTargetsResponse,
    PluginSkillReadResponse, PluginUninstallResponse, ServerNotification,
};
use tietiezhi_agent_realtime::{
    AudioChunk as RealtimeAudioChunk, NotificationSink, RealtimeProvider,
    StartParams as RealtimeStartParams,
};
use tietiezhi_agent_remote::{RemoteClientMetadata, RemoteControlRuntime, RemoteRequestAdmission};
use tietiezhi_agent_review::{
    guardian_completed_notification, guardian_output_schema, guardian_prompt,
    guardian_started_notification, parse_guardian_assessment, parse_review_output,
    render_review_output, review_output_schema, CircuitBreakerAction, GuardianAction,
    GuardianApprovalReviewStatus, GuardianAssessment, GuardianAssessmentOutcome,
    GuardianCommandSource, GUARDIAN_POLICY, GUARDIAN_REVIEW_TIMEOUT_SECS, REVIEW_RUBRIC,
};
use tietiezhi_agent_skills::{SkillsPaths, SkillsRuntime};
use tietiezhi_agent_tools::builtins::{
    apply_patch_handler, context_remaining_handler, current_time_handler,
    request_permissions_handler, request_user_input_handler, sleep_handler, unified_exec_handlers,
    update_plan_handler, view_image_handler, web_search_handler, CommandApprovalRequest,
    CommandNetworkRequest, CommandPolicyOutcome, CommandPolicyRequest, CommandRuntimeEvent,
    FileChangeApprovalRequest, PermissionsApprovalRequest, UserInputRequest,
};
use tietiezhi_agent_tools::{
    ToolCall, ToolCallRuntime, ToolError, ToolFuture, ToolHandler, ToolInvocation,
    ToolModelCallResult, ToolName, ToolOutput, ToolPayload, ToolRegistry, ToolRouter, ToolSpec,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::AppState;

const CODEX_NOTIFICATION_EVENT: &str = "codex-v2-notification";
const CODEX_SERVER_REQUEST_EVENT: &str = "codex-v2-server-request";

#[derive(Debug, Clone, Default)]
pub(crate) struct CodexConnectionState {
    initialized: bool,
    experimental_api: bool,
    request_attestation: bool,
    mcp_server_openai_form_elicitation: bool,
    opt_out_notification_methods: HashSet<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ExternalAuthTokens {
    access_token: String,
    account_id: String,
    plan_type: Option<String>,
}

fn runtime_defaults(app: &AppHandle) -> Result<RuntimeDefaults, String> {
    let settings = super::settings::read_settings(app)?;
    let model_context_windows = settings
        .providers
        .iter()
        .find(|provider| provider.id == settings.chat_provider_id)
        .map(|provider| {
            provider
                .models
                .iter()
                .filter_map(|model| {
                    let context_window = model.context_window?;
                    let context_window = i64::try_from(context_window).ok()?;
                    (context_window > 0).then(|| (model.id.to_ascii_lowercase(), context_window))
                })
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let cwd = dirs::home_dir()
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| "无法定位默认工作目录".to_string())?;
    let approval_policy = match settings.permission_mode.as_str() {
        "ask" => json!("untrusted"),
        "full" => json!("never"),
        _ => json!("on-request"),
    };
    let sandbox = if settings.permission_mode == "full" {
        json!({"type": "dangerFullAccess"})
    } else {
        json!({
            "type": "workspaceWrite",
            "writableRoots": [cwd],
            "networkAccess": false,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false
        })
    };
    let selected_reasoning =
        super::models::ReasoningEffort::from_setting(&settings.chat_reasoning_effort);
    let reasoning_effort = settings
        .providers
        .iter()
        .find(|provider| provider.id == settings.chat_provider_id)
        .and_then(|provider| {
            provider
                .models
                .iter()
                .find(|model| model.id == settings.chat_model)
        })
        .and_then(|model| model.effective_reasoning())
        .and_then(|profile| resolve_runtime_reasoning_effort(profile, selected_reasoning));
    Ok(RuntimeDefaults {
        model: nonempty_or_unconfigured(settings.chat_model),
        model_provider: nonempty_or_unconfigured(settings.chat_provider_id),
        cwd,
        approval_policy,
        approvals_reviewer: "user".into(),
        sandbox,
        reasoning_effort,
        service_tier: None,
        model_context_windows,
        cli_version: env!("CARGO_PKG_VERSION").into(),
    })
}

fn resolve_runtime_reasoning_effort(
    profile: &super::models::ReasoningProfile,
    selected: super::models::ReasoningEffort,
) -> Option<String> {
    if profile.mode == super::models::ReasoningMode::Fixed {
        return None;
    }
    let effort = if selected == super::models::ReasoningEffort::Auto {
        profile.default_effort?
    } else if profile.supported_efforts.contains(&selected) {
        selected
    } else {
        profile.default_effort?
    };
    profile
        .supported_efforts
        .contains(&effort)
        .then(|| effort.as_wire_value())
        .flatten()
        .map(str::to_owned)
}

fn nonempty_or_unconfigured(value: String) -> String {
    if value.trim().is_empty() {
        "unconfigured".into()
    } else {
        value
    }
}

pub(crate) fn thread_manager(app: &AppHandle, state: &AppState) -> Result<ThreadManager, String> {
    let mut slot = state
        .codex_core
        .lock()
        .map_err(|_| "Codex Runtime 状态锁已损坏".to_string())?;
    if let Some(manager) = slot.as_ref() {
        return Ok(manager.clone());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let manager = ThreadManager::open(
        app_data.join("agent-runtime"),
        app_data.join("tasks"),
        runtime_defaults(app)?,
    )
    .map_err(|error| format!("初始化 Codex Runtime 失败：{error:?}"))?;
    super::conversations::migrate_tasks_to_codex(app, &manager)?;
    *slot = Some(manager.clone());
    Ok(manager)
}

fn initialize_connection(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("initialize 参数不符合 App Server V2：{error}"),
        ));
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let capabilities = params
        .get("capabilities")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut connections = state
        .codex_connections
        .lock()
        .map_err(|_| "Codex 连接状态锁已损坏".to_string())?;
    if connections.contains_key(connection_id) {
        return Ok(dispatch_error(
            request,
            -32600,
            "connection already initialized",
        ));
    }
    connections.insert(
        connection_id.to_owned(),
        CodexConnectionState {
            initialized: false,
            experimental_api: capabilities
                .get("experimentalApi")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            request_attestation: capabilities
                .get("requestAttestation")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            mcp_server_openai_form_elicitation: capabilities
                .get("mcpServerOpenaiFormElicitation")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            opt_out_notification_methods: capabilities
                .get("optOutNotificationMethods")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        },
    );
    drop(connections);
    state
        .codex_account
        .register_connection(connection_id)
        .map_err(account_rpc_error)?;
    let codex_home = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位 Codex 配置目录：{error}"))?
        .join("codex");
    dispatch_success(
        request,
        json!({
            "userAgent":format!("tietiezhi-app-server/{}", env!("CARGO_PKG_VERSION")),
            "platformFamily":if cfg!(windows) {"windows"} else {"unix"},
            "platformOs":std::env::consts::OS,
            "codexHome":codex_home
        }),
    )
}

#[tauri::command]
pub fn codex_v2_notify(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    notification: Value,
) -> Result<(), String> {
    if connection_id.trim().is_empty() {
        return Err("connectionId 不能为空".into());
    }
    serde_json::from_value::<ClientNotification>(notification.clone())
        .map_err(|error| format!("Client Notification 不符合 App Server V2：{error}"))?;
    if notification.get("method").and_then(Value::as_str) != Some("initialized") {
        return Err("不支持的 Client Notification".into());
    }
    let mut connections = state
        .codex_connections
        .lock()
        .map_err(|_| "Codex 连接状态锁已损坏".to_string())?;
    let connection = connections
        .get_mut(&connection_id)
        .ok_or_else(|| "connection must be initialized first".to_string())?;
    connection.initialized = true;
    drop(connections);
    emit_notifications(
        &app,
        &[RoutedNotification {
            recipients: vec![connection_id.clone()],
            method: "deprecationNotice".into(),
            params: json!({
                "summary":"旧 Workspace Agent 接口已停用",
                "details":"Work 与 Code 已切换到 Codex Thread/Turn/Item Runtime。"
            }),
        }],
    )?;
    if let Ok(settings) = super::settings::read_settings(&app) {
        let unsupported = settings.chat_provider_id.trim().is_empty()
            || settings.chat_model.trim().is_empty()
            || settings
                .providers
                .iter()
                .find(|provider| provider.id == settings.chat_provider_id)
                .is_none();
        if unsupported {
            emit_notifications(
                &app,
                &[RoutedNotification {
                    recipients: vec![connection_id],
                    method: "warning".into(),
                    params: json!({
                        "threadId":Value::Null,
                        "message":"当前 Workspace 尚未配置可用的模型渠道。"
                    }),
                }],
            )?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum ExternalMigrationSource {
    Claude,
    Cursor,
}

impl ExternalMigrationSource {
    fn parse(value: Option<&str>) -> Self {
        if value.is_some_and(|value| value.eq_ignore_ascii_case("cursor")) {
            Self::Cursor
        } else {
            Self::Claude
        }
    }

    fn config_dir(self) -> &'static str {
        match self {
            Self::Claude => ".claude",
            Self::Cursor => ".cursor",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Cursor => "Cursor",
        }
    }
}

fn external_migration_home(source: ExternalMigrationSource) -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(source.config_dir()))
        .ok_or_else(|| "无法定位用户目录".to_string())
}

fn external_scope_root(
    source: ExternalMigrationSource,
    cwd: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let Some(cwd) = cwd.filter(|cwd| !cwd.trim().is_empty()) else {
        return external_migration_home(source);
    };
    let cwd = std::fs::canonicalize(cwd)
        .map_err(|error| format!("无法读取迁移工作目录 `{cwd}`：{error}"))?;
    Ok(cwd.join(source.config_dir()))
}

fn nonempty_file(path: &std::path::Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

fn directory_names(path: &std::path::Path) -> Vec<Value> {
    let mut names = std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(std::fs::FileType::is_dir)
                .and_then(|_| entry.file_name().into_string().ok())
        })
        .collect::<Vec<_>>();
    names.sort();
    names.into_iter().map(|name| json!({"name":name})).collect()
}

fn session_candidates(path: &std::path::Path) -> Vec<Value> {
    let mut sessions = Vec::new();
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                pending.push(path);
            } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                sessions.push(json!({
                    "path":path,
                    "cwd":"",
                    "title":Value::Null
                }));
            }
            if sessions.len() >= 100 {
                return sessions;
            }
        }
    }
    sessions.sort_by(|left, right| {
        left.get("path")
            .and_then(Value::as_str)
            .cmp(&right.get("path").and_then(Value::as_str))
    });
    sessions
}

fn external_instruction_source(
    source: ExternalMigrationSource,
    cwd: Option<&str>,
) -> Result<Option<std::path::PathBuf>, String> {
    let scope = external_scope_root(source, cwd)?;
    let candidates = match (source, cwd) {
        (ExternalMigrationSource::Claude, Some(cwd)) if !cwd.trim().is_empty() => vec![
            std::path::PathBuf::from(cwd).join("CLAUDE.md"),
            scope.join("CLAUDE.md"),
        ],
        (ExternalMigrationSource::Claude, _) => vec![scope.join("CLAUDE.md")],
        (ExternalMigrationSource::Cursor, Some(cwd)) if !cwd.trim().is_empty() => vec![
            std::path::PathBuf::from(cwd).join(".cursorrules"),
            scope.join("rules"),
        ],
        (ExternalMigrationSource::Cursor, _) => vec![scope.join("rules")],
    };
    Ok(candidates.into_iter().find(|path| {
        nonempty_file(path)
            || (path.is_dir()
                && std::fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_some()))
    }))
}

fn detect_external_agent_items(
    source: ExternalMigrationSource,
    include_home: bool,
    cwds: &[String],
) -> Result<Vec<Value>, String> {
    let mut scopes = Vec::new();
    if include_home {
        scopes.push(None);
    }
    scopes.extend(cwds.iter().cloned().map(Some));
    let mut items = Vec::new();
    for cwd in scopes {
        let scope = external_scope_root(source, cwd.as_deref())?;
        if !scope.exists() {
            continue;
        }
        let cwd_value = cwd.clone().map(Value::String).unwrap_or(Value::Null);
        if let Some(instruction) = external_instruction_source(source, cwd.as_deref())? {
            items.push(json!({
                "itemType":"AGENTS_MD",
                "description":format!("从 {} 导入项目指令：{}", source.label(), instruction.display()),
                "cwd":cwd_value
            }));
        }
        let settings = match source {
            ExternalMigrationSource::Claude => scope.join("settings.json"),
            ExternalMigrationSource::Cursor if cwd.is_some() => scope.join("cli.json"),
            ExternalMigrationSource::Cursor => scope.join("cli-config.json"),
        };
        if nonempty_file(&settings) {
            items.push(json!({
                "itemType":"CONFIG",
                "description":format!("从 {} 导入配置：{}", source.label(), settings.display()),
                "cwd":cwd_value
            }));
        }
        let mut details = serde_json::Map::new();
        for (item_type, directory, detail_key) in [
            ("SKILLS", "skills", "skills"),
            ("SUBAGENTS", "agents", "subagents"),
            ("HOOKS", "hooks", "hooks"),
            ("COMMANDS", "commands", "commands"),
        ] {
            let names = directory_names(&scope.join(directory));
            if !names.is_empty() {
                details.clear();
                details.insert(detail_key.into(), Value::Array(names));
                items.push(json!({
                    "itemType":item_type,
                    "description":format!("从 {} 导入 {}", source.label(), directory),
                    "cwd":cwd_value,
                    "details":Value::Object(details.clone())
                }));
            }
        }
        let mcp = match source {
            ExternalMigrationSource::Claude => scope.join(".mcp.json"),
            ExternalMigrationSource::Cursor => scope.join("mcp.json"),
        };
        if nonempty_file(&mcp) {
            items.push(json!({
                "itemType":"MCP_SERVER_CONFIG",
                "description":format!("从 {} 导入 MCP 配置：{}", source.label(), mcp.display()),
                "cwd":cwd_value
            }));
        }
        if matches!(source, ExternalMigrationSource::Claude) {
            let memory = scope.join("memory");
            let memory_files = directory_files(&memory);
            if !memory_files.is_empty() {
                items.push(json!({
                    "itemType":"MEMORY",
                    "description":"导入 Claude Memory",
                    "cwd":cwd_value,
                    "details":{"memory":memory_files}
                }));
            }
        }
        let sessions = session_candidates(&scope.join("projects"));
        if !sessions.is_empty() {
            items.push(json!({
                "itemType":"SESSIONS",
                "description":format!("从 {} 导入会话", source.label()),
                "cwd":cwd_value,
                "details":{"sessions":sessions}
            }));
        }
    }
    Ok(items)
}

fn directory_files(path: &std::path::Path) -> Vec<String> {
    let mut files = std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(std::fs::FileType::is_file)
                .and_then(|_| entry.path().to_str().map(str::to_owned))
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn rewrite_external_terms(mut content: String, source: ExternalMigrationSource) -> String {
    let replacements = match source {
        ExternalMigrationSource::Claude => [
            ("CLAUDE.md", "AGENTS.md"),
            ("Claude Code", "Codex"),
            ("Claude", "Codex"),
        ],
        ExternalMigrationSource::Cursor => [
            (".cursorrules", "AGENTS.md"),
            ("Cursor CLI", "Codex"),
            ("Cursor", "Codex"),
        ],
    };
    for (from, to) in replacements {
        content = content.replace(from, to);
    }
    content
}

fn copy_tree_without_links(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    std::fs::create_dir_all(target)
        .map_err(|error| format!("创建迁移目录 `{}` 失败：{error}", target.display()))?;
    for entry in std::fs::read_dir(source)
        .map_err(|error| format!("读取迁移目录 `{}` 失败：{error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("读取迁移目录项失败：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取迁移文件类型失败：{error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree_without_links(&entry.path(), &destination)?;
        } else if file_type.is_file() && !destination.exists() {
            std::fs::copy(entry.path(), &destination)
                .map_err(|error| format!("复制迁移文件失败：{error}"))?;
        }
    }
    Ok(())
}

fn write_atomic(path: &std::path::Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "迁移目标缺少父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("创建迁移目标目录失败：{error}"))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("migration"),
        Uuid::new_v4()
    ));
    std::fs::write(&temporary, contents)
        .map_err(|error| format!("写入迁移临时文件失败：{error}"))?;
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("发布迁移文件失败：{error}")
    })
}

fn external_history_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("agent-runtime")
        .join("external-agent-import-history.json"))
}

fn read_external_histories(app: &AppHandle) -> Result<Value, String> {
    let path = external_history_path(app)?;
    let data = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("data").cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    Ok(json!({"data":data,"connectors":[]}))
}

fn selected_named_sources(item: &Value, key: &str) -> HashSet<String> {
    item.pointer(&format!("/details/{key}"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

fn copy_selected_directories(
    source: &std::path::Path,
    target: &std::path::Path,
    selected: &HashSet<String>,
) -> Result<Vec<(String, String)>, String> {
    let mut copied = Vec::new();
    for name in selected {
        let source_path = source.join(name);
        if !source_path.is_dir() {
            return Err(format!("迁移源目录不存在：{}", source_path.display()));
        }
        let target_path = target.join(name);
        copy_tree_without_links(&source_path, &target_path)?;
        copied.push((
            source_path.display().to_string(),
            target_path.display().to_string(),
        ));
    }
    Ok(copied)
}

fn external_message_text(message: &Value) -> Option<String> {
    let content = message
        .pointer("/message/content")
        .or_else(|| message.get("content"))?;
    match content {
        Value::String(text) => (!text.trim().is_empty()).then(|| text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| part.as_str())
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn import_external_session(
    manager: &ThreadManager,
    session: &Value,
) -> Result<(String, String), String> {
    let source_path = session
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "会话迁移缺少 path".to_string())?;
    let bytes = std::fs::read(source_path)
        .map_err(|error| format!("读取外部会话 `{source_path}` 失败：{error}"))?;
    let mut messages = Vec::new();
    let mut discovered_id = None;
    for line in bytes.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        discovered_id = discovered_id.or_else(|| {
            value
                .get("sessionId")
                .or_else(|| value.get("session_id"))
                .and_then(Value::as_str)
                .and_then(|value| Uuid::parse_str(value).ok())
                .map(|value| value.to_string())
        });
        let role = value
            .get("type")
            .and_then(Value::as_str)
            .or_else(|| value.pointer("/message/role").and_then(Value::as_str));
        let Some(role) = role.filter(|role| matches!(*role, "user" | "assistant")) else {
            continue;
        };
        if let Some(content) = external_message_text(&value) {
            messages.push(json!({
                "kind":"message",
                "role":role,
                "content":content,
                "createdAt":0
            }));
        }
    }
    if messages.is_empty() {
        return Err(format!("外部会话 `{source_path}` 没有可导入消息"));
    }
    let id = discovered_id.unwrap_or_else(|| Uuid::now_v7().to_string());
    let title = session
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            messages
                .iter()
                .find_map(|message| message.get("content").and_then(Value::as_str))
                .map(|text| text.chars().take(80).collect())
        })
        .unwrap_or_else(|| "导入的会话".into());
    let cwd = session
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.trim().is_empty())
        .map(std::path::PathBuf::from)
        .filter(|cwd| cwd.is_dir())
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    manager
        .import_legacy_thread(tietiezhi_agent_core::LegacyThreadImport {
            id: id.clone(),
            title,
            cwd,
            created_at_ms: unix_timestamp_ms().max(0) as u64,
            updated_at_ms: unix_timestamp_ms().max(0) as u64,
            model: None,
            model_provider: None,
            task_mode: "code".into(),
            messages,
        })
        .map_err(|error| error.message)?;
    Ok((source_path.into(), id))
}

fn checked_external_session(
    session: &Value,
    allowed_root: &std::path::Path,
) -> Result<Value, String> {
    let source_path = session
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "会话迁移缺少 path".to_string())?;
    let canonical = std::fs::canonicalize(source_path)
        .map_err(|error| format!("读取外部会话 `{source_path}` 失败：{error}"))?;
    if !canonical.is_file() || !canonical.starts_with(allowed_root) {
        return Err("会话路径超出已检测范围".into());
    }
    let mut checked = session.clone();
    checked["path"] = Value::String(canonical.display().to_string());
    Ok(checked)
}

fn import_external_item(
    app: &AppHandle,
    manager: &ThreadManager,
    source: ExternalMigrationSource,
    item: &Value,
) -> Result<Vec<(String, String)>, String> {
    let item_type = item
        .get("itemType")
        .and_then(Value::as_str)
        .ok_or_else(|| "迁移项缺少 itemType".to_string())?;
    let cwd = item.get("cwd").and_then(Value::as_str);
    let scope = external_scope_root(source, cwd)?;
    let codex_home = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位 Codex 配置目录：{error}"))?
        .join("codex");
    let project_root = cwd.map(std::path::PathBuf::from);
    match item_type {
        "AGENTS_MD" => {
            let source_path = external_instruction_source(source, cwd)?
                .ok_or_else(|| "没有检测到可导入的项目指令".to_string())?;
            let target = project_root
                .as_ref()
                .map(|root| root.join("AGENTS.md"))
                .unwrap_or_else(|| codex_home.join("AGENTS.md"));
            if target.exists()
                && std::fs::read_to_string(&target).is_ok_and(|content| !content.trim().is_empty())
            {
                return Ok(Vec::new());
            }
            let content = if source_path.is_dir() {
                directory_files(&source_path)
                    .into_iter()
                    .filter_map(|path| std::fs::read_to_string(path).ok())
                    .collect::<Vec<_>>()
                    .join("\n\n")
            } else {
                std::fs::read_to_string(&source_path)
                    .map_err(|error| format!("读取外部项目指令失败：{error}"))?
            };
            write_atomic(&target, rewrite_external_terms(content, source).as_bytes())?;
            Ok(vec![(
                source_path.display().to_string(),
                target.display().to_string(),
            )])
        }
        "CONFIG" => {
            let source_path = match source {
                ExternalMigrationSource::Claude => scope.join("settings.json"),
                ExternalMigrationSource::Cursor if cwd.is_some() => scope.join("cli.json"),
                ExternalMigrationSource::Cursor => scope.join("cli-config.json"),
            };
            let target = codex_home.join("imports").join(format!(
                "{}-settings.json",
                source.label().to_ascii_lowercase()
            ));
            let bytes = std::fs::read(&source_path)
                .map_err(|error| format!("读取外部配置失败：{error}"))?;
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|error| format!("外部配置不是有效 JSON：{error}"))?;
            write_atomic(&target, &bytes)?;
            Ok(vec![(
                source_path.display().to_string(),
                target.display().to_string(),
            )])
        }
        "SKILLS" | "SUBAGENTS" | "HOOKS" | "COMMANDS" => {
            let (source_name, target_name, detail_key) = match item_type {
                "SKILLS" => ("skills", "skills", "skills"),
                "SUBAGENTS" => ("agents", "agents", "subagents"),
                "HOOKS" => ("hooks", "hooks", "hooks"),
                "COMMANDS" => ("commands", "skills", "commands"),
                _ => unreachable!(),
            };
            let target_root = project_root
                .as_ref()
                .map(|root| root.join(".codex").join(target_name))
                .unwrap_or_else(|| codex_home.join(target_name));
            copy_selected_directories(
                &scope.join(source_name),
                &target_root,
                &selected_named_sources(item, detail_key),
            )
        }
        "MCP_SERVER_CONFIG" => {
            let source_path = match source {
                ExternalMigrationSource::Claude => scope.join(".mcp.json"),
                ExternalMigrationSource::Cursor => scope.join("mcp.json"),
            };
            let target = codex_home
                .join("imports")
                .join(format!("{}-mcp.json", source.label().to_ascii_lowercase()));
            let bytes = std::fs::read(&source_path)
                .map_err(|error| format!("读取外部 MCP 配置失败：{error}"))?;
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|error| format!("外部 MCP 配置不是有效 JSON：{error}"))?;
            write_atomic(&target, &bytes)?;
            Ok(vec![(
                source_path.display().to_string(),
                target.display().to_string(),
            )])
        }
        "MEMORY" => {
            let target = codex_home.join("memories").join("external");
            let mut copied = Vec::new();
            for source_path in item
                .pointer("/details/memory")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let source_path = std::path::PathBuf::from(source_path);
                let canonical = std::fs::canonicalize(&source_path)
                    .map_err(|error| format!("读取外部 Memory 失败：{error}"))?;
                let allowed = std::fs::canonicalize(scope.join("memory"))
                    .map_err(|error| format!("读取外部 Memory 根目录失败：{error}"))?;
                if !canonical.starts_with(&allowed) {
                    return Err("Memory 路径超出已检测范围".into());
                }
                let destination = target.join(
                    canonical
                        .file_name()
                        .ok_or_else(|| "Memory 文件名无效".to_string())?,
                );
                let bytes = std::fs::read(&canonical)
                    .map_err(|error| format!("读取外部 Memory 失败：{error}"))?;
                write_atomic(&destination, &bytes)?;
                copied.push((
                    canonical.display().to_string(),
                    destination.display().to_string(),
                ));
            }
            Ok(copied)
        }
        "SESSIONS" => {
            let allowed = std::fs::canonicalize(scope.join("projects"))
                .map_err(|error| format!("读取外部会话根目录失败：{error}"))?;
            item.pointer("/details/sessions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|session| {
                    let checked = checked_external_session(session, &allowed)?;
                    import_external_session(manager, &checked)
                })
                .collect()
        }
        "PLUGINS" => Err("插件迁移必须通过 Marketplace 安装流程完成".into()),
        _ => Err(format!("不支持的迁移项类型 `{item_type}`")),
    }
}

fn perform_external_import(
    app: AppHandle,
    manager: ThreadManager,
    connection_id: String,
    import_id: String,
    source: ExternalMigrationSource,
    migration_items: Vec<Value>,
) {
    let mut item_type_results = Vec::new();
    for item in migration_items {
        let item_type = item
            .get("itemType")
            .and_then(Value::as_str)
            .unwrap_or("CONFIG")
            .to_owned();
        let cwd = item.get("cwd").cloned().unwrap_or(Value::Null);
        let result = match import_external_item(&app, &manager, source, &item) {
            Ok(successes) => json!({
                "itemType":item_type,
                "successes":successes.into_iter().map(|(source_path,target)| json!({
                    "itemType":item_type,
                    "cwd":cwd,
                    "source":source_path,
                    "target":target
                })).collect::<Vec<_>>(),
                "failures":[]
            }),
            Err(error) => json!({
                "itemType":item_type,
                "successes":[],
                "failures":[{
                    "itemType":item_type,
                    "cwd":cwd,
                    "source":source.label(),
                    "failureStage":"import",
                    "message":error,
                    "errorType":"io",
                    "subErrorType":Value::Null
                }]
            }),
        };
        item_type_results.push(result.clone());
        let params = json!({"importId":import_id,"itemTypeResults":[result]});
        if let Ok(notification) = checked_external_import_notification(
            &connection_id,
            "externalAgentConfig/import/progress",
            params,
        ) {
            let _ = emit_notifications(&app, &[notification]);
        }
    }
    let completed = json!({"importId":import_id,"itemTypeResults":item_type_results});
    if let Ok(notification) = checked_external_import_notification(
        &connection_id,
        "externalAgentConfig/import/completed",
        completed.clone(),
    ) {
        let _ = emit_notifications(&app, &[notification]);
    }
    let mut histories = read_external_histories(&app)
        .ok()
        .and_then(|value| value.get("data").cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let successes = completed
        .get("itemTypeResults")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|result| {
            result
                .get("successes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let failures = completed
        .get("itemTypeResults")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|result| {
            result
                .get("failures")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    histories.push(json!({
        "importId":import_id,
        "completedAtMs":unix_timestamp_ms(),
        "successes":successes,
        "failures":failures
    }));
    if let (Ok(path), Ok(bytes)) = (
        external_history_path(&app),
        serde_json::to_vec_pretty(&json!({"data":histories})),
    ) {
        let _ = write_atomic(&path, &bytes);
    }
}

fn checked_external_import_notification(
    connection_id: &str,
    method: &str,
    params: Value,
) -> Result<RoutedNotification, String> {
    serde_json::from_value::<ServerNotification>(json!({
        "method":method,
        "params":params
    }))
    .map_err(|error| format!("外部 Agent 导入通知不符合 App Server V2：{error}"))?;
    Ok(RoutedNotification {
        recipients: vec![connection_id.to_owned()],
        method: method.to_owned(),
        params,
    })
}

async fn dispatch_external_agent_request(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("{method} 参数不符合 App Server V2：{error}"),
        ));
    }
    match method {
        "externalAgentConfig/detect" => {
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            let source = ExternalMigrationSource::parse(
                params.get("migrationSource").and_then(Value::as_str),
            );
            let cwds = params
                .get("cwds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let result = json!({
                "items":detect_external_agent_items(
                    source,
                    params.get("includeHome").and_then(Value::as_bool).unwrap_or(false),
                    &cwds
                )?
            });
            serde_json::from_value::<ExternalAgentConfigDetectResponse>(result.clone())
                .map_err(|error| format!("externalAgentConfig/detect 返回值无效：{error}"))?;
            dispatch_success(request, result)
        }
        "externalAgentConfig/import" => {
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            let source = ExternalMigrationSource::parse(
                params.get("migrationSource").and_then(Value::as_str),
            );
            let migration_items = params
                .get("migrationItems")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let import_id = Uuid::now_v7().to_string();
            let result = json!({"importId":import_id});
            serde_json::from_value::<ExternalAgentConfigImportResponse>(result.clone())
                .map_err(|error| format!("externalAgentConfig/import 返回值无效：{error}"))?;
            let app = app.clone();
            let manager = thread_manager(&app, state)?;
            let connection_id = connection_id.to_owned();
            let import_task_id = import_id.clone();
            tauri::async_runtime::spawn(async move {
                tokio::task::yield_now().await;
                perform_external_import(
                    app,
                    manager,
                    connection_id,
                    import_task_id,
                    source,
                    migration_items,
                );
            });
            dispatch_success(request, result)
        }
        "externalAgentConfig/import/readHistories" => {
            let result = read_external_histories(app)?;
            serde_json::from_value::<ExternalAgentConfigImportHistoriesReadResponse>(
                result.clone(),
            )
            .map_err(|error| format!("导入历史返回值无效：{error}"))?;
            dispatch_success(request, result)
        }
        _ => Ok(dispatch_error(request, -32601, "method not found")),
    }
}

fn observability_runtime(app: &AppHandle, state: &AppState) -> Result<Observability, String> {
    let mut slot = state
        .codex_observability
        .lock()
        .map_err(|_| "Codex 运维状态锁已损坏".to_string())?;
    if let Some(runtime) = slot.as_ref() {
        return Ok(runtime.clone());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let runtime = Observability::open(ObservabilityConfig::local(
        app_data.join("agent-runtime").join("operations"),
        env!("CARGO_PKG_VERSION"),
    ))
    .map_err(|error| format!("初始化 Codex 运维能力失败：{error}"))?;
    *slot = Some(runtime.clone());
    Ok(runtime)
}

fn doctor_input(app: &AppHandle) -> Result<DoctorInput, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let settings = super::settings::read_settings(app)?;
    let provider_endpoint = settings
        .providers
        .iter()
        .find(|provider| provider.id == settings.chat_provider_id)
        .map(|provider| provider.base_url.clone());
    Ok(DoctorInput {
        runtime_root: app_data.join("agent-runtime"),
        tasks_root: app_data.join("tasks"),
        state_db: app_data.join("agent-runtime").join("state.sqlite3"),
        provider_endpoint,
        sandbox_readiness: Some(json!({
            "readiness":tietiezhi_agent_sandbox::windows_sandbox_readiness()
        })),
    })
}

fn memory_runtime(app: &AppHandle, state: &AppState) -> Result<MemoryRuntime, String> {
    let mut slot = state
        .codex_memory
        .lock()
        .map_err(|_| "Codex Memory 状态锁已损坏".to_string())?;
    if let Some(runtime) = slot.as_ref() {
        return Ok(runtime.clone());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let runtime = MemoryRuntime::open(app_data.join("agent-runtime"))
        .map_err(|error| format!("初始化 Codex Memory 失败：{error}"))?;
    let legacy_home = super::tietiezhi::home_dir(app)?;
    runtime
        .migrate_legacy_tietiezhi(&legacy_home)
        .map_err(|error| format!("迁移铁铁汁长期记忆失败：{error}"))?;
    *slot = Some(runtime.clone());
    Ok(runtime)
}

fn memories_config(app: &AppHandle) -> MemoriesConfig {
    let mut config = MemoriesConfig::default();
    if let Ok(tietiezhi) = super::tietiezhi::read_config(app) {
        config.generate_memories = tietiezhi.memory_enabled;
        config.use_memories = tietiezhi.memory_enabled;
        config.dedicated_tools = tietiezhi.memory_enabled;
    }
    let config_root = app
        .path()
        .app_config_dir()
        .ok()
        .map(|path| path.join("codex"));
    if let Some(memory) = config_root
        .and_then(|config_root| {
            ConfigRuntime::new(ConfigPaths {
                user_config: config_root.join("config.toml"),
                system_config: system_codex_config_path(),
                requirements: system_codex_requirements_path(),
            })
            .dispatch("config/read", &json!({"includeLayers":false}))
            .ok()
        })
        .and_then(|dispatch| dispatch.result.pointer("/config/memories").cloned())
    {
        let bool_field = |camel: &str, snake: &str| {
            memory
                .get(camel)
                .or_else(|| memory.get(snake))
                .and_then(Value::as_bool)
        };
        let usize_field = |camel: &str, snake: &str| {
            memory
                .get(camel)
                .or_else(|| memory.get(snake))
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
        };
        let i64_field = |camel: &str, snake: &str| {
            memory
                .get(camel)
                .or_else(|| memory.get(snake))
                .and_then(Value::as_i64)
        };
        config.disable_on_external_context =
            bool_field("disableOnExternalContext", "disable_on_external_context")
                .unwrap_or(config.disable_on_external_context);
        config.generate_memories =
            bool_field("generateMemories", "generate_memories").unwrap_or(config.generate_memories);
        config.use_memories =
            bool_field("useMemories", "use_memories").unwrap_or(config.use_memories);
        config.dedicated_tools =
            bool_field("dedicatedTools", "dedicated_tools").unwrap_or(config.dedicated_tools);
        config.max_raw_memories_for_consolidation = usize_field(
            "maxRawMemoriesForConsolidation",
            "max_raw_memories_for_consolidation",
        )
        .unwrap_or(config.max_raw_memories_for_consolidation);
        config.max_unused_days =
            i64_field("maxUnusedDays", "max_unused_days").unwrap_or(config.max_unused_days);
        config.max_rollout_age_days = i64_field("maxRolloutAgeDays", "max_rollout_age_days")
            .unwrap_or(config.max_rollout_age_days);
        config.max_rollouts_per_startup =
            usize_field("maxRolloutsPerStartup", "max_rollouts_per_startup")
                .unwrap_or(config.max_rollouts_per_startup);
        config.min_rollout_idle_hours = i64_field("minRolloutIdleHours", "min_rollout_idle_hours")
            .unwrap_or(config.min_rollout_idle_hours);
        config.min_rate_limit_remaining_percent = i64_field(
            "minRateLimitRemainingPercent",
            "min_rate_limit_remaining_percent",
        )
        .unwrap_or(config.min_rate_limit_remaining_percent);
        config.extract_model = memory
            .get("extractModel")
            .or_else(|| memory.get("extract_model"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        config.consolidation_model = memory
            .get("consolidationModel")
            .or_else(|| memory.get("consolidation_model"))
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    config.normalize()
}

fn launch_memory_pipeline(
    app: &AppHandle,
    manager: ThreadManager,
    current_thread_id: String,
    model: String,
    model_provider: String,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            run_memory_pipeline(app, manager, current_thread_id, model, model_provider).await
        {
            eprintln!("[codex-memory] {error}");
        }
    });
}

async fn run_memory_pipeline(
    app: AppHandle,
    manager: ThreadManager,
    current_thread_id: String,
    model: String,
    model_provider: String,
) -> Result<(), ModelError> {
    let config = memories_config(&app);
    if !config.generate_memories {
        return Ok(());
    }
    let state = app.state::<AppState>();
    if !memory_rate_limits_allow_startup(
        &app,
        &state,
        &model_provider,
        config.min_rate_limit_remaining_percent,
    )
    .await
    {
        return Ok(());
    }
    let memory = memory_runtime(&app, &state).map_err(ModelError::Consumer)?;
    memory
        .set_thread_mode(&current_thread_id, ThreadMemoryMode::Enabled)
        .map_err(|error| ModelError::Consumer(error.to_string()))?;
    let candidates = manager
        .memory_rollout_candidates(&current_thread_id)
        .map_err(core_model_error)?
        .into_iter()
        .map(core_memory_candidate)
        .collect::<Vec<_>>();
    let claims = memory
        .claim_stage_one(&current_thread_id, &candidates, &config)
        .map_err(|error| ModelError::Consumer(error.to_string()))?;

    let resolved =
        super::providers::resolve(&app, &model_provider).map_err(ModelError::Transport)?;
    let base_url = super::api_url(&resolved.base_url, "")
        .trim_end_matches('/')
        .to_owned();
    let configured_wire_api = resolved.wire_api;
    let effective_wire_api = resolved.wire_api_for_model(&model);
    let reasoning_transport = resolved.reasoning_transport_for_model(&model, effective_wire_api);
    let bearer_token = state
        .codex_external_auth
        .lock()
        .map_err(|_| ModelError::Consumer("Codex 外部账号状态锁已损坏".into()))?
        .get(&resolved.id)
        .map(|tokens| tokens.access_token.clone())
        .or(resolved.key);
    let client = responses_client(
        &state.http,
        &resolved.kind,
        &base_url,
        bearer_token,
        effective_wire_api,
        reasoning_transport,
    );
    ensure_responses_capability(
        &app,
        &format!("{}\n{base_url}", resolved.id),
        configured_wire_api,
        &client,
    )
    .await?;

    let extraction_model = config
        .extract_model
        .clone()
        .unwrap_or_else(|| model.clone());
    let mut jobs = FuturesUnordered::new();
    for claim in claims {
        let manager = manager.clone();
        let client = client.clone();
        let extraction_model = extraction_model.clone();
        jobs.push(async move {
            let result = async {
                let rollout = manager
                    .memory_rollout_text(&claim.candidate.thread_id, 150_000)
                    .map_err(core_model_error)?;
                if rollout.trim().is_empty() {
                    return Ok::<Option<Value>, ModelError>(None);
                }
                let prompt = build_stage_one_input(
                    &rollout,
                    &claim.candidate.rollout_path,
                    &claim.candidate.cwd,
                );
                let mut request = ResponsesApiRequest::text(
                    extraction_model,
                    vec![json!({
                        "type":"message",
                        "role":"user",
                        "content":[{"type":"input_text","text":prompt}]
                    })],
                );
                request.instructions = STAGE_ONE_SYSTEM_PROMPT.to_owned();
                request.reasoning = Some(Reasoning {
                    effort: Some("low".into()),
                    summary: None,
                    context: None,
                });
                request.prompt_cache_key =
                    Some(format!("memory-stage1:{}", claim.candidate.thread_id));
                request.text = Some(TextControls {
                    verbosity: None,
                    format: Some(TextFormat {
                        r#type: TextFormatType::JsonSchema,
                        strict: true,
                        schema: stage_one_output_schema(),
                        name: "memory_stage_one".into(),
                    }),
                });
                collect_structured_memory_response(&client, &request)
                    .await
                    .map(Some)
            }
            .await;
            (claim, result)
        });
    }
    while let Some((claim, result)) = jobs.next().await {
        match result {
            Ok(Some(output)) => {
                let raw = output
                    .get("raw_memory")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let summary = output
                    .get("rollout_summary")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let slug = output.get("rollout_slug").and_then(Value::as_str);
                if let Err(error) = memory.complete_stage_one(&claim, raw, summary, slug) {
                    let _ = memory.fail_stage_one(&claim, &error.to_string());
                }
            }
            Ok(None) => {
                let _ = memory.complete_stage_one_without_output(&claim);
            }
            Err(error) => {
                let _ = memory.fail_stage_one(&claim, &error.to_string());
            }
        }
    }

    let Some(phase_two) = memory
        .claim_phase_two(&current_thread_id, &config)
        .map_err(|error| ModelError::Consumer(error.to_string()))?
    else {
        return Ok(());
    };
    if phase_two.inputs.is_empty() {
        memory
            .sync_phase_two_inputs(&phase_two, config.max_raw_memories_for_consolidation)
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
        memory
            .complete_phase_two(&phase_two)
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
        return Ok(());
    }
    let result = async {
        let raw_path = memory
            .sync_phase_two_inputs(&phase_two, config.max_raw_memories_for_consolidation)
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
        let raw = std::fs::read_to_string(&raw_path).map_err(|error| {
            ModelError::Consumer(format!("读取 Phase 2 raw memories 失败：{error}"))
        })?;
        let current_memory =
            std::fs::read_to_string(memory.root().join("MEMORY.md")).unwrap_or_default();
        let current_summary =
            std::fs::read_to_string(memory.root().join("memory_summary.md")).unwrap_or_default();
        let instructions = build_consolidation_prompt(
            memory.root(),
            &memory.codex_home().join("memories_extensions"),
        );
        let prompt = format!(
            "Consolidate the following canonical memory inputs. Return the complete next contents \
             of MEMORY.md and memory_summary.md. Preserve source references and make the first line \
             of memory_summary.md exactly `v1`.\n\nCURRENT MEMORY.md:\n{current_memory}\n\n\
             CURRENT memory_summary.md:\n{current_summary}\n\nRAW INPUTS:\n{raw}"
        );
        let mut request = ResponsesApiRequest::text(
            config
                .consolidation_model
                .clone()
                .unwrap_or_else(|| model.clone()),
            vec![json!({
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":prompt}]
            })],
        );
        request.instructions = instructions;
        request.reasoning = Some(Reasoning {
            effort: Some("medium".into()),
            summary: None,
            context: None,
        });
        request.prompt_cache_key = Some("memory-consolidation".into());
        request.text = Some(TextControls {
            verbosity: None,
            format: Some(TextFormat {
                r#type: TextFormatType::JsonSchema,
                strict: true,
                schema: consolidation_output_schema(),
                name: "memory_consolidation".into(),
            }),
        });
        let output = collect_structured_memory_response(&client, &request).await?;
        let memory_markdown = output
            .get("memory_markdown")
            .and_then(Value::as_str)
            .ok_or_else(|| ModelError::Consumer("missing memory_markdown".into()))?;
        let summary_markdown = output
            .get("memory_summary_markdown")
            .and_then(Value::as_str)
            .ok_or_else(|| ModelError::Consumer("missing memory_summary_markdown".into()))?;
        memory
            .apply_consolidation(memory_markdown, summary_markdown)
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
        memory
            .complete_phase_two(&phase_two)
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
        Ok::<(), ModelError>(())
    }
    .await;
    if let Err(error) = &result {
        let _ = memory.fail_phase_two(&phase_two, &error.to_string());
    }
    result
}

async fn memory_rate_limits_allow_startup(
    app: &AppHandle,
    state: &AppState,
    provider_id: &str,
    minimum_remaining_percent: i64,
) -> bool {
    let built_in = super::settings::read_settings(app)
        .ok()
        .and_then(|settings| {
            settings
                .providers
                .into_iter()
                .find(|provider| provider.id == provider_id)
        })
        .is_some_and(|provider| provider.built_in);
    if !built_in {
        return true;
    }
    match super::gateway_auth::load_gateway_quota(&state.http, app, provider_id).await {
        Ok(quota) => gateway_quota_allows_memory_startup(&quota, minimum_remaining_percent),
        Err(error) => {
            eprintln!("[codex-memory] 无法读取限额，按 Codex 容错规则继续：{error}");
            true
        }
    }
}

fn gateway_quota_allows_memory_startup(
    quota: &super::gateway_auth::GatewayQuotaView,
    minimum_remaining_percent: i64,
) -> bool {
    let has_credits = quota.wallet.balance_micro > 0
        || quota
            .packages
            .iter()
            .any(|package| package.window_remaining > 0);
    if !has_credits {
        return false;
    }
    let threshold = minimum_remaining_percent.clamp(0, 100) as i128;
    quota
        .packages
        .iter()
        .filter(|package| package.quota_per_window > 0)
        .all(|package| {
            let remaining = i128::from(package.window_remaining.max(0));
            let total = i128::from(package.quota_per_window);
            remaining.saturating_mul(100) >= total.saturating_mul(threshold)
        })
}

fn core_memory_candidate(candidate: CoreMemoryCandidate) -> RolloutCandidate {
    RolloutCandidate {
        thread_id: candidate.thread_id,
        rollout_path: candidate.rollout_path,
        cwd: candidate.cwd,
        git_branch: candidate.git_branch,
        source_updated_at: candidate.source_updated_at,
    }
}

async fn collect_structured_memory_response(
    client: &ResponsesClient,
    request: &ResponsesApiRequest,
) -> Result<Value, ModelError> {
    let mut deltas = String::new();
    let mut final_text = None;
    tokio::time::timeout(
        Duration::from_secs(300),
        client.stream(request, |event| {
            match event {
                ResponseEvent::OutputTextDelta(delta) => deltas.push_str(&delta),
                ResponseEvent::OutputItemDone(item) => {
                    if let Some(text) = assistant_response_text(&item) {
                        final_text = Some(text);
                    }
                }
                _ => {}
            }
            Ok(())
        }),
    )
    .await
    .map_err(|_| ModelError::Transport("memory model request timed out".into()))??;
    let text = final_text.unwrap_or(deltas);
    serde_json::from_str(&text)
        .map_err(|error| ModelError::Consumer(format!("invalid memory model output: {error}")))
}

fn collaboration_runtime(
    app: &AppHandle,
    state: &AppState,
) -> Result<CollaborationRuntime, String> {
    let mut slot = state
        .codex_collab
        .lock()
        .map_err(|_| "Codex Collaboration 状态锁已损坏".to_string())?;
    if let Some(runtime) = slot.as_ref() {
        return Ok(runtime.clone());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let runtime = CollaborationRuntime::open(
        app_data.join("agent-runtime").join("collaboration"),
        CollaborationConfig::default(),
    )
    .map_err(|error| format!("初始化 Codex Collaboration 失败：{error}"))?;
    *slot = Some(runtime.clone());
    Ok(runtime)
}

fn collaboration_config_for(app: &AppHandle, cwd: &std::path::Path) -> CollaborationConfig {
    let config_root = app
        .path()
        .app_config_dir()
        .ok()
        .map(|path| path.join("codex"));
    let effective = config_root.and_then(|config_root| {
        ConfigRuntime::new(ConfigPaths {
            user_config: config_root.join("config.toml"),
            system_config: system_codex_config_path(),
            requirements: system_codex_requirements_path(),
        })
        .dispatch(
            "config/read",
            &json!({"cwd":cwd.to_string_lossy(),"includeLayers":false}),
        )
        .ok()
        .map(|dispatch| dispatch.result)
    });
    let max_concurrent_threads = effective
        .as_ref()
        .and_then(|config| {
            config
                .pointer("/config/agents/max_concurrent_threads_per_session")
                .or_else(|| {
                    config.pointer(
                        "/config/features/multi_agent_v2/max_concurrent_threads_per_session",
                    )
                })
        })
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or(tietiezhi_agent_collab::DEFAULT_MAX_CONCURRENT_THREADS);
    let max_depth = effective
        .as_ref()
        .and_then(|config| config.pointer("/config/agents/max_depth"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(tietiezhi_agent_collab::DEFAULT_MAX_DEPTH);
    CollaborationConfig {
        max_concurrent_threads,
        max_depth,
    }
}

fn ensure_collaboration_agent(
    app: &AppHandle,
    manager: &ThreadManager,
    runtime: &CollaborationRuntime,
    thread_id: &str,
    cwd: &std::path::Path,
) -> Result<(), ModelError> {
    let mut chain = Vec::new();
    let mut cursor = thread_id.to_owned();
    loop {
        let identity = manager
            .collaboration_identity(&cursor)
            .map_err(core_model_error)?;
        let parent = identity.parent_thread_id.clone();
        chain.push(identity);
        let Some(parent) = parent else {
            break;
        };
        cursor = parent;
    }
    chain.reverse();
    let root = chain
        .first()
        .ok_or_else(|| ModelError::Consumer("empty collaboration identity chain".into()))?;
    runtime
        .register_root_with_config(&root.thread_id, collaboration_config_for(app, cwd))
        .map_err(|error| ModelError::Consumer(error.to_string()))?;
    for identity in chain.into_iter().skip(1) {
        runtime
            .register_existing(
                &identity.thread_id,
                identity
                    .parent_thread_id
                    .as_deref()
                    .ok_or_else(|| ModelError::Consumer("subagent has no parent thread".into()))?,
                identity
                    .agent_path
                    .as_deref()
                    .ok_or_else(|| ModelError::Consumer("subagent has no agent path".into()))?,
                identity.agent_nickname,
                identity.agent_role,
                CollabAgentStatus::running(),
            )
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
    }
    Ok(())
}

fn persistent_approval_store(
    app: &AppHandle,
    state: &AppState,
) -> Result<PersistentApprovalStore, String> {
    let mut slot = state
        .codex_persistent_approvals
        .lock()
        .map_err(|_| "Codex 持久审批规则锁已损坏".to_string())?;
    if let Some(store) = slot.as_ref() {
        return Ok(store.clone());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let store =
        PersistentApprovalStore::open(app_data.join("agent-runtime").join("approval-rules.json"))
            .map_err(|error| format!("无法打开持久审批规则：{error}"))?;
    *slot = Some(store.clone());
    Ok(store)
}

pub(crate) fn remote_control_runtime(
    app: &AppHandle,
    state: &AppState,
) -> Result<RemoteControlRuntime, String> {
    let mut slot = state
        .codex_remote
        .lock()
        .map_err(|_| "Codex Remote Control 状态锁已损坏".to_string())?;
    if let Some(runtime) = slot.as_ref() {
        return Ok(runtime.clone());
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("agent-runtime")
        .join("remote-control");
    let runtime = RemoteControlRuntime::open(root)
        .map_err(|error| format!("初始化 Codex Remote Control 失败：{error}"))?;
    *slot = Some(runtime.clone());
    Ok(runtime)
}

fn remote_control_method(method: &str) -> bool {
    matches!(
        method,
        "remoteControl/enable"
            | "remoteControl/disable"
            | "remoteControl/status/read"
            | "remoteControl/pairing/start"
            | "remoteControl/pairing/status"
            | "remoteControl/clients/list"
            | "remoteControl/clients/revoke"
    )
}

fn routed_wire_notification(
    recipients: Vec<String>,
    wire: Value,
) -> Result<RoutedNotification, String> {
    let method = wire
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex 通知缺少 method".to_string())?
        .to_owned();
    let params = wire
        .get("params")
        .cloned()
        .ok_or_else(|| "Codex 通知缺少 params".to_string())?;
    serde_json::from_value::<ServerNotification>(wire)
        .map_err(|error| format!("Codex 通知不符合 App Server V2：{error}"))?;
    Ok(RoutedNotification {
        recipients,
        method,
        params,
    })
}

fn dispatch_remote_control_request(
    app: &AppHandle,
    state: &AppState,
    manager: &ThreadManager,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    let runtime = remote_control_runtime(app, state)?;
    let params = request
        .get("params")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let result = match method {
        "remoteControl/enable" => {
            if params
                .get("ephemeral")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                runtime.enable_ephemeral()
            } else {
                runtime.enable()
            }
        }
        "remoteControl/disable" => {
            if params
                .get("ephemeral")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                runtime.disable_ephemeral()
            } else {
                runtime.disable()
            }
        }
        "remoteControl/status/read" => runtime.status(),
        "remoteControl/pairing/start" => runtime.start_pairing(
            params
                .get("manualCode")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        "remoteControl/pairing/status" => runtime.pairing_status(
            params.get("pairingCode").and_then(Value::as_str),
            params.get("manualPairingCode").and_then(Value::as_str),
        ),
        "remoteControl/clients/list" => runtime.list_clients(
            params
                .get("environmentId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            params.get("cursor").and_then(Value::as_str),
            params
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
            params.get("order").and_then(Value::as_str) == Some("desc"),
        ),
        "remoteControl/clients/revoke" => runtime.revoke_client(
            params
                .get("environmentId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            params
                .get("clientId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        _ => unreachable!(),
    };
    match result {
        Ok(result) => {
            let mut output = dispatch_success(request, result)?;
            if matches!(method, "remoteControl/enable" | "remoteControl/disable") {
                output.notifications.push(routed_wire_notification(
                    manager
                        .connection_recipients()
                        .map_err(|error| error.message)?,
                    runtime
                        .status_notification()
                        .map_err(|error| error.to_string())?,
                )?);
            }
            Ok(output)
        }
        Err(error) => Ok(dispatch_error(request, -32602, error.to_string())),
    }
}

fn realtime_method(method: &str) -> bool {
    matches!(
        method,
        "thread/realtime/start"
            | "thread/realtime/appendAudio"
            | "thread/realtime/appendText"
            | "thread/realtime/appendSpeech"
            | "thread/realtime/stop"
            | "thread/realtime/listVoices"
    )
}

fn request_id_string(request: &Value) -> String {
    request
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            request
                .get("id")
                .map(Value::to_string)
                .unwrap_or_else(|| Uuid::new_v4().to_string())
        })
}

async fn dispatch_realtime_request(
    app: &AppHandle,
    state: &AppState,
    manager: &ThreadManager,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    let params = request
        .get("params")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if method == "thread/realtime/listVoices" {
        return dispatch_success(request, tietiezhi_agent_realtime::RealtimeRuntime::voices());
    }
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if thread_id.is_empty() {
        return Ok(dispatch_error(request, -32602, "threadId 不能为空"));
    }
    let result = match method {
        "thread/realtime/start" => {
            let thread = manager
                .realtime_thread_config(&thread_id)
                .map_err(|error| error.message)?;
            let resolved = super::providers::resolve(app, &thread.model_provider)
                .map_err(|error| format!("无法解析 Realtime 模型供应商：{error}"))?;
            let base_url = super::api_url(&resolved.base_url, "")
                .trim_end_matches('/')
                .to_owned();
            let bearer_token = state
                .codex_external_auth
                .lock()
                .map_err(|_| "Codex 外部账号状态锁已损坏".to_string())?
                .get(&resolved.id)
                .map(|tokens| tokens.access_token.clone())
                .or(resolved.key);
            let mut start = serde_json::from_value::<RealtimeStartParams>(params.clone())
                .map_err(|error| format!("Realtime start 参数无效：{error}"))?;
            if start.model.is_none() {
                start.model = Some(thread.model);
            }
            if start.prompt.is_none() && !thread.instructions.is_empty() {
                start.prompt = Some(Some(thread.instructions));
            }
            let app = app.clone();
            let manager = manager.clone();
            let sink: NotificationSink = Arc::new(move |wire| {
                let thread_id = wire
                    .pointer("/params/threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let recipients = manager.thread_recipients(thread_id).unwrap_or_default();
                if let Ok(notification) = routed_wire_notification(recipients, wire) {
                    let _ = emit_notifications(&app, &[notification]);
                }
            });
            state
                .codex_realtime
                .start(
                    start,
                    RealtimeProvider::openai_compatible(base_url, bearer_token),
                    sink,
                )
                .await
        }
        "thread/realtime/appendAudio" => {
            let audio = serde_json::from_value::<RealtimeAudioChunk>(
                params.get("audio").cloned().unwrap_or(Value::Null),
            )
            .map_err(|error| format!("Realtime audio 参数无效：{error}"))?;
            state
                .codex_realtime
                .append_audio(&thread_id, &request_id_string(request), audio)
                .await
        }
        "thread/realtime/appendText" => {
            state
                .codex_realtime
                .append_text(
                    &thread_id,
                    &request_id_string(request),
                    params
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    params
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("user")
                        .to_owned(),
                )
                .await
        }
        "thread/realtime/appendSpeech" => {
            state
                .codex_realtime
                .append_speech(
                    &thread_id,
                    &request_id_string(request),
                    params
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                )
                .await
        }
        "thread/realtime/stop" => state.codex_realtime.stop(&thread_id),
        _ => unreachable!(),
    };
    match result {
        Ok(result) => dispatch_success(request, result),
        Err(error) => Ok(dispatch_error(request, -32602, error.to_string())),
    }
}

#[tauri::command]
pub fn codex_remote_grant_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: String,
    thread_id: String,
) -> Result<Vec<String>, String> {
    let manager = thread_manager(&app, &state)?;
    manager
        .thread_recipients(&thread_id)
        .map_err(|error| error.message)?;
    let runtime = remote_control_runtime(&app, &state)?;
    runtime
        .grant_thread(&client_id, &thread_id)
        .map_err(|error| error.to_string())?;
    runtime
        .thread_grants(&client_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn codex_remote_revoke_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: String,
    thread_id: String,
) -> Result<Vec<String>, String> {
    let runtime = remote_control_runtime(&app, &state)?;
    runtime
        .revoke_thread(&client_id, &thread_id)
        .map_err(|error| error.to_string())?;
    runtime
        .thread_grants(&client_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn codex_remote_thread_grants(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: String,
) -> Result<Vec<String>, String> {
    remote_control_runtime(&app, &state)?
        .thread_grants(&client_id)
        .map_err(|error| error.to_string())
}

pub(crate) fn update_remote_transport_status(
    app: &AppHandle,
    state: &AppState,
    connected: bool,
    error: Option<String>,
) {
    let Ok(runtime) = remote_control_runtime(app, state) else {
        return;
    };
    let Ok(wire) = runtime.set_transport_state(connected, error) else {
        return;
    };
    let recipients = thread_manager(app, state)
        .and_then(|manager| {
            manager
                .connection_recipients()
                .map_err(|error| error.message)
        })
        .unwrap_or_default();
    if let Ok(notification) = routed_wire_notification(recipients, wire) {
        let _ = emit_notifications(app, &[notification]);
    }
}

pub(crate) fn claim_remote_pairing(
    app: &AppHandle,
    state: &AppState,
    client_id: &str,
    payload: &Value,
) -> Result<Value, String> {
    let metadata = serde_json::from_value::<RemoteClientMetadata>(
        payload.get("client").cloned().unwrap_or_else(|| json!({})),
    )
    .map_err(|error| format!("远程客户端信息无效：{error}"))?;
    let client = remote_control_runtime(app, state)?
        .claim_pairing(
            payload.get("pairingCode").and_then(Value::as_str),
            payload.get("manualPairingCode").and_then(Value::as_str),
            client_id,
            metadata,
        )
        .map_err(|error| error.to_string())?;
    serde_json::to_value(client).map_err(|error| error.to_string())
}

pub(crate) async fn dispatch_remote_transport_request(
    app: &AppHandle,
    state: &AppState,
    client_id: &str,
    payload: &Value,
) -> Result<Value, String> {
    let request_id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "远程 requestId 不能为空".to_string())?;
    let request_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if request_type == "codex.remote.serverResponse" {
        let response = payload
            .get("response")
            .cloned()
            .ok_or_else(|| "远程审批缺少 response".to_string())?;
        let approval_id = response
            .get("id")
            .cloned()
            .ok_or_else(|| "远程审批缺少 JSON-RPC id".to_string())?;
        let thread_id = state
            .codex_approval_requests
            .pending_thread_id(&approval_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "审批请求不存在或没有 Thread 作用域".to_string())?;
        let runtime = remote_control_runtime(app, state)?;
        match runtime
            .admit_request(client_id, &thread_id, request_id)
            .map_err(|error| error.to_string())?
        {
            RemoteRequestAdmission::Cached(value) => return Ok(value),
            RemoteRequestAdmission::Execute => {}
        }
        let result = state
            .codex_approval_requests
            .resolve(&response)
            .map_err(|error| error.to_string())
            .and_then(|resolved| {
                if resolved {
                    Ok(json!({"resolved":true}))
                } else {
                    Err("审批请求不存在或已经处理".into())
                }
            });
        match result {
            Ok(value) => {
                runtime
                    .complete_request(client_id, &thread_id, request_id, value.clone())
                    .map_err(|error| error.to_string())?;
                return Ok(value);
            }
            Err(error) => {
                let _ = runtime.fail_request(request_id);
                return Err(error);
            }
        }
    }

    let request = payload
        .get("request")
        .cloned()
        .ok_or_else(|| "远程请求缺少 request".to_string())?;
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        method,
        "thread/read"
            | "turn/steer"
            | "turn/interrupt"
            | "thread/realtime/start"
            | "thread/realtime/appendAudio"
            | "thread/realtime/appendText"
            | "thread/realtime/appendSpeech"
            | "thread/realtime/stop"
            | "thread/realtime/listVoices"
    ) {
        return Err(format!("远程方法 `{method}` 不在授权控制面内"));
    }
    let thread_id = payload
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| request.pointer("/params/threadId").and_then(Value::as_str))
        .ok_or_else(|| "远程请求缺少 threadId".to_string())?
        .to_owned();
    if method != "thread/realtime/listVoices"
        && request.pointer("/params/threadId").and_then(Value::as_str) != Some(thread_id.as_str())
    {
        return Err("远程请求的 Thread 作用域不一致".into());
    }
    let runtime = remote_control_runtime(app, state)?;
    match runtime
        .admit_request(client_id, &thread_id, request_id)
        .map_err(|error| error.to_string())?
    {
        RemoteRequestAdmission::Cached(value) => Ok(value),
        RemoteRequestAdmission::Execute => {
            let remote_connection = format!("remote:{client_id}");
            let manager = thread_manager(app, state)?;
            let subscription = manager.dispatch(
                &remote_connection,
                json!({
                    "id":format!("remote-subscribe:{request_id}"),
                    "method":"thread/resume",
                    "params":{"threadId":thread_id}
                }),
            );
            if let Some(message) = subscription
                .response
                .pointer("/error/message")
                .and_then(Value::as_str)
            {
                let _ = runtime.fail_request(request_id);
                return Err(message.to_owned());
            }
            emit_notifications(app, &subscription.notifications)?;
            let result = codex_v2_request_inner(app, state, remote_connection, request)
                .await
                .and_then(|output| serde_json::to_value(output).map_err(|error| error.to_string()));
            match result {
                Ok(value) => {
                    runtime
                        .complete_request(client_id, &thread_id, request_id, value.clone())
                        .map_err(|error| error.to_string())?;
                    Ok(value)
                }
                Err(error) => {
                    let _ = runtime.fail_request(request_id);
                    Err(error)
                }
            }
        }
    }
}

pub(crate) fn emit_notifications(
    app: &AppHandle,
    notifications: &[RoutedNotification],
) -> Result<(), String> {
    for notification in notifications {
        if !notification.method.contains("/delta") {
            let state = app.state::<AppState>();
            if let Ok(runtime) = observability_runtime(app, &state) {
                let thread_id = notification.params.get("threadId").and_then(Value::as_str);
                let turn_id = notification.params.get("turnId").and_then(Value::as_str);
                let mut event = StructuredEvent::new("info", "app_server", &notification.method)
                    .with_thread(thread_id, turn_id)
                    .with_field("recipients", notification.recipients.len() as u64);
                if notification.method == "model/rerouted" {
                    event = event
                        .with_field(
                            "fromModel",
                            notification
                                .params
                                .get("fromModel")
                                .cloned()
                                .unwrap_or(Value::Null),
                        )
                        .with_field(
                            "toModel",
                            notification
                                .params
                                .get("toModel")
                                .cloned()
                                .unwrap_or(Value::Null),
                        );
                    let _ = runtime.counter("model.rerouted", 1);
                } else if notification.method == "model/safetyBuffering/updated" {
                    let _ = runtime.counter("model.safety_buffering", 1);
                } else if notification.method == "error" {
                    let _ = runtime.counter("runtime.errors", 1);
                }
                let _ = runtime.record(event);
            }
        }
        forward_remote_payload(
            app,
            &notification.recipients,
            json!({
                "type":"codex.remote.notification",
                "version":1,
                "notification":notification.wire_message()
            }),
        );
        let mut local_notification = notification.clone();
        local_notification.recipients =
            negotiated_recipients(app, &notification.recipients, &notification.method);
        if local_notification.recipients.is_empty() {
            continue;
        }
        app.emit(CODEX_NOTIFICATION_EVENT, local_notification)
            .map_err(|error| format!("发送 Codex 通知失败：{error}"))?;
    }
    Ok(())
}

fn negotiated_recipients(app: &AppHandle, recipients: &[String], method: &str) -> Vec<String> {
    let state = app.state::<AppState>();
    let Ok(connections) = state.codex_connections.lock() else {
        return recipients.to_vec();
    };
    recipients
        .iter()
        .filter(|recipient| {
            let Some(connection) = connections.get(*recipient) else {
                return true;
            };
            connection.initialized
                && !connection.opt_out_notification_methods.contains(method)
                && (!method.starts_with("experimental/") || connection.experimental_api)
                && (method != "attestation/generate" || connection.request_attestation)
                && (method != "mcpServer/elicitation/request"
                    || connection.mcp_server_openai_form_elicitation)
        })
        .cloned()
        .collect()
}

fn emit_server_request(
    app: &AppHandle,
    request: &AccountServerRequest,
    thread_id: Option<&str>,
) -> Result<(), String> {
    if negotiated_recipients(app, &request.recipients, &request.method).is_empty() {
        return Err(format!("没有客户端声明支持 `{}`", request.method));
    }
    register_server_request(
        app,
        &request.id,
        thread_id.or_else(|| request.params.get("threadId").and_then(Value::as_str)),
        &request.recipients,
    )?;
    forward_remote_payload(
        app,
        &request.recipients,
        json!({
            "type":"codex.remote.serverRequest",
            "version":1,
            "request":request.wire_message()
        }),
    );
    app.emit(CODEX_SERVER_REQUEST_EVENT, request)
        .map_err(|error| format!("发送 Codex Server Request 失败：{error}"))
}

fn emit_approval_server_request(
    app: &AppHandle,
    request: &ApprovalServerRequest,
) -> Result<(), String> {
    if negotiated_recipients(app, &request.recipients, &request.method).is_empty() {
        return Err(format!("没有客户端声明支持 `{}`", request.method));
    }
    register_server_request(
        app,
        &request.id,
        request.params.get("threadId").and_then(Value::as_str),
        &request.recipients,
    )?;
    forward_remote_payload(
        app,
        &request.recipients,
        json!({
            "type":"codex.remote.serverRequest",
            "version":1,
            "request":request.wire_message()
        }),
    );
    app.emit(CODEX_SERVER_REQUEST_EVENT, request)
        .map_err(|error| format!("发送 Codex 审批请求失败：{error}"))
}

fn emit_operations_server_request(
    app: &AppHandle,
    request: &OperationsServerRequest,
    thread_id: &str,
) -> Result<(), String> {
    if negotiated_recipients(app, &request.recipients, &request.method).is_empty() {
        return Err(format!("没有客户端声明支持 `{}`", request.method));
    }
    register_server_request(app, &request.id, Some(thread_id), &request.recipients)?;
    forward_remote_payload(
        app,
        &request.recipients,
        json!({
            "type":"codex.remote.serverRequest",
            "version":1,
            "request":request.wire_message()
        }),
    );
    app.emit(CODEX_SERVER_REQUEST_EVENT, request)
        .map_err(|error| format!("发送 Codex Attestation 请求失败：{error}"))
}

fn register_server_request(
    app: &AppHandle,
    request_id: &Value,
    thread_id: Option<&str>,
    recipients: &[String],
) -> Result<(), String> {
    let Some(thread_id) = thread_id.filter(|thread_id| !thread_id.trim().is_empty()) else {
        return Ok(());
    };
    app.state::<AppState>()
        .codex_attestation
        .tracker()
        .register(request_id, thread_id, recipients.to_vec())
        .map_err(|error| format!("登记 Codex Server Request 失败：{error}"))
}

fn forward_remote_payload(app: &AppHandle, recipients: &[String], payload: Value) {
    let state = app.state::<AppState>();
    for client_id in recipients
        .iter()
        .filter_map(|recipient| recipient.strip_prefix("remote:"))
    {
        let _ = state.device_fabric.send_remote(client_id, payload.clone());
    }
}

#[tauri::command]
pub fn codex_v2_server_response(
    app: AppHandle,
    state: State<'_, AppState>,
    response: Value,
) -> Result<bool, String> {
    if let Some(resolved) = state
        .codex_attestation
        .tracker()
        .resolve(&response)
        .map_err(|error| format!("Codex Server Request 状态错误：{error}"))?
    {
        emit_notifications(
            &app,
            &[RoutedNotification {
                recipients: resolved.recipients,
                method: resolved.method,
                params: resolved.params,
            }],
        )?;
    }
    if state
        .codex_attestation
        .resolve(&response)
        .map_err(|error| format!("Codex Attestation 状态错误：{error}"))?
    {
        return Ok(true);
    }
    if state
        .codex_account_requests
        .resolve(&response)
        .map_err(account_rpc_error)?
    {
        return Ok(true);
    }
    if state.codex_mcp_requests.resolve(&response)? {
        return Ok(true);
    }
    state
        .codex_approval_requests
        .resolve(&response)
        .map_err(|error| format!("Codex approval 状态错误：{error}"))
}

fn cancel_thread(state: &AppState, thread_id: &str, expected_turn_id: Option<&str>) {
    let _ = state.codex_attestation.tracker().cancel_thread(thread_id);
    if let Ok(cancels) = state.codex_cancels.lock() {
        if let Some((turn_id, cancel)) = cancels.get(thread_id) {
            if expected_turn_id.is_none_or(|expected| expected == turn_id) {
                cancel.cancel();
            }
        }
    }
    let descendants = state
        .codex_collab
        .lock()
        .ok()
        .and_then(|runtime| runtime.as_ref().cloned())
        .map(|runtime| {
            let descendants = runtime.descendants(thread_id);
            for descendant in &descendants {
                let _ = runtime.update_status(descendant, CollabAgentStatus::interrupted());
            }
            descendants
        })
        .unwrap_or_default();
    if let Ok(cancels) = state.codex_cancels.lock() {
        for descendant in descendants {
            if let Some((_, cancel)) = cancels.get(&descendant) {
                cancel.cancel();
            }
        }
    }
}

fn signal_turn_input_activity(state: &AppState, thread_id: &str, turn_id: &str) {
    if let Ok(mut activity) = state.codex_input_activity.lock() {
        let Some((active_turn_id, token)) = activity.get_mut(thread_id) else {
            return;
        };
        if active_turn_id != turn_id {
            return;
        }
        token.cancel();
        *token = CancellationToken::new();
    }
}

fn turn_input_activity_token(app: &AppHandle, thread_id: &str, turn_id: &str) -> CancellationToken {
    app.state::<AppState>()
        .codex_input_activity
        .lock()
        .ok()
        .and_then(|activity| {
            activity
                .get(thread_id)
                .filter(|(active_turn_id, _)| active_turn_id == turn_id)
                .map(|(_, token)| token.clone())
        })
        .unwrap_or_default()
}

fn turn_cancellation_token(app: &AppHandle, thread_id: &str, turn_id: &str) -> CancellationToken {
    app.state::<AppState>()
        .codex_cancels
        .lock()
        .ok()
        .and_then(|cancels| {
            cancels
                .get(thread_id)
                .filter(|(active_turn_id, _)| active_turn_id == turn_id)
                .map(|(_, token)| token.clone())
        })
        .unwrap_or_default()
}

#[derive(Clone)]
struct DesktopCollaborationHost {
    app: AppHandle,
    manager: ThreadManager,
}

impl DesktopCollaborationHost {
    fn dispatch_unemitted(&self, method: &str, params: Value) -> Result<Value, CollaborationError> {
        let output = self.manager.dispatch(
            "internal-collaboration",
            json!({
                "id":Uuid::new_v4().to_string(),
                "method":method,
                "params":params
            }),
        );
        if let Some(error) = output.response.get("error") {
            return Err(CollaborationError::Host(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("internal collaboration request failed")
                    .into(),
            ));
        }
        Ok(output
            .response
            .get("result")
            .cloned()
            .unwrap_or(Value::Null))
    }

    fn dispatch(&self, method: &str, params: Value) -> Result<Value, CollaborationError> {
        let output = self.manager.dispatch(
            "internal-collaboration",
            json!({"id":Uuid::new_v4().to_string(),"method":method,"params":params}),
        );
        if let Some(error) = output.response.get("error") {
            return Err(CollaborationError::Host(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("internal collaboration request failed")
                    .into(),
            ));
        }
        emit_notifications(&self.app, &output.notifications).map_err(CollaborationError::Host)?;
        Ok(output
            .response
            .get("result")
            .cloned()
            .unwrap_or(Value::Null))
    }

    fn start_turn(
        &self,
        thread_id: &str,
        message: &str,
        model: Option<String>,
        reasoning_effort: Option<String>,
        service_tier: Option<String>,
    ) -> Result<(), CollaborationError> {
        let result = self.dispatch(
            "turn/start",
            json!({
                "threadId":thread_id,
                "input":[{
                    "type":"text",
                    "text":message,
                    "textElements":[]
                }],
                "model":model,
                "effort":reasoning_effort,
                "serviceTier":service_tier
            }),
        )?;
        let turn_id = result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                CollaborationError::Host("turn/start did not return a turn id".into())
            })?;
        let state = self.app.state::<AppState>();
        launch_turn_executor(
            &self.app,
            &state,
            self.manager.clone(),
            thread_id.into(),
            turn_id.into(),
        );
        Ok(())
    }
}

impl CollaborationHost for DesktopCollaborationHost {
    fn spawn<'a>(
        &'a self,
        request: SpawnRequest,
    ) -> HostFuture<'a, Result<SpawnedAgent, CollaborationError>> {
        Box::pin(async move {
            let parent = self
                .manager
                .turn_execution_snapshot(
                    &request.author_thread_id,
                    self.manager
                        .active_turn_id(&request.author_thread_id)
                        .map_err(|error| CollaborationError::Host(format!("{error:?}")))?
                        .as_deref()
                        .ok_or_else(|| {
                            CollaborationError::Host("parent agent has no active turn".into())
                        })?,
                )
                .map_err(|error| CollaborationError::Host(format!("{error:?}")))?;
            let effective_model = request.model.clone().or_else(|| Some(parent.model.clone()));
            let effective_reasoning_effort = request
                .reasoning_effort
                .clone()
                .or_else(|| parent.reasoning_effort.clone());
            let effective_service_tier = request
                .service_tier
                .clone()
                .or_else(|| parent.service_tier.clone());
            let forked_history = !matches!(request.fork_turns, ForkTurns::None);
            let inherited_history = match request.fork_turns {
                ForkTurns::None => Vec::new(),
                ForkTurns::All => sanitize_collaboration_fork_history(parent.history.clone()),
                ForkTurns::Last(turns) => sanitize_collaboration_fork_history(
                    self.manager
                        .response_history_tail(&request.author_thread_id, turns)
                        .map_err(|error| CollaborationError::Host(format!("{error:?}")))?,
                ),
            };
            let result = self.dispatch_unemitted(
                "thread/start",
                json!({
                    "model":effective_model,
                    "modelProvider":parent.model_provider,
                    "serviceTier":effective_service_tier,
                    "cwd":parent.cwd,
                    "approvalPolicy":parent.approval_policy,
                    "sandbox":sandbox_start_mode(&parent.sandbox),
                    "baseInstructions":parent.base_instructions,
                    "developerInstructions":parent.developer_instructions,
                    "threadSource":"subagent"
                }),
            )?;
            let thread_id = result
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CollaborationError::Host("thread creation did not return a thread id".into())
                })?
                .to_owned();
            let depth = request
                .agent_path
                .split('/')
                .filter(|segment| !segment.is_empty())
                .count()
                .saturating_sub(1);
            self.manager
                .configure_subagent_thread(
                    &thread_id,
                    SubagentThreadConfig {
                        parent_thread_id: request.author_thread_id.clone(),
                        agent_path: request.agent_path.clone(),
                        agent_nickname: None,
                        agent_role: request.agent_type.clone(),
                        depth,
                        forked_history,
                    },
                )
                .map_err(|error| CollaborationError::Host(format!("{error:?}")))?;
            if !inherited_history.is_empty() {
                self.dispatch(
                    "thread/inject_items",
                    json!({"threadId":thread_id,"items":inherited_history}),
                )?;
            }
            let thread = self.dispatch_unemitted(
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":false}),
            )?;
            emit_notifications(
                &self.app,
                &[RoutedNotification {
                    recipients: self
                        .manager
                        .connection_recipients()
                        .map_err(|error| CollaborationError::Host(format!("{error:?}")))?,
                    method: "thread/started".into(),
                    params: json!({"thread":thread["thread"].clone()}),
                }],
            )
            .map_err(CollaborationError::Host)?;
            Ok(SpawnedAgent {
                thread_id,
                nickname: None,
                effective_model,
                effective_reasoning_effort,
                effective_service_tier,
            })
        })
    }

    fn start<'a>(
        &'a self,
        target_thread_id: &'a str,
        message: &'a str,
        model: Option<String>,
        reasoning_effort: Option<String>,
        service_tier: Option<String>,
    ) -> HostFuture<'a, Result<(), CollaborationError>> {
        Box::pin(async move {
            self.start_turn(
                target_thread_id,
                message,
                model,
                reasoning_effort,
                service_tier,
            )
        })
    }

    fn deliver<'a>(
        &'a self,
        target_thread_id: &'a str,
        message: MailboxMessage,
    ) -> HostFuture<'a, Result<(), CollaborationError>> {
        Box::pin(async move {
            let content = format!(
                "<agent_message author=\"{}\">{}</agent_message>",
                message.author, message.message
            );
            if let Some(turn_id) = self
                .manager
                .active_turn_id(target_thread_id)
                .map_err(|error| CollaborationError::Host(format!("{error:?}")))?
            {
                self.dispatch(
                    "turn/steer",
                    json!({
                        "threadId":target_thread_id,
                        "expectedTurnId":turn_id,
                        "input":[{"type":"text","text":content,"textElements":[]}]
                    }),
                )?;
                signal_turn_input_activity(
                    &self.app.state::<AppState>(),
                    target_thread_id,
                    &turn_id,
                );
            } else if message.trigger_turn {
                self.start_turn(target_thread_id, &content, None, None, None)?;
            } else {
                self.dispatch(
                    "thread/inject_items",
                    json!({
                        "threadId":target_thread_id,
                        "items":[{
                            "type":"message",
                            "role":"user",
                            "content":[{"type":"input_text","text":content}]
                        }]
                    }),
                )?;
            }
            Ok(())
        })
    }

    fn interrupt<'a>(
        &'a self,
        target_thread_id: &'a str,
    ) -> HostFuture<'a, Result<(), CollaborationError>> {
        Box::pin(async move {
            if let Some(turn_id) = self
                .manager
                .active_turn_id(target_thread_id)
                .map_err(|error| CollaborationError::Host(format!("{error:?}")))?
            {
                self.dispatch(
                    "turn/interrupt",
                    json!({"threadId":target_thread_id,"turnId":turn_id}),
                )?;
                cancel_thread(
                    &self.app.state::<AppState>(),
                    target_thread_id,
                    Some(&turn_id),
                );
            }
            Ok(())
        })
    }
}

fn sandbox_start_mode(sandbox: &Value) -> Value {
    match sandbox.get("type").and_then(Value::as_str) {
        Some("dangerFullAccess") => json!("danger-full-access"),
        Some("readOnly") => json!("read-only"),
        _ => json!("workspace-write"),
    }
}

fn sanitize_collaboration_fork_history(mut history: Vec<Value>) -> Vec<Value> {
    let dangling_spawn = history
        .iter()
        .enumerate()
        .rev()
        .find(|(_, item)| {
            item.get("type").and_then(Value::as_str) == Some("function_call")
                && item.get("name").and_then(Value::as_str) == Some("spawn_agent")
        })
        .and_then(|(index, item)| {
            let call_id = item.get("call_id").and_then(Value::as_str)?;
            let has_output = history[index + 1..].iter().any(|candidate| {
                candidate.get("call_id").and_then(Value::as_str) == Some(call_id)
                    && matches!(
                        candidate.get("type").and_then(Value::as_str),
                        Some("function_call_output" | "custom_tool_call_output")
                    )
            });
            (!has_output).then_some(index)
        });
    if let Some(index) = dangling_spawn {
        history.remove(index);
    }
    history
}

/// Dispatch one App Server V2 request without embedding an upstream binary.
///
/// The request itself remains synchronous so JSON-RPC acceptance and lifecycle
/// notifications preserve their order. A successful `turn/start` launches the
/// source-native Responses executor on Tauri's async runtime.
#[tauri::command]
pub async fn codex_v2_request(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    request: Value,
) -> Result<DispatchOutput, String> {
    let started = Instant::now();
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let thread_id = request
        .pointer("/params/threadId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let turn_id = request
        .pointer("/params/turnId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let runtime = observability_runtime(&app, &state).ok();
    if let Some(runtime) = runtime.as_ref() {
        let _ = runtime.record(
            StructuredEvent::new("info", "app_server", "request.started")
                .with_thread(thread_id.as_deref(), turn_id.as_deref())
                .with_field("method", method.clone())
                .with_field("connectionId", connection_id.clone()),
        );
    }
    let result = codex_v2_request_inner(&app, &state, connection_id, request).await;
    if let Some(runtime) = runtime {
        let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let failed = result
            .as_ref()
            .map(|output| output.response.get("error").is_some())
            .unwrap_or(true);
        let _ = runtime.histogram("app_server.request.duration_ms", elapsed_ms);
        let _ = runtime.counter(
            if failed {
                "app_server.request.failed"
            } else {
                "app_server.request.completed"
            },
            1,
        );
        let _ = runtime.record(
            StructuredEvent::new(
                if failed { "error" } else { "info" },
                "app_server",
                "request.completed",
            )
            .with_thread(thread_id.as_deref(), turn_id.as_deref())
            .with_field("method", method)
            .with_field("durationMs", elapsed_ms)
            .with_field("failed", failed),
        );
    }
    result
}

#[derive(Debug, Clone)]
struct WorkspaceThreadBinding {
    project_id: String,
    task_mode: super::workspace::TaskMode,
    agent_id: String,
}

fn workspace_thread_binding(request: &Value) -> Result<Option<WorkspaceThreadBinding>, String> {
    if request.get("method").and_then(Value::as_str) != Some("thread/start") {
        return Ok(None);
    }
    let Some(task) = request.pointer("/params/config/tietiezhiTask") else {
        return Ok(None);
    };
    let project_id = task
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let task_mode = match task.get("taskMode").and_then(Value::as_str) {
        Some("work") => super::workspace::TaskMode::Work,
        Some("code") => super::workspace::TaskMode::Code,
        _ => return Err("Tietiezhi 任务模式必须是 work 或 code".into()),
    };
    let agent_id = task
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    Ok(Some(WorkspaceThreadBinding {
        project_id,
        task_mode,
        agent_id,
    }))
}

pub(crate) async fn codex_v2_request_inner(
    app: &AppHandle,
    state: &AppState,
    connection_id: String,
    request: Value,
) -> Result<DispatchOutput, String> {
    if connection_id.trim().is_empty() {
        return Err("connectionId 不能为空".into());
    }
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if method == "initialize" {
        return initialize_connection(app, state, &connection_id, &request);
    }
    {
        let mut connections = state
            .codex_connections
            .lock()
            .map_err(|_| "Codex 连接状态锁已损坏".to_string())?;
        connections
            .entry(connection_id.clone())
            .or_insert_with(|| CodexConnectionState {
                initialized: true,
                ..CodexConnectionState::default()
            });
    }
    state
        .codex_account
        .register_connection(&connection_id)
        .map_err(account_rpc_error)?;
    if remote_control_method(&method) {
        let manager = thread_manager(app, state)?;
        let output = dispatch_remote_control_request(app, state, &manager, &request, &method)?;
        emit_notifications(app, &output.notifications)?;
        return Ok(output);
    }
    if realtime_method(&method) {
        let manager = thread_manager(app, state)?;
        let output = dispatch_realtime_request(app, state, &manager, &request, &method).await?;
        emit_notifications(app, &output.notifications)?;
        return Ok(output);
    }
    if matches!(
        method.as_str(),
        "feedback/upload" | "hooks/list" | "modelProvider/capabilities/read"
    ) {
        return dispatch_operations_request(app, state, &request, &method).await;
    }
    if method.starts_with("externalAgentConfig/") {
        return dispatch_external_agent_request(app, state, &connection_id, &request, &method)
            .await;
    }
    if method == "memory/reset" {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let valid_shape = request.get("method").and_then(Value::as_str) == Some("memory/reset")
            && (id.is_string() || id.is_i64() || id.is_u64())
            && request.get("params").is_none_or(|params| {
                params.is_null() || params.as_object().is_some_and(serde_json::Map::is_empty)
            });
        if !valid_shape {
            return Ok(dispatch_error(
                &request,
                -32602,
                "memory/reset 参数不符合 App Server V2",
            ));
        }
        let runtime = memory_runtime(app, state)?;
        return match runtime.reset() {
            Ok(()) => dispatch_success(&request, json!({})),
            Err(error) => Ok(dispatch_error(
                &request,
                -32603,
                format!("重置 Codex Memory 失败：{error}"),
            )),
        };
    }
    if ConfigRuntime::handles(&method) {
        let output = dispatch_config_request(app, state, &connection_id, &request, &method).await?;
        emit_notifications(app, &output.notifications)?;
        return Ok(output);
    }
    if SkillsRuntime::handles(&method) {
        let output = dispatch_skills_request(app, state, &connection_id, &request, &method)?;
        emit_notifications(app, &output.notifications)?;
        return Ok(output);
    }
    if matches!(method.as_str(), "app/list" | "app/read" | "app/installed") {
        let output = dispatch_apps_request(app, state, &connection_id, &request, &method)?;
        emit_notifications(app, &output.notifications)?;
        return Ok(output);
    }
    if PluginRuntime::handles(&method) {
        let output = dispatch_plugin_request(app, state, &connection_id, &request, &method).await?;
        emit_notifications(app, &output.notifications)?;
        return Ok(output);
    }
    if tietiezhi_agent_account::AccountRuntime::handles(&method) {
        let output =
            dispatch_account_request(app, state, &connection_id, &request, &method).await?;
        emit_notifications(app, &output.notifications)?;
        return Ok(output);
    }
    if method == "model/list" {
        if let Some(output) = online_model_list(app, &request)? {
            return Ok(output);
        }
    }
    if method == "permissionProfile/list" {
        return permission_profile_list(&request);
    }
    if super::codex_fs::handles(&method) {
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        return match super::codex_fs::dispatch(app, state, &connection_id, &method, &params).await {
            Ok((result, notifications)) => {
                let mut output = dispatch_success(&request, result)?;
                output.notifications = notifications;
                emit_notifications(app, &output.notifications)?;
                Ok(output)
            }
            Err(error) => Ok(dispatch_error(&request, -32602, error)),
        };
    }
    if matches!(
        method.as_str(),
        "mcpServer/oauth/login"
            | "mcpServer/resource/read"
            | "mcpServer/tool/call"
            | "mcpServerStatus/list"
    ) {
        return dispatch_mcp_request(app, state, &request, &method).await;
    }
    if matches!(
        method.as_str(),
        "windowsSandbox/readiness" | "windowsSandbox/setupStart"
    ) {
        let output = dispatch_windows_sandbox(&connection_id, &request, &method)?;
        emit_notifications(app, &output.notifications)?;
        return Ok(output);
    }
    if method.starts_with("command/exec") {
        return dispatch_command_exec(app, state, &connection_id, &request, &method).await;
    }
    if method == "thread/shellCommand" {
        return dispatch_thread_shell_command(app, state, &connection_id, &request).await;
    }
    let thread_id = request
        .pointer("/params/threadId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let requested_turn_id = request
        .pointer("/params/turnId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let requested_memory_mode = request
        .pointer("/params/mode")
        .and_then(Value::as_str)
        .and_then(|mode| match mode {
            "enabled" => Some(ThreadMemoryMode::Enabled),
            "disabled" => Some(ThreadMemoryMode::Disabled),
            _ => None,
        });
    let thread_start_ephemeral = request
        .pointer("/params/ephemeral")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let thread_start_is_background = request
        .pointer("/params/threadSource")
        .and_then(Value::as_str)
        .is_some_and(|source| {
            source == "subagent"
                || source == "memory_consolidation"
                || source.starts_with("subagent")
                || source.starts_with("subAgent")
        });

    let workspace_binding = workspace_thread_binding(&request)?;
    if let Some(binding) = workspace_binding.as_ref() {
        if !binding.project_id.is_empty()
            && super::projects::find_project(app, &binding.project_id)?.is_none()
        {
            return Ok(dispatch_error(&request, -32602, "任务关联的项目不存在"));
        }
    }

    let manager = thread_manager(app, state)?;
    if method == "thread/delete" {
        if let Some(thread_id) = thread_id.as_deref() {
            super::conversations::prepare_codex_thread_delete(app, thread_id)?;
        }
    }
    if matches!(method.as_str(), "thread/archive" | "thread/delete") {
        if let Some(thread_id) = thread_id.as_deref() {
            let cwd = runtime_defaults(app)?.cwd;
            let hooks = run_hooks(
                app,
                &manager,
                HookRequest {
                    event_name: HookEventName::SessionEnd,
                    thread_id: thread_id.to_owned(),
                    turn_id: None,
                    cwd,
                    matcher: Some(
                        if method == "thread/archive" {
                            "archive"
                        } else {
                            "delete"
                        }
                        .into(),
                    ),
                    payload: json!({
                        "reason": if method == "thread/archive" {"archive"} else {"delete"}
                    }),
                },
            )
            .await
            .map_err(|error| error.to_string())?;
            ensure_hook_allows(&hooks).map_err(|error| error.to_string())?;
        }
    }
    if method == "turn/interrupt" {
        if let (Some(thread_id), Some(turn_id)) =
            (thread_id.as_deref(), requested_turn_id.as_deref())
        {
            finalize_interrupted_review(app, &manager, thread_id, turn_id);
        }
    } else if matches!(method.as_str(), "thread/archive" | "thread/delete") {
        if let Some(thread_id) = thread_id.as_deref() {
            if let Ok(Some(turn_id)) = manager.active_turn_id(thread_id) {
                finalize_interrupted_review(app, &manager, thread_id, &turn_id);
            }
        }
    }
    let mut output = manager.dispatch(&connection_id, request.clone());
    if output.response.get("error").is_none() {
        if let Some(binding) = workspace_binding {
            let thread_id = output
                .response
                .pointer("/result/thread/id")
                .and_then(Value::as_str)
                .ok_or_else(|| "thread/start 未返回 Thread ID".to_string())?
                .to_owned();
            let configure_result = (|| -> Result<DispatchOutput, String> {
                manager
                    .bind_task_context(
                        &thread_id,
                        &binding.project_id,
                        binding.task_mode.as_str(),
                        &binding.agent_id,
                    )
                    .map_err(|error| error.message)?;
                let cwd = super::workspace::resolve_task_workspace(
                    app,
                    (!binding.project_id.is_empty()).then_some(binding.project_id.as_str()),
                    Some(&thread_id),
                    binding.task_mode,
                )?;
                let sandbox = if output
                    .response
                    .pointer("/result/sandbox/type")
                    .and_then(Value::as_str)
                    == Some("dangerFullAccess")
                {
                    "danger-full-access"
                } else {
                    "workspace-write"
                };
                let resumed = manager.dispatch(
                    &connection_id,
                    json!({
                        "id":request.get("id").cloned().unwrap_or(Value::Null),
                        "method":"thread/resume",
                        "params":{
                            "threadId":thread_id,
                            "cwd":cwd,
                            "sandbox":sandbox
                        }
                    }),
                );
                if let Some(error) = resumed.response.get("error") {
                    return Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("配置任务执行目录失败")
                        .to_owned());
                }
                Ok(resumed)
            })();
            match configure_result {
                Ok(configured) => {
                    output.response = configured.response;
                    output.notifications = configured.notifications;
                }
                Err(error) => {
                    if let Ok(root) = super::conversations::task_root(app, &thread_id) {
                        super::workspace::cleanup_task_workspaces(app, &binding.project_id, &root);
                    }
                    let _ = manager.dispatch(
                        &connection_id,
                        json!({
                            "id":request.get("id").cloned().unwrap_or(Value::Null),
                            "method":"thread/delete",
                            "params":{"threadId":thread_id}
                        }),
                    );
                    return Ok(dispatch_error(&request, -32603, error));
                }
            }
        }
    }
    if method == "thread/memoryMode/set" && output.response.get("error").is_none() {
        if let (Some(thread_id), Some(mode)) = (thread_id.as_deref(), requested_memory_mode) {
            memory_runtime(app, state)?
                .set_thread_mode(thread_id, mode)
                .map_err(|error| format!("保存 Thread Memory Mode 失败：{error}"))?;
        }
    }
    if method == "turn/steer" && output.response.get("error").is_none() {
        if let (Some(thread_id), Some(turn_id)) =
            (thread_id.as_deref(), requested_turn_id.as_deref())
        {
            signal_turn_input_activity(state, thread_id, turn_id);
        }
    }
    let should_cancel = output.response.get("error").is_none()
        && matches!(
            method.as_str(),
            "turn/interrupt" | "thread/archive" | "thread/delete"
        );
    if should_cancel {
        if let Some(thread_id) = thread_id.as_deref() {
            let expected_turn_id = (method == "turn/interrupt")
                .then_some(requested_turn_id.as_deref())
                .flatten();
            cancel_thread(state, thread_id, expected_turn_id);
            if matches!(method.as_str(), "thread/archive" | "thread/delete") {
                let _ = state.codex_realtime.stop(thread_id);
                state
                    .codex_session_approvals
                    .clear_session(thread_id)
                    .map_err(|error| error.to_string())?;
                if let Ok(runtime) = hooks_runtime(app, state) {
                    runtime.end_session(thread_id);
                }
            }
        }
    }
    emit_notifications(app, &output.notifications)?;

    if method == "thread/start"
        && output.response.get("error").is_none()
        && !thread_start_ephemeral
        && !thread_start_is_background
        && memories_config(app).generate_memories
    {
        if let (Some(thread_id), Some(model), Some(model_provider)) = (
            output
                .response
                .pointer("/result/thread/id")
                .and_then(Value::as_str),
            output
                .response
                .pointer("/result/model")
                .and_then(Value::as_str),
            output
                .response
                .pointer("/result/modelProvider")
                .and_then(Value::as_str),
        ) {
            launch_memory_pipeline(
                app,
                manager.clone(),
                thread_id.to_owned(),
                model.to_owned(),
                model_provider.to_owned(),
            );
        }
    }

    let starts_new_turn = method == "turn/start"
        && output
            .notifications
            .iter()
            .any(|notification| notification.method == "turn/started");
    if starts_new_turn {
        if let (Some(thread_id), Some(turn_id)) = (
            thread_id,
            output
                .response
                .pointer("/result/turn/id")
                .and_then(Value::as_str)
                .map(str::to_owned),
        ) {
            launch_turn_executor(app, state, manager, thread_id, turn_id);
        }
    } else if method == "review/start" && output.response.get("error").is_none() {
        let review_thread_id = output
            .response
            .pointer("/result/reviewThreadId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let turn_id = output
            .response
            .pointer("/result/turn/id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let (Some(thread_id), Some(turn_id)) = (review_thread_id, turn_id) {
            launch_turn_executor(app, state, manager, thread_id, turn_id);
        }
    } else if method == "thread/compact/start" && output.response.get("error").is_none() {
        let turn_id = output
            .notifications
            .iter()
            .find(|notification| notification.method == "turn/started")
            .and_then(|notification| notification.params.pointer("/turn/id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            launch_compaction_executor(app, state, manager, thread_id, turn_id);
        }
    }
    Ok(output)
}

fn permission_profile_list(request: &Value) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("permissionProfile/list 参数不符合 App Server V2：{error}"),
        ));
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let profiles = [
        json!({"id":":read-only","description":null,"allowed":true}),
        json!({"id":":workspace","description":null,"allowed":true}),
        json!({"id":":danger-full-access","description":null,"allowed":true}),
    ];
    let total = profiles.len();
    let start = match params.get("cursor").filter(|value| !value.is_null()) {
        Some(cursor) => match cursor
            .as_str()
            .and_then(|cursor| cursor.parse::<usize>().ok())
        {
            Some(start) if start <= total => start,
            _ => {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "invalid permission profile cursor",
                ));
            }
        },
        None => 0,
    };
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .map(|limit| usize::try_from(limit).unwrap_or(usize::MAX))
        .unwrap_or(total)
        .max(1)
        .min(total);
    let end = start.saturating_add(limit).min(total);
    let result = json!({
        "data":profiles[start..end],
        "nextCursor":(end < total).then(|| end.to_string())
    });
    debug_assert!(serde_json::from_value::<PermissionProfileListResponse>(result.clone()).is_ok());
    dispatch_success(request, result)
}

async fn dispatch_operations_request(
    app: &AppHandle,
    state: &AppState,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("{method} 参数不符合 App Server V2：{error}"),
        ));
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match method {
        "hooks/list" => {
            let mut cwds = params
                .get("cwds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(std::path::PathBuf::from)
                .collect::<Vec<_>>();
            if cwds.is_empty() {
                cwds.push(runtime_defaults(app)?.cwd);
            }
            let result = serde_json::to_value(hooks_runtime(app, state)?.list(&cwds))
                .map_err(|error| format!("序列化 Hooks 目录失败：{error}"))?;
            serde_json::from_value::<tietiezhi_agent_protocol::HooksListResponse>(result.clone())
                .map_err(|error| format!("hooks/list 返回值不符合 App Server V2：{error}"))?;
            result
        }
        "modelProvider/capabilities/read" => {
            let settings = super::settings::read_settings(app)?;
            let provider = settings
                .providers
                .iter()
                .find(|provider| provider.id == settings.chat_provider_id);
            let selected_model = provider.and_then(|provider| {
                provider
                    .models
                    .iter()
                    .find(|model| model.id == settings.chat_model)
            });
            let responses = provider.is_some_and(|provider| {
                provider.wire_api != super::settings::WireApi::ChatCompletions
            });
            let result = json!({
                "namespaceTools":responses,
                "imageGeneration":responses && provider.is_some_and(|provider| provider.built_in || provider.kind.eq_ignore_ascii_case("openai")),
                "webSearch":responses && (
                    provider.is_some_and(|provider| provider.built_in)
                    || selected_model.is_some_and(|model| model.capabilities.contains(&super::models::ModelCapability::WebSearch))
                )
            });
            serde_json::from_value::<ModelProviderCapabilitiesReadResponse>(result.clone())
                .map_err(|error| {
                    format!("modelProvider/capabilities/read 返回值不符合 App Server V2：{error}")
                })?;
            result
        }
        "feedback/upload" => {
            let classification = params
                .get("classification")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let extra_log_files = params
                .get("extraLogFiles")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(std::path::PathBuf::from)
                .collect();
            let tags = params
                .get("tags")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_owned()))
                })
                .collect();
            let runtime = observability_runtime(app, state)?;
            let doctor = runtime.doctor(doctor_input(app)?);
            let receipt = match runtime
                .upload_feedback(
                    FeedbackUpload {
                        classification,
                        reason: params
                            .get("reason")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        thread_id: params
                            .get("threadId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        include_logs: params
                            .get("includeLogs")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        extra_log_files,
                        tags,
                    },
                    doctor,
                )
                .await
            {
                Ok(receipt) => receipt,
                Err(error) => {
                    return Ok(dispatch_error(
                        request,
                        -32603,
                        format!("提交反馈失败：{error}"),
                    ));
                }
            };
            let result = json!({"threadId":receipt.thread_id});
            serde_json::from_value::<tietiezhi_agent_protocol::FeedbackUploadResponse>(
                result.clone(),
            )
            .map_err(|error| format!("feedback/upload 返回值不符合 App Server V2：{error}"))?;
            result
        }
        _ => return Ok(dispatch_error(request, -32601, "method not found")),
    };
    dispatch_success(request, result)
}

#[tauri::command]
pub fn codex_doctor_report(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DoctorReport, String> {
    let runtime = observability_runtime(&app, &state)?;
    Ok(runtime.doctor(doctor_input(&app)?))
}

#[tauri::command]
pub fn codex_runtime_metrics(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MetricsSnapshot, String> {
    observability_runtime(&app, &state)?
        .snapshot_metrics()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn codex_export_telemetry(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    observability_runtime(&app, &state)?
        .export_otlp()
        .await
        .map_err(|error| error.to_string())
}

/// Requests an opaque client attestation for a Thread. The Responses
/// WebSocket transport can use this token as `x-oai-attestation` when the
/// initialized client opts into reverse attestation requests.
#[tauri::command]
pub async fn codex_request_attestation(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<String, String> {
    let recipients = thread_manager(&app, &state)?
        .thread_recipients(&thread_id)
        .map_err(|error| format!("读取 Thread 订阅者失败：{error:?}"))?;
    if recipients.is_empty() {
        return Err("当前 Thread 没有可处理 Attestation 的客户端".into());
    }
    let pending = state
        .codex_attestation
        .begin(recipients, &thread_id)
        .map_err(|error| format!("创建 Attestation 请求失败：{error}"))?;
    let request_id = pending.request.id.clone();
    if let Err(error) = emit_operations_server_request(&app, &pending.request, &thread_id) {
        let _ = state.codex_attestation.cancel(&request_id);
        return Err(error);
    }
    match tokio::time::timeout(Duration::from_secs(60), pending.receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            let _ = state.codex_attestation.cancel(&request_id);
            Err("Attestation 客户端已断开".into())
        }
        Err(_) => {
            let _ = state.codex_attestation.cancel(&request_id);
            Err("Attestation 请求超时".into())
        }
    }
}

fn online_model_list(app: &AppHandle, request: &Value) -> Result<Option<DispatchOutput>, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(Some(dispatch_error(
            request,
            -32602,
            format!("model/list 参数不符合 App Server V2：{error}"),
        )));
    }
    let settings = super::settings::read_settings(app)?;
    let Some(provider) = settings
        .providers
        .iter()
        .find(|provider| provider.id == settings.chat_provider_id)
    else {
        return Ok(None);
    };
    let models = provider
        .models
        .iter()
        .filter(|model| {
            model.effective_kind() == super::models::ModelKind::Chat && !model.id.trim().is_empty()
        })
        .map(|model| {
            let reasoning = model.effective_reasoning();
            let reasoning_efforts = reasoning
                .map(|profile| {
                    profile
                        .supported_efforts
                        .iter()
                        .filter_map(|effort| effort.as_wire_value().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            let default_reasoning_effort = reasoning
                .and_then(|profile| profile.default_effort)
                .and_then(|effort| effort.as_wire_value())
                .unwrap_or("medium")
                .to_owned();
            let input_modalities = model
                .input_modalities
                .iter()
                .filter_map(|modality| match modality {
                    super::models::ModelModality::Text => Some("text".into()),
                    super::models::ModelModality::Image => Some("image".into()),
                    _ => None,
                })
                .collect();
            OnlineModel {
                id: model.id.clone(),
                display_name: model.id.clone(),
                description: format!("{} 提供的 Agent 模型", provider.name),
                reasoning_efforts,
                default_reasoning_effort,
                input_modalities,
                is_default: model.id == settings.chat_model,
            }
        })
        .collect::<Vec<_>>();
    if models.is_empty() {
        return Ok(None);
    }
    let cursor = match request
        .pointer("/params/cursor")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "model/list cursor 必须是字符串".to_string())
        })
        .transpose()
    {
        Ok(value) => value,
        Err(error) => return Ok(Some(dispatch_error(request, -32602, error))),
    };
    let limit = match request
        .pointer("/params/limit")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "model/list limit 必须是无符号 32 位整数".to_string())
        })
        .transpose()
    {
        Ok(value) => value,
        Err(error) => return Ok(Some(dispatch_error(request, -32602, error))),
    };
    let result = match list_online_models(models, cursor, limit) {
        Ok(result) => result,
        Err(error) => {
            return Ok(Some(dispatch_error(
                request,
                -32602,
                format!("模型目录无效：{error}"),
            )));
        }
    };
    if let Err(error) = serde_json::from_value::<ModelListResponse>(result.clone()) {
        return Ok(Some(dispatch_error(
            request,
            -32603,
            format!("在线模型目录不符合 App Server V2：{error}"),
        )));
    }
    let response = json!({
        "id": request.get("id").cloned().unwrap_or(Value::Null),
        "result": result
    });
    serde_json::from_value::<JSONRPCResponse>(response.clone())
        .map_err(|error| format!("model/list JSON-RPC 响应无效：{error}"))?;
    Ok(Some(DispatchOutput {
        response,
        notifications: Vec::new(),
    }))
}

fn dispatch_error(request: &Value, code: i64, message: impl Into<String>) -> DispatchOutput {
    DispatchOutput {
        response: json!({
            "id": request.get("id").cloned().unwrap_or(Value::Null),
            "error": {
                "code": code,
                "message": message.into()
            }
        }),
        notifications: Vec::new(),
    }
}

fn dispatch_success(request: &Value, result: Value) -> Result<DispatchOutput, String> {
    let response = json!({
        "id": request.get("id").cloned().unwrap_or(Value::Null),
        "result": result
    });
    serde_json::from_value::<JSONRPCResponse>(response.clone())
        .map_err(|error| format!("Codex JSON-RPC 响应无效：{error}"))?;
    Ok(DispatchOutput {
        response,
        notifications: Vec::new(),
    })
}

async fn dispatch_mcp_request(
    app: &AppHandle,
    state: &AppState,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("{method} 参数不符合 App Server V2：{error}"),
        ));
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let settings = super::settings::read_settings(app)?;
    let mut configs = settings
        .mcp_servers
        .iter()
        .filter(|config| config.enabled)
        .map(|config| {
            super::tietiezhi::resolve_mcp_config_secrets(app, config).map(|config| (config, None))
        })
        .collect::<Result<Vec<_>, _>>()?;
    configs.extend(
        plugin_mcp_configs(app, state)?
            .into_iter()
            .filter(|(config, _)| config.enabled)
            .map(|(config, plugin_id)| (config, Some(plugin_id))),
    );
    let plugin_ids = configs
        .iter()
        .filter_map(|(config, plugin_id)| {
            plugin_id
                .as_ref()
                .map(|plugin_id| (config.id.clone(), plugin_id.clone()))
        })
        .collect::<HashMap<_, _>>();
    let resolve_server = |name: &str| -> Result<crate::mcp::McpServerConfig, String> {
        configs
            .iter()
            .find(|(config, _)| config.id == name)
            .map(|(config, _)| config.clone())
            .ok_or_else(|| format!("No MCP server named '{name}' found."))
    };
    match method {
        "mcpServer/oauth/login" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let config = match resolve_server(name) {
                Ok(config) => config,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let scopes = params
                .get("scopes")
                .and_then(Value::as_array)
                .map(|scopes| {
                    scopes
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let timeout = params
                .get("timeoutSecs")
                .and_then(Value::as_u64)
                .map(Duration::from_secs);
            let login = match state
                .mcp
                .begin_oauth_login(config, thread_id, scopes, timeout)
                .await
            {
                Ok(login) => login,
                Err(error) => return Ok(dispatch_error(request, -32603, error)),
            };
            let result = json!({"authorizationUrl":login.authorization_url});
            serde_json::from_value::<McpServerOauthLoginResponse>(result.clone())
                .map_err(|error| format!("MCP OAuth 响应不符合 App Server V2：{error}"))?;
            dispatch_success(request, result)
        }
        "mcpServer/resource/read" => {
            let server = params
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let uri = params
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let config = match resolve_server(server) {
                Ok(config) => config,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            let contents = match state.mcp.read_resource(&config, uri).await {
                Ok(contents) => contents,
                Err(error) => return Ok(dispatch_error(request, -32603, error)),
            };
            let result = json!({"contents":contents});
            serde_json::from_value::<McpResourceReadResponse>(result.clone())
                .map_err(|error| format!("MCP 资源响应不符合 App Server V2：{error}"))?;
            dispatch_success(request, result)
        }
        "mcpServer/tool/call" => {
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let server = params
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let tool = params
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let config = match resolve_server(server) {
                Ok(config) => config,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            let plugin_id = plugin_ids.get(server).cloned();
            let manager = thread_manager(app, &app.state::<AppState>())?;
            let turn_id = match manager.active_turn_id(thread_id) {
                Ok(turn_id) => turn_id,
                Err(error) => {
                    return Ok(dispatch_error(
                        request,
                        -32602,
                        format!("MCP thread 无效：{error:?}"),
                    ));
                }
            };
            let item_id = format!("mcp-rpc-{}", uuid::Uuid::new_v4());
            let context = turn_id
                .as_ref()
                .map(|turn_id| tietiezhi_agent_mcp::McpCallContext {
                    thread_id: thread_id.into(),
                    turn_id: turn_id.clone(),
                    item_id: item_id.clone(),
                });
            if let Some(context) = &context {
                let notifications = manager
                    .local_tool_item_started(
                        &context.thread_id,
                        &context.turn_id,
                        json!({
                            "type":"mcpToolCall",
                            "id":context.item_id,
                            "server":server,
                            "tool":tool,
                            "status":"inProgress",
                            "arguments":arguments,
                            "appContext":null,
                            "pluginId":plugin_id.clone(),
                            "result":null,
                            "error":null,
                            "durationMs":null
                        }),
                    )
                    .map_err(|error| format!("记录 MCP 工具调用失败：{error:?}"))?;
                emit_notifications(app, &notifications)?;
            }
            let started = std::time::Instant::now();
            let called = state
                .mcp
                .call_tool_rich(
                    &config,
                    tool,
                    &arguments,
                    context.clone(),
                    params.get("_meta").cloned(),
                )
                .await;
            let duration_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
            if let Some(context) = &context {
                let item = match &called {
                    Ok(result) => json!({
                        "type":"mcpToolCall",
                        "id":context.item_id,
                        "server":server,
                        "tool":tool,
                        "status":if result.is_error { "failed" } else { "completed" },
                        "arguments":arguments,
                        "appContext":null,
                        "pluginId":plugin_id.clone(),
                        "result":{
                            "content":result.content,
                            "structuredContent":result.structured_content,
                            "_meta":result.meta
                        },
                        "error":if result.is_error {
                            json!({"message":result.model_text()})
                        } else {
                            Value::Null
                        },
                        "durationMs":duration_ms
                    }),
                    Err(error) => json!({
                        "type":"mcpToolCall",
                        "id":context.item_id,
                        "server":server,
                        "tool":tool,
                        "status":"failed",
                        "arguments":arguments,
                        "appContext":null,
                        "pluginId":plugin_id.clone(),
                        "result":null,
                        "error":{"message":error},
                        "durationMs":duration_ms
                    }),
                };
                let notifications = manager
                    .local_tool_item_completed(&context.thread_id, &context.turn_id, item)
                    .map_err(|error| format!("记录 MCP 工具结果失败：{error:?}"))?;
                emit_notifications(app, &notifications)?;
            }
            let result = match called {
                Ok(result) => serde_json::to_value(result)
                    .map_err(|error| format!("序列化 MCP 工具响应失败：{error}"))?,
                Err(error) => return Ok(dispatch_error(request, -32603, error)),
            };
            serde_json::from_value::<McpServerToolCallResponse>(result.clone())
                .map_err(|error| format!("MCP 工具响应不符合 App Server V2：{error}"))?;
            dispatch_success(request, result)
        }
        "mcpServerStatus/list" => {
            let mut configs = configs
                .iter()
                .map(|(config, _)| config.clone())
                .collect::<Vec<_>>();
            configs.sort_by(|left, right| left.id.cmp(&right.id));
            let total = configs.len();
            let start = match params.get("cursor").filter(|value| !value.is_null()) {
                Some(cursor) => match cursor
                    .as_str()
                    .and_then(|cursor| cursor.parse::<usize>().ok())
                {
                    Some(start) if start <= total => start,
                    _ => return Ok(dispatch_error(request, -32602, "invalid MCP cursor")),
                },
                None => 0,
            };
            let limit = params
                .get("limit")
                .and_then(Value::as_u64)
                .map(|limit| usize::try_from(limit).unwrap_or(usize::MAX))
                .unwrap_or(total)
                .max(1);
            let end = start.saturating_add(limit).min(total);
            let tools_only =
                params.get("detail").and_then(Value::as_str) == Some("toolsAndAuthOnly");
            let mut data = Vec::new();
            for config in &configs[start..end] {
                let auth_status = state.mcp.auth_status(config).await;
                let inventory = state.mcp.inventory(config).await.ok();
                let mut tools = serde_json::Map::new();
                if let Some(inventory) = &inventory {
                    for tool in &inventory.tools {
                        if let Some(name) = tool.get("name").and_then(Value::as_str) {
                            tools.insert(name.into(), tool.clone());
                        }
                    }
                }
                data.push(json!({
                    "name":config.id,
                    "serverInfo":inventory.as_ref().and_then(|item| item.server_info.clone()),
                    "tools":tools,
                    "resources":if tools_only {
                        Vec::<Value>::new()
                    } else {
                        inventory.as_ref().map(|item| item.resources.clone()).unwrap_or_default()
                    },
                    "resourceTemplates":if tools_only {
                        Vec::<Value>::new()
                    } else {
                        inventory.as_ref().map(|item| item.resource_templates.clone()).unwrap_or_default()
                    },
                    "authStatus":auth_status
                }));
            }
            let result = json!({
                "data":data,
                "nextCursor":(end < total).then(|| end.to_string())
            });
            serde_json::from_value::<ListMcpServerStatusResponse>(result.clone())
                .map_err(|error| format!("MCP 状态响应不符合 App Server V2：{error}"))?;
            dispatch_success(request, result)
        }
        _ => Ok(dispatch_error(request, -32601, "unknown MCP method")),
    }
}

async fn dispatch_command_exec(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("{method} 参数不符合 App Server V2：{error}"),
        ));
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let process_id = params
        .get("processId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let owner = format!("connection/{connection_id}");
    match method {
        "command/exec" => {
            let command = params
                .get("command")
                .and_then(Value::as_array)
                .map(|command| {
                    command
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if command.is_empty() || command[0].trim().is_empty() {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "command/exec command must not be empty",
                ));
            }
            let tty = params.get("tty").and_then(Value::as_bool).unwrap_or(false);
            let stream_stdin = tty
                || params
                    .get("streamStdin")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            let stream_output = tty
                || params
                    .get("streamStdoutStderr")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            if (tty || stream_stdin || stream_output) && process_id.is_none() {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "command/exec tty or streaming requires a client-supplied processId",
                ));
            }
            if process_id.as_deref().is_some_and(str::is_empty) {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "command/exec processId must not be empty",
                ));
            }
            if params.get("size").is_some_and(|size| !size.is_null()) && !tty {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "command/exec size requires tty: true",
                ));
            }
            let disable_cap = params
                .get("disableOutputCap")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if disable_cap
                && params
                    .get("outputBytesCap")
                    .is_some_and(|value| !value.is_null())
            {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "disableOutputCap cannot be combined with outputBytesCap",
                ));
            }
            let disable_timeout = params
                .get("disableTimeout")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if disable_timeout
                && params
                    .get("timeoutMs")
                    .is_some_and(|value| !value.is_null())
            {
                return Ok(dispatch_error(
                    request,
                    -32602,
                    "disableTimeout cannot be combined with timeoutMs",
                ));
            }
            let timeout = if disable_timeout {
                None
            } else {
                let timeout_ms = match params.get("timeoutMs").filter(|value| !value.is_null()) {
                    Some(value) => match value.as_i64().filter(|value| *value >= 0) {
                        Some(value) => value as u64,
                        None => {
                            return Ok(dispatch_error(
                                request,
                                -32602,
                                "timeoutMs must be non-negative",
                            ));
                        }
                    },
                    None => 10 * 60 * 1_000,
                };
                Some(Duration::from_millis(timeout_ms))
            };
            let output_bytes_cap = if disable_cap {
                None
            } else {
                Some(
                    params
                        .get("outputBytesCap")
                        .filter(|value| !value.is_null())
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                        .unwrap_or(tietiezhi_agent_exec::DEFAULT_OUTPUT_BYTES_CAP),
                )
            };
            let cwd = params
                .get("cwd")
                .and_then(Value::as_str)
                .map(std::path::PathBuf::from)
                .unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);
            let mut env = params
                .get("env")
                .and_then(Value::as_object)
                .map(|env| {
                    env.iter()
                        .map(|(key, value)| {
                            (
                                key.clone(),
                                value
                                    .as_str()
                                    .map(str::to_owned)
                                    .filter(|_| !value.is_null()),
                            )
                        })
                        .collect::<HashMap<_, _>>()
                })
                .unwrap_or_default();
            let size = match terminal_size(params.get("size")) {
                Ok(size) => size,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            let sandbox_policy_value = params
                .get("sandboxPolicy")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(runtime_defaults(app)?.sandbox);
            let sandbox_policy =
                match tietiezhi_agent_sandbox::SandboxPolicy::from_value(sandbox_policy_value) {
                    Ok(policy) => policy,
                    Err(error) => return Ok(dispatch_error(request, -32602, error.to_string())),
                };
            let _network = if sandbox_policy.is_restricted() && sandbox_policy.network_access() {
                match state
                    .codex_network
                    .prepare_execution(NetworkExecutionRequest {
                        thread_id: format!("command-exec/{connection_id}"),
                        turn_id: "command-exec".into(),
                        item_id: process_id.clone().unwrap_or_else(|| "command-exec".into()),
                        command: command.join(" "),
                        policy: NetworkPolicy {
                            enabled: true,
                            mode: NetworkMode::Full,
                            domains: Default::default(),
                            allow_local_binding: false,
                        },
                        approver: None,
                    })
                    .await
                {
                    Ok(prepared) => {
                        env.extend(prepared.env().clone());
                        Some(prepared)
                    }
                    Err(error) => {
                        return Ok(dispatch_error(request, -32603, error.to_string()));
                    }
                }
            } else {
                None
            };
            let exposed_process_id = process_id
                .clone()
                .unwrap_or_else(|| format!("internal-{}", state.codex_exec.allocate_session_id()));
            let id =
                tietiezhi_agent_exec::SessionId::new(owner.clone(), exposed_process_id.clone());
            let events = match state
                .codex_exec
                .spawn(
                    id.clone(),
                    tietiezhi_agent_exec::ExecRequest {
                        command,
                        cwd,
                        env,
                        tty,
                        stream_stdin,
                        size,
                        output_bytes_cap,
                        timeout,
                        cancellation: None,
                        sandbox_policy: Some(sandbox_policy),
                    },
                )
                .await
            {
                Ok(events) => events,
                Err(error) => return Ok(dispatch_error(request, -32602, error.to_string())),
            };
            let result = if stream_output {
                wait_streamed_command_exec(
                    app,
                    connection_id,
                    &exposed_process_id,
                    events,
                    &state.codex_exec,
                    &id,
                )
                .await?
            } else {
                state
                    .codex_exec
                    .wait(&id, None)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "command/exec ended without a result".to_string())?
            };
            let _ = state.codex_exec.remove(&id);
            let exit_code = if result.timed_out {
                124
            } else {
                result.exit_code
            };
            dispatch_success(
                request,
                json!({
                    "exitCode":exit_code,
                    "stdout":if stream_output { String::new() } else { result.stdout },
                    "stderr":if stream_output { String::new() } else { result.stderr }
                }),
            )
        }
        "command/exec/write" => {
            let Some(process_id) = process_id else {
                return Ok(dispatch_error(request, -32602, "processId is required"));
            };
            let id = tietiezhi_agent_exec::SessionId::new(owner, process_id);
            let bytes = match params.get("deltaBase64").filter(|value| !value.is_null()) {
                Some(value) => {
                    let Some(encoded) = value.as_str() else {
                        return Ok(dispatch_error(
                            request,
                            -32602,
                            "deltaBase64 must be a string",
                        ));
                    };
                    match base64::engine::general_purpose::STANDARD.decode(encoded) {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            return Ok(dispatch_error(
                                request,
                                -32602,
                                format!("invalid deltaBase64: {error}"),
                            ));
                        }
                    }
                }
                None => Vec::new(),
            };
            if let Err(error) = state
                .codex_exec
                .write(
                    &id,
                    &bytes,
                    params
                        .get("closeStdin")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .await
            {
                return Ok(dispatch_error(request, -32602, error.to_string()));
            }
            dispatch_success(request, json!({}))
        }
        "command/exec/resize" => {
            let Some(process_id) = process_id else {
                return Ok(dispatch_error(request, -32602, "processId is required"));
            };
            let id = tietiezhi_agent_exec::SessionId::new(owner, process_id);
            let size = match terminal_size(params.get("size")) {
                Ok(size) => size,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            if let Err(error) = state.codex_exec.resize(&id, size) {
                return Ok(dispatch_error(request, -32602, error.to_string()));
            }
            dispatch_success(request, json!({}))
        }
        "command/exec/terminate" => {
            let Some(process_id) = process_id else {
                return Ok(dispatch_error(request, -32602, "processId is required"));
            };
            let id = tietiezhi_agent_exec::SessionId::new(owner, process_id);
            if let Err(error) = state.codex_exec.terminate(&id) {
                return Ok(dispatch_error(request, -32602, error.to_string()));
            }
            dispatch_success(request, json!({}))
        }
        _ => Ok(dispatch_error(request, -32601, "method not found")),
    }
}

async fn wait_streamed_command_exec(
    app: &AppHandle,
    connection_id: &str,
    process_id: &str,
    mut events: tokio::sync::broadcast::Receiver<tietiezhi_agent_exec::ExecEvent>,
    manager: &tietiezhi_agent_exec::ExecManager,
    id: &tietiezhi_agent_exec::SessionId,
) -> Result<tietiezhi_agent_exec::ExecResult, String> {
    let mut cursor = 0;
    loop {
        match events.recv().await {
            Ok(tietiezhi_agent_exec::ExecEvent::Output(chunk)) => {
                cursor = cursor.max(chunk.cursor);
                emit_command_exec_output(app, connection_id, process_id, chunk)?;
            }
            Ok(tietiezhi_agent_exec::ExecEvent::Exited(result)) => {
                let missed = manager
                    .poll(id, cursor, Duration::ZERO)
                    .await
                    .map_err(|error| error.to_string())?;
                for chunk in missed.chunks {
                    emit_command_exec_output(app, connection_id, process_id, chunk)?;
                }
                return Ok(result);
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                let missed = manager
                    .poll(id, cursor, Duration::ZERO)
                    .await
                    .map_err(|error| error.to_string())?;
                for chunk in missed.chunks {
                    cursor = cursor.max(chunk.cursor);
                    emit_command_exec_output(app, connection_id, process_id, chunk)?;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                return manager
                    .wait(id, None)
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "command/exec output stream closed before exit".into());
            }
        }
    }
}

fn emit_command_exec_output(
    app: &AppHandle,
    connection_id: &str,
    process_id: &str,
    chunk: tietiezhi_agent_exec::OutputChunk,
) -> Result<(), String> {
    emit_checked_notification(
        app,
        RoutedNotification {
            recipients: vec![connection_id.into()],
            method: "command/exec/outputDelta".into(),
            params: json!({
                "processId":process_id,
                "stream":match chunk.stream {
                    tietiezhi_agent_exec::OutputStream::Stdout => "stdout",
                    tietiezhi_agent_exec::OutputStream::Stderr => "stderr",
                },
                "deltaBase64":base64::engine::general_purpose::STANDARD.encode(chunk.bytes),
                "capReached":chunk.cap_reached
            }),
        },
    )
}

async fn dispatch_thread_shell_command(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("thread/shellCommand 参数不符合 App Server V2：{error}"),
        ));
    }
    let thread_id = request
        .pointer("/params/threadId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let command = request
        .pointer("/params/command")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if command.is_empty() {
        return Ok(dispatch_error(request, -32602, "command must not be empty"));
    }
    let manager = thread_manager(app, state)?;
    let context = match manager.thread_shell_context(connection_id, thread_id) {
        Ok(context) => context,
        Err(error) => return Ok(dispatch_error(request, error.code, error.message)),
    };
    let process_handle = uuid::Uuid::new_v4().to_string();
    let id = tietiezhi_agent_exec::SessionId::new(
        format!("thread-shell/{thread_id}"),
        process_handle.clone(),
    );
    let events = match state
        .codex_exec
        .spawn(
            id.clone(),
            tietiezhi_agent_exec::ExecRequest {
                command: host_shell_argv(command),
                cwd: context.cwd,
                env: HashMap::new(),
                tty: false,
                stream_stdin: false,
                size: tietiezhi_agent_exec::TerminalSize::default(),
                output_bytes_cap: Some(tietiezhi_agent_exec::DEFAULT_OUTPUT_BYTES_CAP),
                timeout: None,
                cancellation: None,
                sandbox_policy: None,
            },
        )
        .await
    {
        Ok(events) => events,
        Err(error) => return Ok(dispatch_error(request, -32603, error.to_string())),
    };
    let app_handle = app.clone();
    let exec = state.codex_exec.clone();
    let recipients = context.recipients;
    tauri::async_runtime::spawn(async move {
        let mut events = events;
        loop {
            match events.recv().await {
                Ok(tietiezhi_agent_exec::ExecEvent::Output(chunk)) => {
                    let notification = RoutedNotification {
                        recipients: recipients.clone(),
                        method: "process/outputDelta".into(),
                        params: json!({
                            "processHandle":process_handle,
                            "stream":match chunk.stream {
                                tietiezhi_agent_exec::OutputStream::Stdout => "stdout",
                                tietiezhi_agent_exec::OutputStream::Stderr => "stderr",
                            },
                            "deltaBase64":base64::engine::general_purpose::STANDARD.encode(chunk.bytes),
                            "capReached":chunk.cap_reached
                        }),
                    };
                    let _ = emit_checked_notification(&app_handle, notification);
                }
                Ok(tietiezhi_agent_exec::ExecEvent::Exited(result)) => {
                    let notification = RoutedNotification {
                        recipients: recipients.clone(),
                        method: "process/exited".into(),
                        params: json!({
                            "processHandle":process_handle,
                            "exitCode":if result.timed_out { 124 } else { result.exit_code },
                            "stdout":"",
                            "stdoutCapReached":result.stdout_cap_reached,
                            "stderr":"",
                            "stderrCapReached":result.stderr_cap_reached
                        }),
                    };
                    let _ = emit_checked_notification(&app_handle, notification);
                    let _ = exec.remove(&id);
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    dispatch_success(request, json!({}))
}

fn terminal_size(value: Option<&Value>) -> Result<tietiezhi_agent_exec::TerminalSize, String> {
    let rows = value
        .and_then(|value| value.get("rows"))
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(24);
    let cols = value
        .and_then(|value| value.get("cols"))
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(80);
    if rows == 0 || cols == 0 {
        return Err("command/exec size rows and cols must be greater than 0".into());
    }
    Ok(tietiezhi_agent_exec::TerminalSize { rows, cols })
}

fn host_shell_argv(command: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            "powershell.exe".into(),
            "-NoProfile".into(),
            "-Command".into(),
            command.into(),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
            "-c".into(),
            command.into(),
        ]
    }
}

fn emit_checked_notification(
    app: &AppHandle,
    notification: RoutedNotification,
) -> Result<(), String> {
    serde_json::from_value::<ServerNotification>(notification.wire_message())
        .map_err(|error| format!("Codex notification payload 无效：{error}"))?;
    emit_notifications(app, &[notification])
}

async fn dispatch_account_request(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = state.codex_account.validate_request(connection_id, request) {
        return Ok(account_output(
            state.codex_account.error_output(request, error),
        ));
    }
    let result = match method {
        "account/login/start" => account_login_start(app, state, connection_id, request).await,
        "account/login/cancel" => {
            let (output, canceled) = state.codex_account.cancel_login(connection_id, request);
            if let Some(login_id) = canceled {
                cancel_account_login(state, &login_id);
            }
            Ok(account_output(output))
        }
        "account/logout" => account_logout(app, state, connection_id, request).await,
        "account/read" => match refresh_account_snapshot(app, state).await {
            Ok(()) => cached_account_output(state, connection_id, request),
            Err(error) => Err(error),
        },
        "account/rateLimits/read" => match refresh_rate_limits(app, state).await {
            Ok(()) => cached_account_output(state, connection_id, request),
            Err(error) => Err(error),
        },
        _ => cached_account_output(state, connection_id, request),
    };
    Ok(result.unwrap_or_else(|error| {
        account_output(
            state
                .codex_account
                .error_output(request, AccountRpcError::internal(error)),
        )
    }))
}

fn cached_account_output(
    state: &AppState,
    connection_id: &str,
    request: &Value,
) -> Result<DispatchOutput, String> {
    state
        .codex_account
        .dispatch_cached(connection_id, request)
        .map(account_output)
        .ok_or_else(|| {
            format!(
                "尚未实现的 Codex account 方法：{}",
                request
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )
        })
}

async fn account_login_start(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
) -> Result<DispatchOutput, String> {
    let provider = selected_provider(app)?;
    match request.pointer("/params/type").and_then(Value::as_str) {
        Some("chatgpt") => {
            if !provider.built_in {
                return Ok(account_output(state.codex_account.error_output(
                    request,
                    AccountRpcError::invalid_request(
                        "browser account login is only available for Tietiezhi Gateway",
                    ),
                )));
            }
            cancel_all_account_logins(state);
            let login_id = uuid::Uuid::new_v4().to_string();
            let attempt =
                super::gateway_auth::prepare_gateway_login(&state.http, app, provider.id.clone())
                    .await
                    .map_err(|error| format!("启动 Gateway 登录失败：{error}"))?;
            let output = state.codex_account.begin_chatgpt_login(
                connection_id,
                request,
                login_id.clone(),
                attempt.auth_url().into(),
            );
            if output.response.get("error").is_some() {
                return Ok(account_output(output));
            }
            let cancel = CancellationToken::new();
            state
                .codex_login_cancels
                .lock()
                .map_err(|_| "Codex 登录取消状态锁已损坏".to_string())?
                .insert(login_id.clone(), cancel.clone());
            let app = app.clone();
            let http = state.http.clone();
            tauri::async_runtime::spawn(async move {
                let result = tokio::select! {
                    _ = cancel.cancelled() => return,
                    result = super::gateway_auth::complete_gateway_login(&http, app.clone(), attempt) => result,
                };
                let state = app.state::<AppState>();
                let completion = match result {
                    Ok(view) => {
                        let account = view
                            .account
                            .map(gateway_account_value)
                            .ok_or_else(|| "Gateway 登录完成但没有返回账号".to_string());
                        state
                            .codex_account
                            .complete_chatgpt_login(&login_id, account)
                    }
                    Err(error) => state
                        .codex_account
                        .complete_chatgpt_login(&login_id, Err(error)),
                };
                if let Ok(notifications) = completion {
                    let routed = account_notifications(notifications);
                    let _ = emit_notifications(&app, &routed);
                }
                if let Ok(mut cancels) = state.codex_login_cancels.lock() {
                    cancels.remove(&login_id);
                };
            });
            Ok(account_output(output))
        }
        Some("apiKey") => {
            if provider.built_in {
                return Ok(account_output(state.codex_account.error_output(
                    request,
                    AccountRpcError::invalid_request(
                        "Tietiezhi Gateway credentials are managed by browser login",
                    ),
                )));
            }
            let api_key = match required_account_string(request, "/params/apiKey") {
                Ok(value) => value,
                Err(error) => {
                    return Ok(account_output(
                        state.codex_account.error_output(request, error),
                    ));
                }
            };
            crate::secrets::set_provider_key(&provider.id, &api_key)?;
            if let Ok(mut external) = state.codex_external_auth.lock() {
                external.remove(&provider.id);
            }
            Ok(account_output(
                state.codex_account.complete_immediate_login(
                    connection_id,
                    request,
                    ImmediateLogin {
                        response_type: "apiKey",
                        account: json!({"type": "apiKey"}),
                        requires_openai_auth: false,
                        auth_mode: "apikey",
                        plan_type: None,
                    },
                ),
            ))
        }
        Some("chatgptAuthTokens") => {
            if provider.built_in {
                return Ok(account_output(state.codex_account.error_output(
                    request,
                    AccountRpcError::invalid_request(
                        "Tietiezhi Gateway does not use externally supplied ChatGPT tokens",
                    ),
                )));
            }
            let access_token = match required_account_string(request, "/params/accessToken") {
                Ok(value) => value,
                Err(error) => {
                    return Ok(account_output(
                        state.codex_account.error_output(request, error),
                    ));
                }
            };
            let account_id = match required_account_string(request, "/params/chatgptAccountId") {
                Ok(value) => value,
                Err(error) => {
                    return Ok(account_output(
                        state.codex_account.error_output(request, error),
                    ));
                }
            };
            let plan_type = request
                .pointer("/params/chatgptPlanType")
                .and_then(Value::as_str)
                .map(normalized_plan_type)
                .map(str::to_owned);
            state
                .codex_external_auth
                .lock()
                .map_err(|_| "Codex 外部账号状态锁已损坏".to_string())?
                .insert(
                    provider.id.clone(),
                    ExternalAuthTokens {
                        access_token,
                        account_id,
                        plan_type: plan_type.clone(),
                    },
                );
            Ok(account_output(
                state.codex_account.complete_immediate_login(
                    connection_id,
                    request,
                    ImmediateLogin {
                        response_type: "chatgptAuthTokens",
                        account: json!({
                            "type": "chatgpt",
                            "email": null,
                            "planType": plan_type.as_deref().unwrap_or("unknown")
                        }),
                        requires_openai_auth: false,
                        auth_mode: "chatgptAuthTokens",
                        plan_type: Some(plan_type.as_deref().unwrap_or("unknown")),
                    },
                ),
            ))
        }
        _ => Ok(account_output(state.codex_account.error_output(
            request,
            AccountRpcError::invalid_request(
                "this runtime supports apiKey, chatgpt, and chatgptAuthTokens login",
            ),
        ))),
    }
}

async fn account_logout(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
) -> Result<DispatchOutput, String> {
    let provider = selected_provider(app)?;
    if provider.built_in {
        super::gateway_auth::revoke_gateway_login(&state.http, app, &provider.id).await?;
    } else {
        crate::secrets::delete_provider_key(&provider.id)?;
        state
            .codex_external_auth
            .lock()
            .map_err(|_| "Codex 外部账号状态锁已损坏".to_string())?
            .remove(&provider.id);
    }
    let (output, canceled) = state.codex_account.logout(connection_id, request);
    if let Some(login_id) = canceled {
        cancel_account_login(state, &login_id);
    }
    Ok(account_output(output))
}

async fn refresh_account_snapshot(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let provider = selected_provider(app)?;
    if provider.built_in {
        let view = super::gateway_auth::load_gateway_account(&state.http, app, provider.id.clone())
            .await?;
        let account = view.account.map(gateway_account_value);
        state
            .codex_account
            .set_account(
                account,
                true,
                view.logged_in.then_some("chatgpt"),
                view.logged_in.then_some("unknown"),
            )
            .map_err(account_rpc_error)?;
    } else {
        let external = state
            .codex_external_auth
            .lock()
            .map_err(|_| "Codex 外部账号状态锁已损坏".to_string())?
            .get(&provider.id)
            .cloned();
        let api_key = crate::secrets::get_provider_key(&provider.id)?.is_some();
        let (account, auth_mode, plan_type) = match external {
            Some(tokens) => (
                Some(json!({
                    "type": "chatgpt",
                    "email": null,
                    "planType": tokens.plan_type.as_deref().unwrap_or("unknown")
                })),
                Some("chatgptAuthTokens"),
                Some(tokens.plan_type.unwrap_or_else(|| "unknown".into())),
            ),
            None if api_key => (Some(json!({"type": "apiKey"})), Some("apikey"), None),
            None => (None, None, None),
        };
        state
            .codex_account
            .set_account(account, false, auth_mode, plan_type.as_deref())
            .map_err(account_rpc_error)?;
    }
    Ok(())
}

async fn refresh_rate_limits(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let provider = selected_provider(app)?;
    let response = if provider.built_in {
        let quota = super::gateway_auth::load_gateway_quota(&state.http, app, &provider.id).await?;
        gateway_rate_limits(&quota)
    } else {
        empty_rate_limits()
    };
    state
        .codex_account
        .set_rate_limits(response)
        .map_err(account_rpc_error)?;
    Ok(())
}

fn selected_provider(app: &AppHandle) -> Result<super::settings::Provider, String> {
    let settings = super::settings::read_settings(app)?;
    settings
        .providers
        .into_iter()
        .find(|provider| provider.id == settings.chat_provider_id)
        .ok_or_else(|| "未配置 Codex Runtime 供应商".into())
}

fn gateway_account_value(account: super::gateway_auth::GatewayAccount) -> Value {
    json!({
        "type": "chatgpt",
        "email": (!account.email.trim().is_empty()).then_some(account.email),
        "planType": "unknown"
    })
}

fn gateway_rate_limits(quota: &super::gateway_auth::GatewayQuotaView) -> Value {
    let package_remaining = quota
        .packages
        .iter()
        .map(|package| package.window_remaining.max(0))
        .sum::<i64>();
    let has_credits = quota.wallet.balance_micro > 0 || package_remaining > 0;
    let used_percent = quota
        .packages
        .iter()
        .filter(|package| package.quota_per_window > 0)
        .map(|package| {
            let used = package
                .quota_per_window
                .saturating_sub(package.window_remaining.max(0));
            ((used as f64 / package.quota_per_window as f64) * 100.0)
                .round()
                .clamp(0.0, 100.0) as i32
        })
        .max();
    let snapshot = json!({
        "limitId": "tietiezhi-gateway",
        "limitName": "Tietiezhi Gateway",
        "primary": used_percent.map(|used_percent| json!({
            "usedPercent": used_percent,
            "windowDurationMins": null,
            "resetsAt": null
        })),
        "secondary": null,
        "credits": {
            "hasCredits": has_credits,
            "unlimited": false,
            "balance": format_micro(quota.wallet.balance_micro)
        },
        "individualLimit": null,
        "spendControlReached": !has_credits,
        "planType": "unknown",
        "rateLimitReachedType": (!has_credits).then_some("rate_limit_reached")
    });
    json!({
        "rateLimits": snapshot,
        "rateLimitsByLimitId": {
            "tietiezhi-gateway": snapshot
        },
        "rateLimitResetCredits": null
    })
}

fn empty_rate_limits() -> Value {
    json!({
        "rateLimits": {
            "limitId": null,
            "limitName": null,
            "primary": null,
            "secondary": null,
            "credits": null,
            "individualLimit": null,
            "spendControlReached": null,
            "planType": null,
            "rateLimitReachedType": null
        },
        "rateLimitsByLimitId": null,
        "rateLimitResetCredits": null
    })
}

fn format_micro(value: i64) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let absolute = value.unsigned_abs();
    format!("{sign}{}.{:06}", absolute / 1_000_000, absolute % 1_000_000)
}

fn required_account_string(request: &Value, pointer: &str) -> Result<String, AccountRpcError> {
    request
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AccountRpcError::invalid(format!("{pointer} 不能为空")))
}

fn normalized_plan_type(value: &str) -> &'static str {
    match value {
        "free" => "free",
        "go" => "go",
        "plus" => "plus",
        "pro" => "pro",
        "prolite" => "prolite",
        "team" => "team",
        "self_serve_business_usage_based" => "self_serve_business_usage_based",
        "business" => "business",
        "enterprise_cbp_usage_based" => "enterprise_cbp_usage_based",
        "enterprise" => "enterprise",
        "edu" => "edu",
        _ => "unknown",
    }
}

fn cancel_account_login(state: &AppState, login_id: &str) {
    if let Ok(mut cancels) = state.codex_login_cancels.lock() {
        if let Some(cancel) = cancels.remove(login_id) {
            cancel.cancel();
        }
    }
}

fn cancel_all_account_logins(state: &AppState) {
    if let Ok(mut cancels) = state.codex_login_cancels.lock() {
        for (_, cancel) in cancels.drain() {
            cancel.cancel();
        }
    }
}

fn account_rpc_error(error: AccountRpcError) -> String {
    format!("Codex account 状态错误：{}", error.message)
}

fn account_output(output: AccountDispatchOutput) -> DispatchOutput {
    DispatchOutput {
        response: output.response,
        notifications: account_notifications(output.notifications),
    }
}

fn account_notifications(notifications: Vec<AccountNotification>) -> Vec<RoutedNotification> {
    notifications
        .into_iter()
        .map(|notification| RoutedNotification {
            recipients: notification.recipients,
            method: notification.method,
            params: notification.params,
        })
        .collect()
}

async fn dispatch_config_request(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    serde_json::from_value::<JSONRPCRequest>(request.clone())
        .map_err(|error| format!("无效 JSON-RPC 请求：{error}"))?;
    serde_json::from_value::<ClientRequest>(request.clone())
        .map_err(|error| format!("无效 Codex 配置请求：{error}"))?;
    let config_root = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位配置目录：{error}"))?
        .join("codex");
    let runtime = ConfigRuntime::new(ConfigPaths {
        user_config: config_root.join("config.toml"),
        system_config: system_codex_config_path(),
        requirements: system_codex_requirements_path(),
    });
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    match runtime.dispatch(method, &params) {
        Ok(dispatch) => {
            if method == "config/mcpServer/reload" {
                let settings = super::settings::read_settings(app)?;
                for server in settings.mcp_servers {
                    state.mcp.stop(&server.id).await;
                }
                for (server, _) in plugin_mcp_configs(app, state)? {
                    state.mcp.stop(&server.id).await;
                }
            }
            let plugin_edits = plugin_enablement_edits(method, &params);
            if !plugin_edits.is_empty() {
                let plugins = plugin_runtime(app, state)?;
                for (plugin_id, enabled) in plugin_edits {
                    plugins.set_enabled(&plugin_id, enabled)?;
                }
                refresh_plugin_activation(app, state, &plugins)?;
            }
            let notifications = dispatch
                .warnings
                .into_iter()
                .map(|warning| {
                    let mut params = json!({
                        "summary":warning.summary,
                        "details":warning.details
                    });
                    if let Some(path) = warning.path {
                        params["path"] = json!(path);
                    }
                    RoutedNotification {
                        recipients: vec![connection_id.into()],
                        method: "configWarning".into(),
                        params,
                    }
                })
                .collect::<Vec<_>>();
            for notification in &notifications {
                serde_json::from_value::<ServerNotification>(notification.wire_message())
                    .map_err(|error| format!("无效 configWarning 通知：{error}"))?;
            }
            Ok(DispatchOutput {
                response: json!({"id":id,"result":dispatch.result}),
                notifications,
            })
        }
        Err(error) => Ok(DispatchOutput {
            response: json!({
                "id":id,
                "error":{"code":-32602,"message":error.to_string()}
            }),
            notifications: Vec::new(),
        }),
    }
}

fn plugin_enablement_edits(method: &str, params: &Value) -> Vec<(String, bool)> {
    let edits = match method {
        "config/value/write" => vec![params],
        "config/batchWrite" => params
            .get("edits")
            .and_then(Value::as_array)
            .map(|edits| edits.iter().collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    edits
        .into_iter()
        .filter_map(|edit| {
            let key_path = edit.get("keyPath").and_then(Value::as_str)?;
            let plugin_id = key_path
                .strip_prefix("plugins.")?
                .strip_suffix(".enabled")?;
            let enabled = edit.get("value").and_then(Value::as_bool)?;
            (!plugin_id.is_empty()).then(|| (plugin_id.into(), enabled))
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn system_codex_root() -> std::path::PathBuf {
    std::env::var_os("PROGRAMDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\ProgramData"))
        .join("OpenAI")
        .join("Codex")
}

#[cfg(not(target_os = "windows"))]
fn system_codex_root() -> std::path::PathBuf {
    std::path::PathBuf::from("/etc/codex")
}

fn system_codex_config_path() -> std::path::PathBuf {
    system_codex_root().join("config.toml")
}

fn system_codex_requirements_path() -> std::path::PathBuf {
    system_codex_root().join("requirements.toml")
}

fn skills_runtime(app: &AppHandle, state: &AppState) -> Result<SkillsRuntime, String> {
    let mut slot = state
        .codex_skills
        .lock()
        .map_err(|_| "Codex Skills 状态锁已损坏".to_string())?;
    if let Some(runtime) = slot.as_ref() {
        return Ok(runtime.clone());
    }
    let config_root = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位配置目录：{error}"))?
        .join("codex");
    let home = dirs::home_dir().unwrap_or_else(|| config_root.clone());
    let runtime = SkillsRuntime::new(SkillsPaths {
        user_codex_root: config_root.join("skills"),
        user_agents_root: home.join(".agents/skills"),
        system_root: system_codex_root().join("skills"),
        state_file: config_root.join("skills-state.json"),
    });
    *slot = Some(runtime.clone());
    Ok(runtime)
}

fn hooks_runtime(app: &AppHandle, state: &AppState) -> Result<HookEngine, String> {
    let mut slot = state
        .codex_hooks
        .lock()
        .map_err(|_| "Codex Hooks 状态锁已损坏".to_string())?;
    if let Some(runtime) = slot.as_ref() {
        return Ok(runtime.clone());
    }
    let config_root = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位配置目录：{error}"))?
        .join("codex");
    let runtime = HookEngine::new(HookPaths {
        system: Some(system_codex_root().join("hooks.json")),
        user: Some(config_root.join("hooks.json")),
        trust_state: config_root.join("hooks-state.json"),
    });
    let config = ConfigRuntime::new(ConfigPaths {
        user_config: config_root.join("config.toml"),
        system_config: system_codex_config_path(),
        requirements: system_codex_requirements_path(),
    });
    let managed_only = config
        .dispatch("configRequirements/read", &json!({}))
        .ok()
        .and_then(|dispatch| {
            dispatch
                .result
                .pointer("/requirements/allowManagedHooksOnly")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);
    runtime.set_allow_managed_hooks_only(managed_only);
    *slot = Some(runtime.clone());
    Ok(runtime)
}

fn apps_catalog(app: &AppHandle, state: &AppState) -> Result<AppCatalog, String> {
    let plugins = plugin_runtime(app, state)?;
    let activation = plugins.activation()?;
    AppCatalog::load(&activation.apps)
}

fn dispatch_apps_request(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("{method} 参数不符合 App Server V2：{error}"),
        ));
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let catalog = match apps_catalog(app, state) {
        Ok(catalog) => catalog,
        Err(error) => return Ok(dispatch_error(request, -32603, error)),
    };
    let (result, publish_catalog) = match method {
        "app/list" => {
            let page = match catalog.list(
                params.get("cursor").and_then(Value::as_str),
                params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .and_then(|limit| u32::try_from(limit).ok()),
            ) {
                Ok(page) => page,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            (
                json!({"data":page.data,"nextCursor":page.next_cursor}),
                params
                    .get("forceRefetch")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
        }
        "app/read" => {
            let app_ids = params
                .get("appIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let read = match catalog.read(
                &app_ids,
                params
                    .get("includeTools")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ) {
                Ok(read) => read,
                Err(error) => return Ok(dispatch_error(request, -32602, error)),
            };
            (
                json!({"apps":read.apps,"missingAppIds":read.missing_app_ids}),
                false,
            )
        }
        "app/installed" => (
            json!({"apps":catalog.installed()}),
            params
                .get("forceRefresh")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        _ => return Ok(dispatch_error(request, -32601, "method not found")),
    };
    if let Err(error) = validate_apps_response(method, &result) {
        return Ok(dispatch_error(request, -32603, error));
    }
    let notifications = publish_catalog
        .then(|| {
            catalog
                .list(None, Some(100))
                .map(|page| RoutedNotification {
                    recipients: vec![connection_id.into()],
                    method: "app/list/updated".into(),
                    params: json!({"data":page.data}),
                })
        })
        .transpose()?
        .into_iter()
        .collect();
    let mut output = dispatch_success(request, result)?;
    output.notifications = notifications;
    Ok(output)
}

fn validate_apps_response(method: &str, result: &Value) -> Result<(), String> {
    macro_rules! validate {
        ($ty:ty) => {
            serde_json::from_value::<$ty>(result.clone())
                .map(|_| ())
                .map_err(|error| format!("{method} 返回值不符合 App Server V2：{error}"))
        };
    }
    match method {
        "app/list" => validate!(AppsListResponse),
        "app/read" => validate!(AppsReadResponse),
        "app/installed" => validate!(AppsInstalledResponse),
        _ => Err(format!("不支持的 Apps 方法：{method}")),
    }
}

fn plugin_runtime(app: &AppHandle, state: &AppState) -> Result<PluginRuntime, String> {
    let mut slot = state
        .codex_plugins
        .lock()
        .map_err(|_| "Codex Plugins 状态锁已损坏".to_string())?;
    if let Some(runtime) = slot.as_ref() {
        return Ok(runtime.clone());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let home = dirs::home_dir().unwrap_or_else(|| app_data.clone());
    let runtime = PluginRuntime::new(PluginPaths {
        root: app_data.join("agent-runtime").join("plugins"),
        personal_marketplace: home
            .join(".agents")
            .join("plugins")
            .join("marketplace.json"),
    })?;
    refresh_plugin_activation(app, state, &runtime)?;
    *slot = Some(runtime.clone());
    Ok(runtime)
}

fn refresh_plugin_activation(
    app: &AppHandle,
    state: &AppState,
    runtime: &PluginRuntime,
) -> Result<PluginActivation, String> {
    let activation = runtime.activation()?;
    let cwd = runtime_defaults(app)?.cwd;
    skills_runtime(app, state)?.dispatch(
        "skills/extraRoots/set",
        &json!({"extraRoots":activation.skill_roots}),
        &cwd,
    )?;
    hooks_runtime(app, state)?.set_extra_sources(
        activation
            .hook_paths
            .iter()
            .cloned()
            .map(|path| (path, HookSource::Plugin, true))
            .collect(),
    );
    Ok(activation)
}

async fn dispatch_plugin_request(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("{method} 参数不符合 App Server V2：{error}"),
        ));
    }
    let runtime = plugin_runtime(app, state)?;
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    match runtime.dispatch(method, &params).await {
        Ok(dispatch) => {
            validate_plugin_response(method, &dispatch.result)?;
            let activation_changed =
                dispatch.changed && matches!(method, "plugin/install" | "plugin/uninstall");
            if activation_changed {
                refresh_plugin_activation(app, state, &runtime)?;
            }
            let mut notifications = activation_changed
                .then(|| RoutedNotification {
                    recipients: vec![connection_id.into()],
                    method: "skills/changed".into(),
                    params: json!({}),
                })
                .into_iter()
                .collect::<Vec<_>>();
            if activation_changed {
                let apps = apps_catalog(app, state)?.list(None, Some(100))?.data;
                notifications.push(RoutedNotification {
                    recipients: vec![connection_id.into()],
                    method: "app/list/updated".into(),
                    params: json!({"data":apps}),
                });
            }
            Ok(DispatchOutput {
                response: json!({
                    "id":request.get("id").cloned().unwrap_or(Value::Null),
                    "result":dispatch.result
                }),
                notifications,
            })
        }
        Err(error) => Ok(dispatch_error(request, -32602, error)),
    }
}

fn validate_plugin_response(method: &str, result: &Value) -> Result<(), String> {
    macro_rules! validate {
        ($ty:ty) => {
            serde_json::from_value::<$ty>(result.clone())
                .map(|_| ())
                .map_err(|error| format!("{method} 返回值不符合 App Server V2：{error}"))
        };
    }
    match method {
        "marketplace/add" => validate!(MarketplaceAddResponse),
        "marketplace/remove" => validate!(MarketplaceRemoveResponse),
        "marketplace/upgrade" => validate!(MarketplaceUpgradeResponse),
        "plugin/install" => validate!(PluginInstallResponse),
        "plugin/installed" => validate!(PluginInstalledResponse),
        "plugin/list" => validate!(PluginListResponse),
        "plugin/read" => validate!(PluginReadResponse),
        "plugin/share/checkout" => validate!(PluginShareCheckoutResponse),
        "plugin/share/delete" => validate!(PluginShareDeleteResponse),
        "plugin/share/list" => validate!(PluginShareListResponse),
        "plugin/share/save" => validate!(PluginShareSaveResponse),
        "plugin/share/updateTargets" => validate!(PluginShareUpdateTargetsResponse),
        "plugin/skill/read" => validate!(PluginSkillReadResponse),
        "plugin/uninstall" => validate!(PluginUninstallResponse),
        _ => Err(format!("不支持的 Plugin 方法：{method}")),
    }
}

fn plugin_mcp_configs(
    app: &AppHandle,
    state: &AppState,
) -> Result<Vec<(crate::mcp::McpServerConfig, String)>, String> {
    let runtime = plugin_runtime(app, state)?;
    let activation = runtime.activation()?;
    let mut configs = Vec::new();
    for source in activation.mcp_servers {
        configs.extend(
            parse_plugin_mcp_source(&source)?
                .into_iter()
                .map(|config| (config, source.plugin_id.clone())),
        );
    }
    Ok(configs)
}

fn parse_plugin_mcp_source(
    source: &PluginMcpSource,
) -> Result<Vec<crate::mcp::McpServerConfig>, String> {
    let value = match (&source.path, &source.inline) {
        (Some(path), _) => {
            let bytes = std::fs::read(path)
                .map_err(|error| format!("读取插件 MCP 配置 {} 失败：{error}", path.display()))?;
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|error| format!("解析插件 MCP 配置 {} 失败：{error}", path.display()))?
        }
        (None, Some(value)) => value.clone(),
        (None, None) => return Ok(Vec::new()),
    };
    let servers = value
        .get("mcpServers")
        .unwrap_or(&value)
        .as_object()
        .ok_or_else(|| format!("插件 {} 的 mcpServers 必须是对象", source.plugin_id))?;
    servers
        .iter()
        .map(|(name, raw)| plugin_mcp_config(&source.plugin_id, name, raw))
        .collect()
}

fn plugin_mcp_config(
    plugin_id: &str,
    name: &str,
    raw: &Value,
) -> Result<crate::mcp::McpServerConfig, String> {
    let object = raw
        .as_object()
        .ok_or_else(|| format!("插件 MCP `{plugin_id}/{name}` 必须是对象"))?;
    let server_id = format!(
        "plugin_{}_{}",
        stable_identifier(plugin_id),
        stable_identifier(name)
    );
    let transport = if let Some(transport) = object.get("transport") {
        transport.clone()
    } else if let Some(command) = object.get("command").and_then(Value::as_str) {
        json!({
            "kind":"stdio",
            "command":command,
            "args":object.get("args").cloned().unwrap_or_else(||json!([])),
            "env":object.get("env").cloned().unwrap_or_else(||json!({}))
        })
    } else if let Some(url) = object
        .get("url")
        .or_else(|| object.get("httpUrl"))
        .and_then(Value::as_str)
    {
        json!({
            "kind":"http",
            "url":url,
            "headers":object.get("headers").cloned().unwrap_or_else(||json!({})),
            "oauth":object.get("oauth").and_then(Value::as_bool).unwrap_or(false)
        })
    } else {
        return Err(format!(
            "插件 MCP `{plugin_id}/{name}` 缺少 command、url 或 transport"
        ));
    };
    serde_json::from_value(json!({
        "id":server_id,
        "name":format!("{plugin_id} / {name}"),
        "enabled":object.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "required":object.get("required").and_then(Value::as_bool).unwrap_or(false),
        "enabledTools":object.get("enabledTools").cloned().unwrap_or_else(||json!([])),
        "disabledTools":object.get("disabledTools").cloned().unwrap_or_else(||json!([])),
        "startupTimeoutSecs":object.get("startupTimeoutSecs").cloned().unwrap_or_else(||json!(15)),
        "toolTimeoutSecs":object.get("toolTimeoutSecs").cloned().unwrap_or_else(||json!(120)),
        "oauthScopes":object.get("oauthScopes").cloned().unwrap_or_else(||json!([])),
        "transport":transport
    }))
    .map_err(|error| format!("插件 MCP `{plugin_id}/{name}` 配置无效：{error}"))
}

fn stable_identifier(value: &str) -> String {
    let mut output = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .take(32)
        .collect::<String>();
    while output.contains("__") {
        output = output.replace("__", "_");
    }
    let output = output.trim_matches('_');
    let digest = Sha256::digest(value.as_bytes());
    let suffix = digest[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{output}_{suffix}")
}

async fn run_hooks(
    app: &AppHandle,
    manager: &ThreadManager,
    request: HookRequest,
) -> Result<HookDispatch, ModelError> {
    let runtime = hooks_runtime(app, &app.state::<AppState>()).map_err(ModelError::Consumer)?;
    let result = runtime.dispatch(request.clone()).await;
    for run in &result.runs {
        let started = serde_json::to_value(&run.started)
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
        let notifications = manager
            .hook_started_notification(&request.thread_id, request.turn_id.as_deref(), started)
            .map_err(core_model_error)?;
        emit_notifications(app, &notifications).map_err(ModelError::Consumer)?;
        let completed = serde_json::to_value(&run.completed)
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
        let notifications = manager
            .hook_completed_notification(&request.thread_id, request.turn_id.as_deref(), completed)
            .map_err(core_model_error)?;
        emit_notifications(app, &notifications).map_err(ModelError::Consumer)?;
    }
    if let Some(turn_id) = request.turn_id.as_deref() {
        for context in &result.additional_context {
            let notifications = manager
                .record_hook_context(&request.thread_id, turn_id, &context.run_id, &context.text)
                .map_err(core_model_error)?;
            emit_notifications(app, &notifications).map_err(ModelError::Consumer)?;
        }
    }
    Ok(result)
}

fn dispatch_skills_request(
    app: &AppHandle,
    state: &AppState,
    connection_id: &str,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("{method} 参数不符合 App Server V2：{error}"),
        ));
    }
    let runtime = skills_runtime(app, state)?;
    let cwd = runtime_defaults(app)?.cwd;
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    match runtime.dispatch(method, &params, &cwd) {
        Ok(dispatch) => {
            let notifications = dispatch
                .changed
                .then(|| RoutedNotification {
                    recipients: vec![connection_id.into()],
                    method: "skills/changed".into(),
                    params: json!({}),
                })
                .into_iter()
                .collect();
            Ok(DispatchOutput {
                response: json!({
                    "id":request.get("id").cloned().unwrap_or(Value::Null),
                    "result":dispatch.result
                }),
                notifications,
            })
        }
        Err(error) => Ok(dispatch_error(request, -32602, error)),
    }
}

fn launch_compaction_executor(
    app: &AppHandle,
    state: &AppState,
    manager: ThreadManager,
    thread_id: String,
    turn_id: String,
) {
    let cancel = CancellationToken::new();
    if let Ok(mut cancels) = state.codex_cancels.lock() {
        if let Some((_, stale)) =
            cancels.insert(thread_id.clone(), (turn_id.clone(), cancel.clone()))
        {
            stale.cancel();
        }
    }
    let app = app.clone();
    let http = state.http.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let snapshot = manager
                .compaction_execution_snapshot(&thread_id, &turn_id)
                .map_err(core_model_error)?;
            run_compaction_snapshot(app.clone(), manager.clone(), http, snapshot, cancel.clone())
                .await
        }
        .await;
        if let Err(error) = result {
            if !cancel.is_cancelled() {
                fail_turn(&app, &manager, &thread_id, &turn_id, error);
            }
        }
        let state = app.state::<AppState>();
        if let Ok(mut cancels) = state.codex_cancels.lock() {
            if cancels
                .get(&thread_id)
                .is_some_and(|(active_turn_id, _)| active_turn_id == &turn_id)
            {
                cancels.remove(&thread_id);
            }
        };
    });
}

async fn run_compaction_snapshot(
    app: AppHandle,
    manager: ThreadManager,
    http: reqwest::Client,
    snapshot: CompactionExecutionSnapshot,
    cancel: CancellationToken,
) -> Result<(), ModelError> {
    let cwd = manager
        .turn_execution_snapshot(&snapshot.thread_id, &snapshot.turn_id)
        .map(|snapshot| snapshot.cwd)
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(".")));
    let pre_hooks = run_hooks(
        &app,
        &manager,
        HookRequest {
            event_name: HookEventName::PreCompact,
            thread_id: snapshot.thread_id.clone(),
            turn_id: Some(snapshot.turn_id.clone()),
            cwd: cwd.clone(),
            matcher: Some(if snapshot.automatic {
                "auto".into()
            } else {
                "manual".into()
            }),
            payload: json!({
                "trigger": if snapshot.automatic {"auto"} else {"manual"},
                "custom_instructions": Value::Null
            }),
        },
    )
    .await?;
    ensure_hook_allows(&pre_hooks)?;
    let resolved =
        super::providers::resolve(&app, &snapshot.model_provider).map_err(ModelError::Transport)?;
    let base_url = super::api_url(&resolved.base_url, "")
        .trim_end_matches('/')
        .to_owned();
    let configured_wire_api = resolved.wire_api;
    let effective_wire_api = resolved.wire_api_for_model(&snapshot.model);
    let reasoning_transport =
        resolved.reasoning_transport_for_model(&snapshot.model, effective_wire_api);
    let provider_id = resolved.id;
    let provider_name = resolved.kind;
    let mut bearer_token = app
        .state::<AppState>()
        .codex_external_auth
        .lock()
        .map_err(|_| ModelError::Consumer("Codex 外部账号状态锁已损坏".into()))?
        .get(&provider_id)
        .map(|tokens| tokens.access_token.clone())
        .or(resolved.key);
    let capability_key = format!("{provider_id}\n{base_url}");
    let mut client = responses_client(
        &http,
        &provider_name,
        &base_url,
        bearer_token.clone(),
        effective_wire_api,
        reasoning_transport,
    );
    ensure_responses_capability(&app, &capability_key, configured_wire_api, &client).await?;

    let mut history = compaction_prompt_history(&snapshot.history);
    let mut summary_suffix = String::new();
    let mut model_output_seen = false;
    let mut auth_refresh_attempted = false;
    let mut server_model = None;
    loop {
        let request = compaction_response_request(&snapshot, history.clone());
        let stream = client.stream(&request, |event| {
            let notifications = match event {
                ResponseEvent::Created
                | ResponseEvent::ServerReasoningIncluded(_)
                | ResponseEvent::ModelsEtag(_)
                | ResponseEvent::OutputTextDelta(_)
                | ResponseEvent::ToolCallInputDelta { .. }
                | ResponseEvent::ReasoningSummaryDelta { .. }
                | ResponseEvent::ReasoningSummaryDone { .. }
                | ResponseEvent::ReasoningContentDelta { .. }
                | ResponseEvent::ReasoningSummaryPartAdded { .. } => Vec::new(),
                ResponseEvent::Retrying { error, .. } => manager
                    .error_notification(
                        &snapshot.thread_id,
                        &snapshot.turn_id,
                        error.as_turn_error(),
                        true,
                    )
                    .map_err(core_model_error)?,
                ResponseEvent::OutputItemAdded(_) => {
                    model_output_seen = true;
                    Vec::new()
                }
                ResponseEvent::OutputItemDone(item) => {
                    model_output_seen = true;
                    if let Some(text) = assistant_response_text(&item) {
                        summary_suffix = text;
                    }
                    manager
                        .record_compaction_response_item(
                            &snapshot.thread_id,
                            &snapshot.turn_id,
                            item,
                        )
                        .map_err(core_model_error)?;
                    Vec::new()
                }
                ResponseEvent::ServerModel(model) => {
                    if server_model.as_deref() == Some(model.as_str())
                        || model.eq_ignore_ascii_case(&snapshot.model)
                    {
                        Vec::new()
                    } else {
                        server_model = Some(model.clone());
                        manager
                            .model_rerouted_notification(
                                &snapshot.thread_id,
                                &snapshot.turn_id,
                                &snapshot.model,
                                &model,
                            )
                            .map_err(core_model_error)?
                    }
                }
                ResponseEvent::ModelVerifications(verifications) => manager
                    .model_verification_notification(
                        &snapshot.thread_id,
                        &snapshot.turn_id,
                        verifications,
                    )
                    .map_err(core_model_error)?,
                ResponseEvent::TurnModerationMetadata(metadata) => manager
                    .turn_moderation_metadata_notification(
                        &snapshot.thread_id,
                        &snapshot.turn_id,
                        metadata,
                    )
                    .map_err(core_model_error)?,
                ResponseEvent::SafetyBuffering(buffering) => manager
                    .safety_buffering_notification(
                        &snapshot.thread_id,
                        &snapshot.turn_id,
                        &snapshot.model,
                        buffering.use_cases,
                        buffering.reasons,
                        buffering.show_buffering_ui,
                        buffering.faster_model,
                    )
                    .map_err(core_model_error)?,
                ResponseEvent::Completed { token_usage, .. } => {
                    if let Some(usage) = token_usage {
                        manager
                            .record_token_usage(
                                &snapshot.thread_id,
                                &snapshot.turn_id,
                                usage,
                                snapshot.model_context_window,
                            )
                            .map_err(core_model_error)?
                    } else {
                        Vec::new()
                    }
                }
            };
            emit_notifications(&app, &notifications).map_err(ModelError::Consumer)
        });
        let result = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = stream => result,
        };
        if matches!(result, Err(ModelError::Unauthorized { .. }))
            && !auth_refresh_attempted
            && !model_output_seen
        {
            if let Some(tokens) =
                refresh_external_auth(&app, &provider_id, &snapshot.thread_id).await?
            {
                auth_refresh_attempted = true;
                bearer_token = Some(tokens.access_token);
                client = responses_client(
                    &http,
                    &provider_name,
                    &base_url,
                    bearer_token.clone(),
                    effective_wire_api,
                    reasoning_transport,
                );
                continue;
            }
        }
        if matches!(result, Err(ModelError::ContextWindowExceeded)) && history.len() > 1 {
            history.remove(0);
            model_output_seen = false;
            continue;
        }
        result?;
        break;
    }
    if cancel.is_cancelled() {
        return Ok(());
    }
    let post_hooks = run_hooks(
        &app,
        &manager,
        HookRequest {
            event_name: HookEventName::PostCompact,
            thread_id: snapshot.thread_id.clone(),
            turn_id: Some(snapshot.turn_id.clone()),
            cwd,
            matcher: Some(if snapshot.automatic {
                "auto".into()
            } else {
                "manual".into()
            }),
            payload: json!({
                "trigger": if snapshot.automatic {"auto"} else {"manual"},
                "summary": summary_suffix
            }),
        },
    )
    .await?;
    ensure_hook_allows(&post_hooks)?;
    let notifications = manager
        .complete_compaction(&snapshot.thread_id, &snapshot.turn_id, &summary_suffix)
        .map_err(core_model_error)?;
    emit_notifications(&app, &notifications).map_err(ModelError::Consumer)
}

pub(crate) fn launch_turn_executor(
    app: &AppHandle,
    state: &AppState,
    manager: ThreadManager,
    thread_id: String,
    turn_id: String,
) {
    let cancel = CancellationToken::new();
    if let Ok(mut cancels) = state.codex_cancels.lock() {
        if let Some((_, stale)) =
            cancels.insert(thread_id.clone(), (turn_id.clone(), cancel.clone()))
        {
            stale.cancel();
        }
    }
    if let Ok(mut activity) = state.codex_input_activity.lock() {
        if let Some((_, stale)) = activity.insert(
            thread_id.clone(),
            (turn_id.clone(), CancellationToken::new()),
        ) {
            stale.cancel();
        }
    }
    let app = app.clone();
    let http = state.http.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_turn_executor(
            app.clone(),
            manager.clone(),
            http,
            thread_id.clone(),
            turn_id.clone(),
            cancel.clone(),
        )
        .await;
        if let Err(error) = &result {
            if !cancel.is_cancelled() {
                finalize_interrupted_review(&app, &manager, &thread_id, &turn_id);
                fail_turn(
                    &app,
                    &manager,
                    &thread_id,
                    &turn_id,
                    ModelError::Consumer(error.to_string()),
                );
            }
        }
        let state = app.state::<AppState>();
        let collaboration_identity = manager.collaboration_identity(&thread_id).ok();
        if collaboration_identity.as_ref().is_some_and(|identity| {
            identity.parent_thread_id.is_some() && identity.agent_path.is_some()
        }) {
            if let Ok(runtime) = collaboration_runtime(&app, &state) {
                let status = if cancel.is_cancelled() {
                    CollabAgentStatus::interrupted()
                } else if let Err(error) = &result {
                    CollabAgentStatus::errored(error.to_string())
                } else {
                    CollabAgentStatus::completed(
                        manager.latest_agent_message(&thread_id).ok().flatten(),
                    )
                };
                let _ = runtime.update_status(&thread_id, status.clone());
                if let Some(parent_thread_id) = collaboration_identity
                    .as_ref()
                    .and_then(|identity| identity.parent_thread_id.as_deref())
                {
                    let summary = serde_json::to_string(&status)
                        .unwrap_or_else(|_| "{\"status\":\"errored\"}".into());
                    if let Ok(message) = runtime.record_message(
                        &thread_id,
                        parent_thread_id,
                        &format!(
                            "Agent {} reached final status: {summary}",
                            collaboration_identity
                                .as_ref()
                                .and_then(|identity| identity.agent_path.as_deref())
                                .unwrap_or(&thread_id)
                        ),
                        false,
                    ) {
                        let host = DesktopCollaborationHost {
                            app: app.clone(),
                            manager: manager.clone(),
                        };
                        if host
                            .deliver(parent_thread_id, message.clone())
                            .await
                            .is_ok()
                        {
                            let _ = runtime.discard_message(parent_thread_id, &message.id);
                        }
                    }
                }
            }
            let read = manager.dispatch(
                "internal-collaboration",
                json!({
                    "id":Uuid::new_v4().to_string(),
                    "method":"thread/read",
                    "params":{"threadId":thread_id,"includeTurns":false}
                }),
            );
            if let Some(cwd) = read
                .response
                .pointer("/result/thread/cwd")
                .and_then(Value::as_str)
            {
                let identity = collaboration_identity.as_ref().expect("checked above");
                let _ = run_hooks(
                    &app,
                    &manager,
                    HookRequest {
                        event_name: HookEventName::SubagentStop,
                        thread_id: thread_id.clone(),
                        turn_id: Some(turn_id.clone()),
                        cwd: cwd.into(),
                        matcher: identity.agent_role.clone(),
                        payload: json!({
                            "agentPath":identity.agent_path,
                            "parentThreadId":identity.parent_thread_id,
                            "agentRole":identity.agent_role,
                            "cancelled":cancel.is_cancelled(),
                            "error":result.as_ref().err().map(ToString::to_string)
                        }),
                    },
                )
                .await;
            }
        }
        if let Ok(mut cancels) = state.codex_cancels.lock() {
            if cancels
                .get(&thread_id)
                .is_some_and(|(active_turn_id, _)| active_turn_id == &turn_id)
            {
                cancels.remove(&thread_id);
            }
        };
        if let Ok(mut activity) = state.codex_input_activity.lock() {
            if activity
                .get(&thread_id)
                .is_some_and(|(active_turn_id, _)| active_turn_id == &turn_id)
            {
                activity.remove(&thread_id);
            }
        };
        if let Ok(mut guardian) = state.codex_guardian.lock() {
            guardian.clear(&turn_id);
        };
    });
}

pub(crate) fn launch_automation_turn(
    app: &AppHandle,
    state: &AppState,
    run_id: &str,
    cwd: &std::path::Path,
    prompt: String,
) -> Result<(String, String), String> {
    let manager = thread_manager(app, state)?;
    let connection_id = format!("automation:{run_id}");
    let thread = manager.dispatch(&connection_id, automation_thread_start_request(run_id, cwd));
    if let Some(error) = thread.response.get("error") {
        return Err(format!("创建 Automation Thread 失败：{error}"));
    }
    emit_notifications(app, &thread.notifications)?;
    let thread_id = thread
        .response
        .pointer("/result/thread/id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Automation Thread 响应缺少 thread id".to_string())?
        .to_owned();
    let turn = manager.dispatch(
        &connection_id,
        automation_turn_start_request(run_id, &thread_id, cwd, prompt),
    );
    if let Some(error) = turn.response.get("error") {
        return Err(format!("创建 Automation Turn 失败：{error}"));
    }
    emit_notifications(app, &turn.notifications)?;
    let turn_id = turn
        .response
        .pointer("/result/turn/id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Automation Turn 响应缺少 turn id".to_string())?
        .to_owned();
    launch_turn_executor(app, state, manager, thread_id.clone(), turn_id.clone());
    Ok((thread_id, turn_id))
}

fn automation_thread_start_request(run_id: &str, cwd: &std::path::Path) -> Value {
    json!({
        "id":format!("{run_id}:thread"),
        "method":"thread/start",
        "params":{
            "cwd":cwd,
            "approvalPolicy":"never",
            "sandbox":"workspace-write",
            "developerInstructions":"This is an unattended Automation run. Never request user input or approval. Execute only the published workflow. If a required operation cannot run under the active sandbox and approvalPolicy=never, stop and report the blocked step instead of bypassing policy.",
            "threadSource":"automation",
            "serviceName":"Tietiezhi Automation",
            "ephemeral":false
        }
    })
}

fn automation_turn_start_request(
    run_id: &str,
    thread_id: &str,
    cwd: &std::path::Path,
    prompt: String,
) -> Value {
    json!({
        "id":format!("{run_id}:turn"),
        "method":"turn/start",
        "params":{
            "threadId":thread_id,
            "clientUserMessageId":run_id,
            "input":[{"type":"text","text":prompt,"textElements":[]}],
            "cwd":cwd,
            "approvalPolicy":"never",
            "sandboxPolicy":{
                "type":"workspaceWrite",
                "writableRoots":[cwd],
                "networkAccess":false,
                "excludeTmpdirEnvVar":false,
                "excludeSlashTmp":false
            }
        }
    })
}

pub(crate) fn interrupt_automation_turn(
    app: &AppHandle,
    state: &AppState,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), String> {
    let manager = thread_manager(app, state)?;
    let output = manager.dispatch(
        "automation",
        json!({
            "id":Uuid::new_v4().to_string(),
            "method":"turn/interrupt",
            "params":{"threadId":thread_id,"turnId":turn_id}
        }),
    );
    if let Some(error) = output.response.get("error") {
        return Err(format!("停止 Automation Turn 失败：{error}"));
    }
    cancel_thread(state, thread_id, Some(turn_id));
    emit_notifications(app, &output.notifications)
}

fn finalize_interrupted_review(
    app: &AppHandle,
    manager: &ThreadManager,
    thread_id: &str,
    turn_id: &str,
) {
    let is_review = manager
        .turn_execution_snapshot(thread_id, turn_id)
        .ok()
        .is_some_and(|snapshot| snapshot.review.is_some());
    if !is_review {
        return;
    }
    if let Ok(notifications) = manager.review_mode_completed(
        thread_id,
        turn_id,
        "Review was interrupted. Please re-run the review and wait for it to complete.",
    ) {
        let _ = emit_notifications(app, &notifications);
    }
}

async fn run_turn_executor(
    app: AppHandle,
    manager: ThreadManager,
    http: reqwest::Client,
    thread_id: String,
    turn_id: String,
    cancel: CancellationToken,
) -> Result<(), ModelError> {
    let initial = manager
        .turn_execution_snapshot(&thread_id, &turn_id)
        .map_err(core_model_error)?;
    let memory_config = memories_config(&app);
    let memory = memory_runtime(&app, &app.state::<AppState>()).map_err(ModelError::Consumer)?;
    let memory_mode = match initial.memory_mode.as_str() {
        "disabled" => ThreadMemoryMode::Disabled,
        "polluted" => ThreadMemoryMode::Polluted,
        _ => ThreadMemoryMode::Enabled,
    };
    memory
        .set_thread_mode(&thread_id, memory_mode)
        .map_err(|error| ModelError::Consumer(error.to_string()))?;
    let memory_instructions = if initial.review.is_none() {
        memory
            .developer_instructions(initial.memory_mode == "enabled" && memory_config.use_memories)
            .map_err(|error| ModelError::Consumer(error.to_string()))?
    } else {
        None
    };
    let collaboration_identity = manager
        .collaboration_identity(&thread_id)
        .map_err(core_model_error)?;
    if collaboration_identity.parent_thread_id.is_some()
        && collaboration_identity.agent_path.is_some()
    {
        let dispatch = run_hooks(
            &app,
            &manager,
            HookRequest {
                event_name: HookEventName::SubagentStart,
                thread_id: thread_id.clone(),
                turn_id: Some(turn_id.clone()),
                cwd: initial.cwd.clone(),
                matcher: collaboration_identity.agent_role.clone(),
                payload: json!({
                    "agentPath":collaboration_identity.agent_path,
                    "parentThreadId":collaboration_identity.parent_thread_id,
                    "agentRole":collaboration_identity.agent_role
                }),
            },
        )
        .await?;
        ensure_hook_allows(&dispatch)?;
    }
    let hook_runtime =
        hooks_runtime(&app, &app.state::<AppState>()).map_err(ModelError::Consumer)?;
    if hook_runtime.mark_session_start(&thread_id) {
        let dispatch = run_hooks(
            &app,
            &manager,
            HookRequest {
                event_name: HookEventName::SessionStart,
                thread_id: thread_id.clone(),
                turn_id: Some(turn_id.clone()),
                cwd: initial.cwd.clone(),
                matcher: Some("startup".into()),
                payload: json!({"source":"startup"}),
            },
        )
        .await?;
        ensure_hook_allows(&dispatch)?;
    }
    let resolved =
        super::providers::resolve(&app, &initial.model_provider).map_err(ModelError::Transport)?;
    let base_url = super::api_url(&resolved.base_url, "")
        .trim_end_matches('/')
        .to_owned();
    let configured_wire_api = resolved.wire_api;
    let effective_wire_api = resolved.wire_api_for_model(&initial.model);
    let reasoning_transport =
        resolved.reasoning_transport_for_model(&initial.model, effective_wire_api);
    let provider_id = resolved.id;
    let provider_name = resolved.kind;
    let mut bearer_token = app
        .state::<AppState>()
        .codex_external_auth
        .lock()
        .map_err(|_| ModelError::Consumer("Codex 外部账号状态锁已损坏".into()))?
        .get(&provider_id)
        .map(|tokens| tokens.access_token.clone())
        .or(resolved.key);
    let capability_key = format!("{provider_id}\n{base_url}");
    let mut client = responses_client(
        &http,
        &provider_name,
        &base_url,
        bearer_token.clone(),
        effective_wire_api,
        reasoning_transport,
    );
    ensure_responses_capability(&app, &capability_key, configured_wire_api, &client).await?;
    let mut projection = ResponseProjection::new(
        initial.model.clone(),
        initial.model_context_window,
        initial.cwd.clone(),
    );
    if initial.memory_mode == "enabled" && memory_config.use_memories {
        projection =
            projection.with_memory(memory.clone(), memory_config.disable_on_external_context);
    }
    if initial.review.is_some() {
        projection.suppress_agent_messages = true;
    }
    let mut can_drain_steered = false;
    let mut output_schema = initial.review.as_ref().map(|_| review_output_schema());
    let mut auth_refresh_attempted = false;
    let (tool_runtime, base_tool_specs) = turn_tool_runtime(&app, &manager, &initial).await?;
    let mut loaded_tool_specs = Vec::new();
    let skill_metadata = {
        let state = app.state::<AppState>();
        skills_runtime(&app, &state)
            .map_err(ModelError::Consumer)?
            .enabled_skills(&initial.cwd)
            .map_err(ModelError::Consumer)?
            .into_iter()
            .map(|skill| serde_json::to_value(skill).map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(ModelError::Consumer)?
    };
    let project_instructions =
        load_project_instructions(&initial.cwd, &ProjectInstructionConfig::default())
            .ok()
            .flatten();

    loop {
        let drained = manager
            .drain_turn_inputs(&thread_id, &turn_id, can_drain_steered)
            .map_err(core_model_error)?;
        emit_notifications(&app, &drained.notifications).map_err(ModelError::Consumer)?;
        if !drained.batches.is_empty() {
            let dispatch = run_hooks(
                &app,
                &manager,
                HookRequest {
                    event_name: HookEventName::UserPromptSubmit,
                    thread_id: thread_id.clone(),
                    turn_id: Some(turn_id.clone()),
                    cwd: initial.cwd.clone(),
                    matcher: None,
                    payload: json!({
                        "input": drained
                            .batches
                            .iter()
                            .flat_map(|batch| batch.input.clone())
                            .collect::<Vec<_>>()
                    }),
                },
            )
            .await?;
            ensure_hook_allows(&dispatch)?;
        }
        can_drain_steered = true;
        if manager
            .should_auto_compact(&thread_id, &turn_id)
            .map_err(core_model_error)?
        {
            let (snapshot, notifications) = manager
                .begin_auto_compaction(&thread_id, &turn_id)
                .map_err(core_model_error)?;
            emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
            run_compaction_snapshot(
                app.clone(),
                manager.clone(),
                http.clone(),
                snapshot,
                cancel.clone(),
            )
            .await?;
        }
        let context_snapshot = manager
            .turn_execution_snapshot(&thread_id, &turn_id)
            .map_err(core_model_error)?;
        let mut tool_specs = merge_tool_specs(&base_tool_specs, &loaded_tool_specs);
        if initial.review.is_some() {
            tool_specs.retain(review_tool_allowed);
        }
        record_runtime_world_state(
            &manager,
            &context_snapshot,
            &tool_specs,
            skill_metadata.clone(),
            project_instructions.clone(),
        )?;
        let snapshot = manager
            .turn_execution_snapshot(&thread_id, &turn_id)
            .map_err(core_model_error)?;
        if let Some(schema) = drained
            .batches
            .iter()
            .rev()
            .find_map(|batch| batch.output_schema.clone())
        {
            output_schema = Some(schema);
        }
        let mut request = response_request(&snapshot, output_schema.clone(), tool_specs);
        if !projection.memory_polluted() {
            if let Some(instructions) = &memory_instructions {
                request.input.insert(
                    0,
                    json!({
                        "type":"message",
                        "role":"developer",
                        "content":[{"type":"input_text","text":instructions}]
                    }),
                );
            }
        }
        if initial.review.is_some() {
            request.instructions = REVIEW_RUBRIC.to_owned();
        }
        let stream = client.stream(&request, |event| {
            let notifications = projection.apply(&manager, &thread_id, &turn_id, event)?;
            emit_notifications(&app, &notifications).map_err(ModelError::Consumer)
        });
        let result = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = stream => result,
        };
        if matches!(result, Err(ModelError::Unauthorized { .. }))
            && !auth_refresh_attempted
            && !projection.model_output_seen()
        {
            if let Some(tokens) = refresh_external_auth(&app, &provider_id, &thread_id).await? {
                auth_refresh_attempted = true;
                bearer_token = Some(tokens.access_token);
                client = responses_client(
                    &http,
                    &provider_name,
                    &base_url,
                    bearer_token.clone(),
                    effective_wire_api,
                    reasoning_transport,
                );
                continue;
            }
        }
        result?;
        if cancel.is_cancelled() {
            return Ok(());
        }
        let tool_calls = projection.take_tool_calls();
        if !tool_calls.is_empty() {
            if memory_config.disable_on_external_context
                && tool_calls.iter().any(|call| {
                    call.tool_name
                        .namespace
                        .as_deref()
                        .is_some_and(|namespace| namespace != "memories")
                })
            {
                mark_memory_polluted(&manager, &memory, &thread_id)?;
                projection.memory_polluted = true;
            }
            let input_activity = turn_input_activity_token(&app, &thread_id, &turn_id);
            if manager
                .has_pending_turn_input(&thread_id, &turn_id)
                .map_err(core_model_error)?
            {
                input_activity.cancel();
            }
            let mut calls = Vec::with_capacity(tool_calls.len());
            for mut call in tool_calls {
                let pre_hooks = run_hooks(
                    &app,
                    &manager,
                    HookRequest {
                        event_name: HookEventName::PreToolUse,
                        thread_id: thread_id.clone(),
                        turn_id: Some(turn_id.clone()),
                        cwd: initial.cwd.clone(),
                        matcher: Some(call.tool_name.display_name()),
                        payload: json!({
                            "tool_name": call.tool_name.display_name(),
                            "tool_input": tool_call_input(&call),
                            "tool_use_id": call.call_id
                        }),
                    },
                )
                .await?;
                if let Some(updated_input) = pre_hooks.updated_input {
                    update_tool_call_input(&mut call, updated_input)?;
                }
                let timeline_item = local_tool_timeline_item(&snapshot, &call);
                let precomputed =
                    pre_hooks
                        .blocked_reason
                        .or(pre_hooks.stop_reason)
                        .map(|reason| ToolModelCallResult {
                            response_item: ToolOutput::failure(json!({
                                "error": reason,
                                "blockedBy": "PreToolUse"
                            }))
                            .to_response_item(&call),
                            metadata: None,
                        });
                calls.push((call, timeline_item, precomputed));
            }
            for (_, item, _) in &calls {
                let Some(item) = item else {
                    continue;
                };
                let notifications = manager
                    .local_tool_item_started(&thread_id, &turn_id, item.clone())
                    .map_err(core_model_error)?;
                emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                if item.get("type").and_then(Value::as_str) == Some("fileChange") {
                    let changes = item
                        .get("changes")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let notifications = manager
                        .file_change_patch_updated(
                            &thread_id,
                            &turn_id,
                            item.get("id").and_then(Value::as_str).unwrap_or_default(),
                            changes,
                        )
                        .map_err(core_model_error)?;
                    emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                }
            }
            let executions = calls.into_iter().map(|(call, timeline_item, precomputed)| {
                let runtime = tool_runtime.clone();
                let thread_id = thread_id.clone();
                let turn_id = turn_id.clone();
                let cancel = cancel.clone();
                let input_activity = input_activity.clone();
                async move {
                    let output = match precomputed {
                        Some(output) => output,
                        None => {
                            runtime
                                .handle_model_call_result_with_activity(
                                    thread_id,
                                    turn_id,
                                    call.clone(),
                                    cancel,
                                    input_activity,
                                )
                                .await
                        }
                    };
                    (call, timeline_item, output)
                }
            });
            for (call, timeline_item, mut output) in
                futures_util::future::join_all(executions).await
            {
                let post_hooks = run_hooks(
                    &app,
                    &manager,
                    HookRequest {
                        event_name: HookEventName::PostToolUse,
                        thread_id: thread_id.clone(),
                        turn_id: Some(turn_id.clone()),
                        cwd: initial.cwd.clone(),
                        matcher: Some(call.tool_name.display_name()),
                        payload: json!({
                            "tool_name": call.tool_name.display_name(),
                            "tool_input": tool_call_input(&call),
                            "tool_use_id": call.call_id,
                            "tool_response": output.response_item
                        }),
                    },
                )
                .await?;
                if let Some(reason) = post_hooks.blocked_reason.or(post_hooks.stop_reason) {
                    output.response_item = ToolOutput::failure(json!({
                        "error": reason,
                        "blockedBy": "PostToolUse",
                        "toolOutput": output.response_item
                    }))
                    .to_response_item(&call);
                }
                let metadata_item = output
                    .metadata
                    .as_ref()
                    .filter(|metadata| {
                        matches!(
                            metadata.get("kind").and_then(Value::as_str),
                            Some("fileChange" | "commandExecution" | "dynamicToolCall")
                        )
                    })
                    .and_then(|metadata| metadata.get("item"))
                    .cloned();
                let defer_item_completion = output
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("deferItemCompletion"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let collaboration_item = output
                    .metadata
                    .as_ref()
                    .and_then(|metadata| collaboration_timeline_item(&call, metadata));
                let timeline_item = timeline_item.map(|mut item| {
                    if item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall") {
                        item["status"] = json!("failed");
                    }
                    item
                });
                if let Some(item) = metadata_item.or(collaboration_item).or(timeline_item) {
                    if item.get("type").and_then(Value::as_str) == Some("fileChange") {
                        let changes = item
                            .get("changes")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let notifications = manager
                            .file_change_patch_updated(
                                &thread_id,
                                &turn_id,
                                item.get("id").and_then(Value::as_str).unwrap_or_default(),
                                changes,
                            )
                            .map_err(core_model_error)?;
                        emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                    }
                    if !defer_item_completion {
                        let notifications = manager
                            .local_tool_item_completed(&thread_id, &turn_id, item)
                            .map_err(core_model_error)?;
                        emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                    }
                }
                if let Some(activity) = output
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.pointer("/codexCollaboration/activity"))
                    .filter(|activity| !activity.is_null())
                {
                    if let (Some(kind), Some(agent_thread_id), Some(agent_path)) = (
                        activity.get("kind").and_then(Value::as_str),
                        activity.get("agentThreadId").and_then(Value::as_str),
                        activity.get("agentPath").and_then(Value::as_str),
                    ) {
                        let activity_item = json!({
                            "type":"subAgentActivity",
                            "id":call.call_id,
                            "kind":kind,
                            "agentThreadId":agent_thread_id,
                            "agentPath":agent_path
                        });
                        let notifications = manager
                            .local_tool_item_completed(&thread_id, &turn_id, activity_item)
                            .map_err(core_model_error)?;
                        emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                    }
                }
                if let Some(diff) = output
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("turnDiff"))
                    .and_then(Value::as_str)
                {
                    let notifications = manager
                        .turn_diff_updated(&thread_id, &turn_id, diff)
                        .map_err(core_model_error)?;
                    emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                }
                if let Some(metadata) = output.metadata.as_ref().filter(|metadata| {
                    metadata.get("kind").and_then(Value::as_str) == Some("planUpdate")
                }) {
                    let plan = metadata
                        .get("plan")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let explanation = metadata
                        .get("explanation")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let notifications = manager
                        .turn_plan_updated(&thread_id, &turn_id, explanation, plan)
                        .map_err(core_model_error)?;
                    emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                }
                if matches!(call.payload, ToolPayload::ToolSearch { .. }) {
                    if let Some(tools) = output.response_item.get("tools").and_then(Value::as_array)
                    {
                        loaded_tool_specs.extend(tools.iter().cloned());
                    }
                }
                let notifications = manager
                    .model_item_completed(&thread_id, &turn_id, output.response_item)
                    .map_err(core_model_error)?;
                emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
            }
            continue;
        }
        if projection.take_needs_follow_up() {
            continue;
        }
        let stop_hooks = run_hooks(
            &app,
            &manager,
            HookRequest {
                event_name: HookEventName::Stop,
                thread_id: thread_id.clone(),
                turn_id: Some(turn_id.clone()),
                cwd: initial.cwd.clone(),
                matcher: None,
                payload: json!({"stopHookActive":false}),
            },
        )
        .await?;
        if stop_hooks.blocked_reason.is_some() || stop_hooks.stop_reason.is_some() {
            continue;
        }
        if initial.review.is_some() {
            let raw = projection.take_captured_agent_text().unwrap_or_default();
            let rendered = match parse_review_output(&raw) {
                Ok(output) => render_review_output(&output),
                Err(_) if raw.trim().is_empty() => {
                    "Review was interrupted. Please re-run the review and wait for it to complete."
                        .into()
                }
                Err(_) => raw,
            };
            let notifications = manager
                .review_mode_completed(&thread_id, &turn_id, &rendered)
                .map_err(core_model_error)?;
            emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
        }
        match manager
            .complete_turn_if_no_pending(&thread_id, &turn_id)
            .map_err(core_model_error)?
        {
            Some(notifications) => {
                emit_notifications(&app, &notifications).map_err(ModelError::Consumer)?;
                return Ok(());
            }
            None => continue,
        }
    }
}

fn ensure_hook_allows(dispatch: &HookDispatch) -> Result<(), ModelError> {
    if let Some(reason) = dispatch
        .blocked_reason
        .as_deref()
        .or(dispatch.stop_reason.as_deref())
    {
        return Err(ModelError::InvalidRequest {
            message: reason.to_owned(),
        });
    }
    Ok(())
}

async fn run_permission_hooks(
    app: &AppHandle,
    manager: &ThreadManager,
    thread_id: &str,
    turn_id: &str,
    cwd: std::path::PathBuf,
    matcher: &str,
    payload: Value,
) -> Result<Option<HookPermissionDecision>, tietiezhi_agent_tools::ToolError> {
    let dispatch = run_hooks(
        app,
        manager,
        HookRequest {
            event_name: HookEventName::PermissionRequest,
            thread_id: thread_id.to_owned(),
            turn_id: Some(turn_id.to_owned()),
            cwd,
            matcher: Some(matcher.to_owned()),
            payload,
        },
    )
    .await
    .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))?;
    Ok(dispatch.permission_decision)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum GuardianDecision {
    NotApplicable,
    Allow,
    Deny(String),
    Abort,
}

async fn run_guardian_review(
    app: &AppHandle,
    manager: &ThreadManager,
    thread_id: &str,
    turn_id: &str,
    target_item_id: Option<&str>,
    action: GuardianAction,
    cancellation: CancellationToken,
) -> GuardianDecision {
    let snapshot = match manager.turn_execution_snapshot(thread_id, turn_id) {
        Ok(snapshot) => snapshot,
        Err(_) => return GuardianDecision::Deny("automatic approval review lost its turn".into()),
    };
    if !matches!(
        snapshot.approvals_reviewer.as_str(),
        "auto_review" | "guardian_subagent"
    ) {
        return GuardianDecision::NotApplicable;
    }
    if let Ok(approvals) = manager.take_guardian_approvals(thread_id) {
        if approvals
            .iter()
            .any(|event| guardian_override_matches(event, &action))
        {
            return GuardianDecision::Allow;
        }
    }

    let started = guardian_started_notification(
        thread_id,
        turn_id,
        target_item_id,
        &action,
        unix_timestamp_ms(),
    );
    let started_notifications = match manager.guardian_review_notification(
        thread_id,
        "item/autoApprovalReview/started",
        started.clone(),
    ) {
        Ok(notifications) => notifications,
        Err(error) => {
            return GuardianDecision::Deny(format!(
                "automatic approval review could not start: {error:?}"
            ));
        }
    };
    if emit_notifications(app, &started_notifications).is_err() {
        return GuardianDecision::Deny(
            "automatic approval review could not publish its state".into(),
        );
    }

    let review_result = run_guardian_model(app, &snapshot, &action, cancellation.clone()).await;
    let (assessment, status, decision) = match review_result {
        Ok(assessment) => {
            let status = match assessment.outcome {
                GuardianAssessmentOutcome::Allow => GuardianApprovalReviewStatus::Approved,
                GuardianAssessmentOutcome::Deny => GuardianApprovalReviewStatus::Denied,
            };
            let decision = match assessment.outcome {
                GuardianAssessmentOutcome::Allow => GuardianDecision::Allow,
                GuardianAssessmentOutcome::Deny => {
                    GuardianDecision::Deny(assessment.rationale.clone())
                }
            };
            (Some(assessment), status, decision)
        }
        Err(GuardianModelFailure::TimedOut) => (
            None,
            GuardianApprovalReviewStatus::TimedOut,
            GuardianDecision::Deny("automatic approval review timed out".into()),
        ),
        Err(GuardianModelFailure::Aborted) => (
            None,
            GuardianApprovalReviewStatus::Aborted,
            GuardianDecision::Abort,
        ),
        Err(GuardianModelFailure::Failed(message)) => (
            None,
            GuardianApprovalReviewStatus::Denied,
            GuardianDecision::Deny(format!(
                "automatic approval review could not complete: {message}"
            )),
        ),
    };
    let completed =
        guardian_completed_notification(&started, assessment.as_ref(), status, unix_timestamp_ms());
    if let Ok(notifications) = manager.guardian_review_notification(
        thread_id,
        "item/autoApprovalReview/completed",
        completed,
    ) {
        let _ = emit_notifications(app, &notifications);
    }

    if matches!(decision, GuardianDecision::Deny(_)) {
        let circuit = app
            .state::<AppState>()
            .codex_guardian
            .lock()
            .ok()
            .map(|mut breaker| breaker.record(turn_id, true))
            .unwrap_or(CircuitBreakerAction::Continue);
        if let CircuitBreakerAction::Interrupt {
            consecutive_denials,
            recent_denials,
        } = circuit
        {
            let message = format!(
                "Guardian interrupted the turn after {consecutive_denials} consecutive denials \
                 ({recent_denials} denials in the recent review window)."
            );
            if let Ok(notifications) = manager.guardian_warning(thread_id, &message) {
                let _ = emit_notifications(app, &notifications);
            }
            let interrupted = manager.dispatch(
                "guardian",
                json!({
                    "id":Uuid::new_v4().to_string(),
                    "method":"turn/interrupt",
                    "params":{"threadId":thread_id,"turnId":turn_id}
                }),
            );
            let _ = emit_notifications(app, &interrupted.notifications);
            cancel_thread(&app.state::<AppState>(), thread_id, Some(turn_id));
            return GuardianDecision::Abort;
        }
    } else if matches!(decision, GuardianDecision::Allow) {
        if let Ok(mut breaker) = app.state::<AppState>().codex_guardian.lock() {
            let _ = breaker.record(turn_id, false);
        }
    }
    decision
}

pub(crate) async fn guardian_mcp_approval(
    app: &AppHandle,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    server: &str,
    tool_name: &str,
) -> Option<&'static str> {
    let state = app.state::<AppState>();
    let manager = thread_manager(app, &state).ok()?;
    let decision = run_guardian_review(
        app,
        &manager,
        thread_id,
        turn_id,
        Some(item_id),
        GuardianAction::McpToolCall {
            server: server.into(),
            tool_name: tool_name.into(),
            connector_id: None,
            connector_name: None,
            tool_title: None,
        },
        turn_cancellation_token(app, thread_id, turn_id),
    )
    .await;
    match decision {
        GuardianDecision::NotApplicable => None,
        GuardianDecision::Allow => Some("accept"),
        GuardianDecision::Deny(_) => Some("decline"),
        GuardianDecision::Abort => Some("cancel"),
    }
}

fn guardian_override_matches(event: &Value, action: &GuardianAction) -> bool {
    let expected = serde_json::to_value(action).ok();
    event
        .get("action")
        .or_else(|| event.pointer("/params/action"))
        .is_some_and(|candidate| Some(candidate) == expected.as_ref())
        && event
            .pointer("/review/status")
            .or_else(|| event.pointer("/params/review/status"))
            .and_then(Value::as_str)
            .is_some_and(|status| status == "denied")
}

#[derive(Debug)]
enum GuardianModelFailure {
    TimedOut,
    Aborted,
    Failed(String),
}

async fn run_guardian_model(
    app: &AppHandle,
    snapshot: &TurnExecutionSnapshot,
    action: &GuardianAction,
    cancellation: CancellationToken,
) -> Result<GuardianAssessment, GuardianModelFailure> {
    let resolved = super::providers::resolve(app, &snapshot.model_provider)
        .map_err(GuardianModelFailure::Failed)?;
    let base_url = super::api_url(&resolved.base_url, "")
        .trim_end_matches('/')
        .to_owned();
    let effective_wire_api = resolved.wire_api_for_model(&snapshot.model);
    let reasoning_transport =
        resolved.reasoning_transport_for_model(&snapshot.model, effective_wire_api);
    let bearer_token = app
        .state::<AppState>()
        .codex_external_auth
        .lock()
        .map_err(|_| GuardianModelFailure::Failed("external auth state lock poisoned".into()))?
        .get(&resolved.id)
        .map(|tokens| tokens.access_token.clone())
        .or(resolved.key);
    let client = responses_client(
        &app.state::<AppState>().http,
        &resolved.kind,
        &base_url,
        bearer_token,
        effective_wire_api,
        reasoning_transport,
    );
    let prompt = guardian_prompt(&snapshot.history, action)
        .map_err(|error| GuardianModelFailure::Failed(error.to_string()))?;
    let mut request = ResponsesApiRequest::text(
        snapshot.model.clone(),
        vec![json!({
            "type":"message",
            "role":"user",
            "content":[{"type":"input_text","text":prompt}]
        })],
    );
    request.instructions = GUARDIAN_POLICY.to_owned();
    request.prompt_cache_key = Some(format!("guardian:{}", snapshot.thread_id));
    request.service_tier.clone_from(&snapshot.service_tier);
    request.reasoning = snapshot.reasoning_effort.as_ref().map(|effort| Reasoning {
        effort: Some(effort.clone()),
        summary: Some("auto".into()),
        context: None,
    });
    request.text = Some(TextControls {
        verbosity: None,
        format: Some(TextFormat {
            r#type: TextFormatType::JsonSchema,
            strict: true,
            schema: guardian_output_schema(),
            name: "guardian_assessment".into(),
        }),
    });
    let mut output = String::new();
    let stream = client.stream(&request, |event| {
        match event {
            ResponseEvent::OutputItemDone(item) => {
                if let Some(text) = assistant_response_text(&item) {
                    output = text;
                }
            }
            ResponseEvent::OutputTextDelta(delta) => output.push_str(&delta),
            _ => {}
        }
        Ok(())
    });
    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(GuardianModelFailure::Aborted),
        result = tokio::time::timeout(
            Duration::from_secs(GUARDIAN_REVIEW_TIMEOUT_SECS),
            stream
        ) => result,
    };
    match result {
        Err(_) => Err(GuardianModelFailure::TimedOut),
        Ok(Err(error)) => Err(GuardianModelFailure::Failed(error.to_string())),
        Ok(Ok(())) => parse_guardian_assessment(&output)
            .map_err(|error| GuardianModelFailure::Failed(error.to_string())),
    }
}

fn unix_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn tool_call_input(call: &ToolCall) -> Value {
    match &call.payload {
        ToolPayload::Function { arguments } => {
            serde_json::from_str(arguments).unwrap_or_else(|_| json!({"raw":arguments}))
        }
        ToolPayload::Custom { input } => json!(input),
        ToolPayload::ToolSearch { arguments } => arguments.clone(),
    }
}

fn update_tool_call_input(call: &mut ToolCall, input: Value) -> Result<(), ModelError> {
    match &mut call.payload {
        ToolPayload::Function { arguments } => {
            *arguments = serde_json::to_string(&input)
                .map_err(|error| ModelError::Consumer(error.to_string()))?;
        }
        ToolPayload::Custom { input: current } => {
            *current = input
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| input.to_string());
        }
        ToolPayload::ToolSearch { arguments } => *arguments = input,
    }
    Ok(())
}

fn responses_client(
    http: &reqwest::Client,
    provider_name: &str,
    base_url: &str,
    bearer_token: Option<String>,
    wire_api: super::settings::WireApi,
    reasoning_transport: super::models::ReasoningTransport,
) -> ResponsesClient {
    let wire_api = match wire_api {
        super::settings::WireApi::Auto | super::settings::WireApi::Responses => {
            tietiezhi_agent_model::WireApi::Responses
        }
        super::settings::WireApi::ChatCompletions => {
            tietiezhi_agent_model::WireApi::ChatCompletions
        }
        super::settings::WireApi::AnthropicMessages => {
            tietiezhi_agent_model::WireApi::AnthropicMessages
        }
        super::settings::WireApi::GeminiGenerateContent => {
            tietiezhi_agent_model::WireApi::GeminiGenerateContent
        }
    };
    ResponsesClient::new(
        http.clone(),
        tietiezhi_agent_model::Provider::openai_compatible(provider_name, base_url, bearer_token)
            .with_wire_api(wire_api)
            .with_reasoning_wire_format(match reasoning_transport {
                super::models::ReasoningTransport::None => {
                    tietiezhi_agent_model::ReasoningWireFormat::Auto
                }
                super::models::ReasoningTransport::ResponsesReasoning => {
                    tietiezhi_agent_model::ReasoningWireFormat::ResponsesReasoning
                }
                super::models::ReasoningTransport::OpenaiReasoningEffort => {
                    tietiezhi_agent_model::ReasoningWireFormat::ChatReasoningEffort
                }
                super::models::ReasoningTransport::OpenrouterReasoning => {
                    tietiezhi_agent_model::ReasoningWireFormat::OpenRouterReasoning
                }
                super::models::ReasoningTransport::EnableThinking => {
                    tietiezhi_agent_model::ReasoningWireFormat::EnableThinking
                }
                super::models::ReasoningTransport::AnthropicAdaptive => {
                    tietiezhi_agent_model::ReasoningWireFormat::AnthropicAdaptive
                }
                super::models::ReasoningTransport::AnthropicThinkingBudget => {
                    tietiezhi_agent_model::ReasoningWireFormat::AnthropicThinkingBudget
                }
                super::models::ReasoningTransport::GeminiThinkingLevel => {
                    tietiezhi_agent_model::ReasoningWireFormat::GeminiThinkingLevel
                }
                super::models::ReasoningTransport::GeminiThinkingBudget => {
                    tietiezhi_agent_model::ReasoningWireFormat::GeminiThinkingBudget
                }
            }),
    )
}

async fn refresh_external_auth(
    app: &AppHandle,
    provider_id: &str,
    thread_id: &str,
) -> Result<Option<ExternalAuthTokens>, ModelError> {
    let state = app.state::<AppState>();
    let current = state
        .codex_external_auth
        .lock()
        .map_err(|_| ModelError::Consumer("Codex 外部账号状态锁已损坏".into()))?
        .get(provider_id)
        .cloned();
    let Some(current) = current else {
        return Ok(None);
    };
    let recipients = state
        .codex_account
        .connections()
        .map_err(|error| ModelError::Consumer(error.message))?;
    let pending = state
        .codex_account_requests
        .begin_auth_refresh(recipients, Some(current.account_id))
        .map_err(|error| ModelError::Consumer(error.message))?;
    emit_server_request(app, &pending.request, Some(thread_id)).map_err(ModelError::Consumer)?;
    let request_id = pending.request.id.clone();
    let result = match tokio::time::timeout(Duration::from_secs(60), pending.receiver).await {
        Ok(Ok(result)) => result.map_err(|error| ModelError::InvalidRequest {
            message: error.message,
        })?,
        Ok(Err(_)) => {
            return Err(ModelError::Consumer("外部账号刷新响应通道已关闭".into()));
        }
        Err(_) => {
            let _ = state.codex_account_requests.cancel(&request_id);
            let _ = state.codex_attestation.tracker().cancel(&request_id);
            return Err(ModelError::InvalidRequest {
                message: "等待外部账号刷新超时".into(),
            });
        }
    };
    let access_token = result
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ModelError::Consumer("外部账号刷新缺少 accessToken".into()))?
        .to_owned();
    let account_id = result
        .get("chatgptAccountId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ModelError::Consumer("外部账号刷新缺少 chatgptAccountId".into()))?
        .to_owned();
    let plan_type = result
        .get("chatgptPlanType")
        .and_then(Value::as_str)
        .map(normalized_plan_type)
        .map(str::to_owned);
    let tokens = ExternalAuthTokens {
        access_token,
        account_id,
        plan_type,
    };
    state
        .codex_external_auth
        .lock()
        .map_err(|_| ModelError::Consumer("Codex 外部账号状态锁已损坏".into()))?
        .insert(provider_id.into(), tokens.clone());
    Ok(Some(tokens))
}

async fn ensure_responses_capability(
    app: &AppHandle,
    capability_key: &str,
    wire_api: super::settings::WireApi,
    client: &ResponsesClient,
) -> Result<(), ModelError> {
    if client.wire_api() != tietiezhi_agent_model::WireApi::Responses {
        return Ok(());
    }
    match wire_api {
        super::settings::WireApi::Responses
        | super::settings::WireApi::ChatCompletions
        | super::settings::WireApi::AnthropicMessages
        | super::settings::WireApi::GeminiGenerateContent => return Ok(()),
        super::settings::WireApi::Auto => {}
    }
    let state = app.state::<AppState>();
    let cached = state
        .codex_wire_capabilities
        .lock()
        .map_err(|_| ModelError::Consumer("供应商 capability 缓存锁已损坏".into()))?
        .get(capability_key)
        .copied();
    let supported = match cached {
        Some(supported) => supported,
        None => {
            let supported = client.supports_responses().await?;
            state
                .codex_wire_capabilities
                .lock()
                .map_err(|_| ModelError::Consumer("供应商 capability 缓存锁已损坏".into()))?
                .insert(capability_key.into(), supported);
            supported
        }
    };
    if supported {
        Ok(())
    } else {
        Err(ModelError::InvalidRequest {
            message:
                "自动探测未找到 /v1/responses；请在供应商或模型设置中明确选择 Chat Completions、Anthropic Messages 或 Gemini GenerateContent"
                    .into(),
        })
    }
}

fn response_request(
    snapshot: &TurnExecutionSnapshot,
    output_schema: Option<Value>,
    tools: Vec<Value>,
) -> ResponsesApiRequest {
    let mut request = ResponsesApiRequest::text(
        snapshot.model.clone(),
        strip_internal_world_state_metadata(&snapshot.history),
    );
    request.instructions = snapshot.base_instructions.clone().unwrap_or_default();
    request.tools = (!tools.is_empty()).then_some(tools);
    request.reasoning = snapshot.reasoning_effort.as_ref().map(|effort| Reasoning {
        effort: Some(effort.clone()),
        summary: snapshot
            .reasoning_summary
            .as_ref()
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| Some("auto".into())),
        context: None,
    });
    request.service_tier.clone_from(&snapshot.service_tier);
    request.prompt_cache_key = Some(snapshot.thread_id.clone());
    request.text = output_schema.map(|schema| TextControls {
        verbosity: None,
        format: Some(TextFormat {
            r#type: TextFormatType::JsonSchema,
            strict: true,
            schema,
            name: "output".into(),
        }),
    });
    request
}

fn record_runtime_world_state(
    manager: &ThreadManager,
    snapshot: &TurnExecutionSnapshot,
    tool_specs: &[Value],
    skill_metadata: Vec<Value>,
    project_instructions: Option<tietiezhi_agent_config::LoadedProjectInstructions>,
) -> Result<(), ModelError> {
    let previous = manager
        .world_state_baseline(&snapshot.thread_id, &snapshot.turn_id)
        .map_err(core_model_error)?;
    let now = Local::now();
    let timezone = iana_time_zone::get_timezone().unwrap_or_else(|_| now.offset().to_string());
    let tool_names = tool_specs
        .iter()
        .filter_map(|spec| {
            spec.get("name")
                .and_then(Value::as_str)
                .or_else(|| spec.get("type").and_then(Value::as_str))
                .map(str::to_owned)
        })
        .collect();
    let update = build_world_state(
        &snapshot.turn_id,
        WorldStateInput {
            cwd: snapshot.cwd.clone(),
            shell: std::env::var("SHELL")
                .or_else(|_| std::env::var("COMSPEC"))
                .ok(),
            current_date: now.format("%Y-%m-%d").to_string(),
            timezone,
            approval_policy: snapshot.approval_policy.clone(),
            sandbox_policy: snapshot.sandbox.clone(),
            tool_names,
            skill_metadata,
            collaboration_mode: "default".into(),
            collaboration_mode_instructions: None,
            developer_instructions: snapshot.developer_instructions.clone(),
            project_instructions,
        },
        previous.as_ref(),
    );
    manager
        .record_step_context(
            &snapshot.thread_id,
            &snapshot.turn_id,
            update.response_items,
            update.snapshot,
        )
        .map_err(core_model_error)?;
    Ok(())
}

#[derive(Clone)]
struct DeviceAppToolHandler {
    app: AppHandle,
    manager: ThreadManager,
    cwd: std::path::PathBuf,
    approval_policy: AskForApproval,
    tool: AppToolDefinition,
}

impl DeviceAppToolHandler {
    fn handlers(
        app: AppHandle,
        manager: ThreadManager,
        cwd: std::path::PathBuf,
        approval_policy: AskForApproval,
    ) -> Vec<Arc<dyn ToolHandler>> {
        device_app()
            .tools
            .into_iter()
            .map(|tool| {
                Arc::new(Self {
                    app: app.clone(),
                    manager: manager.clone(),
                    cwd: cwd.clone(),
                    approval_policy,
                    tool,
                }) as Arc<dyn ToolHandler>
            })
            .collect()
    }

    fn arguments(invocation: &ToolInvocation) -> Result<Value, ToolError> {
        let ToolPayload::Function { arguments } = &invocation.call.payload else {
            return Err(ToolError::InvalidCall(
                "app tools require function arguments".into(),
            ));
        };
        serde_json::from_str(arguments)
            .map_err(|error| ToolError::InvalidCall(format!("invalid app arguments: {error}")))
    }

    async fn approve_device_call(
        &self,
        invocation: &ToolInvocation,
        device_id: &str,
        capability: &str,
        input: &Value,
    ) -> Result<(), ToolError> {
        if is_read_only_device_capability(capability) {
            return Ok(());
        }
        if self.approval_policy == AskForApproval::Never {
            return Err(ToolError::Handler(
                "approval policy is never; device side effects are forbidden".into(),
            ));
        }
        let command = vec!["device".into(), device_id.to_owned(), capability.to_owned()];
        let key = ApprovalKey::Command {
            environment_id: format!("device:{device_id}"),
            command: command.clone(),
            cwd: self.cwd.to_string_lossy().into_owned(),
            tty: false,
            sandbox_permissions: "danger-full-access".into(),
            additional_permissions: Some(json!({
                "appId":tietiezhi_agent_apps::DEVICE_APP_ID,
                "deviceId":device_id,
                "capability":capability,
                "input":input
            })),
        };
        let state = self.app.state::<AppState>();
        if state
            .codex_session_approvals
            .contains_all_for(&invocation.thread_id, std::slice::from_ref(&key))
        {
            return Ok(());
        }
        match run_permission_hooks(
            &self.app,
            &self.manager,
            &invocation.thread_id,
            &invocation.turn_id,
            self.cwd.clone(),
            "tietiezhi_devices.invoke",
            json!({
                "tool_name":"tietiezhi_devices.invoke",
                "device_id":device_id,
                "capability":capability,
                "input":input
            }),
        )
        .await?
        {
            Some(HookPermissionDecision::Allow) => return Ok(()),
            Some(HookPermissionDecision::Deny(reason)) => {
                return Err(ToolError::Handler(reason));
            }
            None => {}
        }
        match run_guardian_review(
            &self.app,
            &self.manager,
            &invocation.thread_id,
            &invocation.turn_id,
            Some(&invocation.call.call_id),
            GuardianAction::McpToolCall {
                server: "codex_apps".into(),
                tool_name: "tietiezhi_devices.invoke".into(),
                connector_id: Some(tietiezhi_agent_apps::DEVICE_APP_ID.into()),
                connector_name: Some("Tietiezhi Device Fabric".into()),
                tool_title: Some(format!("{device_id}/{capability}")),
            },
            invocation.cancellation.clone(),
        )
        .await
        {
            GuardianDecision::Allow => return Ok(()),
            GuardianDecision::Deny(reason) => return Err(ToolError::Handler(reason)),
            GuardianDecision::Abort => {
                return Err(ToolError::Handler(
                    "device capability approval cancelled".into(),
                ));
            }
            GuardianDecision::NotApplicable => {}
        }
        let waiting = self
            .manager
            .set_thread_status(
                &invocation.thread_id,
                json!({"type":"active","activeFlags":["waitingOnApproval"]}),
            )
            .map_err(|error| {
                ToolError::Handler(format!("set device approval status: {error:?}"))
            })?;
        emit_notifications(&self.app, &waiting).map_err(ToolError::Handler)?;
        let recipients = self
            .manager
            .thread_recipients(&invocation.thread_id)
            .map_err(|error| {
                ToolError::Handler(format!("resolve device approval recipients: {error:?}"))
            })?;
        let started_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64;
        let pending = state
            .codex_approval_requests
            .begin_command_execution(
                recipients,
                CommandExecutionApprovalParams {
                    thread_id: invocation.thread_id.clone(),
                    turn_id: invocation.turn_id.clone(),
                    item_id: invocation.call.call_id.clone(),
                    approval_id: None,
                    command: Some(format!("device://{device_id}/{capability}")),
                    cwd: Some(self.cwd.to_string_lossy().into_owned()),
                    command_actions: None,
                    environment_id: Some(format!("device:{device_id}")),
                    network_approval_context: Some(json!({
                        "host":device_id,
                        "protocol":"device"
                    })),
                    proposed_execpolicy_amendment: None,
                    proposed_network_policy_amendments: None,
                    reason: Some(format!(
                        "Allow device capability {capability} on {device_id}"
                    )),
                    started_at_ms,
                },
            )
            .map_err(|error| ToolError::Handler(error.to_string()))?;
        let request_id = pending.request.id.clone();
        emit_approval_server_request(&self.app, &pending.request).map_err(ToolError::Handler)?;
        let decision = tokio::select! {
            result = pending.receiver => result
                .map_err(|_| ToolError::Handler("device approval channel closed".into()))?
                .map_err(|error| ToolError::Handler(error.to_string()))?,
            () = invocation.cancellation.cancelled() => {
                let _ = state.codex_approval_requests.cancel(&request_id);
                CommandExecutionApprovalDecision::Cancel
            }
        };
        let active = self
            .manager
            .set_thread_status(
                &invocation.thread_id,
                json!({"type":"active","activeFlags":[]}),
            )
            .map_err(|error| {
                ToolError::Handler(format!("restore device approval status: {error:?}"))
            })?;
        emit_notifications(&self.app, &active).map_err(ToolError::Handler)?;
        match decision {
            CommandExecutionApprovalDecision::Accept => Ok(()),
            CommandExecutionApprovalDecision::AcceptForSession => {
                state
                    .codex_session_approvals
                    .approve_for(&invocation.thread_id, &[key])
                    .map_err(|error| ToolError::Handler(error.to_string()))?;
                Ok(())
            }
            CommandExecutionApprovalDecision::Decline => {
                Err(ToolError::Handler("device capability declined".into()))
            }
            CommandExecutionApprovalDecision::Cancel => {
                Err(ToolError::Handler("device capability cancelled".into()))
            }
            CommandExecutionApprovalDecision::AcceptWithExecpolicyAmendment { .. }
            | CommandExecutionApprovalDecision::ApplyNetworkPolicyAmendment { .. } => Err(
                ToolError::Handler("unsupported approval amendment for a device capability".into()),
            ),
        }
    }
}

fn device_app_tool_spec(tool: &AppToolDefinition) -> ToolSpec {
    let name = ToolName::namespaced(DEVICE_TOOL_NAMESPACE, tool.name.clone());
    let mut spec = ToolSpec::function(name, tool.description.clone(), tool.input_schema.clone());
    spec.output_schema.clone_from(&tool.output_schema);
    spec.namespace_description = Some(
        "Discover and invoke Tietiezhi Device Fabric capabilities through the Codex Apps lifecycle."
            .into(),
    );
    // App inputs are dynamic by design. In particular, `invoke.input`
    // intentionally accepts capability-specific fields, so advertising it as
    // a strict function would make the Responses API reject the entire request
    // before the model runs.
    spec.strict = false;
    spec
}

impl ToolHandler for DeviceAppToolHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::namespaced(DEVICE_TOOL_NAMESPACE, self.tool.name.clone())
    }

    fn spec(&self) -> ToolSpec {
        device_app_tool_spec(&self.tool)
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        self.tool.name == DEVICE_LIST_TOOL_NAME
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            let started = std::time::Instant::now();
            let arguments = Self::arguments(&invocation)?;
            let output = match self.tool.name.as_str() {
                DEVICE_LIST_TOOL_NAME => serde_json::to_value(
                    super::devices::list_connected_devices_inner(
                        &self.app,
                        &self.app.state::<AppState>().http,
                    )
                    .await
                    .map_err(ToolError::Handler)?,
                )
                .map_err(|error| ToolError::Handler(error.to_string()))?,
                DEVICE_TOOL_NAME => {
                    let device_id = arguments
                        .get("device_id")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| ToolError::InvalidCall("device_id is required".into()))?;
                    let capability = arguments
                        .get("capability")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| ToolError::InvalidCall("capability is required".into()))?;
                    let input = arguments.get("input").cloned().unwrap_or_else(|| json!({}));
                    let devices = super::devices::list_connected_devices_inner(
                        &self.app,
                        &self.app.state::<AppState>().http,
                    )
                    .await
                    .map_err(ToolError::Handler)?;
                    let device = devices
                        .iter()
                        .find(|device| device.id == device_id)
                        .ok_or_else(|| {
                            ToolError::InvalidCall(format!("unknown device id: {device_id}"))
                        })?;
                    if !device.capabilities.iter().any(|item| item == capability) {
                        return Err(ToolError::InvalidCall(format!(
                            "device {device_id} does not advertise capability {capability}"
                        )));
                    }
                    self.approve_device_call(&invocation, device_id, capability, &input)
                        .await?;
                    serde_json::to_value(
                        super::devices::invoke_device_inner(
                            &self.app,
                            &self.app.state::<AppState>().http,
                            device_id,
                            capability,
                            input,
                        )
                        .await
                        .map_err(ToolError::Handler)?,
                    )
                    .map_err(|error| ToolError::Handler(error.to_string()))?
                }
                _ => {
                    return Err(ToolError::InvalidCall(format!(
                        "unknown app tool: {}",
                        self.tool.name
                    )));
                }
            };
            let success = output.get("ok").and_then(Value::as_bool).unwrap_or(true);
            let content = serde_json::to_string_pretty(&output)
                .map_err(|error| ToolError::Handler(error.to_string()))?;
            Ok(ToolOutput {
                content: output,
                success,
                metadata: Some(json!({
                    "kind":"dynamicToolCall",
                    "item":{
                        "type":"dynamicToolCall",
                        "id":invocation.call.call_id,
                        "namespace":DEVICE_TOOL_NAMESPACE,
                        "tool":self.tool.name,
                        "arguments":arguments,
                        "status":if success {"completed"} else {"failed"},
                        "contentItems":[{"type":"inputText","text":content}],
                        "success":success,
                        "durationMs":started.elapsed().as_millis().min(u64::MAX as u128) as u64
                    }
                })),
            })
        })
    }
}

#[derive(Clone)]
struct MemoryToolHandler {
    runtime: MemoryRuntime,
    name: &'static str,
}

impl MemoryToolHandler {
    fn handler(runtime: MemoryRuntime, name: &'static str) -> Arc<dyn ToolHandler> {
        Arc::new(Self { runtime, name })
    }

    fn arguments(invocation: &ToolInvocation) -> Result<Value, ToolError> {
        let ToolPayload::Function { arguments } = &invocation.call.payload else {
            return Err(ToolError::InvalidCall(
                "memory tools require function arguments".into(),
            ));
        };
        if arguments.trim().is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(arguments)
            .map_err(|error| ToolError::InvalidCall(format!("invalid memory arguments: {error}")))
    }
}

impl ToolHandler for MemoryToolHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::namespaced("memories", self.name)
    }

    fn spec(&self) -> ToolSpec {
        let (description, properties, required) = match self.name {
            "list" => (
                "List entries in the managed memory folder.",
                json!({
                    "path":{"type":["string","null"]},
                    "cursor":{"type":["string","null"]},
                    "max_results":{"type":["integer","null"],"minimum":1,"maximum":2000}
                }),
                json!([]),
            ),
            "read" => (
                "Read a bounded line range from one managed memory file.",
                json!({
                    "path":{"type":"string"},
                    "line_offset":{"type":["integer","null"],"minimum":1},
                    "max_lines":{"type":["integer","null"],"minimum":1},
                    "max_tokens":{"type":["integer","null"],"minimum":1}
                }),
                json!(["path"]),
            ),
            "search" => (
                "Search managed memory files and return line-numbered evidence.",
                json!({
                    "queries":{"type":"array","minItems":1,"items":{"type":"string"}},
                    "path":{"type":["string","null"]},
                    "cursor":{"type":["string","null"]},
                    "match_mode":{"oneOf":[
                        {"type":"object","additionalProperties":false,"properties":{"type":{"const":"any"}},"required":["type"]},
                        {"type":"object","additionalProperties":false,"properties":{"type":{"const":"all_on_same_line"}},"required":["type"]},
                        {"type":"object","additionalProperties":false,"properties":{"type":{"const":"all_within_lines"},"line_count":{"type":"integer","minimum":1}},"required":["type","line_count"]}
                    ]},
                    "context_lines":{"type":["integer","null"],"minimum":0},
                    "case_sensitive":{"type":["boolean","null"]},
                    "normalized":{"type":["boolean","null"]},
                    "max_results":{"type":["integer","null"],"minimum":1,"maximum":200}
                }),
                json!(["queries"]),
            ),
            "add_ad_hoc_note" => (
                "Add one immutable memory update note only after an explicit user request.",
                json!({"filename":{"type":"string"},"note":{"type":"string"}}),
                json!(["filename", "note"]),
            ),
            _ => ("Unknown memory tool.", json!({}), json!([])),
        };
        let mut spec = ToolSpec::function(
            self.tool_name(),
            description,
            json!({
                "type":"object",
                "additionalProperties":false,
                "properties":properties,
                "required":required
            }),
        );
        spec.namespace_description =
            Some("Read and update the source-native Codex memory workspace.".into());
        spec
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        self.name != "add_ad_hoc_note"
    }

    fn handle(&self, invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            let arguments = Self::arguments(&invocation)?;
            let output = match self.name {
                "list" => {
                    let page = self
                        .runtime
                        .list(
                            arguments.get("path").and_then(Value::as_str),
                            arguments.get("cursor").and_then(Value::as_str),
                            arguments
                                .get("max_results")
                                .and_then(Value::as_u64)
                                .and_then(|value| usize::try_from(value).ok())
                                .unwrap_or(tietiezhi_agent_memory::DEFAULT_LIST_MAX_RESULTS),
                        )
                        .map_err(|error| ToolError::Handler(error.to_string()))?;
                    json!({
                        "path":arguments.get("path").cloned().unwrap_or(Value::Null),
                        "entries":page.data,
                        "next_cursor":page.next_cursor,
                        "truncated":page.truncated
                    })
                }
                "read" => self
                    .runtime
                    .read(
                        arguments
                            .get("path")
                            .and_then(Value::as_str)
                            .ok_or_else(|| ToolError::InvalidCall("path is required".into()))?,
                        arguments
                            .get("line_offset")
                            .and_then(Value::as_u64)
                            .and_then(|value| usize::try_from(value).ok())
                            .unwrap_or(1),
                        arguments
                            .get("max_lines")
                            .and_then(Value::as_u64)
                            .and_then(|value| usize::try_from(value).ok()),
                        arguments
                            .get("max_tokens")
                            .and_then(Value::as_u64)
                            .and_then(|value| usize::try_from(value).ok())
                            .unwrap_or(tietiezhi_agent_memory::DEFAULT_READ_MAX_TOKENS),
                    )
                    .map_err(|error| ToolError::Handler(error.to_string()))?,
                "search" => {
                    let queries = arguments
                        .get("queries")
                        .and_then(Value::as_array)
                        .ok_or_else(|| ToolError::InvalidCall("queries are required".into()))?
                        .iter()
                        .map(|query| {
                            query.as_str().map(str::to_owned).ok_or_else(|| {
                                ToolError::InvalidCall("queries must contain strings".into())
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let mode = match arguments
                        .pointer("/match_mode/type")
                        .and_then(Value::as_str)
                        .unwrap_or("any")
                    {
                        "any" => SearchMatchMode::Any,
                        "all_on_same_line" => SearchMatchMode::AllOnSameLine,
                        "all_within_lines" => SearchMatchMode::AllWithinLines {
                            line_count: arguments
                                .pointer("/match_mode/line_count")
                                .and_then(Value::as_u64)
                                .and_then(|value| usize::try_from(value).ok())
                                .unwrap_or(1),
                        },
                        other => {
                            return Err(ToolError::InvalidCall(format!(
                                "unknown match_mode `{other}`"
                            )))
                        }
                    };
                    self.runtime
                        .search(
                            queries,
                            mode,
                            arguments.get("path").and_then(Value::as_str),
                            arguments.get("cursor").and_then(Value::as_str),
                            arguments
                                .get("context_lines")
                                .and_then(Value::as_u64)
                                .and_then(|value| usize::try_from(value).ok())
                                .unwrap_or(2),
                            arguments
                                .get("case_sensitive")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            arguments
                                .get("normalized")
                                .and_then(Value::as_bool)
                                .unwrap_or(true),
                            arguments
                                .get("max_results")
                                .and_then(Value::as_u64)
                                .and_then(|value| usize::try_from(value).ok())
                                .unwrap_or(tietiezhi_agent_memory::DEFAULT_SEARCH_MAX_RESULTS),
                        )
                        .map_err(|error| ToolError::Handler(error.to_string()))?
                }
                "add_ad_hoc_note" => {
                    let filename = arguments
                        .get("filename")
                        .and_then(Value::as_str)
                        .ok_or_else(|| ToolError::InvalidCall("filename is required".into()))?;
                    let note = arguments
                        .get("note")
                        .and_then(Value::as_str)
                        .ok_or_else(|| ToolError::InvalidCall("note is required".into()))?;
                    self.runtime
                        .add_ad_hoc_note(filename, note)
                        .map_err(|error| ToolError::Handler(error.to_string()))?;
                    json!({})
                }
                other => return Err(ToolError::Unknown(format!("memories.{other}"))),
            };
            Ok(ToolOutput::success(output))
        })
    }
}

async fn turn_tool_runtime(
    app: &AppHandle,
    manager: &ThreadManager,
    snapshot: &TurnExecutionSnapshot,
) -> Result<(ToolCallRuntime, Vec<Value>), ModelError> {
    let context_manager = manager.clone();
    let mut handlers = vec![
        current_time_handler(),
        sleep_handler(),
        context_remaining_handler(Arc::new(move |thread_id, turn_id| {
            context_manager
                .context_tokens_remaining(thread_id, turn_id)
                .ok()
                .flatten()
        })),
        web_search_handler(),
        update_plan_handler(),
    ];
    let memory_config = memories_config(app);
    if snapshot.memory_mode == "enabled"
        && memory_config.use_memories
        && memory_config.dedicated_tools
    {
        let runtime =
            memory_runtime(app, &app.state::<AppState>()).map_err(ModelError::Consumer)?;
        handlers.extend(
            ["add_ad_hoc_note", "list", "read", "search"]
                .into_iter()
                .map(|name| MemoryToolHandler::handler(runtime.clone(), name)),
        );
    }
    if snapshot.review.is_none() {
        let approval_policy =
            serde_json::from_value::<AskForApproval>(snapshot.approval_policy.clone())
                .unwrap_or_default();
        handlers.extend(DeviceAppToolHandler::handlers(
            app.clone(),
            manager.clone(),
            snapshot.cwd.clone(),
            approval_policy,
        ));
        let collaboration =
            collaboration_runtime(app, &app.state::<AppState>()).map_err(ModelError::Consumer)?;
        ensure_collaboration_agent(
            app,
            manager,
            &collaboration,
            &snapshot.thread_id,
            &snapshot.cwd,
        )?;
        handlers.extend(
            CollaborationTools::new(
                collaboration,
                Arc::new(DesktopCollaborationHost {
                    app: app.clone(),
                    manager: manager.clone(),
                }),
            )
            .handlers(),
        );
    }
    let user_input_app = app.clone();
    let user_input_manager = manager.clone();
    handlers.push(request_user_input_handler(Arc::new(
        move |request: UserInputRequest| {
            let app = user_input_app.clone();
            let manager = user_input_manager.clone();
            Box::pin(async move {
                if manager
                    .collaboration_identity(&request.thread_id)
                    .map_err(|error| {
                        tietiezhi_agent_tools::ToolError::Handler(format!("{error:?}"))
                    })?
                    .parent_thread_id
                    .is_some()
                {
                    return Err(tietiezhi_agent_tools::ToolError::InvalidCall(
                        "request_user_input is not available to subagents".into(),
                    ));
                }
                let waiting = manager
                    .set_thread_status(
                        &request.thread_id,
                        json!({"type":"active","activeFlags":["waitingOnUserInput"]}),
                    )
                    .map_err(|error| {
                        tietiezhi_agent_tools::ToolError::Handler(format!(
                            "set user input status: {error:?}"
                        ))
                    })?;
                emit_notifications(&app, &waiting)
                    .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                let state = app.state::<AppState>();
                let recipients = manager
                    .thread_recipients(&request.thread_id)
                    .map_err(|error| {
                        tietiezhi_agent_tools::ToolError::Handler(format!(
                            "resolve user input recipients: {error:?}"
                        ))
                    })?;
                let pending = state
                    .codex_approval_requests
                    .begin_user_input(
                        recipients,
                        UserInputRequestParams {
                            thread_id: request.thread_id.clone(),
                            turn_id: request.turn_id.clone(),
                            item_id: request.item_id,
                            questions: request.questions,
                            auto_resolution_ms: request.auto_resolution_ms,
                        },
                    )
                    .map_err(|error| {
                        tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                    })?;
                let request_id = pending.request.id.clone();
                emit_approval_server_request(&app, &pending.request)
                    .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                let response = if let Some(timeout_ms) = request.auto_resolution_ms {
                    tokio::select! {
                        result = pending.receiver => result
                            .map_err(|_| tietiezhi_agent_tools::ToolError::Handler(
                                "user input response channel closed".into()
                            ))?
                            .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string())),
                        () = request.cancellation.cancelled() => {
                            let _ = state.codex_approval_requests.cancel(&request_id);
                            Err(tietiezhi_agent_tools::ToolError::Handler(
                                "user input request cancelled".into()
                            ))
                        },
                        () = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
                            let _ = state.codex_approval_requests.cancel(&request_id);
                            Ok(json!({"answers":{}}))
                        }
                    }
                } else {
                    tokio::select! {
                        result = pending.receiver => result
                            .map_err(|_| tietiezhi_agent_tools::ToolError::Handler(
                                "user input response channel closed".into()
                            ))?
                            .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string())),
                        () = request.cancellation.cancelled() => {
                            let _ = state.codex_approval_requests.cancel(&request_id);
                            Err(tietiezhi_agent_tools::ToolError::Handler(
                                "user input request cancelled".into()
                            ))
                        }
                    }
                };
                let active = manager
                    .set_thread_status(
                        &request.thread_id,
                        json!({"type":"active","activeFlags":[]}),
                    )
                    .map_err(|error| {
                        tietiezhi_agent_tools::ToolError::Handler(format!(
                            "restore active status: {error:?}"
                        ))
                    })?;
                emit_notifications(&app, &active)
                    .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                response
            }) as tietiezhi_agent_tools::builtins::UserInputFuture
        },
    )));
    let settings = super::settings::read_settings(app).map_err(ModelError::Consumer)?;
    let supports_images = settings
        .providers
        .iter()
        .find(|provider| provider.id == snapshot.model_provider)
        .and_then(|provider| {
            provider
                .models
                .iter()
                .find(|model| model.id == snapshot.model)
        })
        .is_some_and(|model| {
            model
                .input_modalities
                .contains(&super::models::ModelModality::Image)
        });
    if supports_images {
        handlers.push(view_image_handler(
            snapshot.cwd.clone(),
            supports_original_image_detail(&snapshot.model),
        ));
    }
    let approval_policy = if snapshot.review.is_some() {
        AskForApproval::Never
    } else {
        serde_json::from_value::<AskForApproval>(snapshot.approval_policy.clone())
            .unwrap_or_default()
    };
    let mcp_manager = app.state::<AppState>().mcp.clone();
    mcp_manager
        .set_elicitation_allowed(
            snapshot.thread_id.clone(),
            approval_policy.allows(ApprovalCategory::McpElicitation),
        )
        .map_err(ModelError::Consumer)?;
    // macOS uses R15 Seatbelt and Windows uses the R16 Restricted Token/ACL wrapper.
    let sandbox_policy =
        tietiezhi_agent_sandbox::SandboxPolicy::from_value(snapshot.sandbox.clone())
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
    if approval_policy.allows(ApprovalCategory::RequestPermissions) {
        let permissions_app = app.clone();
        let permissions_manager = manager.clone();
        let permissions_requirement = category_approval_requirement(
            approval_policy,
            ApprovalCategory::RequestPermissions,
            "request additional permissions",
        );
        handlers.push(request_permissions_handler(
            snapshot.cwd.clone(),
            Arc::new(move |request: PermissionsApprovalRequest| {
                let app = permissions_app.clone();
                let manager = permissions_manager.clone();
                let requirement = permissions_requirement.clone();
                Box::pin(async move {
                    if let ApprovalRequirement::Forbidden { reason } = requirement {
                        return Err(tietiezhi_agent_tools::ToolError::Handler(reason));
                    }
                    let wire_permissions = permission_profile_to_v2(request.permissions.clone());
                    let key = ApprovalKey::Permissions {
                        environment_id: request.environment_id.clone(),
                        cwd: request.cwd.clone(),
                        permissions: wire_permissions.clone(),
                    };
                    let state = app.state::<AppState>();
                    if state
                        .codex_session_approvals
                        .contains_all_for(&request.thread_id, std::slice::from_ref(&key))
                    {
                        return Ok(tietiezhi_agent_approval::PermissionsApprovalResponse {
                            permissions: request.permissions,
                            scope: "session".into(),
                            strict_auto_review: None,
                        });
                    }
                    match run_permission_hooks(
                        &app,
                        &manager,
                        &request.thread_id,
                        &request.turn_id,
                        request.cwd.clone().into(),
                        "request_permissions",
                        json!({
                            "tool_name":"request_permissions",
                            "permissions":wire_permissions,
                            "reason":request.reason
                        }),
                    )
                    .await?
                    {
                        Some(HookPermissionDecision::Allow) => {
                            return Ok(tietiezhi_agent_approval::PermissionsApprovalResponse {
                                permissions: request.permissions,
                                scope: "turn".into(),
                                strict_auto_review: None,
                            });
                        }
                        Some(HookPermissionDecision::Deny(reason)) => {
                            return Err(tietiezhi_agent_tools::ToolError::Handler(reason));
                        }
                        None => {}
                    }
                    match run_guardian_review(
                        &app,
                        &manager,
                        &request.thread_id,
                        &request.turn_id,
                        Some(&request.item_id),
                        GuardianAction::RequestPermissions {
                            reason: request.reason.clone(),
                            permissions: wire_permissions.clone(),
                        },
                        request.cancellation.clone(),
                    )
                    .await
                    {
                        GuardianDecision::Allow => {
                            return Ok(tietiezhi_agent_approval::PermissionsApprovalResponse {
                                permissions: request.permissions,
                                scope: "turn".into(),
                                strict_auto_review: Some(false),
                            });
                        }
                        GuardianDecision::Deny(_) => {
                            return Ok(tietiezhi_agent_approval::PermissionsApprovalResponse {
                                permissions: json!({}),
                                scope: "turn".into(),
                                strict_auto_review: Some(false),
                            });
                        }
                        GuardianDecision::Abort => {
                            return Err(tietiezhi_agent_tools::ToolError::Handler(
                                "permissions approval cancelled".into(),
                            ));
                        }
                        GuardianDecision::NotApplicable => {}
                    }
                    let waiting = manager
                        .set_thread_status(
                            &request.thread_id,
                            json!({"type":"active","activeFlags":["waitingOnApproval"]}),
                        )
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(format!(
                                "set permissions approval status: {error:?}"
                            ))
                        })?;
                    emit_notifications(&app, &waiting)
                        .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                    let recipients =
                        manager
                            .thread_recipients(&request.thread_id)
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(format!(
                                    "resolve permissions approval recipients: {error:?}"
                                ))
                            })?;
                    let started_at_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis()
                        .min(i64::MAX as u128) as i64;
                    let pending = state
                        .codex_approval_requests
                        .begin_permissions(
                            recipients,
                            PermissionsApprovalParams {
                                thread_id: request.thread_id.clone(),
                                turn_id: request.turn_id.clone(),
                                item_id: request.item_id,
                                environment_id: Some(request.environment_id),
                                cwd: request.cwd,
                                reason: request.reason,
                                permissions: wire_permissions,
                                started_at_ms,
                            },
                        )
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                        })?;
                    let request_id = pending.request.id.clone();
                    emit_approval_server_request(&app, &pending.request)
                        .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                    let mut response = tokio::select! {
                        result = pending.receiver => result
                            .map_err(|_| tietiezhi_agent_tools::ToolError::Handler(
                                "permissions approval channel closed".into()
                            ))?
                            .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))?,
                        () = request.cancellation.cancelled() => {
                            let _ = state.codex_approval_requests.cancel(&request_id);
                            return Err(tietiezhi_agent_tools::ToolError::Handler(
                                "permissions approval cancelled".into()
                            ));
                        }
                    };
                    if response.scope == "session" {
                        state
                            .codex_session_approvals
                            .approve_for(&request.thread_id, &[key])
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                            })?;
                    }
                    let active = manager
                        .set_thread_status(
                            &request.thread_id,
                            json!({"type":"active","activeFlags":[]}),
                        )
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(format!(
                                "restore active status: {error:?}"
                            ))
                        })?;
                    emit_notifications(&app, &active)
                        .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                    response.permissions = permission_profile_to_tool(response.permissions);
                    Ok(response)
                }) as tietiezhi_agent_tools::builtins::PermissionsApprovalFuture
            }),
        ));
    }
    let always_requires_patch_approval = approval_policy == AskForApproval::UnlessTrusted;
    let patch_escape_requirement = category_approval_requirement(
        approval_policy,
        ApprovalCategory::Sandbox,
        "apply patch outside writable sandbox roots",
    );
    let has_patch_approver = always_requires_patch_approval
        || matches!(
            patch_escape_requirement,
            ApprovalRequirement::NeedsApproval { .. }
        );
    let approval_app = app.clone();
    let approval_manager = manager.clone();
    let patch_requirement = patch_escape_requirement.clone();
    let patch_hook_cwd = snapshot.cwd.clone();
    handlers.push(
        apply_patch_handler(
            snapshot.cwd.clone(),
            sandbox_policy.clone(),
            always_requires_patch_approval,
            patch_escape_requirement,
            has_patch_approver.then(|| {
                Arc::new(move |request: FileChangeApprovalRequest| {
                    let app = approval_app.clone();
                    let manager = approval_manager.clone();
                    let requirement = patch_requirement.clone();
                    let hook_cwd = patch_hook_cwd.clone();
                    Box::pin(async move {
                        if let ApprovalRequirement::Forbidden { .. } = requirement {
                            return Ok(FileChangeApprovalDecision::Decline);
                        }
                        let keys = request
                            .files
                            .iter()
                            .map(|path| ApprovalKey::FileChange {
                                environment_id: request.environment_id.clone(),
                                path: path.clone(),
                            })
                            .collect::<Vec<_>>();
                        let state = app.state::<AppState>();
                        if state
                            .codex_session_approvals
                            .contains_all_for(&request.thread_id, &keys)
                        {
                            return Ok(FileChangeApprovalDecision::AcceptForSession);
                        }
                        match run_permission_hooks(
                            &app,
                            &manager,
                            &request.thread_id,
                            &request.turn_id,
                            hook_cwd.clone(),
                            "apply_patch",
                            json!({
                                "tool_name":"apply_patch",
                                "files":request.files,
                                "reason":request.reason
                            }),
                        )
                        .await?
                        {
                            Some(HookPermissionDecision::Allow) => {
                                return Ok(FileChangeApprovalDecision::Accept);
                            }
                            Some(HookPermissionDecision::Deny(_)) => {
                                return Ok(FileChangeApprovalDecision::Decline);
                            }
                            None => {}
                        }
                        match run_guardian_review(
                            &app,
                            &manager,
                            &request.thread_id,
                            &request.turn_id,
                            Some(&request.item_id),
                            GuardianAction::ApplyPatch {
                                cwd: hook_cwd.clone(),
                                files: request
                                    .files
                                    .iter()
                                    .map(std::path::PathBuf::from)
                                    .collect(),
                            },
                            request.cancellation.clone(),
                        )
                        .await
                        {
                            GuardianDecision::Allow => {
                                return Ok(FileChangeApprovalDecision::Accept);
                            }
                            GuardianDecision::Deny(_) => {
                                return Ok(FileChangeApprovalDecision::Decline);
                            }
                            GuardianDecision::Abort => {
                                return Ok(FileChangeApprovalDecision::Cancel);
                            }
                            GuardianDecision::NotApplicable => {}
                        }
                        let waiting = manager
                            .set_thread_status(
                                &request.thread_id,
                                json!({"type":"active","activeFlags":["waitingOnApproval"]}),
                            )
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(format!(
                                    "set approval status: {error:?}"
                                ))
                            })?;
                        emit_notifications(&app, &waiting)
                            .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                        let state = app.state::<AppState>();
                        let recipients = manager
                            .thread_recipients(&request.thread_id)
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(format!(
                                    "resolve approval recipients: {error:?}"
                                ))
                            })?;
                        let started_at_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis()
                            .min(i64::MAX as u128) as i64;
                        let pending = state
                            .codex_approval_requests
                            .begin_file_change(
                                recipients,
                                FileChangeApprovalParams {
                                    thread_id: request.thread_id.clone(),
                                    turn_id: request.turn_id.clone(),
                                    item_id: request.item_id.clone(),
                                    reason: request.reason,
                                    grant_root: request.grant_root,
                                    started_at_ms,
                                },
                            )
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                            })?;
                        let request_id = pending.request.id.clone();
                        emit_approval_server_request(&app, &pending.request)
                            .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                        let decision = tokio::select! {
                            result = pending.receiver => result
                                .map_err(|_| tietiezhi_agent_tools::ToolError::Handler(
                                    "file change approval channel closed".into()
                                ))?
                                .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))?,
                            () = request.cancellation.cancelled() => {
                                let _ = state.codex_approval_requests.cancel(&request_id);
                                FileChangeApprovalDecision::Cancel
                            }
                        };
                        if decision == FileChangeApprovalDecision::AcceptForSession {
                            state
                                .codex_session_approvals
                                .approve_for(&request.thread_id, &keys)
                                .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(
                                    error.to_string()
                                ))?;
                        }
                        let active = manager
                            .set_thread_status(
                                &request.thread_id,
                                json!({"type":"active","activeFlags":[]}),
                            )
                            .map_err(|error| {
                                tietiezhi_agent_tools::ToolError::Handler(format!(
                                    "restore active status: {error:?}"
                                ))
                            })?;
                        emit_notifications(&app, &active)
                            .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
                        Ok(decision)
                    })
                        as tietiezhi_agent_tools::builtins::FileChangeApprovalFuture
                }) as tietiezhi_agent_tools::builtins::FileChangeApprover
            }),
        )
        .map_err(|error| {
            ModelError::Consumer(format!("初始化 Codex apply_patch 失败：{error}"))
        })?,
    );
    let execpolicy_runtime = app.state::<AppState>().codex_execpolicy.clone();
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| ModelError::Consumer(format!("无法定位 ExecPolicy 配置目录：{error}")))?;
    let execpolicy_rules_path = app_data
        .join("agent-runtime")
        .join("rules")
        .join("default.rules");
    if execpolicy_rules_path.exists() {
        let loaded =
            tietiezhi_agent_execpolicy::ExecPolicyRuntime::load_files([&execpolicy_rules_path])
                .map_err(|error| ModelError::Consumer(format!("加载 ExecPolicy 失败：{error}")))?;
        execpolicy_runtime.merge(&loaded.policy());
    }
    let persisted_rules = persistent_approval_store(app, &app.state::<AppState>())
        .map_err(ModelError::Consumer)?
        .snapshot()
        .map_err(|error| ModelError::Consumer(error.to_string()))?;
    for rule in persisted_rules.rules {
        if let PersistentApprovalRule::ExecPolicy { amendment } = rule {
            execpolicy_runtime
                .add_allow_prefix(&amendment)
                .map_err(|error| ModelError::Consumer(error.to_string()))?;
        }
    }
    let runtime_approval_policy = match approval_policy {
        AskForApproval::UnlessTrusted => ExecApprovalPolicy::Untrusted,
        AskForApproval::OnRequest => ExecApprovalPolicy::OnRequest,
        AskForApproval::Never => ExecApprovalPolicy::Never,
        AskForApproval::Granular(config) => ExecApprovalPolicy::Granular {
            rules: config.rules,
            sandbox_approval: config.sandbox_approval,
        },
    };
    let policy_runtime = execpolicy_runtime.clone();
    let policy_evaluator = Arc::new(move |request: CommandPolicyRequest| {
        match policy_runtime.evaluate(
            &request.command,
            ExecEvaluationContext {
                approval_policy: runtime_approval_policy,
                sandbox_restricted: request.sandbox_restricted,
                requests_sandbox_override: request.requests_sandbox_override,
            },
        ) {
            RuntimeExecPolicyOutcome::Allow {
                bypass_sandbox,
                proposed_amendment,
            } => CommandPolicyOutcome::Allow {
                bypass_sandbox,
                proposed_amendment,
            },
            RuntimeExecPolicyOutcome::Prompt {
                reason,
                proposed_amendment,
            } => CommandPolicyOutcome::Prompt {
                reason,
                proposed_amendment,
            },
            RuntimeExecPolicyOutcome::Forbidden { reason } => {
                CommandPolicyOutcome::Forbidden { reason }
            }
        }
    }) as tietiezhi_agent_tools::builtins::CommandPolicyEvaluator;
    let command_approval_app = app.clone();
    let command_approval_manager = manager.clone();
    let command_execpolicy_runtime = execpolicy_runtime.clone();
    let command_execpolicy_rules_path = execpolicy_rules_path.clone();
    let command_approver = Some(Arc::new(move |request: CommandApprovalRequest| {
        let app = command_approval_app.clone();
        let manager = command_approval_manager.clone();
        let execpolicy_runtime = command_execpolicy_runtime.clone();
        let execpolicy_rules_path = command_execpolicy_rules_path.clone();
        Box::pin(async move {
            let keys = vec![ApprovalKey::Command {
                environment_id: request.environment_id.clone(),
                command: vec![request.command.clone()],
                cwd: request.cwd.clone(),
                tty: request.tty,
                sandbox_permissions: request.sandbox_permissions.clone(),
                additional_permissions: request.additional_permissions.clone(),
            }];
            let state = app.state::<AppState>();
            if state
                .codex_session_approvals
                .contains_all_for(&request.thread_id, &keys)
            {
                return Ok(CommandExecutionApprovalDecision::AcceptForSession);
            }
            match run_permission_hooks(
                &app,
                &manager,
                &request.thread_id,
                &request.turn_id,
                request.cwd.clone().into(),
                "exec_command",
                json!({
                    "tool_name":"exec_command",
                    "command":request.command,
                    "cwd":request.cwd,
                    "reason":request.reason
                }),
            )
            .await?
            {
                Some(HookPermissionDecision::Allow) => {
                    return Ok(CommandExecutionApprovalDecision::Accept);
                }
                Some(HookPermissionDecision::Deny(_)) => {
                    return Ok(CommandExecutionApprovalDecision::Decline);
                }
                None => {}
            }
            match run_guardian_review(
                &app,
                &manager,
                &request.thread_id,
                &request.turn_id,
                Some(&request.item_id),
                GuardianAction::Command {
                    source: GuardianCommandSource::UnifiedExec,
                    command: request.command.clone(),
                    cwd: request.cwd.clone().into(),
                },
                request.cancellation.clone(),
            )
            .await
            {
                GuardianDecision::Allow => {
                    return Ok(CommandExecutionApprovalDecision::Accept);
                }
                GuardianDecision::Deny(_) => {
                    return Ok(CommandExecutionApprovalDecision::Decline);
                }
                GuardianDecision::Abort => {
                    return Ok(CommandExecutionApprovalDecision::Cancel);
                }
                GuardianDecision::NotApplicable => {}
            }
            let waiting = manager
                .set_thread_status(
                    &request.thread_id,
                    json!({"type":"active","activeFlags":["waitingOnApproval"]}),
                )
                .map_err(|error| {
                    tietiezhi_agent_tools::ToolError::Handler(format!(
                        "set command approval status: {error:?}"
                    ))
                })?;
            emit_notifications(&app, &waiting)
                .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
            let state = app.state::<AppState>();
            let recipients = manager
                .thread_recipients(&request.thread_id)
                .map_err(|error| {
                    tietiezhi_agent_tools::ToolError::Handler(format!(
                        "resolve command approval recipients: {error:?}"
                    ))
                })?;
            let started_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(i64::MAX as u128) as i64;
            let pending = state
                .codex_approval_requests
                .begin_command_execution(
                    recipients,
                    CommandExecutionApprovalParams {
                        thread_id: request.thread_id.clone(),
                        turn_id: request.turn_id.clone(),
                        item_id: request.item_id.clone(),
                        approval_id: None,
                        command: Some(request.command),
                        cwd: Some(request.cwd),
                        command_actions: None,
                        environment_id: Some(request.environment_id.clone()),
                        network_approval_context: None,
                        proposed_execpolicy_amendment: request.prefix_rule.clone(),
                        proposed_network_policy_amendments: None,
                        reason: request.reason,
                        started_at_ms,
                    },
                )
                .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))?;
            let request_id = pending.request.id.clone();
            emit_approval_server_request(&app, &pending.request)
                .map_err(tietiezhi_agent_tools::ToolError::Handler)?;
            let decision = tokio::select! {
                result = pending.receiver => result
                    .map_err(|_| tietiezhi_agent_tools::ToolError::Handler(
                        "command approval channel closed".into()
                    ))?
                    .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))?,
                () = request.cancellation.cancelled() => {
                    let _ = state.codex_approval_requests.cancel(&request_id);
                    CommandExecutionApprovalDecision::Cancel
                }
            };
            if decision == CommandExecutionApprovalDecision::AcceptForSession {
                state
                    .codex_session_approvals
                    .approve_for(&request.thread_id, &keys)
                    .map_err(|error| {
                        tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                    })?;
            }
            match &decision {
                CommandExecutionApprovalDecision::AcceptWithExecpolicyAmendment {
                    execpolicy_amendment,
                } => {
                    execpolicy_runtime
                        .add_allow_prefix(execpolicy_amendment)
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                        })?;
                    tietiezhi_agent_execpolicy::blocking_append_allow_prefix_rule(
                        &execpolicy_rules_path,
                        execpolicy_amendment,
                    )
                    .map_err(|error| {
                        tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                    })?;
                    persistent_approval_store(&app, &state)
                        .map_err(tietiezhi_agent_tools::ToolError::Handler)?
                        .append(PersistentApprovalRule::ExecPolicy {
                            amendment: execpolicy_amendment.clone(),
                        })
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                        })?;
                }
                CommandExecutionApprovalDecision::ApplyNetworkPolicyAmendment {
                    network_policy_amendment,
                } => {
                    persistent_approval_store(&app, &state)
                        .map_err(tietiezhi_agent_tools::ToolError::Handler)?
                        .append(PersistentApprovalRule::NetworkPolicy {
                            amendment: network_policy_amendment.clone(),
                        })
                        .map_err(|error| {
                            tietiezhi_agent_tools::ToolError::Handler(error.to_string())
                        })?;
                }
                _ => {}
            }
            let active = manager
                .set_thread_status(
                    &request.thread_id,
                    json!({"type":"active","activeFlags":[]}),
                )
                .map_err(|error| {
                    tietiezhi_agent_tools::ToolError::Handler(format!(
                        "restore active status: {error:?}"
                    ))
                })?;
            emit_notifications(&app, &active).map_err(tietiezhi_agent_tools::ToolError::Handler)?;
            Ok(decision)
        }) as tietiezhi_agent_tools::builtins::CommandApprovalFuture
    }) as tietiezhi_agent_tools::builtins::CommandApprover);
    let observer_app = app.clone();
    let observer_manager = manager.clone();
    let observer = Arc::new(move |event: CommandRuntimeEvent| {
        let notifications = match event {
            CommandRuntimeEvent::Output {
                thread_id,
                turn_id,
                item_id,
                delta,
            } => observer_manager
                .command_execution_output_delta(&thread_id, &turn_id, &item_id, &delta),
            CommandRuntimeEvent::TerminalInteraction {
                thread_id,
                turn_id,
                item_id,
                process_id,
                stdin,
            } => observer_manager.command_execution_terminal_interaction(
                &thread_id,
                &turn_id,
                &item_id,
                &process_id,
                &stdin,
            ),
            CommandRuntimeEvent::Exited {
                thread_id,
                turn_id,
                item_id,
                command,
                cwd,
                process_id,
                result,
            } => {
                let mut aggregated_output = result.stdout;
                aggregated_output.push_str(&result.stderr);
                observer_manager.local_tool_item_completed(
                    &thread_id,
                    &turn_id,
                    json!({
                        "type":"commandExecution",
                        "id":item_id,
                        "command":command,
                        "cwd":cwd,
                        "processId":process_id,
                        "status":if result.exit_code == 0 { "completed" } else { "failed" },
                        "commandActions":[],
                        "aggregatedOutput":aggregated_output,
                        "exitCode":if result.timed_out { 124 } else { result.exit_code },
                        "durationMs":i64::try_from(result.wall_time_ms).unwrap_or(i64::MAX),
                        "source":"agent"
                    }),
                )
            }
        }
        .map_err(|error| {
            tietiezhi_agent_tools::ToolError::Handler(format!("project command event: {error:?}"))
        })?;
        emit_notifications(&observer_app, &notifications)
            .map_err(tietiezhi_agent_tools::ToolError::Handler)
    }) as tietiezhi_agent_tools::builtins::CommandObserver;
    let network_runtime = app.state::<AppState>().codex_network.clone();
    let network_app = app.clone();
    let network_manager = manager.clone();
    let network_hook_cwd = snapshot.cwd.clone();
    let network_prompts_allowed = approval_policy.allows(ApprovalCategory::Rule);
    let network_preparer = Arc::new(move |request: CommandNetworkRequest| {
        let runtime = network_runtime.clone();
        let app = network_app.clone();
        let manager = network_manager.clone();
        let hook_cwd = network_hook_cwd.clone();
        Box::pin(async move {
            let app_state = app.state::<AppState>();
            if let Ok(store) = persistent_approval_store(&app, &app_state) {
                let amendments = store
                    .snapshot()
                    .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))?
                    .rules
                    .into_iter()
                    .filter_map(|rule| match rule {
                        PersistentApprovalRule::NetworkPolicy { amendment } => {
                            parse_network_policy_amendment(&amendment)
                        }
                        PersistentApprovalRule::ExecPolicy { .. } => None,
                    });
                runtime.replace_persistent_rules(amendments);
            }
            let approval_app = app.clone();
            let approval_manager = manager.clone();
            let approval_runtime = runtime.clone();
            let approval_hook_cwd = hook_cwd.clone();
            let approver = Arc::new(
                move |network: tietiezhi_agent_network::NetworkApprovalRequest| {
                    let app = approval_app.clone();
                    let manager = approval_manager.clone();
                    let runtime = approval_runtime.clone();
                    let hook_cwd = approval_hook_cwd.clone();
                    Box::pin(async move {
                        if !network_prompts_allowed {
                            return NetworkApprovalDecision::Deny;
                        }
                        let protocol = network_protocol_label(network.protocol);
                        let key = ApprovalKey::Network {
                            scheme: protocol.into(),
                            host: network.host.clone(),
                            port: Some(network.port),
                            action: "connect".into(),
                        };
                        let state = app.state::<AppState>();
                        if state
                            .codex_session_approvals
                            .contains_all_for(&network.thread_id, std::slice::from_ref(&key))
                        {
                            return NetworkApprovalDecision::AllowOnce;
                        }
                        match run_permission_hooks(
                            &app,
                            &manager,
                            &network.thread_id,
                            &network.turn_id,
                            hook_cwd,
                            "network",
                            json!({
                                "tool_name":"network",
                                "command":network.command,
                                "host":network.host,
                                "port":network.port,
                                "protocol":protocol,
                                "reason":network.reason
                            }),
                        )
                        .await
                        {
                            Ok(Some(HookPermissionDecision::Allow)) => {
                                return NetworkApprovalDecision::AllowOnce;
                            }
                            Ok(Some(HookPermissionDecision::Deny(_))) | Err(_) => {
                                return NetworkApprovalDecision::Deny;
                            }
                            Ok(None) => {}
                        }
                        match run_guardian_review(
                            &app,
                            &manager,
                            &network.thread_id,
                            &network.turn_id,
                            None,
                            GuardianAction::NetworkAccess {
                                target: format!("{}:{}", network.host, network.port),
                                host: network.host.clone(),
                                protocol: protocol.into(),
                                port: network.port,
                            },
                            turn_cancellation_token(&app, &network.thread_id, &network.turn_id),
                        )
                        .await
                        {
                            GuardianDecision::Allow => {
                                return NetworkApprovalDecision::AllowOnce;
                            }
                            GuardianDecision::Deny(_) => return NetworkApprovalDecision::Deny,
                            GuardianDecision::Abort => return NetworkApprovalDecision::Cancel,
                            GuardianDecision::NotApplicable => {}
                        }
                        let recipients = match manager.thread_recipients(&network.thread_id) {
                            Ok(recipients) => recipients,
                            Err(_) => return NetworkApprovalDecision::Deny,
                        };
                        let started_at_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis()
                            .min(i64::MAX as u128)
                            as i64;
                        let pending = match state.codex_approval_requests.begin_command_execution(
                            recipients,
                            CommandExecutionApprovalParams {
                                thread_id: network.thread_id.clone(),
                                turn_id: network.turn_id.clone(),
                                item_id: network.item_id.clone(),
                                approval_id: None,
                                command: Some(network.command),
                                cwd: None,
                                command_actions: None,
                                environment_id: Some("local".into()),
                                network_approval_context: Some(json!({
                                    "host":network.host,
                                    "protocol":protocol
                                })),
                                proposed_execpolicy_amendment: None,
                                proposed_network_policy_amendments: Some(vec![
                                    json!({"host":network.host,"action":"allow"}),
                                    json!({"host":network.host,"action":"deny"}),
                                ]),
                                reason: Some(network.reason),
                                started_at_ms,
                            },
                        ) {
                            Ok(pending) => pending,
                            Err(_) => return NetworkApprovalDecision::Deny,
                        };
                        if emit_approval_server_request(&app, &pending.request).is_err() {
                            return NetworkApprovalDecision::Deny;
                        }
                        match pending.receiver.await {
                            Ok(Ok(CommandExecutionApprovalDecision::Accept)) => {
                                NetworkApprovalDecision::AllowOnce
                            }
                            Ok(Ok(CommandExecutionApprovalDecision::AcceptForSession)) => {
                                let _ = state
                                    .codex_session_approvals
                                    .approve_for(&network.thread_id, &[key]);
                                NetworkApprovalDecision::AllowOnce
                            }
                            Ok(Ok(
                                CommandExecutionApprovalDecision::ApplyNetworkPolicyAmendment {
                                    network_policy_amendment,
                                },
                            )) => {
                                let Some(amendment) =
                                    parse_network_policy_amendment(&network_policy_amendment)
                                else {
                                    return NetworkApprovalDecision::Deny;
                                };
                                if let Ok(store) = persistent_approval_store(&app, &state) {
                                    let _ = store.append(PersistentApprovalRule::NetworkPolicy {
                                        amendment: network_policy_amendment,
                                    });
                                }
                                runtime.apply_persistent_amendment(amendment.clone());
                                NetworkApprovalDecision::Apply(amendment)
                            }
                            Ok(Ok(CommandExecutionApprovalDecision::Cancel)) => {
                                NetworkApprovalDecision::Cancel
                            }
                            _ => NetworkApprovalDecision::Deny,
                        }
                    }) as tietiezhi_agent_network::NetworkApprovalFuture
                },
            ) as tietiezhi_agent_network::NetworkApprover;
            runtime
                .prepare_execution(NetworkExecutionRequest {
                    thread_id: request.thread_id,
                    turn_id: request.turn_id,
                    item_id: request.item_id,
                    command: request.command,
                    policy: NetworkPolicy {
                        enabled: true,
                        mode: NetworkMode::Full,
                        domains: Default::default(),
                        allow_local_binding: false,
                    },
                    approver: Some(approver),
                })
                .await
                .map_err(|error| tietiezhi_agent_tools::ToolError::Handler(error.to_string()))
        }) as tietiezhi_agent_tools::builtins::NetworkPreparationFuture
    }) as tietiezhi_agent_tools::builtins::NetworkPreparer;
    handlers.extend(unified_exec_handlers(
        app.state::<AppState>().codex_exec.clone(),
        snapshot.cwd.clone(),
        sandbox_policy,
        false,
        command_approver,
        observer,
        Some(network_preparer),
        Some(policy_evaluator),
    ));
    let app_state = app.state::<AppState>();
    if let Some(handler) = skills_runtime(app, &app_state)
        .map_err(ModelError::Consumer)?
        .handler(snapshot.cwd.clone())
        .map_err(ModelError::Consumer)?
    {
        handlers.push(handler);
    }
    let mut mcp_configs = settings
        .mcp_servers
        .iter()
        .filter(|config| config.enabled)
        .map(|config| {
            super::tietiezhi::resolve_mcp_config_secrets(app, config).map(|config| (config, None))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(ModelError::Consumer)?;
    mcp_configs.extend(
        plugin_mcp_configs(app, &app_state)
            .map_err(ModelError::Consumer)?
            .into_iter()
            .filter(|(config, _)| config.enabled)
            .map(|(config, plugin_id)| (config, Some(plugin_id))),
    );
    let mcp_plugin_ids = Arc::new(
        mcp_configs
            .iter()
            .filter_map(|(config, plugin_id)| {
                plugin_id
                    .as_ref()
                    .map(|plugin_id| (config.id.clone(), plugin_id.clone()))
            })
            .collect::<HashMap<_, _>>(),
    );
    let mcp_observer_app = app.clone();
    let mcp_observer_manager = manager.clone();
    let observer_plugin_ids = mcp_plugin_ids.clone();
    let mcp_observer = Arc::new(move |event: tietiezhi_agent_mcp::McpToolRuntimeEvent| {
        let (thread_id, notifications) = match event {
            tietiezhi_agent_mcp::McpToolRuntimeEvent::Started {
                context,
                server,
                tool,
                arguments,
            } => {
                let thread_id = context.thread_id.clone();
                let plugin_id = observer_plugin_ids.get(&server).cloned();
                let notifications = mcp_observer_manager.local_tool_item_started(
                    &context.thread_id,
                    &context.turn_id,
                    json!({
                        "type":"mcpToolCall",
                        "id":context.item_id,
                        "server":server,
                        "tool":tool,
                        "status":"inProgress",
                        "arguments":arguments,
                        "appContext":null,
                        "pluginId":plugin_id,
                        "result":null,
                        "error":null,
                        "durationMs":null
                    }),
                );
                (thread_id, notifications)
            }
            tietiezhi_agent_mcp::McpToolRuntimeEvent::Completed {
                context,
                server,
                tool,
                arguments,
                result,
                duration_ms,
            } => {
                let thread_id = context.thread_id.clone();
                let plugin_id = observer_plugin_ids.get(&server).cloned();
                let status = if result.is_error {
                    "failed"
                } else {
                    "completed"
                };
                let error = if result.is_error {
                    json!({"message":result.model_text()})
                } else {
                    Value::Null
                };
                let result_value = json!({
                    "content":result.content,
                    "structuredContent":result.structured_content,
                    "_meta":result.meta
                });
                let notifications = mcp_observer_manager.local_tool_item_completed(
                    &context.thread_id,
                    &context.turn_id,
                    json!({
                        "type":"mcpToolCall",
                        "id":context.item_id,
                        "server":server,
                        "tool":tool,
                        "status":status,
                        "arguments":arguments,
                        "appContext":null,
                        "pluginId":plugin_id,
                        "result":result_value,
                        "error":error,
                        "durationMs":i64::try_from(duration_ms).unwrap_or(i64::MAX)
                    }),
                );
                (thread_id, notifications)
            }
            tietiezhi_agent_mcp::McpToolRuntimeEvent::Failed {
                context,
                server,
                tool,
                arguments,
                error,
                duration_ms,
            } => {
                let thread_id = context.thread_id.clone();
                let plugin_id = observer_plugin_ids.get(&server).cloned();
                let notifications = mcp_observer_manager.local_tool_item_completed(
                    &context.thread_id,
                    &context.turn_id,
                    json!({
                        "type":"mcpToolCall",
                        "id":context.item_id,
                        "server":server,
                        "tool":tool,
                        "status":"failed",
                        "arguments":arguments,
                        "appContext":null,
                        "pluginId":plugin_id,
                        "result":null,
                        "error":{"message":error},
                        "durationMs":i64::try_from(duration_ms).unwrap_or(i64::MAX)
                    }),
                );
                (thread_id, notifications)
            }
        };
        let notifications = notifications.map_err(|error| {
            tietiezhi_agent_tools::ToolError::Handler(format!(
                "project MCP tool event for {thread_id}: {error:?}"
            ))
        })?;
        emit_notifications(&mcp_observer_app, &notifications)
            .map_err(tietiezhi_agent_tools::ToolError::Handler)
    }) as tietiezhi_agent_mcp::McpToolObserver;
    for (config, _) in mcp_configs {
        match mcp_manager.list_tools(&config).await {
            Ok(tools) => {
                handlers.extend(tools.into_iter().map(|info| {
                    tietiezhi_agent_mcp::McpToolHandler::new(
                        mcp_manager.clone(),
                        config.clone(),
                        info,
                        Some(mcp_observer.clone()),
                    ) as Arc<dyn tietiezhi_agent_tools::ToolHandler>
                }));
            }
            Err(error) if config.required => {
                return Err(ModelError::Consumer(format!(
                    "必需的 MCP 服务器 `{}` 启动失败：{error}",
                    config.id
                )));
            }
            Err(_) => {}
        }
    }
    let registry = ToolRegistry::new(handlers, Vec::new())
        .map_err(|error| ModelError::Consumer(format!("初始化 Codex 基础工具失败：{error}")))?;
    let router = Arc::new(ToolRouter::new(registry));
    let specs = router.model_visible_wire_specs();
    Ok((ToolCallRuntime::new(router), specs))
}

fn network_protocol_label(protocol: tietiezhi_agent_network::NetworkProtocol) -> &'static str {
    match protocol {
        tietiezhi_agent_network::NetworkProtocol::Http => "http",
        tietiezhi_agent_network::NetworkProtocol::HttpsConnect => "https",
        tietiezhi_agent_network::NetworkProtocol::Socks5Tcp => "socks5Tcp",
    }
}

fn parse_network_policy_amendment(value: &Value) -> Option<NetworkPolicyAmendment> {
    let host = value.get("host")?.as_str()?.trim();
    if host.is_empty() {
        return None;
    }
    let action = match value.get("action")?.as_str()? {
        "allow" => NetworkDomainPermission::Allow,
        "deny" => NetworkDomainPermission::Deny,
        _ => return None,
    };
    Some(NetworkPolicyAmendment {
        host: host.into(),
        action,
    })
}

fn dispatch_windows_sandbox(
    connection_id: &str,
    request: &Value,
    method: &str,
) -> Result<DispatchOutput, String> {
    if let Err(error) = serde_json::from_value::<JSONRPCRequest>(request.clone())
        .and_then(|_| serde_json::from_value::<ClientRequest>(request.clone()))
    {
        return Ok(dispatch_error(
            request,
            -32602,
            format!("{method} 参数不符合 App Server V2：{error}"),
        ));
    }
    match method {
        "windowsSandbox/readiness" => dispatch_success(
            request,
            json!({
                "status":tietiezhi_agent_sandbox::windows_sandbox_readiness()
            }),
        ),
        "windowsSandbox/setupStart" => {
            let mode = request
                .pointer("/params/mode")
                .and_then(Value::as_str)
                .unwrap_or("unelevated");
            #[cfg(not(test))]
            let setup_result = tietiezhi_agent_sandbox::setup_windows_sandbox(&[1080, 3128], false);
            #[cfg(test)]
            let setup_result: Result<(), tietiezhi_agent_sandbox::SandboxError> = if cfg!(windows) {
                Ok(())
            } else {
                Err(tietiezhi_agent_sandbox::SandboxError::UnsupportedPlatform)
            };
            let success = setup_result.is_ok();
            let setup_error = setup_result.err().map(|error| error.to_string());
            let cwd = request
                .pointer("/params/cwd")
                .and_then(Value::as_str)
                .map(std::path::PathBuf::from)
                .unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);
            let audit = tietiezhi_agent_sandbox::audit_windows_world_writable(
                &cwd,
                &std::env::vars().collect(),
            );
            let mut notifications = Vec::new();
            if !audit.paths.is_empty() || audit.failed_scan {
                let sample_paths = audit
                    .paths
                    .iter()
                    .take(20)
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                notifications.push(RoutedNotification {
                    recipients: vec![connection_id.into()],
                    method: "windows/worldWritableWarning".into(),
                    params: json!({
                        "samplePaths":sample_paths,
                        "extraCount":audit.paths.len().saturating_sub(20),
                        "failedScan":audit.failed_scan
                    }),
                });
            }
            notifications.push(RoutedNotification {
                recipients: vec![connection_id.into()],
                method: "windowsSandbox/setupCompleted".into(),
                params: json!({
                    "mode":mode,
                    "success":success,
                    "error":setup_error
                }),
            });
            for notification in &notifications {
                serde_json::from_value::<ServerNotification>(notification.wire_message())
                    .map_err(|error| format!("Windows sandbox setup notification 无效：{error}"))?;
            }
            let mut output = dispatch_success(request, json!({"started":true}))?;
            output.notifications = notifications;
            Ok(output)
        }
        _ => Ok(dispatch_error(request, -32601, "method not found")),
    }
}

fn permission_profile_to_v2(mut permissions: Value) -> Value {
    if let Some(object) = permissions.as_object_mut() {
        if let Some(file_system) = object.remove("file_system") {
            object.insert("fileSystem".into(), file_system);
        }
    }
    permissions
}

fn permission_profile_to_tool(mut permissions: Value) -> Value {
    if let Some(object) = permissions.as_object_mut() {
        if let Some(file_system) = object.remove("fileSystem") {
            object.insert("file_system".into(), file_system);
        }
    }
    permissions
}

fn merge_tool_specs(base: &[Value], loaded: &[Value]) -> Vec<Value> {
    let mut result = Vec::with_capacity(base.len() + loaded.len());
    let mut seen = std::collections::HashSet::new();
    for spec in base.iter().chain(loaded) {
        let key = serde_json::to_string(spec).unwrap_or_else(|_| spec.to_string());
        if seen.insert(key) {
            result.push(spec.clone());
        }
    }
    result
}

fn local_tool_timeline_item(snapshot: &TurnExecutionSnapshot, call: &ToolCall) -> Option<Value> {
    if call.tool_name.namespace.is_none() && call.tool_name.name == "apply_patch" {
        if let ToolPayload::Custom { input } = &call.payload {
            let plan = tietiezhi_agent_patch::PatchPlan::preview(&snapshot.cwd, input).ok()?;
            return Some(json!({
                "type":"fileChange",
                "id":call.call_id,
                "changes":plan.changes(),
                "status":"inProgress"
            }));
        }
    }
    let ToolPayload::Function { arguments } = &call.payload else {
        return None;
    };
    let arguments: Value = serde_json::from_str(arguments).ok()?;
    if let Some(tool) = collaboration_tool_name(&call.tool_name.name) {
        return Some(json!({
            "type":"collabAgentToolCall",
            "id":call.call_id,
            "tool":tool,
            "status":"inProgress",
            "senderThreadId":snapshot.thread_id,
            "receiverThreadIds":[],
            "prompt":arguments.get("message").and_then(Value::as_str),
            "model":arguments.get("model").and_then(Value::as_str),
            "reasoningEffort":arguments.get("reasoning_effort").and_then(Value::as_str),
            "agentsStates":{}
        }));
    }
    match (
        call.tool_name.namespace.as_deref(),
        call.tool_name.name.as_str(),
    ) {
        (None, "exec_command") => {
            let command = arguments.get("cmd")?.as_str()?;
            let workdir = arguments
                .get("workdir")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(std::path::PathBuf::from)
                .map_or_else(
                    || snapshot.cwd.clone(),
                    |path| {
                        if path.is_absolute() {
                            path
                        } else {
                            snapshot.cwd.join(path)
                        }
                    },
                );
            Some(json!({
                "type":"commandExecution",
                "id":call.call_id,
                "command":command,
                "cwd":workdir.to_string_lossy(),
                "processId":null,
                "status":"inProgress",
                "commandActions":[],
                "aggregatedOutput":null,
                "exitCode":null,
                "durationMs":null,
                "source":"agent"
            }))
        }
        (Some("clock"), "sleep") => {
            let duration_ms = arguments.get("duration_ms")?.as_u64()?;
            (duration_ms > 0 && duration_ms <= 12 * 60 * 60 * 1000).then(|| {
                json!({
                    "type":"sleep",
                    "id":call.call_id,
                    "durationMs":duration_ms
                })
            })
        }
        (Some(DEVICE_TOOL_NAMESPACE), tool) => Some(json!({
            "type":"dynamicToolCall",
            "id":call.call_id,
            "namespace":DEVICE_TOOL_NAMESPACE,
            "tool":tool,
            "arguments":arguments,
            "status":"inProgress",
            "contentItems":Value::Null,
            "success":Value::Null,
            "durationMs":Value::Null
        })),
        (None, "view_image") => {
            let path = std::path::PathBuf::from(arguments.get("path")?.as_str()?);
            let path = if path.is_absolute() {
                path
            } else {
                snapshot.cwd.join(path)
            };
            path.is_file().then(|| {
                json!({
                    "type":"imageView",
                    "id":call.call_id,
                    "path":path.to_string_lossy()
                })
            })
        }
        _ => None,
    }
}

fn collaboration_tool_name(name: &str) -> Option<&'static str> {
    match name {
        "spawn_agent" => Some("spawnAgent"),
        "send_message" => Some("sendInput"),
        "followup_task" => Some("resumeAgent"),
        "wait_agent" => Some("wait"),
        "interrupt_agent" => Some("closeAgent"),
        _ => None,
    }
}

fn collaboration_timeline_item(call: &ToolCall, metadata: &Value) -> Option<Value> {
    let collaboration = metadata.get("codexCollaboration")?;
    let tool = collaboration
        .get("tool")
        .and_then(Value::as_str)
        .or_else(|| collaboration_tool_name(&call.tool_name.name))?;
    let receiver_thread_ids = collaboration
        .get("receiverThreadIds")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let agents_states = collaboration
        .get("agentsStates")
        .cloned()
        .or_else(|| {
            collaboration
                .pointer("/activity/previousStatus")
                .filter(|status| !status.is_null())
                .and_then(|status| {
                    receiver_thread_ids
                        .as_array()
                        .and_then(|ids| ids.first())
                        .and_then(Value::as_str)
                        .map(|thread_id| {
                            Value::Object(serde_json::Map::from_iter([(
                                thread_id.into(),
                                status.clone(),
                            )]))
                        })
                })
        })
        .unwrap_or_else(|| json!({}));
    Some(json!({
        "type":"collabAgentToolCall",
        "id":call.call_id,
        "tool":tool,
        "status":"completed",
        "senderThreadId":collaboration
            .get("senderThreadId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "receiverThreadIds":receiver_thread_ids,
        "prompt":collaboration.get("prompt").cloned().unwrap_or(Value::Null),
        "model":Value::Null,
        "reasoningEffort":Value::Null,
        "agentsStates":agents_states
    }))
}

fn compaction_response_request(
    snapshot: &CompactionExecutionSnapshot,
    history: Vec<Value>,
) -> ResponsesApiRequest {
    let mut request = ResponsesApiRequest::text(
        snapshot.model.clone(),
        strip_internal_world_state_metadata(&history),
    );
    request.instructions = snapshot.base_instructions.clone().unwrap_or_default();
    request.reasoning = snapshot.reasoning_effort.as_ref().map(|effort| Reasoning {
        effort: Some(effort.clone()),
        summary: snapshot
            .reasoning_summary
            .as_ref()
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| Some("auto".into())),
        context: None,
    });
    request.service_tier.clone_from(&snapshot.service_tier);
    request.prompt_cache_key = Some(snapshot.thread_id.clone());
    request
}

fn assistant_response_text(item: &Value) -> Option<String> {
    if item.get("type").and_then(Value::as_str) != Some("message")
        || item.get("role").and_then(Value::as_str) != Some("assistant")
    {
        return None;
    }
    let text = item
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter(|content| {
            matches!(
                content.get("type").and_then(Value::as_str),
                Some("output_text" | "text")
            )
        })
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    Some(text)
}

#[derive(Debug)]
struct ResponseProjection {
    requested_model: String,
    model_context_window: Option<i64>,
    server_model: Option<String>,
    current_agent_item: Option<String>,
    current_reasoning_item: Option<String>,
    reroute_emitted: bool,
    verification_emitted: bool,
    needs_follow_up: bool,
    model_output_seen: bool,
    suppress_agent_messages: bool,
    captured_agent_text: Option<String>,
    tool_calls: Vec<ToolCall>,
    cwd: std::path::PathBuf,
    patch_inputs: HashMap<String, String>,
    patch_items_started: HashSet<String>,
    memory: Option<MemoryRuntime>,
    pollute_on_external_context: bool,
    memory_polluted: bool,
}

impl ResponseProjection {
    fn new(
        requested_model: String,
        model_context_window: Option<i64>,
        cwd: std::path::PathBuf,
    ) -> Self {
        Self {
            requested_model,
            model_context_window,
            server_model: None,
            current_agent_item: None,
            current_reasoning_item: None,
            reroute_emitted: false,
            verification_emitted: false,
            needs_follow_up: false,
            model_output_seen: false,
            suppress_agent_messages: false,
            captured_agent_text: None,
            tool_calls: Vec::new(),
            cwd,
            patch_inputs: HashMap::new(),
            patch_items_started: HashSet::new(),
            memory: None,
            pollute_on_external_context: false,
            memory_polluted: false,
        }
    }

    fn with_memory(mut self, memory: MemoryRuntime, pollute_on_external_context: bool) -> Self {
        self.memory = Some(memory);
        self.pollute_on_external_context = pollute_on_external_context;
        self
    }

    fn apply(
        &mut self,
        manager: &ThreadManager,
        thread_id: &str,
        turn_id: &str,
        event: ResponseEvent,
    ) -> Result<Vec<RoutedNotification>, ModelError> {
        match event {
            ResponseEvent::Created
            | ResponseEvent::ServerReasoningIncluded(_)
            | ResponseEvent::ModelsEtag(_) => Ok(Vec::new()),
            ResponseEvent::Retrying { error, .. } => manager
                .error_notification(thread_id, turn_id, error.as_turn_error(), true)
                .map_err(core_model_error),
            ResponseEvent::OutputItemAdded(item) => {
                self.model_output_seen = true;
                self.track_item(&item);
                if self.suppress_agent_messages && is_assistant_message(&item) {
                    return Ok(Vec::new());
                }
                manager
                    .model_item_started(thread_id, turn_id, item)
                    .map_err(core_model_error)
            }
            ResponseEvent::OutputItemDone(mut item) => {
                if self.pollute_on_external_context
                    && item.get("type").and_then(Value::as_str) == Some("web_search_call")
                {
                    if let Some(memory) = &self.memory {
                        mark_memory_polluted(manager, memory, thread_id)?;
                    }
                    self.memory_polluted = true;
                }
                self.project_memory_citation(&mut item)?;
                self.track_completed_item(&item)?;
                if self.suppress_agent_messages && is_assistant_message(&item) {
                    self.captured_agent_text = assistant_response_text(&item);
                    return Ok(Vec::new());
                }
                manager
                    .model_item_completed(thread_id, turn_id, item)
                    .map_err(core_model_error)
            }
            ResponseEvent::OutputTextDelta(delta) => {
                self.model_output_seen = true;
                if self.suppress_agent_messages {
                    return Ok(Vec::new());
                }
                let item_id = self.current_agent_item.as_deref().ok_or_else(|| {
                    ModelError::Consumer("text delta arrived before agent message item".into())
                })?;
                manager
                    .agent_message_delta(thread_id, turn_id, item_id, &delta)
                    .map_err(core_model_error)
            }
            ResponseEvent::ReasoningSummaryPartAdded { summary_index } => {
                self.model_output_seen = true;
                let item_id = self.reasoning_item()?;
                manager
                    .reasoning_summary_part_added(thread_id, turn_id, item_id, summary_index)
                    .map_err(core_model_error)
            }
            ResponseEvent::ReasoningSummaryDelta {
                delta,
                summary_index,
            } => {
                self.model_output_seen = true;
                let item_id = self.reasoning_item()?;
                manager
                    .reasoning_summary_delta(thread_id, turn_id, item_id, summary_index, &delta)
                    .map_err(core_model_error)
            }
            ResponseEvent::ReasoningSummaryDone {
                item_id,
                text,
                summary_index,
            } => {
                self.model_output_seen = true;
                manager
                    .reasoning_summary_done(thread_id, turn_id, &item_id, summary_index, &text)
                    .map_err(core_model_error)?;
                Ok(Vec::new())
            }
            ResponseEvent::ReasoningContentDelta {
                delta,
                content_index,
            } => {
                self.model_output_seen = true;
                let item_id = self.reasoning_item()?;
                manager
                    .reasoning_text_delta(thread_id, turn_id, item_id, content_index, &delta)
                    .map_err(core_model_error)
            }
            ResponseEvent::ToolCallInputDelta {
                item_id,
                call_id,
                delta,
            } => {
                self.model_output_seen = true;
                self.apply_patch_delta(
                    manager,
                    thread_id,
                    turn_id,
                    &item_id,
                    call_id.as_deref(),
                    &delta,
                )
            }
            ResponseEvent::ServerModel(model) => {
                if self.server_model.as_deref() == Some(model.as_str()) {
                    return Ok(Vec::new());
                }
                self.server_model = Some(model.clone());
                if model.eq_ignore_ascii_case(&self.requested_model) || self.reroute_emitted {
                    return Ok(Vec::new());
                }
                self.reroute_emitted = true;
                manager
                    .model_rerouted_notification(thread_id, turn_id, &self.requested_model, &model)
                    .map_err(core_model_error)
            }
            ResponseEvent::ModelVerifications(verifications) => {
                if self.verification_emitted {
                    return Ok(Vec::new());
                }
                self.verification_emitted = true;
                manager
                    .model_verification_notification(thread_id, turn_id, verifications)
                    .map_err(core_model_error)
            }
            ResponseEvent::TurnModerationMetadata(metadata) => manager
                .turn_moderation_metadata_notification(thread_id, turn_id, metadata)
                .map_err(core_model_error),
            ResponseEvent::SafetyBuffering(buffering) => manager
                .safety_buffering_notification(
                    thread_id,
                    turn_id,
                    &self.requested_model,
                    buffering.use_cases,
                    buffering.reasons,
                    buffering.show_buffering_ui,
                    buffering.faster_model,
                )
                .map_err(core_model_error),
            ResponseEvent::Completed {
                token_usage,
                end_turn,
                ..
            } => {
                self.needs_follow_up = end_turn == Some(false);
                let Some(last) = token_usage else {
                    return Ok(Vec::new());
                };
                manager
                    .record_token_usage(thread_id, turn_id, last, self.model_context_window)
                    .map_err(core_model_error)
            }
        }
    }

    fn track_item(&mut self, item: &Value) {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            return;
        };
        match item.get("type").and_then(Value::as_str) {
            Some("message") if item.get("role").and_then(Value::as_str) == Some("assistant") => {
                self.current_agent_item = Some(id.into());
            }
            Some("reasoning") => self.current_reasoning_item = Some(id.into()),
            _ => {}
        }
    }

    fn track_completed_item(&mut self, item: &Value) -> Result<(), ModelError> {
        self.model_output_seen = true;
        self.track_item(item);
        if let Some(call) = ToolRouter::build_tool_call(item)
            .map_err(|error| ModelError::Consumer(error.to_string()))?
        {
            self.tool_calls.push(call);
        }
        Ok(())
    }

    fn project_memory_citation(&self, item: &mut Value) -> Result<(), ModelError> {
        let Some(memory) = &self.memory else {
            return Ok(());
        };
        let Some(text) = assistant_response_text(item) else {
            return Ok(());
        };
        let (visible, citation) = strip_and_parse_memory_citation(&text);
        let Some(citation) = citation else {
            return Ok(());
        };
        let mut replaced = false;
        if let Some(content) = item.get_mut("content").and_then(Value::as_array_mut) {
            for part in content {
                if matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("output_text" | "text")
                ) {
                    part["text"] = if replaced {
                        json!("")
                    } else {
                        replaced = true;
                        json!(visible)
                    };
                }
            }
        }
        item["memory_citation"] = serde_json::to_value(&citation)
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
        memory
            .record_citation_usage(&citation)
            .map_err(|error| ModelError::Consumer(error.to_string()))?;
        Ok(())
    }

    fn apply_patch_delta(
        &mut self,
        manager: &ThreadManager,
        thread_id: &str,
        turn_id: &str,
        response_item_id: &str,
        call_id: Option<&str>,
        delta: &str,
    ) -> Result<Vec<RoutedNotification>, ModelError> {
        let input = self
            .patch_inputs
            .entry(response_item_id.to_owned())
            .or_default();
        input.push_str(delta);
        let Some(call_id) = call_id else {
            return Ok(Vec::new());
        };
        let Ok(plan) = tietiezhi_agent_patch::PatchPlan::preview(&self.cwd, input) else {
            return Ok(Vec::new());
        };
        let changes = serde_json::to_value(plan.changes())
            .map_err(|error| ModelError::Consumer(error.to_string()))?
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut notifications = Vec::new();
        if self.patch_items_started.insert(call_id.to_owned()) {
            notifications.extend(
                manager
                    .local_tool_item_started(
                        thread_id,
                        turn_id,
                        json!({
                            "type":"fileChange",
                            "id":call_id,
                            "changes":changes,
                            "status":"inProgress"
                        }),
                    )
                    .map_err(core_model_error)?,
            );
        }
        notifications.extend(
            manager
                .file_change_patch_updated(thread_id, turn_id, call_id, changes)
                .map_err(core_model_error)?,
        );
        Ok(notifications)
    }

    fn reasoning_item(&self) -> Result<&str, ModelError> {
        self.current_reasoning_item.as_deref().ok_or_else(|| {
            ModelError::Consumer("reasoning delta arrived before reasoning item".into())
        })
    }

    fn take_needs_follow_up(&mut self) -> bool {
        std::mem::take(&mut self.needs_follow_up)
    }

    fn take_tool_calls(&mut self) -> Vec<ToolCall> {
        std::mem::take(&mut self.tool_calls)
    }

    fn model_output_seen(&self) -> bool {
        self.model_output_seen
    }

    fn memory_polluted(&self) -> bool {
        self.memory_polluted
    }

    fn take_captured_agent_text(&mut self) -> Option<String> {
        self.captured_agent_text.take()
    }
}

fn is_assistant_message(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("message")
        && item.get("role").and_then(Value::as_str) == Some("assistant")
}

fn review_tool_allowed(spec: &Value) -> bool {
    let name = spec
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| spec.pointer("/function/name").and_then(Value::as_str))
        .or_else(|| spec.get("type").and_then(Value::as_str));
    !matches!(
        name,
        Some(
            "web_search"
                | "view_image"
                | "update_plan"
                | "spawn_agent"
                | "send_message"
                | "followup_task"
                | "wait_agent"
                | "interrupt_agent"
                | "list_agents"
        )
    )
}

fn core_model_error(error: tietiezhi_agent_core::RpcError) -> ModelError {
    ModelError::Consumer(format!("Codex Runtime 状态错误：{error:?}"))
}

fn mark_memory_polluted(
    manager: &ThreadManager,
    memory: &MemoryRuntime,
    thread_id: &str,
) -> Result<(), ModelError> {
    manager
        .mark_thread_memory_polluted(thread_id)
        .map_err(core_model_error)?;
    memory
        .mark_thread_polluted(thread_id)
        .map_err(|error| ModelError::Consumer(error.to_string()))?;
    Ok(())
}

fn fail_turn(
    app: &AppHandle,
    manager: &ThreadManager,
    thread_id: &str,
    turn_id: &str,
    error: ModelError,
) {
    if let Ok(notifications) =
        manager.error_notification(thread_id, turn_id, error.as_turn_error(), false)
    {
        let _ = emit_notifications(app, &notifications);
    }
    if let Ok(notifications) =
        manager.complete_turn(thread_id, turn_id, Some(error.as_turn_error()))
    {
        let _ = emit_notifications(app, &notifications);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        assistant_response_text, automation_thread_start_request, automation_turn_start_request,
        checked_external_import_notification, checked_external_session,
        collaboration_timeline_item, compaction_response_request, copy_tree_without_links,
        device_app_tool_spec, dispatch_windows_sandbox, empty_rate_limits, external_message_text,
        format_micro, gateway_quota_allows_memory_startup, gateway_rate_limits,
        local_tool_timeline_item, merge_tool_specs, nonempty_or_unconfigured, normalized_plan_type,
        parse_plugin_mcp_source, permission_profile_list, permission_profile_to_tool,
        permission_profile_to_v2, plugin_enablement_edits, resolve_runtime_reasoning_effort,
        response_request, review_tool_allowed, rewrite_external_terms,
        sanitize_collaboration_fork_history, workspace_thread_binding, write_atomic, ConfigPaths,
        ConfigRuntime, ExternalMigrationSource, PluginMcpSource, ResponseEvent, ResponseProjection,
        SkillsPaths, SkillsRuntime,
    };
    use crate::commands::gateway_auth::{
        GatewayOwnedPackage, GatewayPaymentChannels, GatewayQuotaView, GatewayWallet,
    };
    use serde_json::{json, Value};
    use tempfile::TempDir;
    use tietiezhi_agent_context::SUMMARIZATION_PROMPT;
    use tietiezhi_agent_core::{
        CompactionExecutionSnapshot, RuntimeDefaults, ThreadManager, TurnExecutionSnapshot,
    };
    use tietiezhi_agent_tools::{ToolCall, ToolPayload};

    #[test]
    fn workspace_thread_binding_reads_selected_project_and_mode() {
        let binding = workspace_thread_binding(&json!({
            "id":1,
            "method":"thread/start",
            "params":{
                "config":{
                    "tietiezhiTask":{
                        "projectId":" project-1 ",
                        "taskMode":"work",
                        "agentId":" agent-1 "
                    }
                }
            }
        }))
        .unwrap()
        .unwrap();
        assert_eq!(binding.project_id, "project-1");
        assert_eq!(
            binding.task_mode,
            crate::commands::workspace::TaskMode::Work
        );
        assert_eq!(binding.agent_id, "agent-1");
    }

    #[test]
    fn runtime_reasoning_honors_explicit_off_and_rejects_stale_max() {
        use crate::commands::models::{
            ReasoningEffort, ReasoningMode, ReasoningProfile, ReasoningTransport,
        };

        let profile = ReasoningProfile {
            mode: ReasoningMode::Effort,
            supported_efforts: vec![
                ReasoningEffort::Off,
                ReasoningEffort::Low,
                ReasoningEffort::High,
                ReasoningEffort::Xhigh,
            ],
            default_effort: Some(ReasoningEffort::High),
            transport: ReasoningTransport::OpenaiReasoningEffort,
            protocol_transports: Default::default(),
        };

        assert_eq!(
            resolve_runtime_reasoning_effort(&profile, ReasoningEffort::Off).as_deref(),
            Some("none")
        );
        assert_eq!(
            resolve_runtime_reasoning_effort(&profile, ReasoningEffort::Max).as_deref(),
            Some("high")
        );
    }

    #[test]
    fn device_app_dynamic_input_is_not_advertised_as_strict() {
        let invoke = tietiezhi_agent_apps::device_app()
            .tools
            .into_iter()
            .find(|tool| tool.name == tietiezhi_agent_apps::DEVICE_TOOL_NAME)
            .expect("device invoke tool");
        let wire = tietiezhi_agent_tools::wire_specs([device_app_tool_spec(&invoke)]);
        let invoke_wire = wire[0]["tools"]
            .as_array()
            .and_then(|tools| tools.iter().find(|tool| tool["name"] == "invoke"))
            .expect("namespaced invoke wire");

        assert_eq!(invoke_wire["strict"], false);
        assert_eq!(
            invoke_wire["parameters"]["properties"]["input"]["additionalProperties"],
            true
        );
    }

    #[test]
    fn external_agent_migration_rewrites_terms_and_extracts_text() {
        assert_eq!(
            rewrite_external_terms(
                "Claude Code reads CLAUDE.md".into(),
                ExternalMigrationSource::Claude
            ),
            "Codex reads AGENTS.md"
        );
        assert_eq!(
            external_message_text(&json!({
                "message":{"content":[{"type":"text","text":"first"},"second"]}
            }))
            .as_deref(),
            Some("first\nsecond")
        );
    }

    #[test]
    fn external_agent_migration_uses_atomic_files_and_bounded_sessions() {
        let temp = TempDir::new().unwrap();
        let source_root = temp.path().join("source");
        let target_root = temp.path().join("target");
        let projects = source_root.join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::write(projects.join("session.jsonl"), b"{\"type\":\"user\"}\n").unwrap();
        std::fs::write(source_root.join("regular.txt"), b"safe").unwrap();
        copy_tree_without_links(&source_root, &target_root).unwrap();
        assert_eq!(
            std::fs::read(target_root.join("regular.txt")).unwrap(),
            b"safe"
        );

        let checked = checked_external_session(
            &json!({"path":projects.join("session.jsonl")}),
            &std::fs::canonicalize(&projects).unwrap(),
        )
        .unwrap();
        assert!(checked["path"]
            .as_str()
            .is_some_and(|path| path.ends_with("session.jsonl")));

        let outside = temp.path().join("outside.jsonl");
        std::fs::write(&outside, b"{}\n").unwrap();
        assert!(checked_external_session(
            &json!({"path":outside}),
            &std::fs::canonicalize(&projects).unwrap()
        )
        .is_err());

        let atomic = temp.path().join("nested").join("history.json");
        write_atomic(&atomic, b"{\"ok\":true}").unwrap();
        assert_eq!(std::fs::read(&atomic).unwrap(), b"{\"ok\":true}");
        assert!(std::fs::read_dir(atomic.parent().unwrap())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
    }

    #[cfg(unix)]
    #[test]
    fn external_agent_migration_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(temp.path().join("secret"), b"secret").unwrap();
        symlink(temp.path().join("secret"), source.join("link")).unwrap();
        copy_tree_without_links(&source, &target).unwrap();
        assert!(!target.join("link").exists());
    }

    #[test]
    fn external_agent_import_notifications_match_app_server_v2() {
        for method in [
            "externalAgentConfig/import/progress",
            "externalAgentConfig/import/completed",
        ] {
            let notification = checked_external_import_notification(
                "desktop",
                method,
                json!({
                    "importId":"import-1",
                    "itemTypeResults":[{
                        "itemType":"CONFIG",
                        "successes":[],
                        "failures":[]
                    }]
                }),
            )
            .unwrap();
            assert_eq!(notification.recipients, ["desktop"]);
            assert_eq!(notification.method, method);
        }
        assert!(checked_external_import_notification(
            "desktop",
            "externalAgentConfig/import/progress",
            json!({"importId":"missing-results"})
        )
        .is_err());
    }

    #[test]
    fn empty_runtime_selection_is_explicitly_unconfigured() {
        assert_eq!(nonempty_or_unconfigured(String::new()), "unconfigured");
        assert_eq!(nonempty_or_unconfigured("  ".into()), "unconfigured");
        assert_eq!(nonempty_or_unconfigured("gpt-test".into()), "gpt-test");
    }

    #[test]
    fn config_runtime_results_match_app_server_v2_wire_types() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = ConfigRuntime::new(ConfigPaths {
            user_config: temp.path().join("config.toml"),
            system_config: temp.path().join("system.toml"),
            requirements: temp.path().join("requirements.toml"),
        });
        let write = runtime
            .dispatch(
                "config/value/write",
                &json!({
                    "keyPath":"model",
                    "value":"gpt-5.6-sol",
                    "mergeStrategy":"replace"
                }),
            )
            .unwrap();
        assert!(
            serde_json::from_value::<tietiezhi_agent_protocol::ConfigWriteResponse>(write.result)
                .is_ok()
        );
        let read = runtime.dispatch("config/read", &json!({})).unwrap();
        assert!(
            serde_json::from_value::<tietiezhi_agent_protocol::ConfigReadResponse>(read.result)
                .is_ok()
        );
        let requirements = runtime
            .dispatch("configRequirements/read", &json!({}))
            .unwrap();
        assert!(
            serde_json::from_value::<tietiezhi_agent_protocol::ConfigRequirementsReadResponse>(
                requirements.result
            )
            .is_ok()
        );
        let features = runtime
            .dispatch("experimentalFeature/list", &json!({}))
            .unwrap();
        assert!(
            serde_json::from_value::<tietiezhi_agent_protocol::ExperimentalFeatureListResponse>(
                features.result
            )
            .is_ok()
        );
        let enabled = runtime
            .dispatch(
                "experimentalFeature/enablement/set",
                &json!({"enablement":{"hooks":true}}),
            )
            .unwrap();
        assert!(serde_json::from_value::<
            tietiezhi_agent_protocol::ExperimentalFeatureEnablementSetResponse,
        >(enabled.result)
        .is_ok());
    }

    #[test]
    fn skills_runtime_results_match_app_server_v2_wire_types() {
        let temp = tempfile::tempdir().unwrap();
        let skill_dir = temp.path().join("skills/example");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: example\ndescription: Example skill\n---\nbody",
        )
        .unwrap();
        let runtime = SkillsRuntime::new(SkillsPaths {
            user_codex_root: temp.path().join("skills"),
            user_agents_root: temp.path().join("agents"),
            system_root: temp.path().join("system"),
            state_file: temp.path().join("skills-state.json"),
        });
        let list = runtime
            .dispatch("skills/list", &json!({}), temp.path())
            .unwrap();
        assert!(
            serde_json::from_value::<tietiezhi_agent_protocol::SkillsListResponse>(list.result)
                .is_ok()
        );
        let write = runtime
            .dispatch(
                "skills/config/write",
                &json!({"name":"example","enabled":false}),
                temp.path(),
            )
            .unwrap();
        assert!(
            serde_json::from_value::<tietiezhi_agent_protocol::SkillsConfigWriteResponse>(
                write.result
            )
            .is_ok()
        );
    }

    #[test]
    fn response_projection_tracks_turn_scoped_server_state() {
        let mut projection =
            ResponseProjection::new("gpt-requested".into(), Some(272_000), ".".into());
        assert_eq!(projection.requested_model, "gpt-requested");
        assert!(!projection.reroute_emitted);
        assert!(!projection.verification_emitted);
        assert!(!projection.model_output_seen());
        projection.needs_follow_up = true;
        assert!(projection.take_needs_follow_up());
        assert!(!projection.take_needs_follow_up());
        projection
            .track_completed_item(&json!({
                "type":"function_call",
                "id":"fc_1",
                "name":"sleep",
                "namespace":"clock",
                "arguments":"{\"duration_ms\":1}",
                "call_id":"call_1"
            }))
            .unwrap();
        let calls = projection.take_tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].tool_name.namespace.as_deref(), Some("clock"));
        assert_eq!(calls[0].tool_name.name, "sleep");
    }

    #[test]
    fn review_projection_hides_structured_message_and_keeps_review_text() {
        let temp = TempDir::new().unwrap();
        let manager = ThreadManager::open(
            temp.path().join("state"),
            temp.path().join("threads"),
            RuntimeDefaults::default(),
        )
        .unwrap();
        let mut projection = ResponseProjection::new("gpt-test".into(), None, ".".into());
        projection.suppress_agent_messages = true;
        let item = json!({
            "type":"message",
            "id":"msg_review",
            "role":"assistant",
            "content":[{
                "type":"output_text",
                "text":"{\"findings\":[],\"overall_correctness\":\"patch is correct\",\"overall_explanation\":\"No findings.\",\"overall_confidence_score\":0.9}"
            }]
        });
        assert!(projection
            .apply(
                &manager,
                "unused-thread",
                "unused-turn",
                ResponseEvent::OutputItemAdded(item.clone()),
            )
            .unwrap()
            .is_empty());
        assert!(projection
            .apply(
                &manager,
                "unused-thread",
                "unused-turn",
                ResponseEvent::OutputTextDelta("hidden".into()),
            )
            .unwrap()
            .is_empty());
        assert!(projection
            .apply(
                &manager,
                "unused-thread",
                "unused-turn",
                ResponseEvent::OutputItemDone(item),
            )
            .unwrap()
            .is_empty());
        assert!(projection
            .take_captured_agent_text()
            .unwrap()
            .contains("No findings."));
        assert!(review_tool_allowed(
            &json!({"type":"function","name":"exec_command"})
        ));
        assert!(!review_tool_allowed(
            &json!({"type":"function","name":"web_search"})
        ));
        assert!(!review_tool_allowed(
            &json!({"type":"function","name":"spawn_agent"})
        ));
    }

    #[test]
    fn collaboration_metadata_projects_protocol_exact_items() {
        let call = ToolCall {
            tool_name: tietiezhi_agent_tools::ToolName::plain("spawn_agent"),
            call_id: "call_spawn".into(),
            payload: ToolPayload::Function {
                arguments: r#"{"message":"inspect","task_name":"worker"}"#.into(),
            },
        };
        let item = collaboration_timeline_item(
            &call,
            &json!({
                "codexCollaboration":{
                    "tool":"spawnAgent",
                    "senderThreadId":"018f16f7-58ca-7f59-bb7f-6626b6630f6a",
                    "receiverThreadIds":["018f16f7-58ca-7f59-bb7f-6626b6630f6b"],
                    "prompt":"inspect",
                    "agentsStates":{
                        "018f16f7-58ca-7f59-bb7f-6626b6630f6b":{
                            "status":"running",
                            "message":null
                        }
                    }
                }
            }),
        )
        .unwrap();
        assert_eq!(item["type"], "collabAgentToolCall");
        assert_eq!(item["tool"], "spawnAgent");
        assert_eq!(item["status"], "completed");
        assert!(serde_json::from_value::<tietiezhi_agent_protocol::ThreadItem>(item).is_ok());
        let activity = json!({
            "type":"subAgentActivity",
            "id":"call_spawn",
            "kind":"started",
            "agentThreadId":"018f16f7-58ca-7f59-bb7f-6626b6630f6b",
            "agentPath":"/root/worker"
        });
        assert!(serde_json::from_value::<tietiezhi_agent_protocol::ThreadItem>(activity).is_ok());
    }

    #[test]
    fn collaboration_fork_drops_only_the_dangling_spawn_call() {
        let history = vec![
            json!({"type":"message","role":"user","content":[]}),
            json!({
                "type":"function_call",
                "name":"spawn_agent",
                "call_id":"old",
                "arguments":"{}"
            }),
            json!({
                "type":"function_call_output",
                "call_id":"old",
                "output":"{}"
            }),
            json!({
                "type":"function_call",
                "name":"spawn_agent",
                "call_id":"current",
                "arguments":"{}"
            }),
        ];

        let forked = sanitize_collaboration_fork_history(history);
        assert_eq!(forked.len(), 3);
        assert_eq!(forked[1]["call_id"], "old");
        assert_eq!(forked[2]["call_id"], "old");
    }

    #[test]
    fn streamed_apply_patch_input_publishes_file_change_preview() {
        let temp = TempDir::new().unwrap();
        let cwd = temp.path().join("workspace");
        std::fs::create_dir(&cwd).unwrap();
        let manager = ThreadManager::open(
            temp.path().join("state"),
            temp.path().join("threads"),
            RuntimeDefaults {
                model: "gpt-test".into(),
                model_provider: "test".into(),
                cwd: cwd.clone(),
                ..RuntimeDefaults::default()
            },
        )
        .unwrap();
        let started = manager.dispatch(
            "desktop",
            json!({"id":1,"method":"thread/start","params":{}}),
        );
        let thread_id = started.response["result"]["thread"]["id"].as_str().unwrap();
        let turn = manager.dispatch(
            "desktop",
            json!({
                "id":2,
                "method":"turn/start",
                "params":{
                    "threadId":thread_id,
                    "input":[{"type":"text","text":"edit","textElements":[]}]
                }
            }),
        );
        let turn_id = turn.response["result"]["turn"]["id"].as_str().unwrap();
        let mut projection = ResponseProjection::new("gpt-test".into(), None, cwd.clone());
        let notifications = projection
            .apply(
                &manager,
                thread_id,
                turn_id,
                ResponseEvent::ToolCallInputDelta {
                    item_id: "output_1".into(),
                    call_id: Some("call_patch".into()),
                    delta: "*** Begin Patch\n*** Add File: preview.txt\n+preview\n*** End Patch"
                        .into(),
                },
            )
            .unwrap();
        assert_eq!(
            notifications
                .iter()
                .map(|notification| notification.method.as_str())
                .collect::<Vec<_>>(),
            ["item/started", "item/fileChange/patchUpdated"]
        );
        assert_eq!(notifications[1].params["changes"][0]["path"], "preview.txt");
        assert!(!cwd.join("preview.txt").exists());
    }

    #[test]
    fn responses_request_includes_deduplicated_tool_specs() {
        let snapshot = TurnExecutionSnapshot {
            thread_id: "018f16f7-58ca-7f59-bb7f-6626b6630f6a".into(),
            turn_id: "018f16f7-58ca-7f59-bb7f-6626b6630f6b".into(),
            cwd: std::path::PathBuf::from("/tmp/project"),
            model: "gpt-5.6-sol".into(),
            model_provider: "gateway".into(),
            base_instructions: Some("base".into()),
            developer_instructions: Some("developer".into()),
            approval_policy: json!("on-request"),
            approvals_reviewer: "user".into(),
            sandbox: json!({"type":"workspaceWrite"}),
            reasoning_effort: Some("high".into()),
            reasoning_summary: None,
            service_tier: Some("priority".into()),
            history: vec![json!({
                "type":"message",
                "role":"user",
                "content":[],
                "_tietiezhiWorldState":{"turnId":"turn"}
            })],
            model_context_window: Some(272_000),
            active_context_tokens: 100,
            auto_compact_token_limit: None,
            review: None,
            memory_mode: "enabled".into(),
        };
        let base = vec![
            json!({"type":"function","name":"view_image"}),
            json!({"type":"web_search"}),
        ];
        let loaded = vec![
            json!({"type":"function","name":"view_image"}),
            json!({"type":"function","name":"deferred"}),
        ];
        let tools = merge_tool_specs(&base, &loaded);
        let request = response_request(&snapshot, None, tools.clone());
        assert_eq!(tools.len(), 3);
        assert_eq!(request.tools, Some(tools));
        assert_eq!(request.instructions, "base");
        assert!(request.input[0]
            .get(tietiezhi_agent_config::WORLD_STATE_METADATA_KEY)
            .is_none());
        assert!(request.parallel_tool_calls);
        let sleep = local_tool_timeline_item(
            &snapshot,
            &tietiezhi_agent_tools::ToolCall {
                tool_name: tietiezhi_agent_tools::ToolName::namespaced("clock", "sleep"),
                call_id: "call_sleep".into(),
                payload: tietiezhi_agent_tools::ToolPayload::Function {
                    arguments: "{\"duration_ms\":25}".into(),
                },
            },
        )
        .unwrap();
        assert_eq!(sleep["type"], "sleep");
        assert_eq!(sleep["durationMs"], 25);
        let command = local_tool_timeline_item(
            &snapshot,
            &tietiezhi_agent_tools::ToolCall {
                tool_name: tietiezhi_agent_tools::ToolName::plain("exec_command"),
                call_id: "call_exec".into(),
                payload: tietiezhi_agent_tools::ToolPayload::Function {
                    arguments: "{\"cmd\":\"printf ok\",\"workdir\":\"subdir\"}".into(),
                },
            },
        )
        .unwrap();
        assert_eq!(command["type"], "commandExecution");
        assert_eq!(command["status"], "inProgress");
        assert_eq!(command["command"], "printf ok");
        let device = local_tool_timeline_item(
            &snapshot,
            &tietiezhi_agent_tools::ToolCall {
                tool_name: tietiezhi_agent_tools::ToolName::namespaced(
                    tietiezhi_agent_apps::DEVICE_TOOL_NAMESPACE,
                    tietiezhi_agent_apps::DEVICE_TOOL_NAME,
                ),
                call_id: "call_device".into(),
                payload: tietiezhi_agent_tools::ToolPayload::Function {
                    arguments:
                        "{\"device_id\":\"local\",\"capability\":\"system.status\",\"input\":{}}"
                            .into(),
                },
            },
        )
        .unwrap();
        assert_eq!(device["type"], "dynamicToolCall");
        assert_eq!(device["status"], "inProgress");
        assert!(serde_json::from_value::<tietiezhi_agent_protocol::ThreadItem>(device).is_ok());
    }

    #[test]
    fn compaction_request_uses_private_summary_history_and_extracts_assistant_text() {
        let history = vec![
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"goal"}]}),
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":SUMMARIZATION_PROMPT.trim_end()}]}),
        ];
        let snapshot = CompactionExecutionSnapshot {
            thread_id: "018f16f7-58ca-7f59-bb7f-6626b6630f6a".into(),
            turn_id: "018f16f7-58ca-7f59-bb7f-6626b6630f6b".into(),
            item_id: "item-compact".into(),
            model: "gpt-5.6-sol".into(),
            model_provider: "gateway".into(),
            base_instructions: Some("base".into()),
            reasoning_effort: Some("high".into()),
            reasoning_summary: None,
            service_tier: Some("priority".into()),
            history: Vec::new(),
            automatic: true,
            model_context_window: Some(272_000),
        };
        let request = compaction_response_request(&snapshot, history.clone());
        assert_eq!(request.input, history);
        assert_eq!(request.instructions, "base");
        assert_eq!(
            request.prompt_cache_key.as_deref(),
            Some(snapshot.thread_id.as_str())
        );
        assert_eq!(request.service_tier.as_deref(), Some("priority"));
        assert_eq!(
            assistant_response_text(&json!({
                "type":"message",
                "role":"assistant",
                "content":[
                    {"type":"output_text","text":"first"},
                    {"type":"output_text","text":"second"}
                ]
            }))
            .as_deref(),
            Some("first\nsecond")
        );
        assert!(assistant_response_text(&json!({"type":"reasoning"})).is_none());
    }

    #[test]
    fn gateway_quota_maps_to_protocol_rate_limit_without_losing_micro_units() {
        let quota = GatewayQuotaView {
            wallet: GatewayWallet {
                balance_micro: 12_345_678,
                frozen_micro: 0,
                total_topup_micro: 0,
                total_spend_micro: 0,
            },
            packages: Vec::new(),
            recent_consumption: Vec::new(),
            payment_channels: GatewayPaymentChannels {
                alipay: true,
                wechat: false,
            },
        };
        let response = gateway_rate_limits(&quota);
        assert_eq!(response["rateLimits"]["credits"]["balance"], "12.345678");
        assert_eq!(response["rateLimits"]["credits"]["hasCredits"], true);
        assert_eq!(
            response["rateLimitsByLimitId"]["tietiezhi-gateway"],
            response["rateLimits"]
        );
        assert_eq!(format_micro(-1), "-0.000001");
        assert!(
            serde_json::from_value::<tietiezhi_agent_protocol::GetAccountRateLimitsResponse>(
                response
            )
            .is_ok()
        );
    }

    #[test]
    fn memory_startup_honors_the_codex_remaining_rate_limit_threshold() {
        let package = GatewayOwnedPackage {
            id: 1,
            name: "primary".into(),
            status: "active".into(),
            meter_by: "tokens".into(),
            quota_per_window: 10_000,
            total_quota_cap: 10_000,
            total_used: 7_600,
            window_remaining: 2_400,
            valid_until: None,
        };
        let quota = GatewayQuotaView {
            wallet: GatewayWallet {
                balance_micro: 1,
                frozen_micro: 0,
                total_topup_micro: 1,
                total_spend_micro: 0,
            },
            packages: vec![package.clone()],
            recent_consumption: Vec::new(),
            payment_channels: GatewayPaymentChannels {
                alipay: false,
                wechat: false,
            },
        };
        assert!(!gateway_quota_allows_memory_startup(&quota, 25));
        assert!(gateway_quota_allows_memory_startup(&quota, 24));

        let exhausted = GatewayQuotaView {
            wallet: GatewayWallet {
                balance_micro: 0,
                frozen_micro: 0,
                total_topup_micro: 0,
                total_spend_micro: 0,
            },
            packages: vec![GatewayOwnedPackage {
                window_remaining: 0,
                ..package
            }],
            recent_consumption: Vec::new(),
            payment_channels: GatewayPaymentChannels {
                alipay: false,
                wechat: false,
            },
        };
        assert!(!gateway_quota_allows_memory_startup(&exhausted, 0));
    }

    #[test]
    fn empty_limits_and_plan_types_stay_protocol_valid() {
        assert!(
            serde_json::from_value::<tietiezhi_agent_protocol::GetAccountRateLimitsResponse>(
                empty_rate_limits()
            )
            .is_ok()
        );
        assert_eq!(normalized_plan_type("team"), "team");
        assert_eq!(normalized_plan_type("future-plan"), "unknown");
    }

    #[test]
    fn unified_exec_requests_and_notifications_match_v2() {
        for request in [
            json!({"id":1,"method":"command/exec","params":{"command":["printf","ok"],"tty":false,"streamStdin":false,"streamStdoutStderr":false,"disableOutputCap":false,"disableTimeout":false}}),
            json!({"id":2,"method":"command/exec/write","params":{"processId":"p1","deltaBase64":"b2sK","closeStdin":false}}),
            json!({"id":3,"method":"command/exec/resize","params":{"processId":"p1","size":{"rows":24,"cols":80}}}),
            json!({"id":4,"method":"command/exec/terminate","params":{"processId":"p1"}}),
            json!({"id":5,"method":"thread/shellCommand","params":{"threadId":"01900000-0000-7000-8000-000000000001","command":"printf ok"}}),
        ] {
            assert!(
                serde_json::from_value::<tietiezhi_agent_protocol::ClientRequest>(request).is_ok()
            );
        }
        for notification in [
            json!({"method":"command/exec/outputDelta","params":{"processId":"p1","stream":"stdout","deltaBase64":"b2s=","capReached":false}}),
            json!({"method":"item/commandExecution/outputDelta","params":{"threadId":"01900000-0000-7000-8000-000000000001","turnId":"01900000-0000-7000-8000-000000000002","itemId":"exec_1","delta":"ok"}}),
            json!({"method":"item/commandExecution/terminalInteraction","params":{"threadId":"01900000-0000-7000-8000-000000000001","turnId":"01900000-0000-7000-8000-000000000002","itemId":"exec_1","processId":"1","stdin":"input\n"}}),
            json!({"method":"process/outputDelta","params":{"processHandle":"p1","stream":"stderr","deltaBase64":"ZXJy","capReached":false}}),
            json!({"method":"process/exited","params":{"processHandle":"p1","exitCode":0,"stdout":"","stdoutCapReached":false,"stderr":"","stderrCapReached":false}}),
        ] {
            assert!(
                serde_json::from_value::<tietiezhi_agent_protocol::ServerNotification>(
                    notification
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn permission_profile_catalog_matches_v2_pagination() {
        let first = permission_profile_list(&json!({
            "id":1,
            "method":"permissionProfile/list",
            "params":{"limit":2}
        }))
        .unwrap();
        assert_eq!(
            first.response["result"]["data"].as_array().unwrap().len(),
            2
        );
        assert_eq!(first.response["result"]["nextCursor"], "2");
        assert_eq!(first.response["result"]["data"][0]["id"], ":read-only");
        let second = permission_profile_list(&json!({
            "id":2,
            "method":"permissionProfile/list",
            "params":{"cursor":"2"}
        }))
        .unwrap();
        assert_eq!(
            second.response["result"]["data"][0]["id"],
            ":danger-full-access"
        );
        assert!(second.response["result"]["nextCursor"].is_null());
    }

    #[test]
    fn permission_profiles_convert_between_tool_and_v2_shapes() {
        let tool = json!({
            "file_system":{"read":["/tmp/input"]},
            "network":{"enabled":true}
        });
        let wire = permission_profile_to_v2(tool.clone());
        assert!(wire.get("fileSystem").is_some());
        assert!(wire.get("file_system").is_none());
        assert_eq!(permission_profile_to_tool(wire), tool);
    }

    #[test]
    fn plugin_mcp_sources_are_namespaced_and_keep_transport_policy() {
        let source = PluginMcpSource {
            plugin_id: "review@example".into(),
            path: None,
            inline: Some(json!({
                "review":{
                    "type":"stdio",
                    "command":"review-mcp",
                    "args":["--stdio"],
                    "required":true,
                    "enabledTools":["review"]
                },
                "docs":{
                    "url":"https://example.invalid/mcp",
                    "oauth":true
                }
            })),
        };
        let configs = parse_plugin_mcp_source(&source).unwrap();
        assert_eq!(configs.len(), 2);
        let review = configs
            .iter()
            .find(|config| config.name.ends_with(" / review"))
            .unwrap();
        assert!(review.id.starts_with("plugin_review_example_"));
        assert!(review.id.ends_with("_review_c97ace4c"));
        assert!(review.required);
        assert_eq!(review.enabled_tools, ["review"]);
        assert!(matches!(
            review.transport,
            crate::mcp::McpTransport::Stdio { .. }
        ));
        let docs = configs
            .iter()
            .find(|config| config.name.ends_with(" / docs"))
            .unwrap();
        assert!(matches!(
            docs.transport,
            crate::mcp::McpTransport::Http { oauth: true, .. }
        ));
        assert_eq!(
            plugin_enablement_edits(
                "config/value/write",
                &json!({
                    "keyPath":"plugins.review@example.enabled",
                    "value":false,
                    "mergeStrategy":"replace"
                })
            ),
            [("review@example".into(), false)]
        );
    }

    #[test]
    fn windows_sandbox_lifecycle_matches_v2() {
        let readiness = dispatch_windows_sandbox(
            "connection",
            &json!({
                "id":1,
                "method":"windowsSandbox/readiness",
                "params":{}
            }),
            "windowsSandbox/readiness",
        )
        .unwrap();
        assert_eq!(
            readiness.response["result"]["status"],
            if cfg!(windows) {
                tietiezhi_agent_sandbox::windows_sandbox_readiness()
            } else {
                "notConfigured"
            }
        );
        let setup = dispatch_windows_sandbox(
            "connection",
            &json!({
                "id":2,
                "method":"windowsSandbox/setupStart",
                "params":{"mode":"unelevated","cwd":null}
            }),
            "windowsSandbox/setupStart",
        )
        .unwrap();
        assert_eq!(setup.response["result"]["started"], true);
        let completed = setup
            .notifications
            .iter()
            .find(|notification| notification.method == "windowsSandbox/setupCompleted")
            .unwrap();
        assert_eq!(completed.recipients, ["connection"]);
    }

    #[test]
    fn automation_requests_are_unattended_v2_turns() {
        let cwd = std::path::Path::new("/tmp/automation-worktree");
        let thread = automation_thread_start_request("run-1", cwd);
        let turn = automation_turn_start_request(
            "run-1",
            "01900000-0000-7000-8000-000000000001",
            cwd,
            "execute".into(),
        );
        assert_eq!(thread["method"], "thread/start");
        assert_eq!(thread["params"]["approvalPolicy"], "never");
        assert_eq!(thread["params"]["sandbox"], "workspace-write");
        assert_eq!(thread["params"]["threadSource"], "automation");
        assert_eq!(turn["method"], "turn/start");
        assert_eq!(turn["params"]["approvalPolicy"], "never");
        assert_eq!(turn["params"]["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(
            turn["params"]["sandboxPolicy"]["networkAccess"],
            Value::Bool(false)
        );
        assert!(serde_json::from_value::<tietiezhi_agent_protocol::ClientRequest>(thread).is_ok());
        assert!(serde_json::from_value::<tietiezhi_agent_protocol::ClientRequest>(turn).is_ok());
    }
}
