//! Connection- and turn-scoped process sessions built on the pinned Codex PTY layer.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, broadcast, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{
    DEFAULT_OUTPUT_BYTES_CAP, ProcessHandle, TerminalSize, spawn_pipe_process,
    spawn_pipe_process_no_stdin, spawn_pty_process,
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionId {
    pub owner: String,
    pub process_id: String,
}

impl SessionId {
    pub fn new(owner: impl Into<String>, process_id: impl Into<String>) -> Self {
        Self {
            owner: owner.into(),
            process_id: process_id.into(),
        }
    }

    fn key(&self) -> String {
        format!("{}\0{}", self.owner, self.process_id)
    }
}

#[derive(Debug, Clone)]
pub struct ExecRequest {
    pub command: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, Option<String>>,
    pub tty: bool,
    pub stream_stdin: bool,
    pub size: TerminalSize,
    /// `None` disables capture truncation.
    pub output_bytes_cap: Option<usize>,
    /// `None` disables the execution timeout.
    pub timeout: Option<Duration>,
    pub cancellation: Option<CancellationToken>,
}

impl ExecRequest {
    pub fn buffered(command: Vec<String>, cwd: PathBuf) -> Self {
        Self {
            command,
            cwd,
            env: HashMap::new(),
            tty: false,
            stream_stdin: false,
            size: TerminalSize::default(),
            output_bytes_cap: Some(DEFAULT_OUTPUT_BYTES_CAP),
            timeout: Some(DEFAULT_TIMEOUT),
            cancellation: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputChunk {
    pub cursor: usize,
    pub stream: OutputStream,
    pub bytes: Vec<u8>,
    pub cap_reached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecEvent {
    Output(OutputChunk),
    Exited(ExecResult),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub stdout_cap_reached: bool,
    pub stderr_cap_reached: bool,
    pub timed_out: bool,
    pub wall_time_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PollResult {
    pub chunks: Vec<OutputChunk>,
    pub next_cursor: usize,
    pub result: Option<ExecResult>,
}

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error("command argv must not be empty")]
    EmptyCommand,
    #[error("process id must not be empty")]
    EmptyProcessId,
    #[error("working directory does not exist: {0}")]
    MissingCwd(PathBuf),
    #[error("process already exists: {0}")]
    DuplicateProcess(String),
    #[error("process not found: {0}")]
    UnknownProcess(String),
    #[error("process has already exited: {0}")]
    ProcessExited(String),
    #[error("process stdin streaming is disabled: {0}")]
    StdinDisabled(String),
    #[error("process is not attached to a PTY")]
    NotTty,
    #[error("failed to spawn process: {0}")]
    Spawn(String),
    #[error("process operation failed: {0}")]
    Operation(String),
    #[error("process state lock poisoned")]
    StatePoisoned,
}

#[derive(Clone, Default)]
pub struct ExecManager {
    inner: Arc<ManagerInner>,
}

#[derive(Default)]
struct ManagerInner {
    next_session_id: AtomicU64,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl Drop for ManagerInner {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.lock() {
            for session in sessions.values() {
                session.process.request_terminate();
            }
        }
    }
}

struct Session {
    id: SessionId,
    process: Arc<ProcessHandle>,
    tty: bool,
    stream_stdin: bool,
    state: Mutex<SessionState>,
    notify: Notify,
    events: broadcast::Sender<ExecEvent>,
    timed_out: AtomicBool,
    started: Instant,
}

#[derive(Default)]
struct SessionState {
    stdout: CapturedStream,
    stderr: CapturedStream,
    chunks: Vec<OutputChunk>,
    result: Option<ExecResult>,
}

#[derive(Default)]
struct CapturedStream {
    bytes: Vec<u8>,
    cap_reached: bool,
}

impl ExecManager {
    pub fn allocate_session_id(&self) -> String {
        (self.inner.next_session_id.fetch_add(1, Ordering::Relaxed) + 1).to_string()
    }

    pub async fn spawn(
        &self,
        id: SessionId,
        request: ExecRequest,
    ) -> Result<broadcast::Receiver<ExecEvent>, ExecError> {
        validate_request(&id, &request)?;
        let key = id.key();
        {
            let sessions = self
                .inner
                .sessions
                .lock()
                .map_err(|_| ExecError::StatePoisoned)?;
            if sessions.contains_key(&key) {
                return Err(ExecError::DuplicateProcess(id.process_id));
            }
        }

        let mut env = std::env::vars().collect::<HashMap<_, _>>();
        for (name, value) in &request.env {
            match value {
                Some(value) => {
                    env.insert(name.clone(), value.clone());
                }
                None => {
                    env.remove(name);
                }
            }
        }
        let program = &request.command[0];
        let args = request.command[1..].to_vec();
        let spawned = if request.tty {
            spawn_pty_process(program, &args, &request.cwd, &env, &None, request.size, &[]).await
        } else if request.stream_stdin {
            spawn_pipe_process(program, &args, &request.cwd, &env, &None, &[]).await
        } else {
            spawn_pipe_process_no_stdin(program, &args, &request.cwd, &env, &None, &[]).await
        }
        .map_err(|error| ExecError::Spawn(error.to_string()))?;

        let (events, receiver) = broadcast::channel(512);
        let session = Arc::new(Session {
            id,
            process: Arc::new(spawned.session),
            tty: request.tty,
            stream_stdin: request.stream_stdin || request.tty,
            state: Mutex::new(SessionState::default()),
            notify: Notify::new(),
            events,
            timed_out: AtomicBool::new(false),
            started: Instant::now(),
        });
        self.inner
            .sessions
            .lock()
            .map_err(|_| ExecError::StatePoisoned)?
            .insert(key, Arc::clone(&session));

        run_session(
            Arc::clone(&session),
            spawned.stdout_rx,
            spawned.stderr_rx,
            spawned.exit_rx,
            request.output_bytes_cap,
        );
        if let Some(timeout) = request.timeout {
            let session = Arc::clone(&session);
            tokio::spawn(async move {
                tokio::time::sleep(timeout).await;
                if !session.process.has_exited() {
                    session.timed_out.store(true, Ordering::SeqCst);
                    session.process.request_terminate();
                }
            });
        }
        if let Some(cancellation) = request.cancellation {
            let session = Arc::clone(&session);
            tokio::spawn(async move {
                cancellation.cancelled().await;
                if !session.process.has_exited() {
                    session.process.request_terminate();
                }
            });
        }
        Ok(receiver)
    }

    pub fn subscribe(&self, id: &SessionId) -> Result<broadcast::Receiver<ExecEvent>, ExecError> {
        Ok(self.session(id)?.events.subscribe())
    }

    pub async fn wait(
        &self,
        id: &SessionId,
        timeout: Option<Duration>,
    ) -> Result<Option<ExecResult>, ExecError> {
        let session = self.session(id)?;
        loop {
            if let Some(result) = session
                .state
                .lock()
                .map_err(|_| ExecError::StatePoisoned)?
                .result
                .clone()
            {
                return Ok(Some(result));
            }
            let notified = session.notify.notified();
            if let Some(timeout) = timeout {
                if tokio::time::timeout(timeout, notified).await.is_err() {
                    return Ok(None);
                }
            } else {
                notified.await;
            }
        }
    }

    pub async fn poll(
        &self,
        id: &SessionId,
        cursor: usize,
        timeout: Duration,
    ) -> Result<PollResult, ExecError> {
        let session = self.session(id)?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let snapshot = poll_snapshot(&session, cursor)?;
            if snapshot.result.is_some() || timeout.is_zero() {
                return Ok(snapshot);
            }
            if tokio::time::timeout_at(deadline, session.notify.notified())
                .await
                .is_err()
            {
                return poll_snapshot(&session, cursor);
            }
        }
    }

    pub async fn write(
        &self,
        id: &SessionId,
        bytes: &[u8],
        close_stdin: bool,
    ) -> Result<(), ExecError> {
        let session = self.session(id)?;
        if session.process.has_exited() {
            return Err(ExecError::ProcessExited(id.process_id.clone()));
        }
        if !session.stream_stdin {
            return Err(ExecError::StdinDisabled(id.process_id.clone()));
        }
        if !bytes.is_empty() {
            session
                .process
                .writer_sender()
                .send(bytes.to_vec())
                .await
                .map_err(|_| ExecError::ProcessExited(id.process_id.clone()))?;
        }
        if close_stdin {
            session.process.close_stdin();
        }
        Ok(())
    }

    pub fn resize(&self, id: &SessionId, size: TerminalSize) -> Result<(), ExecError> {
        let session = self.session(id)?;
        if !session.tty {
            return Err(ExecError::NotTty);
        }
        session
            .process
            .resize(size)
            .map_err(|error| ExecError::Operation(error.to_string()))
    }

    pub fn terminate(&self, id: &SessionId) -> Result<(), ExecError> {
        let session = self.session(id)?;
        session.process.request_terminate();
        Ok(())
    }

    pub fn remove(&self, id: &SessionId) -> Result<bool, ExecError> {
        Ok(self
            .inner
            .sessions
            .lock()
            .map_err(|_| ExecError::StatePoisoned)?
            .remove(&id.key())
            .is_some())
    }

    pub fn terminate_owner(&self, owner: &str) -> Result<usize, ExecError> {
        let sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| ExecError::StatePoisoned)?;
        let mut count = 0;
        for session in sessions
            .values()
            .filter(|session| session.id.owner == owner)
        {
            session.process.request_terminate();
            count += 1;
        }
        Ok(count)
    }

    fn session(&self, id: &SessionId) -> Result<Arc<Session>, ExecError> {
        self.inner
            .sessions
            .lock()
            .map_err(|_| ExecError::StatePoisoned)?
            .get(&id.key())
            .cloned()
            .ok_or_else(|| ExecError::UnknownProcess(id.process_id.clone()))
    }
}

fn validate_request(id: &SessionId, request: &ExecRequest) -> Result<(), ExecError> {
    if id.process_id.trim().is_empty() {
        return Err(ExecError::EmptyProcessId);
    }
    if request.command.is_empty() || request.command[0].trim().is_empty() {
        return Err(ExecError::EmptyCommand);
    }
    if !request.cwd.is_dir() {
        return Err(ExecError::MissingCwd(request.cwd.clone()));
    }
    Ok(())
}

fn run_session(
    session: Arc<Session>,
    mut stdout_rx: mpsc::Receiver<Vec<u8>>,
    mut stderr_rx: mpsc::Receiver<Vec<u8>>,
    mut exit_rx: oneshot::Receiver<i32>,
    cap: Option<usize>,
) {
    tokio::spawn(async move {
        let mut stdout_open = true;
        let mut stderr_open = true;
        let mut exit_code = None;
        loop {
            if exit_code.is_some() && !stdout_open && !stderr_open {
                break;
            }
            tokio::select! {
                chunk = stdout_rx.recv(), if stdout_open => match chunk {
                    Some(bytes) => append_output(&session, OutputStream::Stdout, bytes, cap),
                    None => stdout_open = false,
                },
                chunk = stderr_rx.recv(), if stderr_open => match chunk {
                    Some(bytes) => append_output(&session, OutputStream::Stderr, bytes, cap),
                    None => stderr_open = false,
                },
                result = &mut exit_rx, if exit_code.is_none() => {
                    exit_code = Some(result.unwrap_or(-1));
                }
            }
        }
        let result = {
            let Ok(mut state) = session.state.lock() else {
                return;
            };
            let result = ExecResult {
                exit_code: exit_code.unwrap_or_else(|| session.process.exit_code().unwrap_or(-1)),
                stdout: String::from_utf8_lossy(&state.stdout.bytes).into_owned(),
                stderr: String::from_utf8_lossy(&state.stderr.bytes).into_owned(),
                stdout_cap_reached: state.stdout.cap_reached,
                stderr_cap_reached: state.stderr.cap_reached,
                timed_out: session.timed_out.load(Ordering::SeqCst),
                wall_time_ms: session.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            };
            state.result = Some(result.clone());
            result
        };
        let _ = session.events.send(ExecEvent::Exited(result));
        session.notify.notify_waiters();
    });
}

fn append_output(session: &Session, stream: OutputStream, bytes: Vec<u8>, cap: Option<usize>) {
    let Ok(mut state) = session.state.lock() else {
        return;
    };
    let captured = match stream {
        OutputStream::Stdout => &mut state.stdout,
        OutputStream::Stderr => &mut state.stderr,
    };
    if captured.cap_reached {
        return;
    }
    let accepted_len = cap
        .map(|cap| cap.saturating_sub(captured.bytes.len()).min(bytes.len()))
        .unwrap_or(bytes.len());
    let accepted = bytes[..accepted_len].to_vec();
    captured.bytes.extend_from_slice(&accepted);
    let cap_reached = accepted_len < bytes.len()
        || cap.is_some_and(|cap| captured.bytes.len() >= cap && !bytes.is_empty());
    captured.cap_reached = cap_reached;
    let cursor = state.chunks.len() + 1;
    let chunk = OutputChunk {
        cursor,
        stream,
        bytes: accepted,
        cap_reached,
    };
    state.chunks.push(chunk.clone());
    drop(state);
    let _ = session.events.send(ExecEvent::Output(chunk));
    session.notify.notify_waiters();
}

fn poll_snapshot(session: &Session, cursor: usize) -> Result<PollResult, ExecError> {
    let state = session.state.lock().map_err(|_| ExecError::StatePoisoned)?;
    let chunks = state
        .chunks
        .iter()
        .filter(|chunk| chunk.cursor > cursor)
        .cloned()
        .collect::<Vec<_>>();
    let next_cursor = state.chunks.last().map_or(cursor, |chunk| chunk.cursor);
    Ok(PollResult {
        chunks,
        next_cursor,
        result: state.result.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell_command(script: &str) -> Vec<String> {
        if cfg!(windows) {
            vec![
                "powershell.exe".into(),
                "-NoProfile".into(),
                "-Command".into(),
                script.into(),
            ]
        } else {
            vec!["/bin/sh".into(), "-c".into(), script.into()]
        }
    }

    #[tokio::test]
    async fn pipe_keeps_stdout_and_stderr_separate() {
        let cwd = tempfile::tempdir().unwrap();
        let manager = ExecManager::default();
        let id = SessionId::new("test", "separate");
        manager
            .spawn(
                id.clone(),
                ExecRequest::buffered(
                    shell_command("printf out; printf err >&2"),
                    cwd.path().to_path_buf(),
                ),
            )
            .await
            .unwrap();
        let result = manager.wait(&id, None).await.unwrap().unwrap();
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "out");
        assert_eq!(result.stderr, "err");
    }

    #[tokio::test]
    async fn stdin_roundtrip_and_background_poll() {
        let cwd = tempfile::tempdir().unwrap();
        let manager = ExecManager::default();
        let id = SessionId::new("test", "stdin");
        let mut request = ExecRequest::buffered(
            if cfg!(windows) {
                vec!["more.com".into()]
            } else {
                vec!["/bin/cat".into()]
            },
            cwd.path().to_path_buf(),
        );
        request.stream_stdin = true;
        manager.spawn(id.clone(), request).await.unwrap();
        assert!(
            manager
                .wait(&id, Some(Duration::from_millis(20)))
                .await
                .unwrap()
                .is_none()
        );
        manager.write(&id, b"hello\n", true).await.unwrap();
        let result = manager.wait(&id, None).await.unwrap().unwrap();
        assert!(result.stdout.contains("hello"));
        let poll = manager.poll(&id, 0, Duration::ZERO).await.unwrap();
        assert!(poll.result.is_some());
        assert!(!poll.chunks.is_empty());
    }

    #[tokio::test]
    async fn output_cap_is_reported_without_losing_completion() {
        let cwd = tempfile::tempdir().unwrap();
        let manager = ExecManager::default();
        let id = SessionId::new("test", "cap");
        let mut request =
            ExecRequest::buffered(shell_command("printf 123456789"), cwd.path().to_path_buf());
        request.output_bytes_cap = Some(4);
        manager.spawn(id.clone(), request).await.unwrap();
        let result = manager.wait(&id, None).await.unwrap().unwrap();
        assert_eq!(result.stdout, "1234");
        assert!(result.stdout_cap_reached);
    }

    #[tokio::test]
    async fn timeout_terminates_process() {
        let cwd = tempfile::tempdir().unwrap();
        let manager = ExecManager::default();
        let id = SessionId::new("test", "timeout");
        let mut request = ExecRequest::buffered(
            if cfg!(windows) {
                shell_command("Start-Sleep -Seconds 10")
            } else {
                shell_command("sleep 10")
            },
            cwd.path().to_path_buf(),
        );
        request.timeout = Some(Duration::from_millis(30));
        manager.spawn(id.clone(), request).await.unwrap();
        let result = manager.wait(&id, None).await.unwrap().unwrap();
        assert!(result.timed_out);
        assert_ne!(result.exit_code, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_reports_and_accepts_terminal_size() {
        let cwd = tempfile::tempdir().unwrap();
        let manager = ExecManager::default();
        let id = SessionId::new("test", "pty");
        let mut request = ExecRequest::buffered(
            shell_command("stty size; read line; stty size"),
            cwd.path().to_path_buf(),
        );
        request.tty = true;
        request.stream_stdin = true;
        request.size = TerminalSize { rows: 30, cols: 90 };
        manager.spawn(id.clone(), request).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        manager
            .resize(
                &id,
                TerminalSize {
                    rows: 40,
                    cols: 100,
                },
            )
            .unwrap();
        manager.write(&id, b"\n", true).await.unwrap();
        let result = manager.wait(&id, None).await.unwrap().unwrap();
        assert!(result.stdout.contains("30 90"));
        assert!(result.stdout.contains("40 100"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminate_kills_the_entire_process_group() {
        let cwd = tempfile::tempdir().unwrap();
        let manager = ExecManager::default();
        let id = SessionId::new("test", "tree");
        let mut events = manager
            .spawn(
                id.clone(),
                ExecRequest::buffered(
                    shell_command("sleep 30 & child=$!; printf '%s\\n' \"$child\"; wait"),
                    cwd.path().to_path_buf(),
                ),
            )
            .await
            .unwrap();
        let child_pid = loop {
            if let ExecEvent::Output(chunk) = events.recv().await.unwrap()
                && let Ok(pid) = String::from_utf8_lossy(&chunk.bytes).trim().parse::<i32>()
            {
                break pid;
            }
        };
        manager.terminate(&id).unwrap();
        manager.wait(&id, None).await.unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let result = unsafe { libc::kill(child_pid, 0) };
        assert_eq!(result, -1, "descendant process {child_pid} survived");
    }
}
