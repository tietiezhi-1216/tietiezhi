use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use tietiezhi_agent_state::{StateStore, ThreadMetadata};

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let root = PathBuf::from(arguments.next().expect("runtime root"));
    let rollout_path = PathBuf::from(arguments.next().expect("rollout path"));
    let thread_id = arguments
        .next()
        .expect("thread id")
        .to_string_lossy()
        .into_owned();

    let store = StateStore::open(&root).expect("state store");
    store
        .upsert_checkpoint(
            ThreadMetadata {
                id: thread_id.clone(),
                rollout_path: rollout_path.clone(),
                created_at_ms: 100,
                updated_at_ms: 200,
                title: "crash fixture".into(),
                project_id: String::new(),
                task_mode: "code".into(),
                archived_at_ms: 0,
                pinned_at_ms: 0,
                agent_id: String::new(),
                preview: "before crash".into(),
                revision: 0,
                last_complete_ordinal: 0,
                recovery_status: "clean".into(),
            },
            &json!({"id": thread_id, "messages": [{"content": "before crash"}]}),
        )
        .expect("checkpoint");
    let appender = store.rollout_appender(&rollout_path).expect("appender");
    appender
        .append_event(json!({
            "type": "toolCallStart",
            "threadId": thread_id,
            "turnId": "turn-crash",
            "itemId": "call-crash",
            "sequence": 1,
            "emittedAtMs": 300,
            "id": "call-crash",
            "name": "bash",
            "args": {"command": "sleep 30"}
        }))
        .expect("event");
    drop(appender);

    let mut file = OpenOptions::new()
        .append(true)
        .open(&rollout_path)
        .expect("rollout");
    file.write_all(br#"{"timestampMs":400,"ordinal":"#)
        .expect("partial write");
    file.flush().expect("flush");
    std::process::abort();
}
