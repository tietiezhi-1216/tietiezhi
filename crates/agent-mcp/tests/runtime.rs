use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tietiezhi_agent_mcp::{
    HostFuture, McpCallContext, McpElicitation, McpElicitationResponse, McpHost, McpManager,
    McpProgress, McpServerConfig, McpTransport,
};

#[derive(Default)]
struct TestHost {
    progress: Mutex<Vec<McpProgress>>,
}

impl McpHost for TestHost {
    fn progress(&self, progress: McpProgress) {
        self.progress.lock().unwrap().push(progress);
    }

    fn startup_status(&self, _server: &str, _status: &str, _error: Option<&str>) {}

    fn oauth_completed(
        &self,
        _server: &str,
        _thread_id: Option<&str>,
        _success: bool,
        _error: Option<&str>,
    ) {
    }

    fn elicit(&self, _request: McpElicitation) -> HostFuture<McpElicitationResponse> {
        Box::pin(async {
            McpElicitationResponse {
                action: "decline".into(),
                content: None,
                meta: None,
            }
        })
    }
}

fn fixture_config() -> McpServerConfig {
    McpServerConfig {
        id: "fixture".into(),
        name: "Fixture".into(),
        enabled: true,
        required: true,
        enabled_tools: Vec::new(),
        disabled_tools: Vec::new(),
        startup_timeout_secs: 10,
        tool_timeout_secs: 10,
        oauth_scopes: Vec::new(),
        transport: McpTransport::Stdio {
            command: env!("CARGO_BIN_EXE_mcp_fixture").into(),
            args: Vec::new(),
            env: HashMap::new(),
        },
    }
}

#[tokio::test]
async fn stdio_server_preserves_inventory_resources_and_rich_results() {
    let manager = McpManager::default();
    let host = Arc::new(TestHost::default());
    manager.set_host(host.clone()).unwrap();
    let config = fixture_config();
    let inventory = manager.inventory(&config).await.expect("inventory");
    assert_eq!(inventory.tools.len(), 1);
    assert_eq!(inventory.tools[0]["name"], "rich");
    assert_eq!(inventory.tools[0]["title"], "Rich Fixture");
    assert_eq!(inventory.tools[0]["annotations"]["readOnlyHint"], true);
    assert!(inventory.tools[0].get("outputSchema").is_some());
    assert_eq!(inventory.resources[0]["uri"], "fixture://notes/readme");
    assert_eq!(
        inventory.resource_templates[0]["uriTemplate"],
        "fixture://notes/{name}"
    );

    let resource = manager
        .read_resource(&config, "fixture://notes/readme")
        .await
        .expect("resource");
    assert_eq!(resource[0]["text"], "fixture resource body");

    let result = manager
        .call_tool_rich(
            &config,
            "rich",
            &json!({"message":"hello"}),
            Some(McpCallContext {
                thread_id: "thread".into(),
                turn_id: "turn".into(),
                item_id: "item".into(),
            }),
            None,
        )
        .await
        .expect("rich result");
    assert!(!result.is_error);
    assert_eq!(result.content[0]["text"], "echo:hello");
    assert_eq!(result.content[1]["type"], "image");
    assert_eq!(result.content[2]["type"], "audio");
    assert_eq!(result.structured_content, Some(json!({"echo":"hello"})));
    assert_eq!(result.meta, Some(json!({"fixture/result":"preserved"})));
    {
        let progress = host.progress.lock().unwrap();
        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0].context.item_id, "item");
        assert_eq!(progress[0].message, "fixture complete");
    }

    manager.stop(&config.id).await;
}
