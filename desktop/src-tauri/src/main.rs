// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if tietiezhi_agent_sandbox::run_windows_sandbox_wrapper_if_requested() {
        return;
    }
    tietiezhi_desktop_lib::run()
}
