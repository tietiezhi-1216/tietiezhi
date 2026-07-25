use serde_json::Value;

use super::{resolve_in_workspace, str_arg, ToolCtx};

const MAX_READ_LINES: usize = 2000;
const MAX_READ_BYTES: usize = 50 * 1024;

fn ensure_not_managed_secret(
    workspace: &std::path::Path,
    path: &std::path::Path,
) -> Result<(), String> {
    if workspace.join(".tietiezhi-home").is_file() && path.starts_with(workspace.join("secrets")) {
        Err("密钥说明由铁铁汁控制中心管理，不能通过文件工具修改".into())
    } else {
        Ok(())
    }
}

pub fn read_file(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let path = resolve_in_workspace(&ctx.workspace, str_arg(args, "path")?)?;
    let raw = std::fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    let text = String::from_utf8_lossy(&raw);
    let offset = args
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(MAX_READ_LINES)
        .min(MAX_READ_LINES);

    let mut out = String::new();
    let mut shown = 0usize;
    let mut total = 0usize;
    for (i, line) in text.lines().enumerate() {
        total = i + 1;
        if i + 1 < offset || shown >= limit || out.len() > MAX_READ_BYTES {
            continue;
        }
        out.push_str(&format!("{:>5}\t{line}\n", i + 1));
        shown += 1;
    }
    if total > offset.saturating_sub(1) + shown {
        out.push_str(&format!("[共 {total} 行，可用 offset/limit 继续读取]"));
    }
    if out.is_empty() {
        out = "[空文件]".into();
    }
    Ok(out)
}

pub fn write_file(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let path = resolve_in_workspace(&ctx.workspace, str_arg(args, "path")?)?;
    ensure_not_managed_secret(&ctx.workspace, &path)?;
    let content = str_arg(args, "content")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(format!(
        "已写入 {}（{} 字节）",
        path.display(),
        content.len()
    ))
}

pub fn edit_file(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let path = resolve_in_workspace(&ctx.workspace, str_arg(args, "path")?)?;
    ensure_not_managed_secret(&ctx.workspace, &path)?;
    let old = str_arg(args, "old_string")?;
    let new = str_arg(args, "new_string")?;
    if old.is_empty() {
        return Err("old_string 不能为空".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    let count = text.matches(old).count();
    if count == 0 {
        return Err("old_string 在文件中不存在，请先 read_file 确认原文".into());
    }
    if count > 1 {
        return Err(format!(
            "old_string 出现了 {count} 次，必须唯一；请提供更长的上下文"
        ));
    }
    let updated = text.replacen(old, new, 1);
    std::fs::write(&path, updated).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(format!("已编辑 {}", path.display()))
}

pub fn list_dir(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let rel = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let path = resolve_in_workspace(&ctx.workspace, rel)?;
    let entries = std::fs::read_dir(&path).map_err(|e| format!("读取目录失败：{e}"))?;
    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".tietiezhi-home" {
            continue;
        }
        if entry.path().is_dir() {
            names.push(format!("{name}/"));
        } else {
            names.push(name);
        }
    }
    names.sort();
    if names.is_empty() {
        return Ok("[空目录]".into());
    }
    Ok(names.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::ensure_not_managed_secret;

    #[test]
    fn managed_secret_documents_are_not_writable_by_file_tools() {
        let root = std::env::temp_dir().join(format!("tietiezhi-fs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("secrets")).unwrap();
        std::fs::write(root.join(".tietiezhi-home"), "managed").unwrap();
        assert!(ensure_not_managed_secret(&root, &root.join("secrets/token.md")).is_err());
        assert!(ensure_not_managed_secret(&root, &root.join("notes/today.md")).is_ok());
        let _ = std::fs::remove_dir_all(root);
    }
}
