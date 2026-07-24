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
    /// Persistent connections that expose this install as a device node to
    /// every configured remote Core.
    pub(crate) device_fabric: commands::devices::DeviceFabric,
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
            device_fabric: commands::devices::DeviceFabric::default(),
        })
        .manage(commands::hotkey::HotkeyState::default())
        .setup(|app| {
            let handle = app.handle().clone();
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
            commands::workspace::transfer_task_workspace_file,
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
