# Codex MCP Runtime

## 范围

R19 按固定上游 `rust-v0.145.0` 在 Tauri Rust 进程内实现 MCP 客户端、App Server V2 请求、反向 Elicitation 和强类型 Item，不运行或打包上游 Codex 二进制。

- `crates/agent-mcp` 负责 stdio、Streamable HTTP、OAuth、工具、资源、进度和 Elicitation。
- `desktop/src-tauri/src/mcp` 把 MCP Host 事件映射到 App Server V2。
- `desktop/src-tauri/src/commands/codex.rs` 实现 MCP Client Request，并把模型工具调用注册到统一 Tool Runtime。
- `crates/agent-core` 持久化和恢复 `mcpToolCall` Item。

## 传输与生命周期

- stdio 使用子进程 transport，握手、工具调用和资源读取分别受启动与调用超时约束。
- Streamable HTTP 支持自定义 Header 和 OAuth transport。
- `required: true` 的服务器启动失败会阻止 Turn；可选服务器失败只从本次工具目录移除。
- `enabledTools` 与 `disabledTools` 在工具暴露和直接调用两条路径上同时执行。
- 服务器启动状态发布 `mcpServer/startupStatus/updated`，工具进度发布 `item/mcpToolCall/progress`。
- 进度 Token 精确绑定 `threadId/turnId/itemId`，并发调用不会把进度归给错误 Item。

## OAuth

- OAuth 使用 Protected Resource/Authorization Server metadata discovery。
- 授权码流程使用 PKCE S256、动态客户端注册和 loopback callback。
- 凭据按服务器与 URL 哈希后写入 macOS Keychain 或 Windows Credential Manager，不进入设置 JSON、rollout 或日志。
- Keyring I/O 在 blocking worker 上运行，不阻塞 Tauri async runtime。
- HTTP transport 使用 rmcp `AuthClient`，每次请求通过共享互斥状态取得 Token；临近过期时单飞刷新，失败后要求重新授权。
- 登录请求立即返回 authorization URL，完成后发布 `mcpServer/oauthLogin/completed` 并重新建立服务器连接。

## 工具、资源与内容

- 工具目录保留 `title`、`inputSchema`、`outputSchema`、`annotations`、`icons` 和 `_meta`。
- `readOnlyHint` 决定统一 Tool Runtime 是否允许并发。
- `destructiveHint` 且非只读的工具在执行前发起表单 Elicitation；审批策略禁止 Elicitation 时直接拒绝。
- 工具结果完整保留 text、image、audio、embedded resource、resource link、`structuredContent`、`isError` 和 `_meta`。
- `mcpServerStatus/list` 支持稳定排序、cursor/limit、`full` 与 `toolsAndAuthOnly` 详情。
- `mcpServer/resource/read` 和 `mcpServer/tool/call` 使用固定 V2 Schema 校验请求与响应。

## Elicitation

- MCP Client capability 声明 form/schema Elicitation。
- Server Request 使用 `mcpServer/elicitation/request`，包含 Thread、Turn 与 Server 身份。
- 前端按 JSON Schema 渲染 boolean、number、string、enum/oneOf 字段，并返回 `{action, content, _meta}`。
- `accept`、`decline` 和 `cancel` 保持不同语义；取消关闭 pending request，不伪装成拒绝。

## 持久化

- 模型路径和直接 V2 调用都生成 `mcpToolCall` Item。
- 开始、完成、失败、参数、富结果、错误和耗时写入 canonical rollout。
- Thread 重启恢复和 Fork 保留图片、音频、结构化内容与 `_meta`。
- Workspace 只通过同一 Responses Tool Runtime 调用 MCP；正文 UI 的兼容投影不参与 MCP 执行或持久化。

## 验证

- source-built stdio fixture 验证握手、工具 Schema、annotations、resources、templates、文本、图片、音频、structured content、`_meta` 和进度归因。
- Elicitation Broker 测试验证固定 V2 Server Request 及 accept/cancel/unknown response。
- Core 测试验证 `mcpToolCall` 生命周期、rollout 重启恢复和 Thread Fork。
- SSR 测试验证 Elicitation 表单、按钮和精确响应结构。
- CI 在 macOS 和 Windows 运行 MCP crate、Core、桌面 Rust、协议和前端测试。
