pub mod config;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use rmcp::model::CallToolRequestParams;
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess};
use rmcp::ServiceExt;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

pub use config::{McpServerConfig, McpTransport};

const INIT_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// Prefix separating MCP tools from builtins in the model-facing tool list.
pub fn namespaced(server_id: &str, tool: &str) -> String {
    format!("mcp__{server_id}__{tool}")
}

/// Split `mcp__{server}__{tool}` back apart.
pub fn parse_namespaced(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix("mcp__")?;
    rest.split_once("__")
}

/// Model-facing description of one MCP tool (rmcp types stay inside this
/// module).
#[derive(Debug, Clone)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub id: String,
    pub state: String, // running | stopped | error
    pub tool_count: usize,
    pub error: String,
}

type Client = RunningService<RoleClient, ()>;

/// App-global MCP connection manager: lazy start on first use, explicit
/// restart, status snapshots. One connection per configured server.
#[derive(Default)]
pub struct McpManager {
    clients: Mutex<HashMap<String, Arc<Client>>>,
    errors: Mutex<HashMap<String, String>>,
}

impl McpManager {
    async fn connect(&self, cfg: &McpServerConfig) -> Result<Arc<Client>, String> {
        let client = match &cfg.transport {
            McpTransport::Stdio { command, args, env } => {
                let transport = TokioChildProcess::new(
                    crate::process::background_tokio_command(command).configure(|c| {
                        c.args(args);
                        for (k, v) in env {
                            c.env(k, v);
                        }
                    }),
                )
                .map_err(|e| format!("启动 MCP 进程失败：{e}"))?;
                tokio::time::timeout(INIT_TIMEOUT, ().serve(transport))
                    .await
                    .map_err(|_| "MCP 初始化超时".to_string())?
                    .map_err(|e| format!("MCP 握手失败：{e}"))?
            }
            McpTransport::Http { url, headers } => {
                let mut config = StreamableHttpClientTransportConfig::with_uri(url.clone());
                for (k, v) in headers {
                    if k.eq_ignore_ascii_case("authorization") {
                        config.auth_header = Some(v.clone());
                        continue;
                    }
                    let (Ok(name), Ok(value)) = (
                        k.parse::<http::HeaderName>(),
                        v.parse::<http::HeaderValue>(),
                    ) else {
                        return Err(format!("无效的 HTTP 头：{k}"));
                    };
                    config.custom_headers.insert(name, value);
                }
                let transport =
                    StreamableHttpClientTransport::with_client(reqwest13::Client::new(), config);
                tokio::time::timeout(INIT_TIMEOUT, ().serve(transport))
                    .await
                    .map_err(|_| "MCP 初始化超时".to_string())?
                    .map_err(|e| format!("MCP 握手失败：{e}"))?
            }
        };
        Ok(Arc::new(client))
    }

    /// Get a live connection, starting it if needed. Records the last error
    /// for status reporting.
    pub async fn ensure_started(&self, cfg: &McpServerConfig) -> Result<Arc<Client>, String> {
        if let Some(c) = self.clients.lock().await.get(&cfg.id) {
            return Ok(c.clone());
        }
        match self.connect(cfg).await {
            Ok(client) => {
                self.errors.lock().await.remove(&cfg.id);
                self.clients
                    .lock()
                    .await
                    .insert(cfg.id.clone(), client.clone());
                Ok(client)
            }
            Err(e) => {
                self.errors.lock().await.insert(cfg.id.clone(), e.clone());
                Err(e)
            }
        }
    }

    /// List the tools of one server (starting it if necessary).
    pub async fn list_tools(&self, cfg: &McpServerConfig) -> Result<Vec<McpToolInfo>, String> {
        let client = self.ensure_started(cfg).await?;
        let tools = tokio::time::timeout(LIST_TIMEOUT, client.list_all_tools())
            .await
            .map_err(|_| "获取 MCP 工具列表超时".to_string())?
            .map_err(|e| format!("获取 MCP 工具列表失败：{e}"))?;
        Ok(tools
            .into_iter()
            .map(|t| McpToolInfo {
                name: t.name.into_owned(),
                description: t.description.map(|d| d.into_owned()).unwrap_or_default(),
                input_schema: Value::Object((*t.input_schema).clone()),
            })
            .collect())
    }

    /// Call one tool. Text content blocks are concatenated into the result.
    pub async fn call_tool(
        &self,
        cfg: &McpServerConfig,
        tool: &str,
        args: &Value,
    ) -> Result<(String, bool), String> {
        let client = self.ensure_started(cfg).await?;
        let arguments = args.as_object().cloned();
        let result = tokio::time::timeout(
            CALL_TIMEOUT,
            client.call_tool({
                let mut params = CallToolRequestParams::new(tool.to_string());
                if let Some(a) = arguments {
                    params = params.with_arguments(a);
                }
                params
            }),
        )
        .await
        .map_err(|_| "MCP 工具调用超时".to_string())?
        .map_err(|e| format!("MCP 工具调用失败：{e}"))?;

        let mut text = String::new();
        for block in &result.content {
            if let Some(t) = block.as_text() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&t.text);
            }
        }
        if text.is_empty() {
            if let Some(v) = &result.structured_content {
                text = v.to_string();
            }
        }
        if text.is_empty() {
            text = "[无输出]".into();
        }
        Ok((text, result.is_error.unwrap_or(false)))
    }

    /// Drop the connection; the next use lazy-restarts it.
    pub async fn stop(&self, id: &str) {
        if let Some(client) = self.clients.lock().await.remove(id) {
            if let Ok(client) = Arc::try_unwrap(client) {
                let _ = client.cancel();
            }
        }
        self.errors.lock().await.remove(id);
    }

    pub async fn status(&self, configs: &[McpServerConfig]) -> Vec<McpServerStatus> {
        let clients = self.clients.lock().await;
        let errors = self.errors.lock().await;
        let mut out = Vec::new();
        for cfg in configs {
            let (state, error) = if clients.contains_key(&cfg.id) {
                ("running", String::new())
            } else if let Some(e) = errors.get(&cfg.id) {
                ("error", e.clone())
            } else {
                ("stopped", String::new())
            };
            out.push(McpServerStatus {
                id: cfg.id.clone(),
                state: state.into(),
                tool_count: 0,
                error,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespacing_roundtrips() {
        let n = namespaced("srv-1", "read_query");
        assert_eq!(n, "mcp__srv-1__read_query");
        assert_eq!(parse_namespaced(&n), Some(("srv-1", "read_query")));
        assert_eq!(parse_namespaced("read_file"), None);
    }
}
