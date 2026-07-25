# Codex 上下文系统

## 基线

R9 对齐固定版本 `rust-v0.145.0` 的 History、Context Window、Compaction、World State 和 rollout 重建行为。实现位于：

- `crates/agent-context`
- `crates/agent-state`
- `crates/agent-core`
- `desktop/src-tauri/src/commands/codex.rs`

实现不调用或打包 Codex 二进制。压缩提示词按 Apache-2.0 基线逐字保留，其余逻辑在本仓库源码级实现。

## 历史与 Token

- Responses 返回的 Token Usage 是已采样历史的权威值。
- User、Steer、Tool 等尚未被服务端 usage 覆盖的新 Item 使用 Codex 的四字节近似规则追加估算。
- 固定模型目录中的上下文窗口为 272,000 Token；自定义 Provider 使用其模型元数据声明的窗口。
- 未显式配置时，自动压缩线为上下文窗口的 90%。
- 重启后从 canonical `session_meta`、`response_item`、`compacted` 和 `world_state` 顺序重建历史，不依赖聊天快照。

## 压缩生命周期

手动 `thread/compact/start` 立即返回空响应，并异步创建新的 Turn：

1. 发布 `turn/started`。
2. 发布 `contextCompaction` Item 的 `item/started`。
3. 使用当前历史和固定 summarization prompt 请求 `/v1/responses`。
4. 将模型原始完成 Item 仅写入 rollout，不投影成普通助手消息。
5. 写入 canonical `compacted` 记录和 replacement history。
6. 发布 `item/completed`、warning 和 `turn/completed`。

自动压缩在当前活动 Turn 中使用同一 `contextCompaction` Item 生命周期，完成后继续原 Turn，不额外结束 Turn。

压缩后的 replacement history 保留最近真实用户消息，合计最多约 20,000 Token，并把带固定前缀的摘要作为最后一条用户消息。多次压缩通过 UUIDv7 的 first、previous、current window ID 保持窗口链。

固定 App Server V2 已停止发布废弃的 `thread/compacted` 通知；客户端以 `contextCompaction` Item 为唯一可见生命周期。本实现保持相同行为。

## World State

- 首次状态写为 `{"full":true,"state":...}`。
- 后续变化写为 RFC 7386 Merge Patch。
- 无变化不追加 rollout。
- 压缩后清空旧 baseline，下一次写入新的 full 状态。
- 重启和 Fork 都按原 ordinal 恢复 `compacted`、`world_state` 与 Responses Item 的交错顺序。

R9 提供通用持久化和重建引擎。AGENTS、项目环境、Skills、Plugins 等具体 World State 内容由 R20 注入；分层配置和上游默认关闭的高级 TokenBudget 开关由 R21 接入。

## 验证

- `agent-context` 覆盖 90% 窗口、20K 保留、中间截断、窗口恢复和 RFC 7386。
- `agent-state` 覆盖压缩替换、World State 顺序和真实子进程 abort 恢复。
- `agent-core` 覆盖手动压缩、自动压缩、重启恢复、Fork 和 World State baseline。
- 桌面测试覆盖私有摘要请求、摘要文本提取和真实模型窗口传递。
- CI 同时运行协议、迁移、Rust、TypeScript 和生产构建门禁。
