# Codex Turn 生命周期

## 实现边界

R6 在 `crates/agent-core` 内实现 Codex App Server V2 的 Turn 状态机，不运行、嵌入或分发上游 `codex` 二进制。实现对齐固定基线 `rust-v0.145.0` 的公开协议、rollout 顺序和恢复语义。

## Client Requests

| 方法 | 行为 |
| --- | --- |
| `turn/start` | 允许空输入；生成 UUIDv7 Turn 与 User Message Item；应用 sticky cwd、审批、沙箱、模型、service tier、effort、summary 和 personality 覆盖 |
| `turn/steer` | 只接受非空输入；要求 `expectedTurnId` 与当前活动 Turn 一致；输入进入同一 Turn |
| `turn/interrupt` | 中断活动 Turn；空 `turnId` 保留 Codex 的启动期取消语义；错误 Turn ID 不会影响当前执行 |

`clientUserMessageId` 是持久幂等键。同一键和同一输入重复提交时返回原 Turn，不创建 Item、不重新排队、不重复发送通知；同一键配合不同输入会返回 JSON-RPC `-32600`。

单条用户输入最多 `1 << 20` 个文本字符。超过限制返回 Codex 的 `input_too_large` 数据；公开 HTTP/HTTPS 图片 URL 返回 `-32600`，只接受 inline data URL 或本地路径。

## Server Notifications

R6 已接入并在发布前通过 `agent-protocol` 固定类型校验：

- `turn/started`
- `turn/completed`
- `turn/moderationMetadata`
- `item/started`
- `item/completed`
- 活动与终态对应的 `thread/status/changed`

`turn/start` 响应和 `turn/started` 通知都不内联完整 Item，`itemsView` 为 `notLoaded`；通过 `thread/read`、`thread/resume` 和 `thread/fork` 请求历史时才投影完整 Item。Turn 的完成、失败和中断统一走一个终态路径，生成时间、持续时间、错误和 idle 状态。

## Rollout 与恢复

每个真实 Turn 按顺序追加：

1. `event_msg.task_started`
2. `turn_context`
3. 用户的 canonical Responses `response_item`
4. `event_msg.item_started`
5. `event_msg.item_completed`
6. `event_msg.turn_complete`、`turn_aborted` 或错误事件

公开 V2 `ThreadItem` 使用 camelCase；rollout 中的 Core `TurnItem` 使用 Codex 原生枚举标签和 snake_case 字段。R6 显式执行双向转换，rollout 的 User Message 写为 `type: "UserMessage"`、`client_id` 和 Core `UserInput`，恢复时再投影为 `type: "userMessage"`、`clientId` 和 V2 `UserInput`。

SQLite `canonical_json` 不再保存 Turn 快照。Thread 的 Turn、Item、活动状态和幂等键全部从 canonical rollout 顺序重建。进程终止时仍为 `inProgress` 的 Turn 在首次恢复时只追加一次 `turn_aborted` 并变为 `interrupted`，未消费输入不会自动重放，避免模型或工具产生重复副作用。

归档或删除活动 Thread 会先中断当前 Turn，再关闭 Thread。最后一个订阅者在 Turn 活动时退出只标记延迟卸载，Turn 进入终态后再关闭。

## R7 接口

`take_turn_inputs(thread_id, turn_id)` 以 exactly-once 内存队列把已接受的 Start/Steer 输入交给 R7 Responses 执行器；`complete_turn` 将执行结果送回统一终态路径。崩溃后不重建该执行队列，只恢复为 interrupted 历史。

## 验证

```bash
cargo test --manifest-path crates/agent-state/Cargo.toml
cargo test --manifest-path crates/agent-core/Cargo.toml
cargo clippy --manifest-path crates/agent-core/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path crates/agent-state/Cargo.toml --all-targets -- -D warnings
```

R6 的 19 项 `agent-core` 测试覆盖协议响应、canonical Item 转换、幂等冲突、Steer 前置条件、空输入、输入上限、远程图片拒绝、中断、失败、审核元数据、活动归档、分叉顺序、崩溃恢复一次性中断和不重放。
