use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::{str_arg, ToolCtx, ToolRunResult, MAX_OUTPUT_BYTES};

pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
const GRACEFUL_KILL_TIMEOUT: Duration = Duration::from_secs(3);

pub fn effective_timeout_ms(args: &Value) -> u64 {
    args.get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS)
}

/// Bounded head + tail capture keeps the useful beginning and failure ending
/// without allowing a noisy child process to exhaust desktop memory.
#[derive(Default)]
struct HeadTailBuffer {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total_bytes: usize,
}

impl HeadTailBuffer {
    fn append(&mut self, chunk: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(chunk.len());
        let head_limit = MAX_OUTPUT_BYTES / 2;
        let tail_limit = MAX_OUTPUT_BYTES.saturating_sub(head_limit);
        let head_remaining = head_limit.saturating_sub(self.head.len());
        let head_bytes = head_remaining.min(chunk.len());
        self.head.extend_from_slice(&chunk[..head_bytes]);
        for byte in &chunk[head_bytes..] {
            if self.tail.len() == tail_limit {
                self.tail.pop_front();
            }
            self.tail.push_back(*byte);
        }
    }

    fn truncated(&self) -> bool {
        self.total_bytes > self.head.len() + self.tail.len()
    }

    fn render(&self) -> String {
        let mut output = String::from_utf8_lossy(&self.head).into_owned();
        if self.truncated() {
            let omitted = self
                .total_bytes
                .saturating_sub(self.head.len() + self.tail.len());
            output.push_str(&format!("\n\n[中间输出过长，已省略 {omitted} 字节]\n\n"));
        }
        let tail = self.tail.iter().copied().collect::<Vec<_>>();
        output.push_str(&String::from_utf8_lossy(&tail));
        output
    }
}

async fn capture<R>(mut reader: R, output: Arc<Mutex<HeadTailBuffer>>) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        output.lock().await.append(&chunk[..read]);
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut tokio::process::Command) {
    use std::os::unix::process::CommandExt;

    command.as_std_mut().process_group(0);
}

#[cfg(windows)]
fn configure_process_group(command: &mut tokio::process::Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command
        .as_std_mut()
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn signal_process_tree(pid: u32, force: bool) {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    // The child is its own process-group leader. A negative PID targets every
    // descendant that remained in that group.
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[cfg(windows)]
async fn signal_process_tree(pid: u32, force: bool) {
    let mut command = crate::process::background_tokio_command("taskkill");
    command.arg("/PID").arg(pid.to_string()).arg("/T");
    if force {
        command.arg("/F");
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let _ = command.status().await;
}

async fn stop_process_tree(child: &mut tokio::process::Child, pid: u32) {
    #[cfg(unix)]
    signal_process_tree(pid, false);
    #[cfg(windows)]
    signal_process_tree(pid, false).await;

    if tokio::time::timeout(GRACEFUL_KILL_TIMEOUT, child.wait())
        .await
        .is_ok()
    {
        return;
    }

    #[cfg(unix)]
    signal_process_tree(pid, true);
    #[cfg(windows)]
    signal_process_tree(pid, true).await;
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub async fn bash_tool(ctx: &ToolCtx, args: &Value) -> Result<ToolRunResult, String> {
    let command_text = str_arg(args, "command")?;
    let timeout_ms = effective_timeout_ms(args);
    run_command(
        command_text,
        timeout_ms,
        &ctx.workspace,
        &ctx.cancel,
        Some(ctx),
    )
    .await
}

async fn run_command(
    command_text: &str,
    timeout_ms: u64,
    workspace: &Path,
    cancel: &CancellationToken,
    progress_ctx: Option<&ToolCtx>,
) -> Result<ToolRunResult, String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut command = crate::process::background_tokio_command("cmd");
        command.arg("/D").arg("/S").arg("/C").arg(command_text);
        command
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".into());
        let mut command = crate::process::background_tokio_command(shell);
        command.arg("-lc").arg(command_text);
        command
    };

    configure_process_group(&mut cmd);
    cmd.current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let started = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("启动命令失败：{error}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "无法获取命令进程 ID".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取命令输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取命令错误输出".to_string())?;
    let output = Arc::new(Mutex::new(HeadTailBuffer::default()));
    let mut stdout_task = tokio::spawn(capture(stdout, output.clone()));
    let mut stderr_task = tokio::spawn(capture(stderr, output.clone()));
    let mut deadline = Box::pin(tokio::time::sleep(Duration::from_millis(timeout_ms)));
    let mut progress = tokio::time::interval(PROGRESS_INTERVAL);
    progress.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    progress.tick().await;
    let mut last_progress_bytes = 0;
    let mut timed_out = false;
    let mut cancelled = false;

    let status = loop {
        tokio::select! {
            result = child.wait() => {
                break Some(result.map_err(|error| format!("等待命令失败：{error}"))?);
            }
            _ = cancel.cancelled() => {
                cancelled = true;
                stop_process_tree(&mut child, pid).await;
                break None;
            }
            _ = &mut deadline => {
                timed_out = true;
                stop_process_tree(&mut child, pid).await;
                break None;
            }
            _ = progress.tick() => {
                let guard = output.lock().await;
                if guard.total_bytes != last_progress_bytes {
                    last_progress_bytes = guard.total_bytes;
                    if let Some(ctx) = progress_ctx {
                        let _ = ctx.emit_progress(
                            guard.render(),
                            started.elapsed().as_millis() as u64,
                            guard.truncated(),
                        );
                    }
                }
            }
        }
    };

    // A shell can exit while a background descendant still owns its pipes.
    // Give normal output a brief drain window, then clean up the process group
    // and reader tasks instead of hanging forever on inherited descriptors.
    let drained = tokio::time::timeout(OUTPUT_DRAIN_TIMEOUT, async {
        let _ = (&mut stdout_task).await;
        let _ = (&mut stderr_task).await;
    })
    .await
    .is_ok();
    if !drained {
        #[cfg(unix)]
        signal_process_tree(pid, true);
        #[cfg(windows)]
        signal_process_tree(pid, true).await;
        stdout_task.abort();
        stderr_task.abort();
    }

    let guard = output.lock().await;
    let truncated = guard.truncated();
    let mut text = guard.render();
    drop(guard);
    let exit_code = status.as_ref().and_then(std::process::ExitStatus::code);
    let is_error = timed_out || cancelled || status.as_ref().is_some_and(|value| !value.success());

    if timed_out {
        text.push_str(&format!(
            "\n\n[命令超时：已运行 {} 秒并终止进程树]",
            timeout_ms / 1_000
        ));
    } else if cancelled {
        text.push_str("\n\n[命令已取消，相关进程已终止]");
    } else if let Some(code) = exit_code.filter(|code| *code != 0) {
        text.push_str(&format!("\n\n[退出码 {code}]"));
    }
    if text.trim().is_empty() {
        text = "[无输出]".into();
    }

    Ok(ToolRunResult {
        output: text,
        is_error,
        exit_code,
        timed_out,
        cancelled,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_is_clamped() {
        assert_eq!(
            effective_timeout_ms(&serde_json::json!({})),
            DEFAULT_TIMEOUT_MS
        );
        assert_eq!(
            effective_timeout_ms(&serde_json::json!({"timeout_ms": 1})),
            1_000
        );
        assert_eq!(
            effective_timeout_ms(&serde_json::json!({"timeout_ms": 9_999_999})),
            MAX_TIMEOUT_MS
        );
    }

    #[test]
    fn buffer_keeps_head_and_tail() {
        let mut output = HeadTailBuffer::default();
        output.append(&vec![b'a'; MAX_OUTPUT_BYTES]);
        output.append(b"TAIL");
        let rendered = output.render();
        assert!(output.truncated());
        assert!(rendered.starts_with('a'));
        assert!(rendered.ends_with("TAIL"));
        assert!(rendered.contains("已省略"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_stops_a_running_command_with_a_clear_result() {
        let cancel = CancellationToken::new();
        let started = Instant::now();
        let result = run_command(
            "printf 'started'; sleep 30",
            100,
            &std::env::current_dir().unwrap(),
            &cancel,
            None,
        )
        .await
        .unwrap();

        assert!(result.timed_out);
        assert!(result.is_error);
        assert!(result.output.contains("started"));
        assert!(result.output.contains("命令超时"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn nonzero_exit_is_reported_as_an_error() {
        let result = run_command(
            "printf 'failed' >&2; exit 7",
            1_000,
            &std::env::current_dir().unwrap(),
            &CancellationToken::new(),
            None,
        )
        .await
        .unwrap();

        assert!(result.is_error);
        assert_eq!(result.exit_code, Some(7));
        assert!(result.output.contains("failed"));
        assert!(result.output.contains("退出码 7"));
    }
}
