use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use proptest::prelude::*;
use serde_json::json;
use tempfile::tempdir;
use tietiezhi_agent_exec::{ExecManager, ExecRequest, SessionId};
use tietiezhi_agent_mcp::{McpManager, McpServerConfig, McpTransport};
use tietiezhi_agent_model::{
    Provider, ResponseEvent, ResponsesApiRequest, ResponsesClient, SseDecoder,
};
use tietiezhi_agent_stability::{FaultInjector, FaultPoint, SoakConfig, SoakReport, SoakTimer};
use tietiezhi_agent_state::{StateStore, atomic_write};
use tietiezhi_agent_tools::{
    ToolCall, ToolCallRuntime, ToolExposure, ToolFuture, ToolHandler, ToolInvocation, ToolName,
    ToolOutput, ToolPayload, ToolRegistry, ToolRouter, ToolSpec,
};
use tokio_util::sync::CancellationToken;

struct CountingTool {
    active: Arc<AtomicUsize>,
    max_active: Arc<AtomicUsize>,
    completed: Arc<AtomicUsize>,
    parallel: bool,
    delay: Duration,
}

impl ToolHandler for CountingTool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(if self.parallel {
            "read_count"
        } else {
            "write_count"
        })
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec::function(
            self.tool_name(),
            "Count one invocation.",
            json!({"type":"object"}),
        )
    }

    fn exposure(&self) -> ToolExposure {
        ToolExposure::ModelVisible
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        self.parallel
    }

    fn handle(&self, _invocation: ToolInvocation) -> ToolFuture<'_> {
        Box::pin(async move {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(self.delay).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            let count = self.completed.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(ToolOutput::success(json!({"count":count})))
        })
    }
}

fn tool_call(name: &str, id: usize) -> ToolCall {
    ToolCall {
        tool_name: ToolName::plain(name),
        call_id: format!("call-{id}"),
        payload: ToolPayload::Function {
            arguments: "{}".into(),
        },
    }
}

fn runtime_with_handler(handler: Arc<dyn ToolHandler>) -> ToolCallRuntime {
    let registry = ToolRegistry::new(vec![handler], Vec::new()).unwrap();
    ToolCallRuntime::new(Arc::new(ToolRouter::new(registry)))
}

#[tokio::test]
async fn executes_256_tool_calls_without_a_fixed_iteration_limit() {
    let completed = Arc::new(AtomicUsize::new(0));
    let runtime = runtime_with_handler(Arc::new(CountingTool {
        active: Arc::new(AtomicUsize::new(0)),
        max_active: Arc::new(AtomicUsize::new(0)),
        completed: Arc::clone(&completed),
        parallel: false,
        delay: Duration::ZERO,
    }));
    for id in 0..256 {
        let output = runtime
            .handle(
                "thread-long",
                "turn-long",
                tool_call("write_count", id),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(output.success);
    }
    assert_eq!(completed.load(Ordering::SeqCst), 256);
}

#[tokio::test]
async fn parallel_reads_overlap_but_writes_are_serialized() {
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));
    let runtime = runtime_with_handler(Arc::new(CountingTool {
        active: Arc::clone(&active),
        max_active: Arc::clone(&max_active),
        completed: Arc::new(AtomicUsize::new(0)),
        parallel: true,
        delay: Duration::from_millis(20),
    }));
    let futures = (0..12)
        .map(|id| {
            let runtime = runtime.clone();
            tokio::spawn(async move {
                runtime
                    .handle(
                        "thread",
                        "turn",
                        tool_call("read_count", id),
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap()
            })
        })
        .collect::<Vec<_>>();
    for future in futures {
        future.await.unwrap();
    }
    assert!(max_active.load(Ordering::SeqCst) > 1);

    let max_active = Arc::new(AtomicUsize::new(0));
    let runtime = runtime_with_handler(Arc::new(CountingTool {
        active: Arc::new(AtomicUsize::new(0)),
        max_active: Arc::clone(&max_active),
        completed: Arc::new(AtomicUsize::new(0)),
        parallel: false,
        delay: Duration::from_millis(5),
    }));
    let futures = (0..8)
        .map(|id| {
            let runtime = runtime.clone();
            tokio::spawn(async move {
                runtime
                    .handle(
                        "thread",
                        "turn",
                        tool_call("write_count", id),
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap()
            })
        })
        .collect::<Vec<_>>();
    for future in futures {
        future.await.unwrap();
    }
    assert_eq!(max_active.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn process_cancellation_and_removal_leave_no_retained_session() {
    let dir = tempdir().unwrap();
    let manager = ExecManager::default();
    let id = SessionId::new("turn-1", "process-1");
    let mut request = if cfg!(windows) {
        ExecRequest::buffered(
            vec![
                "powershell.exe".into(),
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 60".into(),
            ],
            dir.path().to_path_buf(),
        )
    } else {
        ExecRequest::buffered(
            vec!["sh".into(), "-c".into(), "sleep 60".into()],
            dir.path().to_path_buf(),
        )
    };
    request.timeout = None;
    manager.spawn(id.clone(), request).await.unwrap();
    assert_eq!(manager.active_session_count().unwrap(), 1);
    assert_eq!(manager.owner_session_count("turn-1").unwrap(), 1);
    manager.terminate(&id).unwrap();
    let result = manager
        .wait(&id, Some(Duration::from_secs(5)))
        .await
        .unwrap();
    assert!(result.is_some());
    assert!(manager.remove(&id).unwrap());
    assert_eq!(manager.active_session_count().unwrap(), 0);
}

#[tokio::test]
async fn hanging_stdio_mcp_call_times_out_and_server_stops() {
    let manager = McpManager::default();
    let fixture = env!("CARGO_BIN_EXE_mcp_hang_fixture");
    let config = McpServerConfig {
        id: "hang".into(),
        name: "Hang fixture".into(),
        enabled: true,
        required: false,
        enabled_tools: Vec::new(),
        disabled_tools: Vec::new(),
        startup_timeout_secs: 5,
        tool_timeout_secs: 1,
        oauth_scopes: Vec::new(),
        transport: McpTransport::Stdio {
            command: fixture.into(),
            args: Vec::new(),
            env: HashMap::new(),
        },
    };
    let tools = manager.list_tools(&config).await.unwrap();
    assert_eq!(tools.len(), 1);
    let started = Instant::now();
    let error = manager
        .call_tool(&config, "hang", &json!({}))
        .await
        .unwrap_err();
    assert!(error.contains("超时"));
    assert!(started.elapsed() < Duration::from_secs(4));
    manager.stop("hang").await;
    let status = manager.status(&[config]).await;
    assert_eq!(status[0].state, "stopped");
}

#[tokio::test]
async fn disconnected_responses_stream_retries_and_completes_once() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for attempt in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let _ = socket.read(&mut request).await.unwrap();
            let body = if attempt == 0 {
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-disconnected\"}}\n\n"
            } else {
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-recovered\",\"end_turn\":true}}\n\n"
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let mut provider = Provider::openai_compatible("fixture", format!("http://{address}/v1"), None);
    provider.stream_max_retries = 1;
    let client = ResponsesClient::new(reqwest::Client::new(), provider);
    let mut events = Vec::new();
    client
        .stream(
            &ResponsesApiRequest::text("gpt-test", Vec::new()),
            |event| {
                events.push(event);
                Ok(())
            },
        )
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, ResponseEvent::Retrying { .. }))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, ResponseEvent::Completed { .. }))
            .count(),
        1
    );
}

#[test]
fn rollout_recovers_complete_prefix_and_truncates_corrupt_tail() {
    let dir = tempdir().unwrap();
    let store = StateStore::open(dir.path()).unwrap();
    let path = dir.path().join("rollout.jsonl");
    let appender = store.rollout_appender(&path).unwrap();
    appender
        .ensure_canonical_session_meta("thread-1", json!({"id":"thread-1"}))
        .unwrap();
    for ordinal in 0..128 {
        appender
            .append_event(json!({"type":"fixture","ordinal":ordinal}))
            .unwrap();
    }
    appender.sync_data().unwrap();
    drop(appender);
    let valid_len = std::fs::metadata(&path).unwrap().len();
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"timestamp\":\"truncated")
        .unwrap();
    let recovery = store.recover_rollout(&path).unwrap();
    assert_eq!(recovery.trailing_events.len(), 128);
    assert!(recovery.truncated_bytes > 0);
    assert_eq!(std::fs::metadata(&path).unwrap().len(), valid_len);
}

#[test]
fn failed_atomic_publish_preserves_previous_file() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("state.json");
    atomic_write(&target, b"stable").unwrap();
    let faults = FaultInjector::default();
    faults.arm(FaultPoint::BeforeRename);
    let staged = dir.path().join("state.staged");
    std::fs::write(&staged, b"partial").unwrap();
    if faults.take(FaultPoint::BeforeRename) {
        let _ = std::fs::remove_file(staged);
    }
    assert_eq!(std::fs::read(&target).unwrap(), b"stable");
}

proptest! {
    #[test]
    fn sse_decoder_is_invariant_to_arbitrary_chunk_boundaries(
        chunk_sizes in prop::collection::vec(1usize..32, 1..64)
    ) {
        let payload = concat!(
            ": keepalive\r\n",
            "event: response\r\n",
            "data: {\"type\":\"response.output_text.delta\",\r\n",
            "data: \"delta\":\"hello\"}\r\n\r\n",
            "data: [DONE]\n\n"
        ).as_bytes();
        let mut decoder = SseDecoder::default();
        let mut offset = 0;
        let mut frames = Vec::new();
        for size in chunk_sizes {
            if offset >= payload.len() {
                break;
            }
            let end = (offset + size).min(payload.len());
            decoder.push(&payload[offset..end]);
            offset = end;
            while let Some(frame) = decoder.next_frame().unwrap() {
                frames.push(frame);
            }
        }
        if offset < payload.len() {
            decoder.push(&payload[offset..]);
        }
        while let Some(frame) = decoder.next_frame().unwrap() {
            frames.push(frame);
        }
        prop_assert_eq!(frames.len(), 2);
        prop_assert_eq!(frames[0].event.as_deref(), Some("response"));
        prop_assert!(frames[0].data.contains("\"delta\":\"hello\""));
        prop_assert_eq!(&frames[1].data, "[DONE]");
    }
}

#[tokio::test]
#[ignore = "scheduled and workflow_dispatch soak test"]
async fn long_runtime_soak_has_no_process_session_leak() {
    let config = SoakConfig::from_environment();
    let timer = SoakTimer::new(Duration::from_secs(config.duration_seconds));
    let completed = Arc::new(AtomicUsize::new(0));
    let runtime = runtime_with_handler(Arc::new(CountingTool {
        active: Arc::new(AtomicUsize::new(0)),
        max_active: Arc::new(AtomicUsize::new(0)),
        completed: Arc::clone(&completed),
        parallel: false,
        delay: Duration::ZERO,
    }));
    let manager = ExecManager::default();
    let mut cycles = 0_u64;
    while timer.should_continue() {
        for call in 0..config.tool_calls_per_cycle {
            runtime
                .handle(
                    "soak-thread",
                    format!("turn-{cycles}"),
                    tool_call("write_count", call),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
        }
        cycles += 1;
        tokio::task::yield_now().await;
    }
    let report = SoakReport {
        elapsed_ms: timer.elapsed_ms(),
        cycles,
        tool_calls: completed.load(Ordering::SeqCst) as u64,
        leaked_process_sessions: manager.active_session_count().unwrap(),
    };
    assert!(report.cycles > 0);
    assert!(report.tool_calls >= config.tool_calls_per_cycle as u64);
    assert_eq!(report.leaked_process_sessions, 0);
}
