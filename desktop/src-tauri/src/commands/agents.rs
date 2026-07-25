use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// A Trae-style agent profile: its own prompt, model, skills, MCP servers,
/// builtin tools, and permission mode. Empty lists mean "all enabled".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub model: String,
    pub model_provider_id: String,
    /// Empty follows the chat selection; otherwise an English effort value.
    pub reasoning_effort: String,
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub tools: Vec<String>,
    pub permission_mode: String,
}

impl Default for Agent {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            system_prompt: String::new(),
            model: String::new(),
            model_provider_id: String::new(),
            reasoning_effort: String::new(),
            skills: Vec::new(),
            mcp_servers: Vec::new(),
            tools: Vec::new(),
            permission_mode: "auto".into(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AgentsFile {
    #[serde(default)]
    agents: Vec<Agent>,
}

fn agents_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    Ok(dir.join("agents.json"))
}

fn read_agents(app: &AppHandle) -> Result<Vec<Agent>, String> {
    let path = agents_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取智能体失败：{e}"))?;
    let file: AgentsFile =
        serde_json::from_str(&raw).map_err(|e| format!("智能体文件损坏：{e}"))?;
    Ok(file.agents)
}

fn write_agents(app: &AppHandle, agents: &[Agent]) -> Result<(), String> {
    let path = agents_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let file = AgentsFile {
        agents: agents.to_vec(),
    };
    let raw = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("写入智能体失败：{e}"))
}

#[tauri::command]
pub fn list_agents(app: AppHandle) -> Result<Vec<Agent>, String> {
    read_agents(&app)
}

#[tauri::command]
pub fn upsert_agent(app: AppHandle, agent: Agent) -> Result<(), String> {
    if agent.id.trim().is_empty() || agent.name.trim().is_empty() {
        return Err("智能体需要 id 和名称".into());
    }
    let mut agents = read_agents(&app)?;
    match agents.iter_mut().find(|a| a.id == agent.id) {
        Some(slot) => *slot = agent,
        None => agents.push(agent),
    }
    write_agents(&app, &agents)
}

#[tauri::command]
pub fn delete_agent(app: AppHandle, id: String) -> Result<(), String> {
    let mut agents = read_agents(&app)?;
    agents.retain(|a| a.id != id);
    write_agents(&app, &agents)
}
