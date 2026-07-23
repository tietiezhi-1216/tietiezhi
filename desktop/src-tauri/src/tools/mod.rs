pub mod bash;
pub mod device;
pub mod fetch;
pub mod fs_tools;
pub mod search;
pub mod skill;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::agent::events::ChatEvent;

/// Everything a builtin tool needs to run.
pub struct ToolCtx {
    pub app: AppHandle,
    pub http: reqwest::Client,
    pub workspace: PathBuf,
    pub available_skills: Vec<String>,
    pub cancel: CancellationToken,
    pub call_id: String,
    pub on_event: Channel<ChatEvent>,
}

impl ToolCtx {
    pub fn emit_progress(
        &self,
        output: String,
        elapsed_ms: u64,
        truncated: bool,
    ) -> Result<(), String> {
        self.on_event
            .send(ChatEvent::ToolProgress {
                id: self.call_id.clone(),
                output,
                elapsed_ms,
                truncated,
            })
            .map_err(|error| format!("推送工具进度失败：{error}"))
    }
}

#[derive(Debug)]
pub struct ToolRunResult {
    pub output: String,
    pub is_error: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub truncated: bool,
}

impl ToolRunResult {
    fn success(output: String) -> Self {
        Self {
            output,
            is_error: false,
            exit_code: None,
            timed_out: false,
            cancelled: false,
            truncated: false,
        }
    }
}

/// Output caps shared by all tools so a single call can't blow up the
/// transcript (and the relay context window).
pub const MAX_OUTPUT_BYTES: usize = 30 * 1024;
pub const MAX_OUTPUT_LINES: usize = 2000;

pub fn truncate_output(s: &str) -> String {
    let mut out = String::new();
    let mut truncated = false;
    for (i, line) in s.lines().enumerate() {
        if i >= MAX_OUTPUT_LINES || out.len() + line.len() > MAX_OUTPUT_BYTES {
            truncated = true;
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    if truncated {
        out.push_str("\n[输出过长，已截断]");
    } else if out.ends_with('\n') {
        out.pop();
    }
    out
}

pub const ALL_TOOLS: &[&str] = &[
    "read_file",
    "write_file",
    "edit_file",
    "list_dir",
    "glob",
    "grep",
    "bash",
    "fetch",
    "skill",
    "device_call",
];

/// Read-only tools are auto-allowed in the "auto" permission mode.
pub fn is_read_only(name: &str) -> bool {
    matches!(
        name,
        "read_file" | "list_dir" | "glob" | "grep" | "fetch" | "skill"
    )
}

fn spec(name: &str, description: &str, parameters: Value) -> Value {
    json!({
        "type": "function",
        "function": { "name": name, "description": description, "parameters": parameters }
    })
}

/// OpenAI function-calling specs for the builtin tools, filtered to `allowed`
/// (empty = all). The skill loader only exists when this turn has skills.
pub fn specs(allowed: &[String], available_skills: &[String]) -> Vec<Value> {
    let want = |n: &str| allowed.is_empty() || allowed.iter().any(|a| a == n);
    let mut out = Vec::new();
    if want("read_file") {
        out.push(spec(
            "read_file",
            "读取工作区内的文本文件，返回带行号的内容。大文件可用 offset/limit 分页。",
            json!({"type":"object","properties":{
                "path":{"type":"string","description":"相对工作区的文件路径"},
                "offset":{"type":"integer","description":"起始行号（1 开始），可选"},
                "limit":{"type":"integer","description":"读取行数，可选，默认 2000"}
            },"required":["path"]}),
        ));
    }
    if want("write_file") {
        out.push(spec(
            "write_file",
            "在工作区内创建或覆盖写入真实的文本文件（父目录会自动创建）。适合 Markdown、JSON、源码和 UTF-8 CSV；不能生成 XLS/XLSX 等二进制格式，禁止仅靠扩展名伪造。",
            json!({"type":"object","properties":{
                "path":{"type":"string","description":"相对工作区的文件路径"},
                "content":{"type":"string","description":"完整文件内容"}
            },"required":["path","content"]}),
        ));
    }
    if want("edit_file") {
        out.push(spec(
            "edit_file",
            "对工作区内文件做精确字符串替换。old_string 必须在文件中恰好出现一次。",
            json!({"type":"object","properties":{
                "path":{"type":"string"},
                "old_string":{"type":"string","description":"要被替换的原文（含缩进，需唯一）"},
                "new_string":{"type":"string","description":"替换后的内容"}
            },"required":["path","old_string","new_string"]}),
        ));
    }
    if want("list_dir") {
        out.push(spec(
            "list_dir",
            "列出工作区内某目录的直接子项（目录以 / 结尾）。",
            json!({"type":"object","properties":{
                "path":{"type":"string","description":"相对工作区的目录路径，省略为工作区根"}
            }}),
        ));
    }
    if want("glob") {
        out.push(spec(
            "glob",
            "按 glob 模式（如 **/*.rs）在工作区内查找文件，按修改时间倒序返回路径。",
            json!({"type":"object","properties":{
                "pattern":{"type":"string","description":"glob 模式，例如 src/**/*.ts"}
            },"required":["pattern"]}),
        ));
    }
    if want("grep") {
        out.push(spec(
            "grep",
            "在工作区文件内容中按正则搜索，返回 文件:行号:内容 匹配列表。",
            json!({"type":"object","properties":{
                "pattern":{"type":"string","description":"Rust 正则表达式"},
                "path":{"type":"string","description":"限定搜索的子目录，可选"},
                "glob":{"type":"string","description":"限定文件名模式，如 *.rs，可选"}
            },"required":["pattern"]}),
        ));
    }
    if want("bash") {
        out.push(spec(
            "bash",
            "在工作区目录下非交互执行 shell 命令，实时返回有界输出。默认超时 120 秒，超时或取消会终止整个进程树。不要启动需要输入、GUI、常驻服务或 watch 模式的前台命令。",
            json!({"type":"object","properties":{
                "command":{"type":"string","description":"要执行的命令"},
                "timeout_ms":{"type":"integer","description":"超时毫秒数，可选；默认 120000，最大 600000。仅为确实需要长时间运行的有限命令调高"}
            },"required":["command"]}),
        ));
    }
    if want("fetch") {
        out.push(spec(
            "fetch",
            "HTTP GET 抓取一个 http(s) URL 的文本内容（上限 5MB / 30 秒）。",
            json!({"type":"object","properties":{
                "url":{"type":"string","description":"要抓取的 URL"}
            },"required":["url"]}),
        ));
    }
    if want("skill") && !available_skills.is_empty() {
        out.push(spec(
            "skill",
            "加载当前可用技能的完整说明。仅当用户请求与系统提示词中的某个技能描述匹配时调用，名称必须从可用列表中精确选择，不得编造。",
            json!({"type":"object","properties":{
                "name":{"type":"string","description":"当前可用技能的精确名称","enum":available_skills}
            },"required":["name"]}),
        ));
    }
    if want("device_call") {
        out.push(spec(
            "device_call",
            "让铁铁汁在指定设备或 Core 上调用一个已授权能力。先使用界面中的设备中心确认 device_id 和能力；所有设备操作都会经过权限确认。",
            json!({"type":"object","properties":{
                "device_id":{"type":"string","description":"设备中心显示的设备 ID，例如 local、core:<id> 或 <core-id>/<device-id>"},
                "capability":{"type":"string","description":"能力标识，例如 system.status、system.ping、app.focus"},
                "input":{"type":"object","description":"传给设备能力的参数；没有参数时传空对象"}
            },"required":["device_id","capability"]}),
        ));
    }
    out
}

/// Dispatch a builtin tool call. Returns the tool output text or an error
/// string that is fed back to the model as an error tool result.
pub async fn run(name: &str, args: &Value, ctx: &ToolCtx) -> Result<ToolRunResult, String> {
    let out = match name {
        "read_file" => ToolRunResult::success(fs_tools::read_file(ctx, args)?),
        "write_file" => ToolRunResult::success(fs_tools::write_file(ctx, args)?),
        "edit_file" => ToolRunResult::success(fs_tools::edit_file(ctx, args)?),
        "list_dir" => ToolRunResult::success(fs_tools::list_dir(ctx, args)?),
        "glob" => ToolRunResult::success(search::glob_tool(ctx, args)?),
        "grep" => ToolRunResult::success(search::grep_tool(ctx, args)?),
        "bash" => bash::bash_tool(ctx, args).await?,
        "fetch" => ToolRunResult::success(fetch::fetch_tool(ctx, args).await?),
        "skill" => ToolRunResult::success(skill::skill_tool(ctx, args)?),
        "device_call" => ToolRunResult::success(device::device_call(ctx, args).await?),
        other => return Err(format!("未知工具：{other}")),
    };
    Ok(ToolRunResult {
        output: truncate_output(&out.output),
        ..out
    })
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少参数 {key}"))
}

/// Resolve a model-supplied relative path inside the workspace, rejecting any
/// escape attempt. The deepest existing ancestor is canonicalized so symlinks
/// can't smuggle the path outside; not-yet-existing tails are checked
/// component-by-component (no `..`).
pub fn resolve_in_workspace(workspace: &Path, user_path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(user_path.trim());
    let joined = if rel.is_absolute() {
        rel.to_path_buf()
    } else {
        workspace.join(rel)
    };
    // Reject `..` anywhere in the requested path.
    if joined
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("路径不允许包含 ..".into());
    }
    let ws = dunce::canonicalize(workspace).map_err(|e| format!("工作区不可用：{e}"))?;
    // Canonicalize the deepest existing ancestor, then re-append the tail.
    let mut existing = joined.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => return Err("非法路径".into()),
        }
    }
    let mut resolved = dunce::canonicalize(&existing).map_err(|e| format!("解析路径失败：{e}"))?;
    for part in tail.iter().rev() {
        resolved.push(part);
    }
    if !resolved.starts_with(&ws) {
        return Err("路径超出工作区范围".into());
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ttz-ws-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        dir
    }

    #[test]
    fn resolve_allows_inside_paths() {
        let ws = ws();
        assert!(resolve_in_workspace(&ws, "a.txt").is_ok());
        assert!(resolve_in_workspace(&ws, "sub/new-file.txt").is_ok());
        assert!(resolve_in_workspace(&ws, "sub/deep/nested/new.txt").is_ok());
    }

    #[test]
    fn resolve_rejects_escapes() {
        let ws = ws();
        assert!(resolve_in_workspace(&ws, "../evil").is_err());
        assert!(resolve_in_workspace(&ws, "sub/../../evil").is_err());
        assert!(resolve_in_workspace(&ws, "/etc/passwd").is_err());
    }

    #[test]
    fn truncate_output_caps_lines() {
        let big = "x\n".repeat(MAX_OUTPUT_LINES + 10);
        let out = truncate_output(&big);
        assert!(out.contains("已截断"));
    }

    #[test]
    fn skill_tool_is_omitted_when_no_skill_is_available() {
        let specs = specs(&[], &[]);
        assert!(!specs.iter().any(|spec| spec["function"]["name"] == "skill"));
    }

    #[test]
    fn skill_tool_only_accepts_available_skill_names() {
        let available = vec!["git-release".to_string(), "pdf-tools".to_string()];
        let specs = specs(&[], &available);
        let skill = specs
            .iter()
            .find(|spec| spec["function"]["name"] == "skill")
            .unwrap();

        assert_eq!(
            skill["function"]["parameters"]["properties"]["name"]["enum"],
            json!(["git-release", "pdf-tools"])
        );
    }

    #[test]
    fn agent_tool_selection_can_disable_the_skill_loader() {
        let allowed = vec!["read_file".to_string()];
        let available = vec!["git-release".to_string()];
        let specs = specs(&allowed, &available);

        assert!(!specs.iter().any(|spec| spec["function"]["name"] == "skill"));
    }
}
