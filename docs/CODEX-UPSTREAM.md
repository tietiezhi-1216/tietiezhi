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
| Responses 客户端 | `codex-rs/codex-api/src/common.rs`、`codex-api/src/sse/responses.rs`、`core/src/client.rs`、`responses_retry.rs`、`models-manager/models.json` | `crates/agent-model`、`crates/agent-core`、`desktop/src-tauri/src/commands/codex.rs` | R7 |
| 账号与 Gateway 服务 | `app-server/src/request_processors/account_processor.rs`、`account_processor/rate_limit_resets.rs`、`app-server-protocol/src/protocol/v2/account.rs` | `crates/agent-account`、`desktop/src-tauri/src/commands/codex.rs`、`gateway_auth.rs` | R8 |
| 上下文与压缩 | `codex-rs/core/src/context_manager`、`compact*.rs`、`session/context_window.rs`、`session/token_budget.rs` | `crates/agent-context`、`crates/agent-core`、`desktop/src-tauri/src/commands/codex.rs` | R9 |
| 工具注册、路由和生命周期 | `codex-rs/core/src/tools/registry.rs`、`router.rs`、`lifecycle.rs`、`orchestrator.rs` | `crates/agent-tools` | R10 |
| 工具并发与取消 | `codex-rs/core/src/tools/parallel.rs` | `crates/agent-tools` | R10 |
| 基础工具与 Responses 工具循环 | `core/src/tools/handlers/{current_time,sleep,get_context_remaining,view_image,tool_search}.rs`、`core/src/tools/spec_plan.rs` | `crates/agent-tools`、`crates/agent-core`、`desktop/src-tauri/src/commands/codex.rs` | R11 |
| Apply Patch | `codex-rs/apply-patch`、`core/src/tools/handlers/apply_patch*` | `crates/agent-patch` | R12 |
| Unified Exec | `codex-rs/core/src/tools/handlers/unified_exec`、`utils/pty` | `crates/agent-exec` | R13 |
| 审批 | `codex-rs/core/src/tools/approvals.rs`、`tools/sandboxing.rs`、`protocol/src/approvals.rs`、`config/permission_profile_catalog.rs` | `crates/agent-approval`、`crates/agent-tools`、`desktop/src-tauri/src/commands/codex.rs` | R14 |
| macOS Seatbelt | `codex-rs/sandboxing/src/seatbelt.rs` | `crates/agent-sandbox` | R15 |
| Windows Sandbox | `codex-rs/windows-sandbox-rs` | `crates/agent-sandbox` | R16 |
| 网络策略 | `codex-rs/network-proxy` | `crates/agent-sandbox` | R17 |
| ExecPolicy | `codex-rs/execpolicy`、`shell-command`、`utils/absolute-path`、`core/src/exec_policy.rs` | `crates/agent-execpolicy`、`crates/agent-shell-command`、`crates/agent-absolute-path`、`crates/agent-tools` | R18 |
| MCP 客户端 | `codex-rs/rmcp-client`、`core/src/mcp*.rs` | `crates/agent-mcp` | R19 |
| AGENTS 与 World State 内容 | `codex-rs/core/src/context/world_state` | `crates/agent-context`、`crates/agent-config` | R20 |
| 配置与 Requirements | `codex-rs/config`、`core/src/config` | `crates/agent-config` | R21 |
| Skills | `codex-rs/core-skills`、`skills` | `crates/agent-skills` | R22 |
| Hooks | `codex-rs/hooks` | `crates/agent-hooks` | R23 |
| Plugins | `codex-rs/plugin`、`core-plugins` | `crates/agent-plugins` | R24 |
| Plan 与用户输入 | `core/src/tools/handlers/plan.rs`、`request_user_input.rs` | `crates/agent-tools` | R25 |
| 子智能体 | `core/src/tools/handlers/multi_agents*` | `crates/agent-collab` | R26 |
| Guardian 与 Review | `codex-rs/core/src/guardian`、`session/review.rs`、`tasks/review.rs` | `crates/agent-review`、`crates/agent-core`、`desktop/src-tauri/src/commands/codex.rs` | R27 |
| Chronicle 长期记忆 | `codex-rs/memories/{read,write}`、`ext/memories`、`state/src/runtime/memories.rs`、`protocol/src/memory_citation.rs` | `crates/agent-memory`、`crates/agent-core`、`desktop/src-tauri/src/commands/codex.rs` | R28 |
| Local、Worktree、Snapshot 与 Handoff | `codex-rs/git-utils`、`core/src/git_info*`、桌面执行环境行为 | `crates/agent-git`、`desktop/src-tauri/src/commands/workspace.rs` | R29 |
| Thread 集成终端 | `codex-rs/utils/pty`、`core/src/unified_exec`、`app-server/src/command_exec.rs` | `crates/agent-exec`、`desktop/src-tauri/src/commands/terminal.rs` | R30 |
| Desktop 时间线与文件服务 | `app-server-protocol/src/protocol/v2/item.rs`、`tui/src/chatwidget/replay.rs`、`exec-server-protocol/src/protocol.rs`、`file-search` | `desktop/src/stores/codex-timeline.ts`、`desktop/src/features/chat/codex-timeline.tsx`、`desktop/src-tauri/src/commands/codex_fs.rs` | R31 |
| Diff 与 Git UI | `git-utils`、`tui/src/chatwidget/replay.rs` 的 FileChange/Diff 行为 | `crates/agent-git`、`desktop/src/features/chat/workspace-git-panel.tsx` | R32 |
| Apps 与连接器 | `app-server/src/request_processors/apps_processor.rs`、`connectors`、`app-server/src/dynamic_tools.rs` | `crates/agent-apps`、`desktop/src-tauri/src/commands/codex.rs`、`desktop/src/features/chat/codex-apps-panel.tsx` | R33 |
| Automations | `protocol/src/protocol.rs` 的 Automation ThreadSource、`core/src/session`、`app-server/src/request_processors/turn_processor.rs` | `desktop/src-tauri/src/automation`、`desktop/src-tauri/src/commands/codex.rs`、`desktop/src/features/automations` | R34 |
| Remote Control 与 Realtime | `app-server/src/request_processors/remote_control_processor.rs`、`app-server/src/request_processors/turn_processor.rs`、`app-server/src/bespoke_event_handling.rs`、`app-server-protocol/src/protocol/v2/{remote_control,realtime}.rs`、`codex-api/src/endpoint/{realtime_call,realtime_websocket}`、`core/src/realtime_conversation.rs` | `crates/agent-remote`、`crates/agent-realtime`、`desktop/src-tauri/src/commands/{codex,devices}.rs`、`desktop/src/features/chat/remote-realtime-panel.tsx` | R35 |
| Rollout 持久化 | `codex-rs/rollout`、`thread-store`、`state` | `crates/agent-state`、`desktop/src-tauri/src/commands/conversations.rs` | R4 |
| 运维与追踪 | `codex-rs/otel`、`feedback`、Doctor 行为 | `crates/agent-observability` | R36 |
| 稳定性、故障注入与 Soak | `codex-rs/core/tests`、`codex-api/src/sse`、`rollout`、`rmcp-client`、`utils/pty` | `crates/agent-stability`、`.github/workflows/codex-soak.yml` | R37 |
| 初始化、外部 Agent 导入与迁移切换 | `app-server/src/message_processor.rs`、`app-server/src/external_agent_migration`、`app-server/src/request_processors/initialize_processor.rs`、`app-server-protocol/src/protocol/v2` | `desktop/src-tauri/src/commands/codex.rs`、`crates/agent-core`、`crates/agent-state`、`desktop/src/lib/api.ts`、`desktop/src/stores/chat.ts` | R38 |

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

R6 已实现 `turn/start`、`turn/steer`、`turn/interrupt`、三类 Turn 通知和 User Message 的 Item 生命周期。Turn 不再保存到 SQLite 快照，而是从 canonical `task_started`、`turn_context`、Responses `response_item`、Core `TurnItem` 与终态事件恢复；崩溃中的活动 Turn 只中断一次且不重放输入。详细行为见 `docs/CODEX-TURNS.md`。

R7 已增加 `crates/agent-model`，实现 `/v1/responses` 请求、HTTP/SSE、错误分类、请求与流重试、reasoning/agent message 增量、Thread Token Usage 累积、模型重路由/校验/safety buffering，以及固定模型目录和分页。Tauri Turn 执行器支持取消、`end_turn: false` 继续采样和 Steer 延迟入历史，详细行为见 `docs/CODEX-MODEL.md`。

R36 已增加 `crates/agent-observability`，实现脱敏结构化日志、进程内指标、OTLP/HTTP JSON、Doctor、原子 Feedback Outbox/上传、Attestation Broker 和 `serverRequest/resolved`；`hooks/list` 复用真实 Hook trust projection，桌面设置提供运行诊断入口。服务端上传映射到 Tietiezhi 自有端点，详细边界见 `docs/CODEX-OPERATIONS.md`。

R37 已增加 `crates/agent-stability`，用真实进程、stdio MCP、HTTP/SSE 和 JSONL 路径覆盖断流、超时、取消、损坏尾部、原子发布失败、256 次连续工具调用和资源泄漏；Proptest 覆盖任意 SSE 分块，macOS/Windows 定时 Soak 验证长时间运行。详细矩阵见 `docs/CODEX-STABILITY.md`。

R8 已增加 `crates/agent-account`，把 App Server V2 的账号登录、取消、退出、读取、额度、用量、工作区消息、重置额度、加额通知和外部令牌刷新映射到 Gateway、Keyring 与客户端反向请求。官方 Provider 固定使用 Responses，自定义 Provider 显式选择或用安全空 POST 探测；Gateway `/v1/models` 元数据投影为 V2 在线目录。详细边界见 `docs/CODEX-GATEWAY.md`。

R9 已增加 `crates/agent-context`，实现 canonical 历史重建、真实服务端 Token Usage 与本地未采样 Item 估算、模型上下文窗口、90% 自动压缩、手动压缩、20,000 Token 最近用户消息保留、压缩窗口链和 RFC 7386 World State 增量。压缩作为正式 `contextCompaction` Item 运行并写入 `compacted` rollout；固定 V2 中已废弃的 `thread/compacted` 不再发送。详细行为见 `docs/CODEX-CONTEXT.md`。

R10 已增加 `crates/agent-tools`，实现名称空间感知的 Registry、Router、模型可见/延迟/隐藏暴露、Lifecycle Contributor、结构化模型结果、`item/tool/call` V2 桥接、取消唯一终态以及与 Codex 相同的 RwLock 并发门。只声明可并行的工具共享读锁，其他工具使用写锁并与所有调用互斥。详细行为见 `docs/CODEX-TOOLS.md`。

R11 已接入 `clock.curr_time`、`clock.sleep`、`get_context_remaining`、`view_image`、托管 `web_search` 和 BM25 `tool_search`。Responses 工具调用会并行执行、按原调用顺序追加 Output、继续同一 Turn，并投影 Sleep、Image View、Web Search 强类型 Item；steer 输入可打断 sleep 而不取消 Turn。详细行为见 `docs/CODEX-BUILTIN-TOOLS.md`。

R12 已增加 `crates/agent-patch` 和 `crates/agent-approval` 的文件审批基础，完整实现 Lark Patch、增量预览、工作区路径约束、多文件事务、FileChange Item、Patch Updated 和累计 Turn Diff。废弃 `item/fileChange/outputDelta` 只保留兼容发布器，正常路径不发送。详细行为见 `docs/CODEX-PATCH.md`。

R13 已增加 `crates/agent-exec`，实现 Pipe、PTY/ConPTY、stdin、resize、输出上限、后台轮询、超时、进程树清理、`command/exec*`、`thread/shellCommand`、CommandExecution Item、输出/交互通知和命令审批请求。详细行为和安全阶段边界见 `docs/CODEX-EXEC.md`。

R14 已实现四种 Approval Policy、granular 分类、精确 Thread 会话缓存、持久 Amendment 边界、新旧审批反向 RPC、Permission Profile 目录和 `request_permissions`。详细行为见 `docs/CODEX-APPROVAL.md`。

R15 已增加 `crates/agent-sandbox`，实现 macOS Seatbelt 的 read-only、workspace-write、danger-full-access、external sandbox、可写根、受保护元数据、临时目录和网络开关，并在 Pipe/PTY 上执行真实内核隔离测试。详细行为见 `docs/CODEX-SANDBOX-MACOS.md`。

R18 已移植 Starlark ExecPolicy、Bash/PowerShell 解析、安全命令分类、host executable 和规则修订，并在 Unified Exec 创建进程前执行。

R19 已增加 `crates/agent-mcp`，实现 stdio、Streamable HTTP、Keychain/Credential Manager OAuth、PKCE、动态注册、Token 刷新、resources、templates、Elicitation、progress、annotations、工具过滤、required server 和富媒体结果，并接入正式 `mcpToolCall` Item。详细行为见 `docs/CODEX-MCP.md`。

R20 已增加 `crates/agent-config`，实现从项目根到当前目录的 `AGENTS.md`、`AGENTS.override.md` 与 fallback 分层发现、共享 32 KiB 预算、World State 全量/差分模型上下文、环境/权限/工具变化和压缩后重建。上下文片段先于 World State rollout 写入并在模型请求前移除内部恢复标记。详细行为见 `docs/CODEX-INSTRUCTIONS.md`。

R21 已在 `crates/agent-config` 实现 system、user、Profile、项目目录和 session-ready 的配置合并、逐字段来源、TOML 原子写入与 CAS 版本、Requirements 收紧、实验功能分页/启停和 MCP 连接重载。详细行为见 `docs/CODEX-CONFIG.md`。

R22 已增加 `crates/agent-skills`，实现 system、admin、user、repo、plugin/extra root 的技能发现，YAML/JSON 元数据预加载、正文延迟读取、按名称/路径启停、磁盘变化失效通知和 Responses `skill` 工具。详细行为见 `docs/CODEX-SKILLS.md`。

R23 已增加 `crates/agent-hooks`，实现 system、user、project 与 plugin-ready Hook 发现、项目精确哈希信任、命令 Handler、超时、结构化输出、阻断/参数改写/审批决策/上下文注入，以及 Session、Prompt、Tool、Permission、Compact、Stop 和 SessionEnd 生命周期。Hook 运行通过 `hook/started`、`hook/completed` 和 canonical `hookPrompt` Item 投影，详细行为见 `docs/CODEX-HOOKS.md`。

R24 已增加 `crates/agent-plugins`，实现本地/Git Marketplace、原子安装与回滚、启停、卸载、目录/详情/Skill 读取、共享 checkout 和 `.codex-plugin/plugin.json`。激活后的 Skills、Hooks 与 MCP 统一进入现有运行时，MCP Item 保留 `pluginId` 来源；Apps 在 R33 接入 Dynamic Tool。详细行为见 `docs/CODEX-PLUGINS.md`。

R25 已实现 `update_plan`、`request_user_input` 和 Thread Goal。Plan 使用正式 Turn 通知，用户输入通过可取消的反向 JSON-RPC 与 `waitingOnUserInput` 状态运行，Goal 进入 canonical metadata 与 rollout 并支持重建、Fork 和预算核算。详细行为见 `docs/CODEX-PLAN-GOALS.md`。

R26 已增加 `crates/agent-collab`，实现 MultiAgentV2 canonical Agent Path、子 Thread 图、并发/深度限制、`spawn_agent`、消息、follow-up、等待、打断、列表、父子取消和终态回传。协作操作投影为正式 `collabAgentToolCall` 与 `subAgentActivity` Item，详细行为见 `docs/CODEX-COLLABORATION.md`。

R27 已增加 `crates/agent-review`，实现 Review target/delivery、内联与独立 Review Thread、Review 专用工具约束和结构化输出，以及 Guardian 对命令、Patch、权限、网络和 MCP 的自动审批。Guardian 使用独立 Responses 调用、90 秒超时、精确 V2 生命周期、人工覆盖与拒绝熔断；沙箱边界始终由 R15/R16 执行，不由审查模型改变。详细行为见 `docs/CODEX-REVIEW-GUARDIAN.md`。

R28 已增加 `crates/agent-memory`，实现 Chronicle 两阶段提取与合并、SQLite 作业租约、受管 Markdown、专用读取工具、Thread 开关与污染状态、`memoryCitation`、额度保护、重置和旧 Tietiezhi MEMORY 扩展迁移。详细行为见 `docs/CODEX-MEMORY.md`。

R29 已增加 `crates/agent-git`，将 Work/Code 收敛为同一任务的工作方式，并实现唯一 Local/Worktree 环境、detached Worktree、`.worktreeinclude`、私有 Snapshot、Restore、Handoff、删除前快照和旧双空间原地接管。详细行为见 `docs/CODEX-GIT-WORKTREES.md`。

R30 已在 `crates/agent-exec` 上增加 Thread 多会话集成终端，用户终端与 App Server/模型命令共享 PTY/ConPTY、stdin、resize、输出缓冲和进程树清理；桌面 UI 提供多标签和持续轮询。详细行为见 `docs/CODEX-INTEGRATED-TERMINAL.md`。

R31 已实现 App Server V2 桌面文件服务和强类型 `ThreadItem` 时间线。Item 开始、增量和完成事件按稳定 ID 合并，18 类 Item、Turn Plan/Diff、警告和 needs-input 状态使用正式协议渲染；旧消息组件只保留正文展示和历史兼容，不承载运行时操作。详细行为见 `docs/CODEX-DESKTOP-TIMELINE.md`。

R32 已在唯一 Local/Worktree 环境上实现文件树、逐文件 Diff、Hunk 审查意见、精确 Stage/Unstage/Discard、Commit、非强推 Push 和 GitHub PR 链接。详细行为见 `docs/CODEX-DIFF-GIT-UI.md`。

R33 已增加 `crates/agent-apps`，实现 App 目录、读取、已安装状态、刷新通知和插件 Apps 激活，并将 Tietiezhi Device Fabric 注册为正式 Dynamic Tool。设备副作用按精确设备/能力/参数进入 Hook、Guardian、审批和 Item 生命周期，详细行为见 `docs/CODEX-APPS.md`。

R34 已将 Automations 接到相同 Thread、Turn、Responses、工具和 Rollout Runtime。发布版本不可变，每次运行使用独立 Worktree、`approvalPolicy=never`、持久运行记录、Cron 调度、暂停/恢复、取消和重启归档，详细行为见 `docs/CODEX-AUTOMATIONS.md`。

R35 已源码实现 Remote Control 生命周期、配对/撤销、精确 Thread 授权、远程 steer/interrupt/approval 和请求幂等，并将专有远程服务映射到 Tietiezhi 自有 Device Fabric。Realtime 直接实现固定版 Codex 的 WebSocket/WebRTC、PCM16、转写/音频/Item 通知及无重放断线恢复，详细行为见 `docs/CODEX-REMOTE-REALTIME.md`。

R17 已补齐 Windows elevated Offline/Online identity、DPAPI、Firewall 代理端口补集规则和持久 WFP filters；真实 Windows runner 验证代理唯一出口。现有功能只有在目标协议、状态恢复、测试和 UI 行为全部符合后，才能更新方法状态。

R38 已完成 App Server `initialize`/`initialized` 协商、Claude/Cursor 外部配置迁移、旧任务原地 canonical 导入与 Workspace 执行切换。Work/Code 只通过 Thread、Turn、Item 和 Responses Runtime 执行；旧 `chat_stream` 与 `run_agent_loop` 已删除，独立铁铁汁 Companion 的兼容流不进入 Workspace。详细迁移、回滚和安全边界见 `docs/CODEX-MIGRATION.md`。

R39 已建立 GA 发布门禁：完整协议账本、依赖与密钥审计、CSP、版本一致性、旧运行时禁止、旧任务字节级回滚测试、签名/公证配置校验，以及 macOS/Windows Tag 构建和 Updater 资产验证。详细流程见 `docs/CODEX-RELEASE.md`。
