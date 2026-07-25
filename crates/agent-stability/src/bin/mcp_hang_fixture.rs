use std::borrow::Cow;
use std::sync::Arc;
use std::time::Duration;

use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Implementation, JsonObject, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::{ErrorData, ServiceExt};
use serde_json::json;

#[derive(Clone)]
struct HangServer {
    tools: Arc<Vec<Tool>>,
}

impl HangServer {
    fn new() -> Self {
        let input_schema: JsonObject = serde_json::from_value(json!({
            "type":"object",
            "properties":{},
            "additionalProperties":false
        }))
        .expect("hang fixture input schema");
        Self {
            tools: Arc::new(vec![Tool::new(
                Cow::Borrowed("hang"),
                Cow::Borrowed("Never returns before the client timeout."),
                Arc::new(input_schema),
            )]),
        }
    }
}

impl ServerHandler for HangServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("tietiezhi-mcp-hang-fixture", env!("CARGO_PKG_VERSION")),
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: (*self.tools).clone(),
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if request.name.as_ref() != "hang" {
            return Err(ErrorData::invalid_params("unknown fixture tool", None));
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
        Ok(CallToolResult::success(vec![]))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let running = HangServer::new()
        .serve((tokio::io::stdin(), tokio::io::stdout()))
        .await?;
    running.waiting().await?;
    Ok(())
}
