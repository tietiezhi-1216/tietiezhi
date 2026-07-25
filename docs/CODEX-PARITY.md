# Codex V2 功能对齐

> 本文件由 `desktop/scripts/check-codex-parity.mjs --write` 根据机器可读 ledger 生成。状态更新应先修改 `shared/codex/v2/upstream-baseline.json`，再重新生成本文档。

## 固定基线

- Codex 版本：`0.145.0`
- Git Tag：`rust-v0.145.0`
- Git Commit：`25af12f7e61572b0bc18ddb1008be543b91519b0`
- 协议：`app-server-v2`
- 上游源码：https://github.com/openai/codex/tree/rust-v0.145.0/codex-rs
- 许可证：`Apache-2.0`
- 捕获日期：`2026-07-25`
- 客户端请求：89
- 客户端通知：1
- 服务端请求：10
- 服务端通知：70
- Thread Item 类型：18
- User Input 类型：7

## 状态规则

- `pending`：尚未实现，但已分配目标阶段。
- `in_progress`：当前阶段正在实现，不能作为发布完成状态。
- `implemented`：已实现且必须在备注中给出源码与测试证据。
- `service_mapped`：Codex 依赖专有服务时映射到 Tietiezhi 服务，并在备注中给出证据。
- Ledger 不允许使用“永久不支持”作为终态。
- 每完成一个 R 阶段必须更新阶段状态、方法状态、证据和剩余风险。

| 方法状态 | 数量 |
| --- | ---: |
| 待实现 | 88 |
| 实现中 | 0 |
| 已实现 | 73 |
| 服务映射 | 9 |

## 阶段进度

| 阶段 | 名称 | 状态 | 证据 | 剩余风险 |
| --- | --- | --- | --- | --- |
| R0 | 基线治理 | 已完成 | shared/codex/v2/upstream-baseline.json；desktop/scripts/check-codex-parity.mjs；pnpm check:codex-parity；pnpm typecheck；pnpm build；cargo test（130 项） | 官方 V2 方法仍全部待实现；R1 起逐项推进 |
| R1 | 旧运行时止血 | 已完成 | desktop/src-tauri/src/permission/mod.rs；desktop/src-tauri/src/agent/loop_.rs；commands::conversations 旧决策迁移测试；scripts/check-permission-prompt.mjs；pnpm test:permission-ui；pnpm typecheck；pnpm build；cargo test | 尚未具备 Codex OS 沙箱、ExecPolicy 和独立 Approval 状态机；这些能力由 R14-R18 实现 |
| R2 | 协议层 | 已完成 | crates/agent-protocol；shared/codex/v2/schema；shared/codex/v2/typescript；desktop/scripts/check-codex-schema.mjs；Rust 双向 fixture 与反向 Schema 测试；pnpm test:codex-protocol-ts | 本阶段只实现协议类型与生成门禁，170 个方法的运行时行为仍由 R3-R39 逐项实现 |
| R3 | 事件模型 | 已完成 | crates/agent-events；desktop/src-tauri/src/agent/events.rs；desktop/src/lib/chat-events.ts；desktop/scripts/check-chat-event-migration.mjs；docs/CODEX-EVENTS.md；cargo test；pnpm test:chat-event-migration；pnpm typecheck；pnpm build | Thread 生命周期通知已由 R5 接入正式 App Server 路由；Turn/Item 通知由 R6 接管，LegacyChatEvent 在 R38 删除 |
| R4 | 持久化 | 已完成 | crates/agent-state；commands/conversations.rs；agent/events.rs；docs/CODEX-STATE.md；SQLite v1→v2 迁移测试；数据库损坏备份测试；真实子进程 abort 恢复测试；pnpm test:conversation-migration；cargo test；pnpm typecheck；pnpm build | 新 Runtime 已由 R5 写入 canonical session_meta/response_item；旧会话仍写 legacy_checkpoint，R6 接管 Turn/Item，task.json 镜像在 R38 删除 |
| R5 | Thread 生命周期 | 已完成 | crates/agent-core；commands/codex.rs；docs/CODEX-THREADS.md；SQLite v2→v3 迁移与 canonical session_meta 索引重建测试；12 项 ThreadManager 测试；137 项桌面 Rust 测试；pnpm typecheck；pnpm build | Turn 列表暂存于 canonical_json 查询缓存；R6 将以 rollout 的 Turn/Item 事件重建并接入真实执行状态机，旧会话适配层在 R38 删除 |
| R6 | Turn 生命周期 | 已完成 | crates/agent-core；crates/agent-state canonical rollout ordinal 投影；docs/CODEX-TURNS.md；19 项 TurnManager 测试；崩溃中断、分叉顺序与 R5 rollout 迁移测试；cargo clippy -D warnings；pnpm 协议/迁移/typecheck/build 门禁 | R7 尚未接入 Responses API、模型增量 Item、usage、reasoning summary 和重试；当前 exactly-once 输入队列只提供执行器边界 |
| R7 | Responses 模型层 | 已完成 | crates/agent-model Responses HTTP/SSE、错误与重试测试；crates/agent-core canonical Item、Steer 顺序、Token Usage 恢复和 V2 通知测试；docs/CODEX-MODEL.md | Gateway Responses 能力探测、在线模型目录、账号额度和 rate-limit 服务映射进入 R8；工具调用执行进入 R10-R13。 |
| R8 | Gateway 对齐 | 已完成 | crates/agent-account 账号与反向请求测试；crates/agent-model Responses 探测与在线目录测试；desktop Gateway/Provider/额度适配；Gateway be473f1 路由与 Discovery 测试；docs/CODEX-GATEWAY.md | Gateway 不提供 Token 日聚合、Workspace Message、reset-credit 和加额邮件时使用协议显式的空能力、noCredit 或 Invalid Request；上下文压缩与工具执行分别进入 R9-R13。 |
| R9 | 上下文系统 | 已完成 | crates/agent-context 历史/窗口/压缩/World State 测试；crates/agent-state canonical compacted/world_state 与 abort 恢复；crates/agent-core 手动/自动压缩和重启/Fork 测试；desktop commands/codex.rs 私有摘要请求与 Token Usage 接线；docs/CODEX-CONTEXT.md | R20 仍需注入 AGENTS、项目环境、Skills 和 Plugins 等具体 World State 内容；R21 接入分层配置与上游默认关闭的高级 TokenBudget 开关。 |
| R10 | 工具内核 | 已完成 | crates/agent-tools Registry、Router、Lifecycle、模型结果、Dynamic Tool V2 和 RwLock 并发/取消测试；docs/CODEX-TOOLS.md | R11-R13 仍需注册基础工具、Apply Patch 与 Unified Exec；R14-R18 在同一内核接入审批、沙箱、网络与 ExecPolicy。 |
| R11 | 基础工具 | 已完成 | crates/agent-tools 基础工具与 BM25 Tool Search；desktop Responses 工具闭环、steer 活动信号和模型能力门控；crates/agent-core 强类型 Sleep/ImageView/WebSearch Item；docs/CODEX-BUILTIN-TOOLS.md | R12/R13 仍需实现有文件或进程副作用的 Patch 与 Unified Exec；R14-R18 负责审批、沙箱、网络与 ExecPolicy，R19/R25 负责 MCP、Plan 和用户输入工具。 |
| R12 | Patch 与 Diff | 已完成 | crates/agent-patch Lark/流式解析与多文件原子事务；crates/agent-approval FileChange 反向请求；agent-tools apply_patch；agent-core FileChange/Turn Diff；docs/CODEX-PATCH.md | R14 仍需扩展完整 Approval Policy、精确会话授权缓存及命令/网络审批；R15-R17 仍需提供 OS 沙箱和网络隔离。 |
| R13 | Unified Exec | 已完成 | crates/agent-exec PTY/ConPTY、管道和会话管理；agent-tools exec_command/write_stdin；desktop command/exec* 与 thread/shellCommand；agent-core CommandExecution Item；docs/CODEX-EXEC.md | R14-R18 仍需完成精确审批策略、macOS/Windows OS 沙箱、网络隔离和 ExecPolicy；R30 再暴露多终端桌面 UI。 |
| R14 | 审批策略 | 已完成 | crates/agent-approval 策略、精确会话缓存和持久 Amendment；agent-tools request_permissions；desktop V2 路由与 CodexApprovalPrompt；docs/CODEX-APPROVAL.md | R15/R16 尚需把审批决策绑定到真实 OS 沙箱，R17/R18 尚需消费持久网络与 ExecPolicy Amendment；关闭 granular 类别已 fail-closed。 |
| R15 | macOS 沙箱 | 已完成 | crates/agent-sandbox 实现固定 /usr/bin/sandbox-exec、read-only/workspace-write/danger/external、可写根、受保护元数据、临时目录、网络开关和 symlink 安全；agent-exec Pipe/PTY、Unified Exec、command/exec 与 apply_patch 共用策略；10 项沙箱测试、7 项 exec 测试和 20 项工具测试覆盖真实 macOS 拒绝。 | Windows 隔离由 R16 实现；域名代理、连接审批和网络审计由 R17 实现；R21 再提供完整分层 Permission Profile 配置。 |
| R16 | Windows 沙箱 | 已完成 | crates/agent-sandbox Windows Restricted Token/ACL/Job/wrapper；crates/agent-exec/tests/windows_sandbox.rs；desktop commands/codex.rs；docs/CODEX-SANDBOX-WINDOWS.md；Windows CI | Windows ACL 准备失败时 fail-closed；每次发布由 Windows runner 重跑真实逃逸测试。 |
| R17 | 网络策略 | 待开始 |  |  |
| R18 | ExecPolicy | 待开始 |  |  |
| R19 | MCP 完整实现 | 待开始 |  |  |
| R20 | 指令层 | 待开始 |  |  |
| R21 | 配置体系 | 待开始 |  |  |
| R22 | Skills | 待开始 |  |  |
| R23 | Hooks | 待开始 |  |  |
| R24 | Plugins | 待开始 |  |  |
| R25 | Plan 与用户输入 | 待开始 |  |  |
| R26 | Collaboration | 待开始 |  |  |
| R27 | Guardian 与 Review | 待开始 |  |  |
| R28 | Memory | 待开始 |  |  |
| R29 | Git 与 Worktree | 待开始 |  |  |
| R30 | 集成终端 | 待开始 |  |  |
| R31 | Desktop 时间线 | 待开始 |  |  |
| R32 | Diff 与 Git UI | 待开始 |  |  |
| R33 | Apps 与连接器 | 待开始 |  |  |
| R34 | Automations | 待开始 |  |  |
| R35 | 远程与实时 | 待开始 |  |  |
| R36 | 运维能力 | 待开始 |  |  |
| R37 | 稳定性工程 | 待开始 |  |  |
| R38 | 迁移切换 | 待开始 |  |  |
| R39 | 正式发布 | 待开始 |  |  |

## Client Requests

| 方法 | 状态 | 目标阶段 | 证据或备注 |
| --- | --- | --- | --- |
| `account/login/cancel` | 服务映射 | R8 | crates/agent-account 的固定 V2 校验、账号状态与服务映射测试；desktop commands/codex.rs 的 Gateway、Keyring、额度和错误适配；docs/CODEX-GATEWAY.md |
| `account/login/start` | 服务映射 | R8 | crates/agent-account 的固定 V2 校验、账号状态与服务映射测试；desktop commands/codex.rs 的 Gateway、Keyring、额度和错误适配；docs/CODEX-GATEWAY.md |
| `account/logout` | 服务映射 | R8 | crates/agent-account 的固定 V2 校验、账号状态与服务映射测试；desktop commands/codex.rs 的 Gateway、Keyring、额度和错误适配；docs/CODEX-GATEWAY.md |
| `account/rateLimitResetCredit/consume` | 服务映射 | R8 | crates/agent-account 的固定 V2 校验、账号状态与服务映射测试；desktop commands/codex.rs 的 Gateway、Keyring、额度和错误适配；docs/CODEX-GATEWAY.md |
| `account/rateLimits/read` | 服务映射 | R8 | crates/agent-account 的固定 V2 校验、账号状态与服务映射测试；desktop commands/codex.rs 的 Gateway、Keyring、额度和错误适配；docs/CODEX-GATEWAY.md |
| `account/read` | 服务映射 | R8 | crates/agent-account 的固定 V2 校验、账号状态与服务映射测试；desktop commands/codex.rs 的 Gateway、Keyring、额度和错误适配；docs/CODEX-GATEWAY.md |
| `account/sendAddCreditsNudgeEmail` | 服务映射 | R8 | crates/agent-account 的固定 V2 校验、账号状态与服务映射测试；desktop commands/codex.rs 的 Gateway、Keyring、额度和错误适配；docs/CODEX-GATEWAY.md |
| `account/usage/read` | 服务映射 | R8 | crates/agent-account 的固定 V2 校验、账号状态与服务映射测试；desktop commands/codex.rs 的 Gateway、Keyring、额度和错误适配；docs/CODEX-GATEWAY.md |
| `account/workspaceMessages/read` | 服务映射 | R8 | crates/agent-account 的固定 V2 校验、账号状态与服务映射测试；desktop commands/codex.rs 的 Gateway、Keyring、额度和错误适配；docs/CODEX-GATEWAY.md |
| `app/installed` | 待实现 | R33 |  |
| `app/list` | 待实现 | R33 |  |
| `app/read` | 待实现 | R33 |  |
| `command/exec` | 已实现 | R13 | desktop codex.rs dispatch_command_exec；agent-exec integration tests |
| `command/exec/resize` | 已实现 | R13 | desktop codex.rs；agent-exec PTY resize test |
| `command/exec/terminate` | 已实现 | R13 | desktop codex.rs；agent-exec process-group cleanup test |
| `command/exec/write` | 已实现 | R13 | desktop codex.rs；agent-exec stdin roundtrip test |
| `config/batchWrite` | 待实现 | R21 |  |
| `config/mcpServer/reload` | 待实现 | R21 |  |
| `config/read` | 待实现 | R21 |  |
| `config/value/write` | 待实现 | R21 |  |
| `configRequirements/read` | 待实现 | R21 |  |
| `experimentalFeature/enablement/set` | 待实现 | R21 |  |
| `experimentalFeature/list` | 待实现 | R21 |  |
| `externalAgentConfig/detect` | 待实现 | R38 |  |
| `externalAgentConfig/import` | 待实现 | R38 |  |
| `externalAgentConfig/import/readHistories` | 待实现 | R38 |  |
| `feedback/upload` | 待实现 | R36 |  |
| `fs/copy` | 待实现 | R31 |  |
| `fs/createDirectory` | 待实现 | R31 |  |
| `fs/getMetadata` | 待实现 | R31 |  |
| `fs/readDirectory` | 待实现 | R31 |  |
| `fs/readFile` | 待实现 | R31 |  |
| `fs/remove` | 待实现 | R31 |  |
| `fs/unwatch` | 待实现 | R31 |  |
| `fs/watch` | 待实现 | R31 |  |
| `fs/writeFile` | 待实现 | R31 |  |
| `fuzzyFileSearch` | 待实现 | R31 |  |
| `hooks/list` | 待实现 | R36 |  |
| `initialize` | 待实现 | R2 |  |
| `marketplace/add` | 待实现 | R24 |  |
| `marketplace/remove` | 待实现 | R24 |  |
| `marketplace/upgrade` | 待实现 | R24 |  |
| `mcpServer/oauth/login` | 待实现 | R19 |  |
| `mcpServer/resource/read` | 待实现 | R19 |  |
| `mcpServer/tool/call` | 待实现 | R19 |  |
| `mcpServerStatus/list` | 待实现 | R19 |  |
| `model/list` | 已实现 | R7 | crates/agent-model Responses HTTP/SSE、固定与在线模型目录测试；crates/agent-core canonical Item、Steer 顺序、Token Usage 恢复和 V2 通知测试；docs/CODEX-MODEL.md；docs/CODEX-GATEWAY.md |
| `modelProvider/capabilities/read` | 待实现 | R36 |  |
| `permissionProfile/list` | 已实现 | R14 | crates/agent-approval 策略、精确会话缓存和持久 Amendment；agent-tools request_permissions；desktop V2 路由与 CodexApprovalPrompt；docs/CODEX-APPROVAL.md |
| `plugin/install` | 待实现 | R24 |  |
| `plugin/installed` | 待实现 | R24 |  |
| `plugin/list` | 待实现 | R24 |  |
| `plugin/read` | 待实现 | R24 |  |
| `plugin/share/checkout` | 待实现 | R24 |  |
| `plugin/share/delete` | 待实现 | R24 |  |
| `plugin/share/list` | 待实现 | R24 |  |
| `plugin/share/save` | 待实现 | R24 |  |
| `plugin/share/updateTargets` | 待实现 | R24 |  |
| `plugin/skill/read` | 待实现 | R24 |  |
| `plugin/uninstall` | 待实现 | R24 |  |
| `review/start` | 待实现 | R27 |  |
| `skills/config/write` | 待实现 | R22 |  |
| `skills/extraRoots/set` | 待实现 | R22 |  |
| `skills/list` | 待实现 | R22 |  |
| `thread/approveGuardianDeniedAction` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/archive` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/compact/start` | 已实现 | R9 | crates/agent-core 与 desktop commands/codex.rs 实现异步手动压缩 Turn、contextCompaction Item、Responses 摘要和 canonical replacement history；docs/CODEX-CONTEXT.md |
| `thread/delete` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/fork` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/goal/clear` | 待实现 | R25 |  |
| `thread/goal/get` | 待实现 | R25 |  |
| `thread/goal/set` | 待实现 | R25 |  |
| `thread/inject_items` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/list` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/loaded/list` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/metadata/update` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/name/set` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/read` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/resume` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/rollback` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/shellCommand` | 已实现 | R13 | desktop codex.rs dispatch_thread_shell_command；docs/CODEX-EXEC.md |
| `thread/start` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/unarchive` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `thread/unsubscribe` | 已实现 | R5 | crates/agent-core ThreadManager 的固定 V2 分派、持久化与协议级生命周期测试；desktop commands/codex.rs 提供 Tauri 请求入口 |
| `turn/interrupt` | 已实现 | R6 | crates/agent-core TurnManager 的固定 V2 分派、UUIDv7、canonical rollout、幂等与崩溃恢复测试；docs/CODEX-TURNS.md |
| `turn/start` | 已实现 | R6 | crates/agent-core TurnManager 的固定 V2 分派、UUIDv7、canonical rollout、幂等与崩溃恢复测试；docs/CODEX-TURNS.md |
| `turn/steer` | 已实现 | R6 | crates/agent-core TurnManager 的固定 V2 分派、UUIDv7、canonical rollout、幂等与崩溃恢复测试；docs/CODEX-TURNS.md |
| `windowsSandbox/readiness` | 已实现 | R16 | 源码构建 self-reentry；真实 Windows runner 执行沙箱、ConPTY 和桌面构建。 |
| `windowsSandbox/setupStart` | 已实现 | R16 | 源码构建 self-reentry；真实 Windows runner 执行沙箱、ConPTY 和桌面构建。 |

## Client Notifications

| 方法 | 状态 | 目标阶段 | 证据或备注 |
| --- | --- | --- | --- |
| `initialized` | 待实现 | R2 |  |

## Server Requests

| 方法 | 状态 | 目标阶段 | 证据或备注 |
| --- | --- | --- | --- |
| `account/chatgptAuthTokens/refresh` | 已实现 | R8 | crates/agent-account AccountServerRequestBroker 的 Request ID 关联、V2 响应校验、超时取消与重复响应测试；desktop codex-v2-server-request IPC |
| `applyPatchApproval` | 已实现 | R14 | crates/agent-approval 策略、精确会话缓存和持久 Amendment；agent-tools request_permissions；desktop V2 路由与 CodexApprovalPrompt；docs/CODEX-APPROVAL.md |
| `attestation/generate` | 待实现 | R36 |  |
| `execCommandApproval` | 已实现 | R14 | crates/agent-approval 策略、精确会话缓存和持久 Amendment；agent-tools request_permissions；desktop V2 路由与 CodexApprovalPrompt；docs/CODEX-APPROVAL.md |
| `item/commandExecution/requestApproval` | 已实现 | R13 | agent-approval command broker；V2 schema tests |
| `item/fileChange/requestApproval` | 已实现 | R12 | crates/agent-approval ServerRequestBroker V2 Schema 与四决策测试；desktop/src-tauri/src/commands/codex.rs |
| `item/permissions/requestApproval` | 已实现 | R14 | crates/agent-approval 策略、精确会话缓存和持久 Amendment；agent-tools request_permissions；desktop V2 路由与 CodexApprovalPrompt；docs/CODEX-APPROVAL.md |
| `item/tool/call` | 已实现 | R10 | crates/agent-tools 生成并校验精确 App Server V2 Dynamic Tool ServerRequest/Response，保持 thread/turn/call/namespace/tool/arguments；docs/CODEX-TOOLS.md |
| `item/tool/requestUserInput` | 待实现 | R25 |  |
| `mcpServer/elicitation/request` | 待实现 | R19 |  |

## Server Notifications

| 方法 | 状态 | 目标阶段 | 证据或备注 |
| --- | --- | --- | --- |
| `account/login/completed` | 已实现 | R8 | crates/agent-account 的全连接登录、账号与稀疏额度通知测试；desktop commands/codex.rs 的 routed notification 适配 |
| `account/rateLimits/updated` | 已实现 | R8 | crates/agent-account 的全连接登录、账号与稀疏额度通知测试；desktop commands/codex.rs 的 routed notification 适配 |
| `account/updated` | 已实现 | R8 | crates/agent-account 的全连接登录、账号与稀疏额度通知测试；desktop commands/codex.rs 的 routed notification 适配 |
| `app/list/updated` | 待实现 | R33 |  |
| `command/exec/outputDelta` | 已实现 | R13 | desktop wait_streamed_command_exec；V2 notification validation |
| `configWarning` | 待实现 | R21 |  |
| `deprecationNotice` | 待实现 | R3 |  |
| `error` | 已实现 | R3 | crates/agent-model Responses HTTP/SSE、错误与重试测试；crates/agent-core canonical Item、Steer 顺序、Token Usage 恢复和 V2 通知测试；docs/CODEX-MODEL.md |
| `externalAgentConfig/import/completed` | 待实现 | R38 |  |
| `externalAgentConfig/import/progress` | 待实现 | R38 |  |
| `fs/changed` | 待实现 | R31 |  |
| `fuzzyFileSearch/sessionCompleted` | 待实现 | R31 |  |
| `fuzzyFileSearch/sessionUpdated` | 待实现 | R31 |  |
| `guardianWarning` | 待实现 | R27 |  |
| `hook/completed` | 待实现 | R23 |  |
| `hook/started` | 待实现 | R23 |  |
| `item/agentMessage/delta` | 已实现 | R3 | crates/agent-model Responses HTTP/SSE、错误与重试测试；crates/agent-core canonical Item、Steer 顺序、Token Usage 恢复和 V2 通知测试；docs/CODEX-MODEL.md |
| `item/autoApprovalReview/completed` | 待实现 | R27 |  |
| `item/autoApprovalReview/started` | 待实现 | R27 |  |
| `item/commandExecution/outputDelta` | 已实现 | R13 | agent-core command_execution_output_delta；core lifecycle test |
| `item/commandExecution/terminalInteraction` | 已实现 | R13 | agent-core terminal interaction；core lifecycle test |
| `item/completed` | 已实现 | R3 | crates/agent-core TurnManager 的固定 V2 分派、UUIDv7、canonical rollout、幂等与崩溃恢复测试；docs/CODEX-TURNS.md |
| `item/fileChange/outputDelta` | 已实现 | R12 | crates/agent-core 兼容发布器与 V2 载荷测试；正常执行按 Codex 0.145.0 不发送废弃通知 |
| `item/fileChange/patchUpdated` | 已实现 | R12 | crates/agent-core FileChange 增量投影；desktop Responses delta/最终预览；FileChange 生命周期测试 |
| `item/mcpToolCall/progress` | 待实现 | R19 |  |
| `item/plan/delta` | 待实现 | R25 |  |
| `item/reasoning/summaryPartAdded` | 已实现 | R3 | crates/agent-model Responses HTTP/SSE、错误与重试测试；crates/agent-core canonical Item、Steer 顺序、Token Usage 恢复和 V2 通知测试；docs/CODEX-MODEL.md |
| `item/reasoning/summaryTextDelta` | 已实现 | R3 | crates/agent-model Responses HTTP/SSE、错误与重试测试；crates/agent-core canonical Item、Steer 顺序、Token Usage 恢复和 V2 通知测试；docs/CODEX-MODEL.md |
| `item/reasoning/textDelta` | 已实现 | R3 | crates/agent-model Responses HTTP/SSE、错误与重试测试；crates/agent-core canonical Item、Steer 顺序、Token Usage 恢复和 V2 通知测试；docs/CODEX-MODEL.md |
| `item/started` | 已实现 | R3 | crates/agent-core TurnManager 的固定 V2 分派、UUIDv7、canonical rollout、幂等与崩溃恢复测试；docs/CODEX-TURNS.md |
| `mcpServer/oauthLogin/completed` | 待实现 | R19 |  |
| `mcpServer/startupStatus/updated` | 待实现 | R19 |  |
| `model/rerouted` | 已实现 | R7 | crates/agent-model Responses HTTP/SSE、错误与重试测试；crates/agent-core canonical Item、Steer 顺序、Token Usage 恢复和 V2 通知测试；docs/CODEX-MODEL.md |
| `model/safetyBuffering/updated` | 已实现 | R7 | crates/agent-model Responses HTTP/SSE、错误与重试测试；crates/agent-core canonical Item、Steer 顺序、Token Usage 恢复和 V2 通知测试；docs/CODEX-MODEL.md |
| `model/verification` | 已实现 | R7 | crates/agent-model Responses HTTP/SSE、错误与重试测试；crates/agent-core canonical Item、Steer 顺序、Token Usage 恢复和 V2 通知测试；docs/CODEX-MODEL.md |
| `process/exited` | 已实现 | R13 | desktop thread shell executor；V2 notification validation |
| `process/outputDelta` | 已实现 | R13 | desktop thread shell executor；V2 notification validation |
| `remoteControl/status/changed` | 待实现 | R35 |  |
| `serverRequest/resolved` | 待实现 | R36 |  |
| `skills/changed` | 待实现 | R22 |  |
| `thread/archived` | 已实现 | R5 | crates/agent-core 订阅路由与 ServerNotification 类型校验；Thread 生命周期及通知发布器测试 |
| `thread/closed` | 已实现 | R5 | crates/agent-core 订阅路由与 ServerNotification 类型校验；Thread 生命周期及通知发布器测试 |
| `thread/compacted` | 已实现 | R9 | 固定 Codex V2 已废弃并主动丢弃该通知；本实现同样不发布，以 contextCompaction Item started/completed 作为唯一可见生命周期；crates/agent-core 测试与 docs/CODEX-CONTEXT.md |
| `thread/deleted` | 已实现 | R5 | crates/agent-core 订阅路由与 ServerNotification 类型校验；Thread 生命周期及通知发布器测试 |
| `thread/environment/connected` | 已实现 | R5 | crates/agent-core 订阅路由与 ServerNotification 类型校验；Thread 生命周期及通知发布器测试 |
| `thread/environment/disconnected` | 已实现 | R5 | crates/agent-core 订阅路由与 ServerNotification 类型校验；Thread 生命周期及通知发布器测试 |
| `thread/goal/cleared` | 待实现 | R25 |  |
| `thread/goal/updated` | 待实现 | R25 |  |
| `thread/name/updated` | 已实现 | R5 | crates/agent-core 订阅路由与 ServerNotification 类型校验；Thread 生命周期及通知发布器测试 |
| `thread/realtime/closed` | 待实现 | R35 |  |
| `thread/realtime/error` | 待实现 | R35 |  |
| `thread/realtime/itemAdded` | 待实现 | R35 |  |
| `thread/realtime/outputAudio/delta` | 待实现 | R35 |  |
| `thread/realtime/sdp` | 待实现 | R35 |  |
| `thread/realtime/started` | 待实现 | R35 |  |
| `thread/realtime/transcript/delta` | 待实现 | R35 |  |
| `thread/realtime/transcript/done` | 待实现 | R35 |  |
| `thread/settings/updated` | 已实现 | R5 | crates/agent-core 订阅路由与 ServerNotification 类型校验；Thread 生命周期及通知发布器测试 |
| `thread/started` | 已实现 | R5 | crates/agent-core 订阅路由与 ServerNotification 类型校验；Thread 生命周期及通知发布器测试 |
| `thread/status/changed` | 已实现 | R5 | crates/agent-core 订阅路由与 ServerNotification 类型校验；Thread 生命周期及通知发布器测试 |
| `thread/tokenUsage/updated` | 已实现 | R5 | crates/agent-core 订阅路由与 ServerNotification 类型校验；Thread 生命周期及通知发布器测试；R7 增加 Thread 累积、token_count rollout 与重启恢复 |
| `thread/unarchived` | 已实现 | R5 | crates/agent-core 订阅路由与 ServerNotification 类型校验；Thread 生命周期及通知发布器测试 |
| `turn/completed` | 已实现 | R6 | crates/agent-core TurnManager 的固定 V2 分派、UUIDv7、canonical rollout、幂等与崩溃恢复测试；docs/CODEX-TURNS.md |
| `turn/diff/updated` | 已实现 | R12 | crates/agent-patch TurnDiffTracker；crates/agent-core V2 发布器；desktop apply_patch 成功路径 |
| `turn/moderationMetadata` | 已实现 | R6 | crates/agent-core TurnManager 的固定 V2 分派、UUIDv7、canonical rollout、幂等与崩溃恢复测试；docs/CODEX-TURNS.md |
| `turn/plan/updated` | 待实现 | R25 |  |
| `turn/started` | 已实现 | R6 | crates/agent-core TurnManager 的固定 V2 分派、UUIDv7、canonical rollout、幂等与崩溃恢复测试；docs/CODEX-TURNS.md |
| `warning` | 待实现 | R3 |  |
| `windows/worldWritableWarning` | 已实现 | R16 | 源码构建 self-reentry；真实 Windows runner 执行沙箱、ConPTY 和桌面构建。 |
| `windowsSandbox/setupCompleted` | 已实现 | R16 | 源码构建 self-reentry；真实 Windows runner 执行沙箱、ConPTY 和桌面构建。 |

## Thread Item 类型

- `agentMessage`
- `collabAgentToolCall`
- `commandExecution`
- `contextCompaction`
- `dynamicToolCall`
- `enteredReviewMode`
- `exitedReviewMode`
- `fileChange`
- `hookPrompt`
- `imageGeneration`
- `imageView`
- `mcpToolCall`
- `plan`
- `reasoning`
- `sleep`
- `subAgentActivity`
- `userMessage`
- `webSearch`

## User Input 类型

- `audio`
- `image`
- `localAudio`
- `localImage`
- `mention`
- `skill`
- `text`
