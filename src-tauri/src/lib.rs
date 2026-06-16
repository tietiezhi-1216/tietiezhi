mod asr;
mod audio;
mod commands;
mod config;
mod dictation;
mod hotkey;
mod insert;
mod llm;
mod realtime;
mod state;
mod volcano;

use std::sync::Arc;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Load persisted configuration.
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let settings = config::load(&config_dir);
            let app_state = Arc::new(AppState::new(config_dir, settings));
            app.manage(app_state);

            // Hidden, transparent, always-on-top recording pill window.
            let _ = WebviewWindowBuilder::new(
                app,
                "pill",
                WebviewUrl::App("index.html?view=pill".into()),
            )
            .title("Orbit Recording")
            .inner_size(300.0, 64.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .focused(false)
            .build();

            // Start the global hotkey listener (needs Accessibility permission).
            hotkey::spawn(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::list_audio_inputs,
            commands::start_hotkey_capture,
            commands::cancel_hotkey_capture,
            commands::dictation_toggle,
            commands::dictation_cancel,
            commands::test_provider,
            commands::fetch_models,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
