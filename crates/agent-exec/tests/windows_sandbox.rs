#![cfg(windows)]

use std::collections::HashMap;

use tietiezhi_agent_exec::{ExecManager, ExecRequest, SessionId, TerminalSize};
use tietiezhi_agent_sandbox::SandboxPolicy;

#[tokio::test]
async fn source_built_wrapper_enforces_pipe_and_conpty() {
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
