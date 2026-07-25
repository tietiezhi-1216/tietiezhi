# Codex 上游基线与源码映射

## 固定基线

- 上游仓库：`https://github.com/openai/codex`
- 稳定版本：`rust-v0.145.0`
- 提交：`25af12f7e61572b0bc18ddb1008be543b91519b0`
- 协议：Codex App Server V2
- 许可证：Apache-2.0
- 基线文件：`shared/codex/v2/upstream-baseline.json`
- 功能账本：`docs/CODEX-PARITY.md`

运行时实现不得直接跟随上游 `main`。升级时先固定新的稳定 Tag，生成协议差异，审查行为变化，完成迁移测试后再更新本文件、机器基线和功能账本。

## 实现原则

- 不运行、不下载、不打包上游 `codex` 二进制。
- 核心运行时在 Tauri Rust 进程内实现。
- 平台沙箱确需辅助进程时，由本仓库源码构建辅助目标，不分发上游预编译文件。
- 可以按 Apache-2.0 移植上游实现，但必须在源文件和 `THIRD_PARTY_NOTICES.md` 中记录来源。
- Tietiezhi 产品能力通过 Dynamic Tool、Extension 或服务映射接入，不绕过统一的 Thread、Turn、Item、Sandbox 和 Approval 生命周期。
- Agent 模型协议最终统一为 Responses API。Chat Completions 仅允许继续服务不带工具的普通聊天。
- 新旧 Runtime 只在迁移期并存。R38 完成后删除旧 Agent 循环。

## 源码映射

| 能力 | Codex 0.145.0 源码 | Tietiezhi 目标模块 | 阶段 |
| --- | --- | --- | --- |
| 旧运行时审批止血 | `codex-rs/core/src/tools/approvals.rs` | `desktop/src-tauri/src/permission` | R1 |
| App Server V2 协议 | `codex-rs/app-server-protocol` | `crates/agent-protocol` | R2 |
| Thread/Turn/Item 映射 | `codex-rs/app-server-protocol/src/protocol` | `crates/agent-protocol`、`crates/agent-events`、`desktop/src-tauri/src/agent/events.rs` | R2-R3 |
| Thread 管理 | `codex-rs/core/src/codex_thread.rs`、`thread_manager.rs` | `crates/agent-core` | R5-R6 |
| Turn 任务状态机 | `codex-rs/core/src/tasks`、`state/turn.rs` | `crates/agent-core` | R6 |
| Responses 客户端 | `codex-rs/core/src/client.rs`、`model-provider` | `crates/agent-model` | R7 |
| 上下文与压缩 | `codex-rs/core/src/context_manager`、`compact*.rs` | `crates/agent-context` | R9 |
| 工具注册和调度 | `codex-rs/core/src/tools/registry.rs`、`router.rs`、`orchestrator.rs` | `crates/agent-tools` | R10 |
| 工具并发 | `codex-rs/core/src/tools/parallel.rs` | `crates/agent-tools` | R10 |
| Apply Patch | `codex-rs/apply-patch`、`core/src/tools/handlers/apply_patch*` | `crates/agent-patch` | R12 |
| Unified Exec | `codex-rs/core/src/tools/handlers/unified_exec`、`utils/pty` | `crates/agent-exec` | R13 |
| 审批 | `codex-rs/core/src/tools/approvals.rs` | `crates/agent-approval` | R14 |
| macOS Seatbelt | `codex-rs/sandboxing/src/seatbelt.rs` | `crates/agent-sandbox` | R15 |
| Windows Sandbox | `codex-rs/windows-sandbox-rs` | `crates/agent-sandbox` | R16 |
| 网络策略 | `codex-rs/network-proxy` | `crates/agent-sandbox` | R17 |
| ExecPolicy | `codex-rs/execpolicy`、`shell-command` | `crates/agent-approval` | R18 |
| MCP 客户端 | `codex-rs/rmcp-client`、`core/src/mcp*.rs` | `crates/agent-mcp` | R19 |
| AGENTS 与 World State | `codex-rs/core/src/context/world_state` | `crates/agent-context` | R20 |
| 配置与 Requirements | `codex-rs/config`、`core/src/config` | `crates/agent-config` | R21 |
| Skills | `codex-rs/core-skills`、`skills` | `crates/agent-skills` | R22 |
| Hooks | `codex-rs/hooks` | `crates/agent-hooks` | R23 |
| Plugins | `codex-rs/plugin`、`core-plugins` | `crates/agent-plugins` | R24 |
| Plan 与用户输入 | `core/src/tools/handlers/plan.rs`、`request_user_input.rs` | `crates/agent-tools` | R25 |
| 子智能体 | `core/src/tools/handlers/multi_agents*` | `crates/agent-collab` | R26 |
| Guardian 与 Review | `codex-rs/core/src/guardian`、`tasks/review.rs` | `crates/agent-collab` | R27 |
| Rollout 持久化 | `codex-rs/rollout`、`thread-store`、`state` | `crates/agent-state`、`desktop/src-tauri/src/commands/conversations.rs` | R4 |
| Git 与 Worktree | `codex-rs/git-utils`、桌面 Worktree 行为 | `crates/agent-git` | R29 |
| 运维与追踪 | `codex-rs/otel`、`feedback`、Doctor 行为 | `crates/agent-observability` | R36 |

## 升级流程

1. 选择新的稳定 `rust-vX.Y.Z` Tag，不使用移动分支。
2. 记录 Tag、解析后的 Commit、Schema 数量和许可证变化。
3. 生成 Client Request、Client Notification、Server Request、Server Notification 差异。
4. 生成 Thread Item、User Input、Approval、Sandbox 和 Tool Schema 差异。
5. 将新增方法加入 machine ledger，状态设为 `pending` 并分配目标阶段。
6. 对删除或重命名的方法提供数据迁移，不直接删除历史记录。
7. 对沙箱、审批、持久化和模型协议变化执行真实平台回归。
8. 更新 `docs/CODEX-PARITY.md`，运行 `pnpm check:codex-parity`。
9. 单独提交上游升级，不与功能实现混在同一提交。

## 当前差异

R2 已引入固定上游生成的 273 个 JSON Schema、617 个 TypeScript 类型和 `crates/agent-protocol` Rust 编译期类型生成。四类协议表面与 machine ledger 的 89/1/10/70 个方法逐项校验，跨语言 fixture 和 Rust 反向 Schema 生成已纳入 CI。

R3 已增加独立的 `crates/agent-events` 事件总线和旧 `ChatEvent` 双端迁移适配。当前所有 Agent 增量事件都带有非空 `threadId`、`turnId`、`itemId`、Turn 内单调 `sequence` 和时间戳；同一消息、推理、工具与压缩生命周期使用稳定 Item ID。具体映射和删除兼容层的条件见 `docs/CODEX-EVENTS.md`。

R4 已增加 `crates/agent-state`：SQLite 元数据索引、追加式 JSONL rollout、原子兼容快照、Schema 迁移、数据库损坏备份和崩溃尾部恢复。R3 事件身份会随流式事件和任务项持久化，独立子进程 `abort` 测试覆盖 checkpoint、未完成工具和半条 JSON 的恢复。详细写入顺序和迁移边界见 `docs/CODEX-STATE.md`。

R5 已增加 `crates/agent-core` 源码级 `ThreadManager`、Tauri V2 请求入口、连接订阅路由、UUIDv7、canonical `session_meta`/`response_item` 与索引重建。15 个 Thread Client Request 和 11 个 Thread Server Notification 已按固定协议实现，详细行为见 `docs/CODEX-THREADS.md`。

当前 Turn 列表仍是 R6 接入前的迁移快照，正式 Turn/Item rollout 投影和执行状态机尚未接入。R14-R18 仍需分别完成审批状态机、macOS/Windows 沙箱、网络策略和 ExecPolicy；现有功能只有在目标协议、状态恢复、测试和 UI 行为全部符合后，才能更新方法状态。
