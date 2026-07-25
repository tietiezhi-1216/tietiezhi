use std::process::Command;
use tempfile::TempDir;
use tietiezhi_agent_state::StateStore;
use uuid::Uuid;

#[test]
fn recovers_checkpoint_and_unfinished_event_after_process_abort() {
    let temp = TempDir::new().unwrap();
    let runtime = temp.path().join("runtime");
    let thread_id = Uuid::new_v4().to_string();
    let rollout = temp
        .path()
        .join("tasks")
        .join(&thread_id)
        .join("rollout.jsonl");
    let status = Command::new(env!("CARGO_BIN_EXE_state_crash_fixture"))
        .arg(&runtime)
        .arg(&rollout)
        .arg(&thread_id)
        .status()
        .unwrap();
    assert!(!status.success());

    let store = StateStore::open(&runtime).unwrap();
    let recovered = store.recover_rollout(&rollout).unwrap();
    let checkpoint = recovered.checkpoint.unwrap();
    assert_eq!(checkpoint.thread_id, thread_id);
    assert_eq!(checkpoint.payload["messages"][0]["content"], "before crash");
    assert_eq!(recovered.trailing_events.len(), 1);
    assert_eq!(
        recovered.trailing_events[0]["type"],
        serde_json::json!("toolCallStart")
    );
    assert!(recovered.truncated_bytes > 0);
}
