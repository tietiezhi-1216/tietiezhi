# Codex Responses 模型层

## 实现边界

R7 在 `crates/agent-model`、`crates/agent-core` 和 Tauri `commands/codex.rs` 内源码级实现固定基线 `rust-v0.145.0` 的 Responses HTTP/SSE 模型路径，不运行、嵌入或分发上游 `codex` 二进制。

新 Runtime 的 Agent 请求只发送到供应商 `/v1/responses`。旧 Runtime 在 R38 删除前仍可为普通聊天和迁移期旧任务调用 `/v1/chat/completions`，但不参与 `codex_v2_request` 的 Thread/Turn 执行。

## Responses 请求

`ResponsesApiRequest` 对齐上游 `codex-api/src/common.rs`：

- `model`、`instructions` 和 canonical Responses `input`
- `tools`、`tool_choice` 和 `parallel_tool_calls`
- `reasoning.effort`、`summary`、`context`
- `store: false`、`stream: true`
- `reasoning.encrypted_content`
- `service_tier`、`prompt_cache_key`
- `text.verbosity` 和严格 JSON Schema 输出
- `client_metadata`

供应商 base URL 继续使用桌面端统一 `/v1` 归一化，API Key 只从 Rust 的 provider/keyring 解析，前端不会传入或接收密钥。R8 已补齐 Gateway Responses 能力、账号错误、在线模型目录和额度通知，见 `docs/CODEX-GATEWAY.md`。

## SSE 与错误

模型层增量解析以下 Codex 事件：

- `response.created`
- `response.output_item.added`、`response.output_item.done`
- `response.output_text.delta`
- `response.custom_tool_call_input.delta`
- `response.reasoning_summary_part.added`
- `response.reasoning_summary_text.delta`、`done`
- `response.reasoning_text.delta`
- `response.metadata`
- `response.completed`、`failed`、`incomplete`

HTTP Header 和 metadata 中的 server model、verification、moderation、safety buffering、reasoning included 与 models etag 会转换为内部强类型事件。公开时间线由 `agent-core` 发布 `item/started`、Item delta、`item/completed`、`model/rerouted`、`model/verification`、`model/safetyBuffering/updated`、`turn/moderationMetadata` 和 `thread/tokenUsage/updated`。

错误分类保持 Codex 语义：context window、quota/usage、invalid request、cyber policy 和 server overloaded 不做流重试；网络、SSE 中断和服务端声明的 retryable error 才进入重试。请求层允许初次请求后最多 4 次 5xx/transport 重试，流层允许最多 5 次重连，指数退避带 0.9 到 1.1 抖动并识别 rate-limit 延迟。Runtime 状态或客户端通知投影失败使用非重试的 consumer error，不能重复发送模型请求。

## Turn 执行

Tauri 在 `turn/start` 成功后创建 Turn 专属取消令牌并异步运行 Responses：

1. 首次采样只消费 `turn/start` 输入。
2. 运行中的 `turn/steer` 先进入同 Turn 队列，不提前写入模型历史。
3. 当前采样完成后才把 steer User Message 追加到 canonical rollout 和历史，再开始下一次采样。
4. `end_turn: false` 或待处理 steer 会继续同一 Turn。
5. JSON Schema 输出约束在 Turn 的后续采样中保持。
6. `turn/interrupt`、archive 和 delete 只有在 JSON-RPC 请求成功后才取消匹配的网络流。

取消表同时绑定 Thread ID 和 Turn ID。旧 Turn 的异步清理不能删除同 Thread 新 Turn 的取消令牌，无效 Turn ID 也不能误取消正确的活动 Turn。

完成的 Responses Item 按原始顺序写入 rollout，并投影为 V2 Reasoning 和 Agent Message Item。Token Usage 在 Thread 范围累积，按 Codex `token_count` 事件持久化；重启、resume 和 fork 可以从 rollout 恢复累计值。

## 模型目录

`model/list` 使用上游固定模型目录的 V2 公开投影，支持 `cursor`、`limit` 和 `includeHidden`，并保持 Codex 的数字游标规则。选中 Provider 已缓存 `/v1/models` 元数据时，R8 会以服务端声明覆盖推理等级、默认等级和输入模态，同时保留固定模型的公开名称与说明；未知模型生成完整 V2 投影。

- 固定目录：`crates/agent-model/models.json`
- 固定来源：`codex-rs/models-manager/models.json`
- 来源与投影哈希：`shared/codex/v2/model-baseline.json`
- CI 校验：`pnpm check:codex-models`

当前固定目录包含 8 个模型、5 个可见模型，且只有 `gpt-5.6-sol` 标记为默认。在线目录只影响当前 Provider 的运行时投影，不改写固定基线文件。

## 验证

```bash
cargo test --manifest-path crates/agent-model/Cargo.toml
cargo clippy --manifest-path crates/agent-model/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path crates/agent-core/Cargo.toml
cargo clippy --manifest-path crates/agent-core/Cargo.toml --all-targets -- -D warnings
cd desktop && pnpm check:codex-models
```

`agent-model` 测试覆盖请求 JSON、UTF-8/CRLF SSE 分片、全部 R7 delta、usage、错误分类、metadata、分页、真实本地 HTTP 流、请求重试、SSE 断线重连和 consumer failure 不重试。`agent-core` 测试覆盖 canonical Item、delta、同 Turn steer 顺序、usage 累积与 rollout 恢复、模型通知和 V2 类型校验。
