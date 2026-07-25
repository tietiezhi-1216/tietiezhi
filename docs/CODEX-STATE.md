# Codex 本地状态与 Rollout

## 存储边界

R4 按 Codex 的可重建索引与追加式历史分层实现本地状态：

| 数据 | 位置 | 角色 |
| --- | --- | --- |
| Thread 元数据 | `app_data_dir()/agent-runtime/state.sqlite3` | 可查询、可重建的 SQLite 索引 |
| 执行历史 | `app_data_dir()/tasks/{threadId}/rollout.jsonl` | 权威追加日志 |
| 兼容快照 | `app_data_dir()/tasks/{threadId}/task.json` | 迁移期旧 UI 兼容镜像 |
| 损坏数据库备份 | `app_data_dir()/agent-runtime/db-backups/sqlite-*` | 自动恢复前保留数据库及 WAL/SHM |

核心实现位于 `crates/agent-state`。它不链接、运行或分发上游 Codex 二进制。

## SQLite

SQLite 使用 WAL、`synchronous=FULL`、外键和五秒 busy timeout。`threads` 表保存：

- Thread ID 与 rollout 路径
- 创建、更新、归档和置顶时间
- 标题、预览、项目、任务模式和 Agent
- checkpoint revision 与最后完整 ordinal
- 恢复状态
- R5 canonical Thread 查询缓存（SQLite v3 `canonical_json`）

迁移按 `PRAGMA user_version` 顺序运行，并记录在 `schema_migrations`。启动时执行 `quick_check`；确认损坏时只移动当前状态数据库及其 `-wal`、`-shm`，随后创建新数据库。Thread 索引会从 rollout 和兼容快照重建。

SQLite 不是会话历史的单一事实源。发生“rollout 已写入、SQLite 事务尚未提交”的中断时，下一次读取以 rollout 为准并修复索引。

## JSONL Rollout

每行都有毫秒时间和递增 ordinal，载荷使用 Codex 风格的扁平 `type` 与 `payload`：

- `session_meta`：Thread 身份、创建时间、rollout 路径和来源
- `turn_context`：每个真实 Turn 的 cwd、审批、沙箱、模型、推理配置和 Turn ID
- `response_item`：模型可见的 canonical Responses API Item
- `legacy_checkpoint`：迁移期完整会话快照
- `event_msg`：带 `threadId`、`turnId`、`itemId` 和 `sequence` 的 R3 流式事件

新写入先进入 rollout 并 flush，checkpoint 还会执行 `sync_data`，随后用 SQLite 事务更新索引，最后原子替换兼容 `task.json`。同一进程内相同路径共享一个锁和文件句柄，checkpoint 与流式事件不会互相覆盖。

R5 新 Thread 已写入 canonical `session_meta` 和 `response_item`。R6 增加 `turn_context` 以及 canonical `task_started`、Core `TurnItem` 生命周期和 Turn 终态事件，并按原始 ordinal 保留不同 rollout 类型的交错顺序。状态库重建后，`ThreadManager` 直接从 `session_meta` 和这些事件恢复完整 Turn；R4 的旧 `threadId` 元数据继续由会话迁移层处理。`legacy_checkpoint` 只负责迁移现有任务，并在 R38 删除旧运行时后停止写入。

## 崩溃恢复

读取端逐行解析 rollout，只接受以换行结束且 JSON 完整的记录。遇到无换行尾部或非法记录时：

1. 保留最后一条完整记录之前的内容。
2. 截断不完整尾部及其后缀。
3. 读取最近的 `legacy_checkpoint`。
4. 按日志顺序重放 checkpoint 后的 `event_msg`。
5. 恢复部分 Assistant 文本、Reasoning、工具状态、审批、压缩和错误。
6. 将仍处于运行中的工具在 UI 恢复时标记为上次运行未正常结束。
7. 写入新的完整 checkpoint，并修复 SQLite 与 `task.json`。

新 Runtime 不重放崩溃前未完成的外部执行。恢复 canonical rollout 时，活动 Turn 被追加一次 `turn_aborted` 并投影为 `interrupted`；再次重启不会重复追加。

`crates/agent-state/tests/crash_recovery.rs` 启动独立子进程，写入 checkpoint、未完成工具事件和半条 JSON 后直接 `abort`。父进程验证历史、未完成事件和尾部修复，不以 mock 代替进程中断。

## 旧数据迁移

- 旧 `conversations/{id}.json` 与工作区迁移仍先归并到 `tasks/{id}`。
- 只有 `task.json` 的任务首次访问时写入 `session_meta`、首个 checkpoint 和 SQLite 索引。
- 旧消息缺少 Thread/Turn/Item 身份时按可选字段读取，不伪造历史身份。
- 新流式事件的身份随消息、工具、审批、错误和压缩项持久化。
- 数据库丢失或损坏时扫描任务目录重建；rollout 与兼容快照都不存在的陈旧索引会被清理。

## 验证

在 `desktop/` 执行：

```bash
cargo test --manifest-path ../crates/agent-state/Cargo.toml
cargo test --manifest-path ../crates/agent-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:chat-event-migration
pnpm test:conversation-migration
pnpm typecheck
pnpm build
```
