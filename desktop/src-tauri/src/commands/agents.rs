use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::workspace::TaskMode;
use crate::agent::loop_::AgentEnv;
use crate::agent::prompt;
use crate::permission::PermissionMode;
use crate::skills;

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

pub(crate) fn find_agent(app: &AppHandle, id: &str) -> Option<Agent> {
    read_agents(app).ok()?.into_iter().find(|a| a.id == id)
}

/// The agent's model override, if it sets one.
/// The provider id stays empty for legacy profiles, so callers can retain the
/// provider selected by the chat while still honoring the model override.
pub(crate) fn model_override(app: &AppHandle, agent_id: Option<&str>) -> Option<(String, String)> {
    let agent = find_agent(app, agent_id?)?;
    (!agent.model.trim().is_empty()).then(|| (agent.model_provider_id, agent.model))
}

pub(crate) fn reasoning_effort_override(app: &AppHandle, agent_id: Option<&str>) -> Option<String> {
    let agent = find_agent(app, agent_id?)?;
    (!agent.reasoning_effort.trim().is_empty()).then(|| agent.reasoning_effort)
}

/// Resolve the full execution environment for a chat turn.
pub(crate) fn resolve_env(
    app: &AppHandle,
    agent_id: Option<&str>,
    project_id: Option<&str>,
    conversation_id: Option<&str>,
    task_mode: TaskMode,
) -> Result<AgentEnv, String> {
    let settings = super::settings::read_settings(app)?;
    let agent = agent_id.and_then(|id| find_agent(app, id));
    let configured_tools = agent
        .as_ref()
        .map(|agent| agent.tools.clone())
        .unwrap_or_default();
    let allowed_tools = task_mode.filter_builtin_tools(&configured_tools);

    let workspace =
        super::workspace::resolve_task_workspace(app, project_id, conversation_id, task_mode)?;

    // Skills visible to this turn: all enabled ones, optionally narrowed by
    // the agent's selection.
    let mut skill_list = skills::list(app, &settings.skills_disabled)?;
    if let Some(agent) = &agent {
        if !agent.skills.is_empty() {
            for s in &mut skill_list {
                if !agent.skills.contains(&s.name) {
                    s.enabled = false;
                }
            }
        }
    }
    let skill_tool_allowed =
        allowed_tools.is_empty() || allowed_tools.iter().any(|tool| tool == "skill");
    if !skill_tool_allowed {
        for skill in &mut skill_list {
            skill.enabled = false;
        }
    }
    let available_skills: Vec<_> = skill_list
        .iter()
        .filter(|skill| skill.enabled)
        .map(|skill| skill.name.clone())
        .collect();

    // MCP servers: enabled ones, optionally narrowed by the agent.
    let mcp_configs = settings
        .mcp_servers
        .iter()
        .filter(|c| c.enabled)
        .filter(|c| {
            agent
                .as_ref()
                .map(|a| a.mcp_servers.is_empty() || a.mcp_servers.contains(&c.id))
                .unwrap_or(true)
        })
        .map(|config| super::tietiezhi::resolve_mcp_config_secrets(app, config))
        .collect::<Result<Vec<_>, _>>()?;

    let system_prompt = prompt::compose(
        &settings.system_prompt,
        agent
            .as_ref()
            .map(|a| a.system_prompt.as_str())
            .unwrap_or(""),
        &workspace.to_string_lossy(),
        &skill_list,
        task_mode,
    );

    let permission_mode = PermissionMode::parse(
        agent
            .as_ref()
            .map(|a| a.permission_mode.as_str())
            .unwrap_or(settings.permission_mode.as_str()),
    );

    Ok(AgentEnv {
        system_prompt,
        allowed_tools,
        available_skills,
        permission_mode,
        mcp_configs,
        workspace,
    })
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
