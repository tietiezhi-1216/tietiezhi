# Codex Thread 生命周期

## 实现边界

R5 在 `crates/agent-core` 内实现源码级 `ThreadManager`，直接消费 R2 固定的 App Server V2 类型。运行时位于 Tauri 进程，不下载、运行、链接或分发上游 `codex` 二进制。

桌面端通过 `codex_v2_request` 发送带原始请求 ID 的 V2 请求；响应保持 `{id,result}` 或 `{id,error}`，通知通过 `codex-v2-notification` 事件发布。每个请求和通知在发送前都通过 `crates/agent-protocol` 的固定类型校验。

## Client Requests

| 方法 | 行为 |
| --- | --- |
| `thread/start` | 创建 UUIDv7 Thread，解析模型、供应商、cwd、审批、沙箱、临时模式和来源，订阅当前连接 |
| `thread/resume` | 从已加载状态或 SQLite/rollout 恢复，应用本次配置覆盖并重新订阅 |
| `thread/fork` | 保留 Session ID，记录 `forkedFromId`，复制 canonical 历史，可按 `lastTurnId` 截断 |
| `thread/read` | 不隐式加载 Thread；按 `includeTurns` 决定是否返回 Turn |
| `thread/list` | 支持归档、cwd、供应商、来源、搜索、排序、限制和不透明游标 |
| `thread/loaded/list` | 仅返回内存中已加载的 Thread，支持不透明游标 |
| `thread/archive` | 标记归档、卸载 Thread，并发送 `thread/archived` 与必要的 `thread/closed` |
| `thread/unarchive` | 恢复索引但不隐式加载，返回 `notLoaded` Thread |
| `thread/delete` | 删除索引和受管 Thread 目录，发送删除与关闭通知 |
| `thread/name/set` | 去除首尾空白，拒绝空名称，不因元数据修改隐式加载 Thread |
| `thread/metadata/update` | 按三态补丁更新 Git SHA、分支和源地址 |
| `thread/inject_items` | 将原始 Responses API Item 加入内存历史，并为持久 Thread 追加 `response_item` |
| `thread/rollback` | 拒绝零值、越界、活动中和临时 Thread；追加 `thread_rolled_back` 事件 |
| `thread/unsubscribe` | 区分 `notLoaded`、`notSubscribed`、`unsubscribed`，最后一个订阅退出时卸载 |
| `thread/approveGuardianDeniedAction` | 将已验证的 Guardian 事件送入 Thread 队列，供 R27 审阅执行器消费 |

`thread/start` 与 `thread/fork` 生成的 ID 使用 UUIDv7。旧任务的 UUIDv4 仍可读取和恢复，但不会为历史数据伪造新身份。

## Server Notifications

R5 已实现并通过固定协议类型校验：

- `thread/started`
- `thread/status/changed`
- `thread/archived`
- `thread/unarchived`
- `thread/deleted`
- `thread/closed`
- `thread/name/updated`
- `thread/environment/connected`
- `thread/environment/disconnected`
- `thread/settings/updated`
- `thread/tokenUsage/updated`

生命周期与状态通知向所有已连接客户端广播；环境、设置和 Token Usage 通知按 Thread 订阅者路由。状态重复值不会重复发送；活动状态只接受 Codex 的 `waitingOnApproval` 和 `waitingOnUserInput` 标记。

## 持久化与恢复

新 Thread 的 rollout 首行使用 Codex canonical `session_meta` 字段，包括：

- `session_id`、`id`、分叉和父 Thread 身份
- RFC 3339 时间、cwd、originator 与 CLI 版本
- Session 来源、Thread 来源、模型供应商和历史模式
- 可选 Git 信息

SQLite v3 的 `canonical_json` 是查询缓存。状态库损坏、丢失或重建后，`ThreadManager` 扫描受管 rollout 的 canonical `session_meta` 恢复 Thread 索引；R4 的旧 `threadId` 元数据仍由会话迁移层处理，不会被误判为新 Runtime Thread。

`response_item`、`turn_context` 与 `event_msg` 是追加式历史。临时 Thread 只存在于内存，不写 SQLite 或 rollout。R6 已把 Turn 开始、Item、完成和中断改为 canonical rollout 投影，并移除 SQLite `canonical_json` 内的 Turn 快照缓存。具体格式和恢复语义见 `docs/CODEX-TURNS.md`。

## 迁移兼容

- canonical Thread 与已迁移旧任务进入同一会话列表；前端通过 Thread API 恢复，兼容 `task.json` 只提供正文与降级回滚锚点。
- App Server V2 原地接管旧任务 ID、项目和工作区，不复制目录。
- R38 已删除旧 Workspace Agent 循环；归档、恢复、删除与执行均走 Thread 生命周期。

## 验证

在 `desktop/` 执行：

```bash
cargo test --manifest-path ../crates/agent-state/Cargo.toml
cargo test --manifest-path ../crates/agent-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
pnpm check:codex-parity
pnpm check:codex-schema
pnpm test:codex-protocol-ts
pnpm typecheck
pnpm build
```

`agent-core` 测试覆盖协议响应、UUIDv7、重启恢复、SQLite 损坏重建、临时 Thread、分叉、归档、删除、订阅、分页、元数据、注入 Item、回滚、Guardian 路由以及 Thread、Turn 和 Item 通知发布器。
