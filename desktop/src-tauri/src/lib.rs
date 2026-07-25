mod agent;
mod automation;
mod commands;
mod mcp;
mod permission;
mod process;
mod secrets;
mod skills;
mod tools;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;
use tokio_util::sync::CancellationToken;

pub struct AppState {
    pub(crate) http: reqwest::Client,
    /// Cancellation tokens of in-flight chat streams, keyed by request id.
    pub(crate) chat_cancels: Mutex<HashMap<u32, CancellationToken>>,
    /// Cancellation tokens of in-flight media generation jobs.
    pub(crate) create_cancels: Mutex<HashMap<u32, CancellationToken>>,
    /// Routes tool-permission answers back to blocked agent loops.
    pub(crate) permissions: permission::PermissionBroker,
    /// App-global MCP server connections (lazy-started).
    pub(crate) mcp: mcp::McpManager,
    /// Reverse JSON-RPC requests initiated by MCP server elicitation.
    pub(crate) codex_mcp_requests: Arc<mcp::ElicitationBroker>,
    /// Persistent connections that expose this install as a device node to
    /// every configured remote Core.
    pub(crate) device_fabric: commands::devices::DeviceFabric,
    /// Lazily initialized source-native App Server V2 runtime.
    pub(crate) codex_core: Mutex<Option<tietiezhi_agent_core::ThreadManager>>,
    /// Root-scoped MultiAgentV2 graph, mailboxes, and activity stream.
    pub(crate) codex_collab: Mutex<Option<tietiezhi_agent_collab::CollaborationRuntime>>,
    /// In-flight Responses turns, keyed by source-native thread id.
    pub(crate) codex_cancels: Mutex<HashMap<String, (String, CancellationToken)>>,
    /// Input-activity signals used by steer-aware tools such as `clock.sleep`.
    pub(crate) codex_input_activity: Mutex<HashMap<String, (String, CancellationToken)>>,
    /// Session-local `/v1/responses` capability probes, keyed by provider id
    /// and normalized base URL.
    pub(crate) codex_wire_capabilities: Mutex<HashMap<String, bool>>,
    /// Source-native App Server V2 account state.
    pub(crate) codex_account: tietiezhi_agent_account::AccountRuntime,
    /// Source-native layered Skills catalog and runtime extra roots.
    pub(crate) codex_skills: Mutex<Option<tietiezhi_agent_skills::SkillsRuntime>>,
    /// Source-native Hook discovery, trust, and command lifecycle runtime.
    pub(crate) codex_hooks: Mutex<Option<tietiezhi_agent_hooks::HookEngine>>,
    /// Source-native plugin, marketplace, and activation runtime.
    pub(crate) codex_plugins: Mutex<Option<tietiezhi_agent_plugins::PluginRuntime>>,
    /// Active browser login callbacks, keyed by App Server login id.
    pub(crate) codex_login_cancels: Mutex<HashMap<String, CancellationToken>>,
    /// Reverse JSON-RPC requests sent by the runtime to the host client.
    pub(crate) codex_account_requests: tietiezhi_agent_account::AccountServerRequestBroker,
    /// Reverse JSON-RPC requests for command/file/network approval.
    pub(crate) codex_approval_requests: tietiezhi_agent_approval::ServerRequestBroker,
    /// Exact per-Thread approval cache. It is intentionally never persisted.
    pub(crate) codex_session_approvals: tietiezhi_agent_approval::SessionApprovalStore,
    /// Durable exec/network amendments; distinct from the session cache.
    pub(crate) codex_persistent_approvals:
        Mutex<Option<tietiezhi_agent_approval::PersistentApprovalStore>>,
    /// PTY and pipe sessions shared by App Server command methods and model tools.
    pub(crate) codex_exec: tietiezhi_agent_exec::ExecManager,
    /// User-visible terminal sessions grouped by Thread and backed by codex_exec.
    pub(crate) terminal_sessions: Mutex<HashMap<String, commands::terminal::TerminalRecord>>,
    /// Source-compatible Starlark command policy and safe-command classifier.
    pub(crate) codex_execpolicy: tietiezhi_agent_execpolicy::ExecPolicyRuntime,
    /// Shared, execution-attributed HTTP/SOCKS network sandbox proxy.
    pub(crate) codex_network: tietiezhi_agent_network::NetworkRuntime,
    /// Turn-scoped denial history for Codex Guardian auto-review.
    pub(crate) codex_guardian: Mutex<tietiezhi_agent_review::GuardianCircuitBreaker>,
    /// Source-native Chronicle, citation and memory pipeline state.
    pub(crate) codex_memory: Mutex<Option<tietiezhi_agent_memory::MemoryRuntime>>,
    /// Unstable externally supplied ChatGPT tokens are intentionally memory-only.
    pub(crate) codex_external_auth: Mutex<HashMap<String, commands::codex::ExternalAuthTokens>>,
    /// Connection-scoped desktop filesystem watch cancellation handles.
    pub(crate) codex_fs_watches: Mutex<HashMap<String, CancellationToken>>,
    /// Experimental fuzzy search session roots, scoped by App Server connection.
    pub(crate) codex_fuzzy_sessions: Mutex<HashMap<String, Vec<std::path::PathBuf>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("failed to build http client");

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // The one global dictation trigger; gesture resolution lives in
        // `commands::hotkey` (click = hands-free + polish, hold = push-to-talk).
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    commands::hotkey::on_hotkey_event(app, event.state());
                })
                .build(),
        )
        // Remember the main window's size/position across launches. The capsule
        // window manages its own placement (bottom-center), so exclude it.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["capsule"])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            http,
            chat_cancels: Mutex::new(HashMap::new()),
            create_cancels: Mutex::new(HashMap::new()),
            permissions: permission::PermissionBroker::default(),
            mcp: mcp::McpManager::default(),
            codex_mcp_requests: Arc::new(mcp::ElicitationBroker::default()),
            device_fabric: commands::devices::DeviceFabric::default(),
            codex_core: Mutex::new(None),
            codex_collab: Mutex::new(None),
            codex_cancels: Mutex::new(HashMap::new()),
            codex_input_activity: Mutex::new(HashMap::new()),
            codex_wire_capabilities: Mutex::new(HashMap::new()),
            codex_account: tietiezhi_agent_account::AccountRuntime::default(),
            codex_skills: Mutex::new(None),
            codex_hooks: Mutex::new(None),
            codex_plugins: Mutex::new(None),
            codex_login_cancels: Mutex::new(HashMap::new()),
            codex_account_requests: tietiezhi_agent_account::AccountServerRequestBroker::default(),
            codex_approval_requests: tietiezhi_agent_approval::ServerRequestBroker::default(),
            codex_session_approvals: tietiezhi_agent_approval::SessionApprovalStore::default(),
            codex_persistent_approvals: Mutex::new(None),
            codex_exec: tietiezhi_agent_exec::ExecManager::default(),
            terminal_sessions: Mutex::new(HashMap::new()),
            codex_execpolicy: tietiezhi_agent_execpolicy::ExecPolicyRuntime::default(),
            codex_network: tietiezhi_agent_network::NetworkRuntime::default(),
            codex_guardian: Mutex::new(tietiezhi_agent_review::GuardianCircuitBreaker::default()),
            codex_memory: Mutex::new(None),
            codex_external_auth: Mutex::new(HashMap::new()),
            codex_fs_watches: Mutex::new(HashMap::new()),
            codex_fuzzy_sessions: Mutex::new(HashMap::new()),
        })
        .manage(commands::hotkey::HotkeyState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            mcp::DesktopMcpHost::install(&handle)?;
            // Build the capsule up-front (hidden, non-focusing) so a hotkey press
            // shows it instantly, and bind the stored dictation trigger.
            if let Err(e) = commands::capsule::ensure_capsule(&handle) {
                eprintln!("[capsule] {e}");
            }
            commands::hotkey::apply_from_settings(&handle);
            let state = app.state::<AppState>();
            if let Err(error) = state.device_fabric.sync_from_store(&handle) {
                eprintln!("[device] {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::automations::list_automations,
            commands::automations::load_automation,
            commands::automations::create_automation,
            commands::automations::save_automation,
            commands::automations::validate_automation,
            commands::automations::archive_automation,
            commands::automations::delete_automation,
            commands::settings::load_settings,
            commands::settings::save_settings,
            commands::providers::list_providers,
            commands::providers::provider_key,
            commands::providers::upsert_provider,
            commands::providers::delete_provider,
            commands::providers::fetch_provider_models,
            commands::gateway_auth::gateway_account,
            commands::gateway_auth::gateway_login,
            commands::gateway_auth::gateway_logout,
            commands::gateway_auth::gateway_quota,
            commands::gateway_auth::gateway_package_catalog,
            commands::gateway_auth::gateway_create_package_order,
            commands::gateway_auth::gateway_package_order_status,
            commands::create::generate_create_image,
            commands::create::generate_create_video,
            commands::create::cancel_create_generation,
            commands::create::read_create_asset_data_url,
            commands::create::export_create_asset,
            commands::create::delete_create_asset,
            commands::chat::chat_stream,
            commands::chat::tietiezhi_stream,
            commands::codex::codex_v2_request,
            commands::codex::codex_v2_server_response,
            commands::tietiezhi::get_tietiezhi_config,
            commands::tietiezhi::save_tietiezhi_config,
            commands::tietiezhi::list_tietiezhi_files,
            commands::tietiezhi::list_tietiezhi_secrets,
            commands::tietiezhi::upsert_tietiezhi_secret,
            commands::tietiezhi::reveal_tietiezhi_secret,
            commands::tietiezhi::delete_tietiezhi_secret,
            commands::tietiezhi::read_tietiezhi_file,
            commands::tietiezhi::write_tietiezhi_file,
            commands::tietiezhi::delete_tietiezhi_file,
            commands::tietiezhi::tietiezhi_home_overview,
            commands::tietiezhi::reveal_tietiezhi_home,
            commands::tietiezhi::load_tietiezhi_timeline,
            commands::tietiezhi::save_tietiezhi_timeline,
            commands::chat::chat_cancel,
            commands::dictation::transcribe,
            commands::dictation::polish_stream,
            commands::dictation::default_polish_prompt,
            commands::devices::list_device_cores,
            commands::devices::add_device_core,
            commands::devices::remove_device_core,
            commands::devices::probe_device_core,
            commands::devices::list_connected_devices,
            commands::devices::invoke_device,
            commands::hotkey::dictation_reset,
            commands::hotkey::dictation_toggle,
            commands::hotkey::set_dictation_hotkey,
            commands::hotkey::dictation_hotkey,
            commands::text_insert::deliver_text,
            commands::text_insert::accessibility_trusted,
            commands::conversations::list_conversations,
            commands::conversations::list_archived_conversations,
            commands::conversations::load_conversation,
            commands::conversations::save_conversation,
            commands::conversations::archive_conversation,
            commands::conversations::restore_conversation,
            commands::conversations::set_conversation_pinned,
            commands::conversations::archive_project_conversations,
            commands::conversations::delete_conversation,
            commands::titles::generate_conversation_title,
            commands::projects::list_projects,
            commands::projects::add_project,
            commands::projects::touch_project,
            commands::projects::rename_project,
            commands::projects::reveal_project,
            commands::projects::project_recommendations,
            commands::projects::refresh_project_recommendations,
            commands::projects::mark_project_suggestion_used,
            commands::capsule::capsule_set_height,
            commands::capsule::hide_capsule,
            commands::capsule::show_capsule,
            commands::agents::list_agents,
            commands::agents::upsert_agent,
            commands::agents::delete_agent,
            commands::skills::list_skills,
            commands::skills::read_skill,
            commands::skills::upsert_skill,
            commands::skills::delete_skill,
            commands::skills::set_skill_enabled,
            commands::skills::import_skill,
            commands::workspace::pick_workspace_dir,
            commands::workspace::task_workspace_overview,
            commands::workspace::set_task_workspace_environment,
            commands::workspace::create_task_workspace_snapshot,
            commands::workspace::restore_task_workspace_snapshot,
            commands::workspace::handoff_task_workspace,
            commands::workspace::task_workspace_git_diff,
            commands::workspace::stage_task_workspace_paths,
            commands::workspace::unstage_task_workspace_paths,
            commands::workspace::discard_task_workspace_paths,
            commands::workspace::commit_task_workspace,
            commands::workspace::push_task_workspace,
            commands::workspace::task_workspace_pull_request_url,
            commands::workspace::transfer_task_workspace_file,
            commands::terminal::terminal_list,
            commands::terminal::terminal_start,
            commands::terminal::terminal_read,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_terminate,
            commands::terminal::terminal_close,
            commands::assets::pick_chat_files,
            commands::assets::pick_chat_folder,
            commands::assets::inspect_chat_asset_paths,
            commands::permissions::permission_respond,
            commands::permissions::default_system_prompt,
            commands::permissions::list_builtin_tools,
            commands::mcp::mcp_server_status,
            commands::mcp::mcp_restart_server,
            commands::mcp::mcp_stop_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
