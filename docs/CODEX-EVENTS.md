# Codex Thread、Turn、Item 事件模型

## 目标

R3 将桌面 Agent 的所有流式事件纳入统一的 Thread、Turn、Item 身份和顺序模型。实现位于 `crates/agent-events`，不依赖 Tauri、模型供应商或上游 Codex 二进制。

每个增量事件都必须包含：

| 字段 | 约束 |
| --- | --- |
| `threadId` | 非空，同一任务稳定 |
| `turnId` | 非空，同一次执行稳定 |
| `itemId` | 非空，同一 Item 生命周期稳定 |
| `sequence` | Turn 内从 1 开始严格递增 |
| `emittedAtMs` | 事件发出时的 Unix 毫秒时间 |

事件载荷保持扁平序列化，因此旧前端仍可按 `type` 分派，同时能够使用正式身份字段构建时间线、持久化和断线恢复。

## 生命周期映射

`desktop/src-tauri/src/agent/events.rs` 中的 `ChatEventEmitter` 是旧 Agent 循环到新事件总线的迁移适配器。

| 旧事件 | Item 身份 |
| --- | --- |
| `delta` | 同一 Agent Message Item |
| `reasoning` | 同一 Reasoning Item |
| `toolCallStart`、`toolProgress`、`toolResult` | 工具调用 ID |
| `permissionRequest` | 当前工具 Item；不存在时使用审批 ID |
| `contextCompactionStarted`、`contextUsage`、`contextCompacted` | 同一 Context Compaction Item |
| `started`、`retrying`、`done`、`error` | Turn 状态 Item |
| `usage` | Agent Message Item；尚无消息时使用 Turn 状态 Item |

工具结果和压缩完成后结束对应 Item 生命周期。后续同类工作会创建新的 Item。

## 兼容策略

- Rust 后端只向 Tauri Channel 发送带身份的 `ScopedChatEvent`。
- TypeScript 业务层只接收带身份的 `ChatEvent`。
- `LegacyChatEvent` 仅作为迁移期 IPC 输入，统一由 `createChatEventNormalizer` 补齐身份和顺序。
- 已带合法身份的事件保持原对象和原顺序，不重复包装。
- 旧 mock、旧应用进程或滚动升级期间的旧事件仍可被当前前端读取。
- R4 已将这些身份写入 rollout 与任务项，SQLite 保存可重建的 Thread 索引；R5 的正式 `ThreadManager` 已分配 UUIDv7 Thread ID 并发送 App Server 通知，R6 将接管 Turn 与 Item ID；R31 将桌面时间线切到强类型 Thread Item。
- R38 删除旧 Agent 循环后，同时删除 `LegacyChatEvent` 兼容输入。

## 验证

在 `desktop/` 执行：

```bash
cargo test --manifest-path ../crates/agent-events/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:chat-event-migration
pnpm typecheck
pnpm build
```

Rust 测试验证非空身份、单调序列、扁平载荷和 Item ID 稳定性。TypeScript 迁移测试验证旧增量事件、工具审批、工具结果、上下文压缩以及原生新事件的兼容行为。
