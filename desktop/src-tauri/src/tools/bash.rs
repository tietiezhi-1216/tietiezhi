use serde_json::Value;

use super::{str_arg, ToolCtx};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

pub async fn bash_tool(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let command = str_arg(args, "command")?;
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(MAX_TIMEOUT_MS);

    #[cfg(windows)]
    let mut cmd = {
        let mut c = crate::process::background_tokio_command("cmd");
        c.arg("/C").arg(command);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = crate::process::background_tokio_command("sh");
        c.arg("-lc").arg(command);
        c
    };

    cmd.current_dir(&ctx.workspace)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let child = cmd.spawn().map_err(|e| format!("启动命令失败：{e}"))?;

    let output = tokio::select! {
        _ = ctx.cancel.cancelled() => return Err("命令已被用户取消".into()),
        _ = tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)) => {
            return Err(format!("命令超时（{} 秒）", timeout_ms / 1000));
        }
        r = child.wait_with_output() => r.map_err(|e| format!("等待命令失败：{e}"))?,
    };

    let mut text = String::new();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    if !output.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    let code = output.status.code().unwrap_or(-1);
    if !output.status.success() {
        text.push_str(&format!("\n[退出码 {code}]"));
    }
    if text.trim().is_empty() {
        text = "[无输出]".into();
    }
    Ok(text)
}
