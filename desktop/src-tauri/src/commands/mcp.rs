use tauri::{AppHandle, State};

use crate::mcp::McpServerStatus;
use crate::AppState;

/// Status snapshot of all configured MCP servers (running/stopped/error).
#[tauri::command]
pub async fn mcp_server_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<McpServerStatus>, String> {
    let settings = super::settings::read_settings(&app)?;
    Ok(state.mcp.status(&settings.mcp_servers).await)
}

/// Drop and (lazily) reconnect one server. Also used after editing its config.
#[tauri::command]
pub async fn mcp_restart_server(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.mcp.stop(&id).await;
    let settings = super::settings::read_settings(&app)?;
    if let Some(cfg) = settings
        .mcp_servers
        .iter()
        .find(|c| c.id == id && c.enabled)
    {
        let resolved = super::tietiezhi::resolve_mcp_config_secrets(&app, cfg)?;
        state.mcp.ensure_started(&resolved).await?;
    }
    Ok(())
}

/// Stop one server's connection (e.g. when disabling it).
#[tauri::command]
pub async fn mcp_stop_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.mcp.stop(&id).await;
    Ok(())
}
