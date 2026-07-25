use serde_json::Value;
use tauri::AppHandle;

use crate::automation::{
    self, AutomationDocument, AutomationMeta, AutomationRun, AutomationValidationIssue,
};

#[tauri::command]
pub fn list_automations(
    app: AppHandle,
    include_archived: Option<bool>,
) -> Result<Vec<AutomationMeta>, String> {
    automation::store::list(&app, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn load_automation(app: AppHandle, id: String) -> Result<AutomationDocument, String> {
    automation::store::load(&app, &id)
}

#[tauri::command]
pub fn create_automation(
    app: AppHandle,
    name: Option<String>,
) -> Result<AutomationDocument, String> {
    automation::store::create(&app, name.as_deref().unwrap_or("未命名自动化"))
}

#[tauri::command]
pub fn save_automation(
    app: AppHandle,
    automation: AutomationDocument,
) -> Result<AutomationDocument, String> {
    automation::store::save(&app, automation)
}

#[tauri::command]
pub fn validate_automation(
    automation: AutomationDocument,
    publish: Option<bool>,
) -> Vec<AutomationValidationIssue> {
    automation::validate::validate(&automation, publish.unwrap_or(false))
}

#[tauri::command]
pub fn archive_automation(
    app: AppHandle,
    id: String,
    archived: bool,
) -> Result<AutomationMeta, String> {
    automation::store::archive(&app, &id, archived)
}

#[tauri::command]
pub fn delete_automation(app: AppHandle, id: String) -> Result<(), String> {
    automation::runtime::delete(&app, &id)
}

#[tauri::command]
pub fn publish_automation(app: AppHandle, id: String) -> Result<AutomationMeta, String> {
    automation::runtime::publish(&app, &id)
}

#[tauri::command]
pub fn pause_automation(
    app: AppHandle,
    id: String,
    paused: bool,
) -> Result<AutomationMeta, String> {
    automation::runtime::set_paused(&app, &id, paused)
}

#[tauri::command]
pub async fn run_automation(
    app: AppHandle,
    id: String,
    input: Option<Value>,
) -> Result<AutomationRun, String> {
    automation::runtime::start_run(
        &app,
        &id,
        "manual",
        input.unwrap_or_else(|| Value::Object(Default::default())),
    )
    .await
}

#[tauri::command]
pub fn list_automation_runs(
    app: AppHandle,
    automation_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<AutomationRun>, String> {
    automation::store::list_runs(&app, automation_id.as_deref(), limit.unwrap_or(100))
}

#[tauri::command]
pub fn cancel_automation_run(
    app: AppHandle,
    automation_id: String,
    run_id: String,
) -> Result<AutomationRun, String> {
    automation::runtime::cancel_run(&app, &automation_id, &run_id)
}
