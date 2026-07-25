#![cfg(windows)]

use std::collections::HashMap;
use std::net::{Ipv4Addr, TcpListener};
use std::sync::{Mutex, OnceLock};

use tietiezhi_agent_exec::{ExecManager, ExecRequest, SessionId, TerminalSize};
use tietiezhi_agent_sandbox::SandboxPolicy;

fn windows_sandbox_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn source_built_wrapper_enforces_pipe_and_conpty() {
    let _guard = windows_sandbox_test_lock();
    unsafe {
        std::env::set_var(
            "TIETIEZHI_WINDOWS_SANDBOX_WRAPPER",
            env!("CARGO_BIN_EXE_tietiezhi-agent-exec-sandbox-runner"),
        );
    }
    for tty in [false, true] {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let allowed = workspace
            .path()
            .join(if tty { "pty-ok" } else { "pipe-ok" });
        let denied = outside.path().join(if tty { "pty-no" } else { "pipe-no" });
        let manager = ExecManager::default();
        let id = SessionId::new("windows-sandbox", if tty { "pty" } else { "pipe" });
        manager
            .spawn(
                id.clone(),
                ExecRequest {
                    command: vec![
                        "cmd.exe".into(),
                        "/d".into(),
                        "/s".into(),
                        "/c".into(),
                        format!(
                            "echo ok>\"{}\" & (echo no>\"{}\" 2>nul) & exit /b 0",
                            allowed.display(),
                            denied.display()
                        ),
                    ],
                    cwd: workspace.path().to_path_buf(),
                    env: HashMap::new(),
                    tty,
                    stream_stdin: tty,
                    size: TerminalSize { rows: 24, cols: 80 },
                    output_bytes_cap: Some(1024 * 1024),
                    timeout: None,
                    cancellation: None,
                    sandbox_policy: Some(SandboxPolicy::WorkspaceWrite {
                        writable_roots: vec![workspace.path().to_path_buf()],
                        network_access: false,
                        exclude_tmpdir_env_var: true,
                        exclude_slash_tmp: true,
                    }),
                },
            )
            .await
            .unwrap();
        let result = manager.wait(&id, None).await.unwrap().unwrap();
        assert_eq!(result.exit_code, 0, "{result:?}");
        assert!(allowed.exists());
        assert!(!denied.exists());
    }
}

#[tokio::test(flavor = "current_thread")]
async fn offline_identity_can_only_reach_managed_loopback_proxy_ports() {
    let _guard = windows_sandbox_test_lock();
    unsafe {
        std::env::set_var(
            "TIETIEZHI_WINDOWS_SANDBOX_WRAPPER",
            env!("CARGO_BIN_EXE_tietiezhi-agent-exec-sandbox-runner"),
        );
    }
    let proxy = TcpListener::bind((Ipv4Addr::LOCALHOST, 3128)).unwrap();
    let denied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let denied_port = denied.local_addr().unwrap().port();
    assert_ne!(denied_port, 1080);
    assert_ne!(denied_port, 3128);
    let workspace = tempfile::tempdir().unwrap();
    let result_path = workspace.path().join("network-result.txt");
    let script = format!(
        r#"
function Test-Port([int]$Port) {{
  $client = [System.Net.Sockets.TcpClient]::new()
  try {{
    $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(2000)) {{ return $false }}
    $client.EndConnect($pending)
    return $true
  }} catch {{
    return $false
  }} finally {{
    $client.Dispose()
  }}
}}
$proxy = Test-Port 3128
$direct = Test-Port {denied_port}
Set-Content -LiteralPath '{}' -Value "$proxy,$direct"
if ($proxy -and -not $direct) {{ exit 0 }} else {{ exit 9 }}
"#,
        result_path.display().to_string().replace('\'', "''")
    );
    let manager = ExecManager::default();
    let id = SessionId::new("windows-sandbox", "network");
    manager
        .spawn(
            id.clone(),
            ExecRequest {
                command: vec![
                    "powershell.exe".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                    script,
                ],
                cwd: workspace.path().to_path_buf(),
                env: HashMap::from([
                    ("HTTP_PROXY".into(), Some("http://127.0.0.1:3128".into())),
                    ("HTTPS_PROXY".into(), Some("http://127.0.0.1:3128".into())),
                    ("ALL_PROXY".into(), Some("socks5h://127.0.0.1:1080".into())),
                    ("CODEX_NETWORK_PROXY_ACTIVE".into(), Some("1".into())),
                    ("CODEX_NETWORK_ALLOW_LOCAL_BINDING".into(), Some("0".into())),
                ]),
                tty: false,
                stream_stdin: false,
                size: TerminalSize { rows: 24, cols: 80 },
                output_bytes_cap: Some(1024 * 1024),
                timeout: None,
                cancellation: None,
                sandbox_policy: Some(SandboxPolicy::WorkspaceWrite {
                    writable_roots: vec![workspace.path().to_path_buf()],
                    network_access: true,
                    exclude_tmpdir_env_var: true,
                    exclude_slash_tmp: true,
                }),
            },
        )
        .await
        .unwrap();
    let result = manager.wait(&id, None).await.unwrap().unwrap();
    assert_eq!(result.exit_code, 0, "{result:?}");
    assert_eq!(
        std::fs::read_to_string(result_path).unwrap().trim(),
        "True,False"
    );
    drop((proxy, denied));
}
