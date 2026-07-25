use std::borrow::Cow;
use std::sync::Arc;

use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ContentBlock, Implementation, JsonObject,
    ListResourceTemplatesResult, ListResourcesResult, ListToolsResult, Meta,
    PaginatedRequestParams, ProgressNotificationParam, ReadResourceRequestParams,
    ReadResourceResult, Resource, ResourceContents, ResourceTemplate, ServerCapabilities,
    ServerInfo, Tool, ToolAnnotations,
};
use rmcp::{ErrorData, ServiceExt};
use serde_json::json;

const RESOURCE_URI: &str = "fixture://notes/readme";

#[derive(Clone)]
struct FixtureServer {
    tools: Arc<Vec<Tool>>,
}

impl FixtureServer {
    fn new() -> Self {
        let input_schema: JsonObject = serde_json::from_value(json!({
            "type":"object",
            "properties":{"message":{"type":"string"}},
            "required":["message"],
            "additionalProperties":false
        }))
        .expect("fixture input schema");
        let output_schema: JsonObject = serde_json::from_value(json!({
            "type":"object",
            "properties":{"echo":{"type":"string"}},
            "required":["echo"],
            "additionalProperties":false
        }))
        .expect("fixture output schema");
        let mut rich = Tool::new(
            Cow::Borrowed("rich"),
            Cow::Borrowed("Return text, image, audio and structured content."),
            Arc::new(input_schema),
        );
        rich.title = Some("Rich Fixture".into());
        rich.output_schema = Some(Arc::new(output_schema));
        rich.annotations = Some(
            ToolAnnotations::new()
                .read_only(true)
                .destructive(false)
                .idempotent(true),
        );
        let mut meta = Meta::new();
        meta.insert("fixture/tool".into(), json!(true));
        rich.meta = Some(meta);
        Self {
            tools: Arc::new(vec![rich]),
        }
    }

    fn resource() -> Resource {
        Resource::new(RESOURCE_URI, "readme")
            .with_title("Fixture Readme")
            .with_description("MCP integration test resource")
            .with_mime_type("text/plain")
    }

    fn template() -> ResourceTemplate {
        ResourceTemplate::new("fixture://notes/{name}", "fixture-note")
            .with_title("Fixture Note")
            .with_description("MCP integration test template")
            .with_mime_type("text/plain")
    }
}

impl ServerHandler for FixtureServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(
            Implementation::new("tietiezhi-mcp-fixture", env!("CARGO_PKG_VERSION"))
                .with_title("Tietiezhi MCP Fixture"),
        )
        .with_instructions("Exercise rich MCP results and resources.")
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

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult {
            resources: vec![Self::resource()],
            next_cursor: None,
            meta: None,
        })
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        Ok(ListResourceTemplatesResult {
            resource_templates: vec![Self::template()],
            next_cursor: None,
            meta: None,
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ReadResourceResult, ErrorData> {
        if request.uri != RESOURCE_URI {
            return Err(ErrorData::resource_not_found(
                "fixture resource not found",
                Some(json!({"uri":request.uri})),
            ));
        }
        Ok(ReadResourceResult::new(vec![
            ResourceContents::TextResourceContents {
                uri: request.uri,
                mime_type: Some("text/plain".into()),
                text: "fixture resource body".into(),
                meta: None,
            },
        ]))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if request.name.as_ref() != "rich" {
            return Err(ErrorData::invalid_params("unknown fixture tool", None));
        }
        let message = request
            .arguments
            .as_ref()
            .and_then(|value| value.get("message"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| ErrorData::invalid_params("message is required", None))?;
        if let Some(token) = context.meta.get_progress_token() {
            context
                .peer
                .notify_progress(
                    ProgressNotificationParam::new(token, 1.0)
                        .with_total(1.0)
                        .with_message("fixture complete"),
                )
                .await
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        }
        let mut meta = Meta::new();
        meta.insert("fixture/result".into(), json!("preserved"));
        let mut result = CallToolResult::success(vec![
            ContentBlock::text(format!("echo:{message}")),
            ContentBlock::image("AA==", "image/png"),
            ContentBlock::audio("AA==", "audio/wav"),
        ])
        .with_meta(Some(meta));
        result.structured_content = Some(json!({"echo":message}));
        Ok(result)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let service = FixtureServer::new();
    let running = service
        .serve((tokio::io::stdin(), tokio::io::stdout()))
        .await?;
    running.waiting().await?;
    Ok(())
}
