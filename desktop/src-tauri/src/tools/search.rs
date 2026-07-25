use globset::GlobBuilder;
use serde_json::Value;
use walkdir::WalkDir;

use super::{resolve_in_workspace, str_arg, ToolCtx};

const MAX_GLOB_RESULTS: usize = 500;
const MAX_GREP_MATCHES: usize = 200;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

fn skip_entry(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    name == ".git" || name == "node_modules" || name == "target" || name == ".DS_Store"
}

pub fn glob_tool(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let pattern = str_arg(args, "pattern")?;
    let matcher = GlobBuilder::new(pattern)
        .literal_separator(false)
        .build()
        .map_err(|e| format!("glob 模式无效：{e}"))?
        .compile_matcher();

    let ws = dunce::canonicalize(&ctx.workspace).map_err(|e| format!("工作区不可用：{e}"))?;
    let mut hits: Vec<(std::time::SystemTime, String)> = Vec::new();
    for entry in WalkDir::new(&ws)
        .into_iter()
        .filter_entry(|e| !skip_entry(e))
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(&ws).unwrap_or(entry.path());
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if matcher.is_match(&rel_str) {
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            hits.push((mtime, rel_str));
            if hits.len() >= MAX_GLOB_RESULTS * 2 {
                break;
            }
        }
    }
    hits.sort_by_key(|hit| std::cmp::Reverse(hit.0));
    hits.truncate(MAX_GLOB_RESULTS);
    if hits.is_empty() {
        return Ok("[无匹配文件]".into());
    }
    Ok(hits
        .into_iter()
        .map(|(_, p)| p)
        .collect::<Vec<_>>()
        .join("\n"))
}

pub fn grep_tool(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let pattern = str_arg(args, "pattern")?;
    let re = regex::Regex::new(pattern).map_err(|e| format!("正则无效：{e}"))?;
    let root = match args.get("path").and_then(Value::as_str) {
        Some(p) if !p.trim().is_empty() => resolve_in_workspace(&ctx.workspace, p)?,
        _ => dunce::canonicalize(&ctx.workspace).map_err(|e| format!("工作区不可用：{e}"))?,
    };
    let name_matcher = match args.get("glob").and_then(Value::as_str) {
        Some(g) if !g.trim().is_empty() => Some(
            GlobBuilder::new(g)
                .build()
                .map_err(|e| format!("glob 模式无效：{e}"))?
                .compile_matcher(),
        ),
        _ => None,
    };

    let ws = dunce::canonicalize(&ctx.workspace).map_err(|e| format!("工作区不可用：{e}"))?;
    let mut out = String::new();
    let mut count = 0usize;
    'outer: for entry in WalkDir::new(&root)
        .into_iter()
        .filter_entry(|e| !skip_entry(e))
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if entry
            .metadata()
            .map(|m| m.len() > MAX_FILE_BYTES)
            .unwrap_or(true)
        {
            continue;
        }
        if let Some(m) = &name_matcher {
            if !m.is_match(entry.file_name().to_string_lossy().as_ref()) {
                continue;
            }
        }
        let Ok(raw) = std::fs::read(entry.path()) else {
            continue;
        };
        if raw.contains(&0) {
            continue; // binary
        }
        let text = String::from_utf8_lossy(&raw);
        let rel = entry.path().strip_prefix(&ws).unwrap_or(entry.path());
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                out.push_str(&format!(
                    "{}:{}:{}\n",
                    rel.to_string_lossy().replace('\\', "/"),
                    i + 1,
                    line.trim_end()
                ));
                count += 1;
                if count >= MAX_GREP_MATCHES {
                    out.push_str("[匹配过多，已截断]");
                    break 'outer;
                }
            }
        }
    }
    if out.is_empty() {
        return Ok("[无匹配]".into());
    }
    Ok(out)
}
