# Third-Party Notices

## OpenAI Codex

Tietiezhi 的 Codex Runtime 对齐工作参考并可能移植 OpenAI Codex 的 Apache-2.0 源码。

- Project: OpenAI Codex
- Source: https://github.com/openai/codex
- Pinned version: `rust-v0.145.0`
- Pinned commit: `25af12f7e61572b0bc18ddb1008be543b91519b0`
- License: Apache License 2.0
- Copyright: Copyright 2025 OpenAI

移植具体源文件时，必须在本文件和对应源文件中补充精确的上游路径及修改说明。

R2 固定了以下上游生成物，未修改协议内容：

- `shared/codex/v2/schema/` 来源于 `codex-rs/app-server-protocol/schema/json/`。
- `shared/codex/v2/typescript/` 来源于 `codex-rs/app-server-protocol/schema/typescript/`。
- `crates/agent-protocol/` 使用上述 JSON Schema 编译生成本项目 Rust 类型；服务端请求枚举因通用生成器无法表达上游交叉类型，按 `codex-rs/app-server-protocol/src/protocol/common.rs` 的方法映射在本仓库源码实现；JSON-RPC Envelope 移植自 `codex-rs/app-server-protocol/src/rpc.rs`，仅将 Trace Context 改为本地同形类型。

R5 的 Thread 生命周期行为参考以下上游源码并在本仓库重新实现，没有链接或调用上游 crate：

- `codex-rs/app-server/src/request_processors/thread_processor.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs`
- `codex-rs/core/src/thread_manager.rs`
- `codex-rs/core/src/thread_rollout_truncation.rs`

R6 的 Turn 生命周期、输入转换和 rollout 投影行为参考以下上游源码并在本仓库重新实现，没有链接或调用上游 crate：

- `codex-rs/app-server/src/request_processors/turn_processor.rs`
- `codex-rs/app-server/src/bespoke_event_handling.rs`
- `codex-rs/app-server/src/thread_state.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
- `codex-rs/app-server-protocol/src/protocol/thread_history.rs`
- `codex-rs/core/src/session/handlers.rs`
- `codex-rs/core/src/session/turn_context.rs`
- `codex-rs/protocol/src/items.rs`
- `codex-rs/protocol/src/protocol.rs`
- `codex-rs/protocol/src/user_input.rs`

R7 的 Responses 请求、SSE、重试、Token Usage 和模型目录行为参考以下上游源码并在本仓库重新实现，没有链接或调用上游 crate：

- `codex-rs/codex-api/src/common.rs`
- `codex-rs/codex-api/src/sse/responses.rs`
- `codex-rs/core/src/client.rs`
- `codex-rs/core/src/responses_retry.rs`
- `codex-rs/core/src/session/turn.rs`
- `codex-rs/model-provider-info/src/lib.rs`
- `codex-rs/models-manager/models.json`
- `codex-rs/app-server/src/models.rs`
- `codex-rs/app-server/src/bespoke_event_handling.rs`

R8 的账号生命周期、额度、外部令牌刷新和服务映射行为参考以下上游源码并在本仓库重新实现，没有链接或调用上游 crate：

- `codex-rs/app-server/src/request_processors/account_processor.rs`
- `codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/account.rs`
- `codex-rs/app-server-protocol/src/protocol/common.rs`
- `codex-rs/app-server/src/message_processor.rs`

R9 的历史规范化、上下文窗口、自动/手动压缩、World State 和 rollout 重建行为参考以下上游源码并在本仓库重新实现，没有链接或调用上游 crate：

- `codex-rs/core/src/context_manager/history.rs`
- `codex-rs/core/src/context_manager/normalize.rs`
- `codex-rs/core/src/compact.rs`
- `codex-rs/core/src/tasks/compact.rs`
- `codex-rs/core/src/session/context_window.rs`
- `codex-rs/core/src/session/token_budget.rs`
- `codex-rs/core/src/state/auto_compact_window.rs`
- `codex-rs/core/src/context/world_state/mod.rs`
- `codex-rs/core/src/session/rollout_reconstruction.rs`
- `codex-rs/protocol/src/protocol.rs`

以下固定提示词文件从上述 Apache-2.0 版本逐字保留，以确保压缩行为与基线一致：

- `crates/agent-context/prompts/compact.md` 来源于 `codex-rs/prompts/templates/compact/prompt.md`
- `crates/agent-context/prompts/summary-prefix.md` 来源于 `codex-rs/prompts/templates/compact/summary_prefix.md`

R10 的工具注册、路由、生命周期、模型结果和并行调度行为参考以下上游源码并在本仓库重新实现，没有链接或调用上游 crate：

- `codex-rs/core/src/tools/context.rs`
- `codex-rs/core/src/tools/registry.rs`
- `codex-rs/core/src/tools/router.rs`
- `codex-rs/core/src/tools/lifecycle.rs`
- `codex-rs/core/src/tools/parallel.rs`
- `codex-rs/core/src/tools/orchestrator.rs`
- `codex-rs/app-server/src/dynamic_tools.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`

上游 `utils/pty/src/win/conpty.rs` 本身包含来自 WezTerm 的 MIT 许可代码，原版权与完整 MIT 许可文本已逐字保留在 `crates/agent-exec/src/win/conpty.rs`：

- Project: WezTerm
- Source: https://github.com/wezterm/wezterm
- Copyright: Copyright (c) 2018-Present Wez Furlong
- License: MIT

R11 的基础工具、Tool Search、模型能力门控和强类型 Item 行为参考以下上游源码并在本仓库重新实现，没有链接或调用上游 crate：

- `codex-rs/core/src/tools/handlers/current_time.rs`
- `codex-rs/core/src/tools/handlers/sleep.rs`
- `codex-rs/core/src/tools/handlers/get_context_remaining.rs`
- `codex-rs/core/src/tools/handlers/get_context_remaining_spec.rs`
- `codex-rs/core/src/tools/handlers/view_image.rs`
- `codex-rs/core/src/tools/handlers/view_image_spec.rs`
- `codex-rs/core/src/tools/handlers/tool_search.rs`
- `codex-rs/core/src/tools/handlers/tool_search_spec.rs`
- `codex-rs/core/src/tools/spec_plan.rs`
- `codex-rs/core/src/web_search.rs`
- `codex-rs/protocol/src/items.rs`
- `codex-rs/ext/items/src/lib.rs`

R12 的 Patch 语法、流式解析、宽容上下文匹配、FileChange 生命周期和 Diff 行为参考或移植以下 Apache-2.0 上游源码，没有链接或调用上游 crate：

- `codex-rs/apply-patch/src/parser.rs` 移植到 `crates/agent-patch/src/parser.rs`，移除 `PathUri` 依赖并由本地工作区路径校验替代。
- `codex-rs/apply-patch/src/streaming_parser.rs` 移植到 `crates/agent-patch/src/streaming_parser.rs`，保持增量语法状态机。
- `codex-rs/apply-patch/src/seek_sequence.rs` 移植到 `crates/agent-patch/src/seek_sequence.rs`，保持逐级宽容匹配。
- `codex-rs/apply-patch/src/lib.rs`
- `codex-rs/core/src/tools/handlers/apply_patch.rs`
- `codex-rs/core/src/tools/handlers/apply_patch_spec.rs`
- `codex-rs/core/src/tools/handlers/apply_patch.lark`
- `codex-rs/app-server/src/bespoke_event_handling.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/turn.rs`

本项目在上游行为之上增加了全量预演、工作区与 symlink 逃逸校验、同文件系统 staging、备份回滚和多文件事务提交，以满足 R12 的原子写入门禁。

R13 的 PTY、管道、进程组和 Windows ConPTY 实现从以下 Apache-2.0 上游源码移植到 `crates/agent-exec`，增加会话管理、输出日志、超时、取消和协议投影，但不链接或调用上游二进制：

- `codex-rs/utils/pty/src/lib.rs`
- `codex-rs/utils/pty/src/pipe.rs`
- `codex-rs/utils/pty/src/process.rs`
- `codex-rs/utils/pty/src/process_group.rs`
- `codex-rs/utils/pty/src/pty.rs`
- `codex-rs/utils/pty/src/windows_input.rs`
- `codex-rs/utils/pty/src/windows_input_tests.rs`
- `codex-rs/utils/pty/src/win/conpty.rs`
- `codex-rs/utils/pty/src/win/mod.rs`
- `codex-rs/utils/pty/src/win/procthreadattr.rs`
- `codex-rs/utils/pty/src/win/psuedocon.rs`

R13 的 Unified Exec 工具、App Server 命令接口和 Item 生命周期还参考以下上游源码重新实现：

- `codex-rs/core/src/tools/handlers/unified_exec.rs`
- `codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs`
- `codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs`
- `codex-rs/core/src/unified_exec/process_manager.rs`
- `codex-rs/app-server/src/command_exec.rs`
- `codex-rs/app-server/src/request_processors/command_exec_processor.rs`
- `codex-rs/app-server/src/request_processors/thread_processor.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/command_exec.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`

R14 的审批策略、会话缓存、反向请求、权限 Profile 和 `request_permissions` 行为参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/protocol/src/protocol.rs`
- `codex-rs/protocol/src/approvals.rs`
- `codex-rs/protocol/src/request_permissions.rs`
- `codex-rs/core/src/tools/approvals.rs`
- `codex-rs/core/src/tools/sandboxing.rs`
- `codex-rs/core/src/tools/runtimes/apply_patch.rs`
- `codex-rs/core/src/tools/runtimes/unified_exec.rs`
- `codex-rs/core/src/tools/handlers/request_permissions.rs`
- `codex-rs/core/src/tools/handlers/shell_spec.rs`
- `codex-rs/core/src/config/permission_profile_catalog.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/permissions.rs`

R15 的 macOS Seatbelt 策略生成、命令封装和逃逸测试参考或移植以下 Apache-2.0 上游源码，没有链接或调用上游二进制：

- `codex-rs/sandboxing/src/seatbelt.rs`
- `codex-rs/sandboxing/src/seatbelt_tests.rs`
- `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl` 移植到 `crates/agent-sandbox/src/policies/seatbelt_base_policy.sbpl`
- `codex-rs/sandboxing/src/seatbelt_network_policy.sbpl` 移植到 `crates/agent-sandbox/src/policies/seatbelt_network_policy.sbpl`
- `codex-rs/core/src/safety.rs`
- `codex-rs/core/src/apply_patch.rs`
- `codex-rs/core/src/tools/runtimes/apply_patch.rs`

本地实现复用同一 `SandboxPolicy` 约束 Pipe、PTY 和 Patch 路径；路径检查额外解析最深已存在父目录，避免新文件通过 symlink 父目录逃逸。

R16 的 Windows Restricted Token、ACL、世界可写审计、用户目录隐藏、Job Object 和自重入 wrapper 行为参考以下 Apache-2.0 上游源码重新实现，没有链接、调用或打包上游二进制：

- `codex-rs/windows-sandbox-rs/src/acl.rs`
- `codex-rs/windows-sandbox-rs/src/audit.rs`
- `codex-rs/windows-sandbox-rs/src/cap.rs`
- `codex-rs/windows-sandbox-rs/src/hide_users.rs`
- `codex-rs/windows-sandbox-rs/src/path_normalization.rs`
- `codex-rs/windows-sandbox-rs/src/process.rs`
- `codex-rs/windows-sandbox-rs/src/token.rs`
- `codex-rs/windows-sandbox-rs/src/wrapper.rs`
- `codex-rs/windows-sandbox-rs/src/bin/command_runner/win.rs`
- `codex-rs/core/src/tools/handlers/unified_exec/mod.rs`

本地实现用当前桌面可执行文件或测试 runner 进行源码级 self-reentry，并增加策略审计缓存、capability SID、Pipe/ConPTY 集成测试和固定 App Server V2 setup/readiness 通知。

R17 的域名规则、私网目标拒绝、代理归因、HTTP/SOCKS5 出口和网络决策语义参考以下 Apache-2.0 上游源码重新实现，没有链接或调用上游二进制：

- `codex-rs/network-proxy/src/attribution.rs`
- `codex-rs/network-proxy/src/config.rs`
- `codex-rs/network-proxy/src/connect_policy.rs`
- `codex-rs/network-proxy/src/network_policy.rs`
- `codex-rs/network-proxy/src/policy.rs`
- `codex-rs/network-proxy/src/proxy.rs`
- `codex-rs/network-proxy/src/reasons.rs`
- `codex-rs/network-proxy/src/responses.rs`
- `codex-rs/core/src/network_policy_decision.rs`
- `codex-rs/protocol/src/network_policy.rs`
- `codex-rs/sandboxing/src/seatbelt.rs`

本地实现增加与现有 `PersistentApprovalStore`、Unified Exec 和 App Server `command/exec` 的适配；模型 API、Hosted Web Search 和用户 shell 不通过命令代理。

R18 的绝对路径、Shell/PowerShell 解析、安全命令分类和 Starlark ExecPolicy 从以下 Apache-2.0 上游源码移植，没有链接、调用或打包上游二进制：

- `codex-rs/utils/absolute-path/src`
- `codex-rs/shell-command/src`
- `codex-rs/execpolicy/src`
- `codex-rs/core/src/exec_policy.rs`
- `codex-rs/core/src/exec_policy_tests.rs`
- `codex-rs/core/src/exec_policy_windows_tests.rs`

移植目标分别为 `crates/agent-absolute-path`、`crates/agent-shell-command` 和 `crates/agent-execpolicy`；本地适配层将策略结果接入 Unified Exec、App Server 审批和 R14 持久规则。

R19 的 MCP 客户端、OAuth、工具/资源、Elicitation、进度、状态目录和 App Server 映射行为参考以下 Apache-2.0 上游源码重新实现，没有链接、调用或打包上游 Codex 二进制：

- `codex-rs/rmcp-client/src/lib.rs`
- `codex-rs/rmcp-client/src/auth.rs`
- `codex-rs/rmcp-client/src/oauth.rs`
- `codex-rs/rmcp-client/src/perform_oauth_login.rs`
- `codex-rs/rmcp-client/src/bin/test_stdio_server.rs`
- `codex-rs/core/src/mcp.rs`
- `codex-rs/core/src/mcp_connection_manager.rs`
- `codex-rs/core/src/mcp_tool_call.rs`
- `codex-rs/core/src/tools/handlers/mcp.rs`
- `codex-rs/app-server/src/request_processors/mcp_processor.rs`
- `codex-rs/app-server/src/mcp_server_request_handler.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/mcp_server.rs`

本地 source-built fixture 仅保留协议测试所需的最小工具、资源和富内容，不分发上游测试服务器二进制。MCP 线协议由 Apache-2.0 `rmcp` crate 实现；其依赖许可证随 Cargo 供应链清单发布。

R20 的分层项目指令发现、AGENTS World State 替换/移除语义和模型上下文写入顺序参考以下 Apache-2.0 上游源码重新实现，没有链接、调用或打包上游 Codex 二进制：

- `codex-rs/core/src/agents_md.rs`
- `codex-rs/core/src/context/world_state/agents_md.rs`
- `codex-rs/core/src/context_manager/history.rs`
- `codex-rs/core/src/context_manager/updates.rs`
- `codex-rs/core/src/session/world_state.rs`
- `codex-rs/core/src/session/mod.rs`
- `codex-rs/protocol/src/protocol.rs`

本地实现位于 `crates/agent-config`，并通过 `crates/agent-core` 的 canonical rollout 与桌面 Responses 执行器接入；上游二进制不参与运行。

R21 的 TOML 配置分层、来源追踪、原子编辑、Requirements 约束与实验功能目录参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/config/src/loader`
- `codex-rs/config/src/merge.rs`
- `codex-rs/config/src/config_requirements.rs`
- `codex-rs/config/src/constraint.rs`
- `codex-rs/config/src/profile_toml.rs`
- `codex-rs/config/src/project_root_markers.rs`
- `codex-rs/config/src/state.rs`
- `codex-rs/core/src/config`
- `codex-rs/app-server/src/request_processors/config_processor.rs`

本地配置写入使用同目录临时文件、`fsync` 和原子重命名，并通过内容 SHA-256 版本实现乐观并发控制。

R22 的技能根发现、元数据解析、配置规则、缓存失效与 App Server 投影参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/skills/src`
- `codex-rs/core-skills/src`
- `codex-rs/app-server/src/request_processors/catalog_processor.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/plugin.rs`

本地实现只在目录扫描时读取 `SKILL.md` frontmatter 和 `SKILL.json`；技能正文直到模型显式调用 `skill` 工具才读取。

R23 的 Hook 配置、发现、命令执行、输出解析、事件生命周期和 App Server 投影参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/hooks/src`
- `codex-rs/config/src/hook_config.rs`
- `codex-rs/protocol/src/items.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/notification.rs`

本地实现位于 `crates/agent-hooks`，命令 Handler 由当前 Tauri 进程直接创建并受超时、输出上限和项目哈希信任约束；不调用或分发上游 Codex 二进制。

R24 的 Plugin Manifest、Marketplace、安装、共享与激活行为参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/plugin/src`
- `codex-rs/core-plugins/src`
- `codex-rs/config/src/plugin_edit.rs`
- `codex-rs/app-server/src/request_processors/plugins.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/plugin.rs`

本地实现位于 `crates/agent-plugins`，以 staging、原子重命名和 rollback 目录管理插件包；Git Marketplace 由源码级 `git` 子进程获取，不运行、链接或分发上游 Codex 二进制。

R25 的 Plan、用户输入和 Thread Goal 行为参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/core/src/tools/handlers/plan.rs`
- `codex-rs/core/src/tools/handlers/plan_spec.rs`
- `codex-rs/core/src/tools/handlers/request_user_input.rs`
- `codex-rs/core/src/tools/handlers/request_user_input_spec.rs`
- `codex-rs/ext/goal/src/api.rs`
- `codex-rs/ext/goal/src/accounting.rs`
- `codex-rs/app-server/src/request_processors/thread_goal_processor.rs`
- `codex-rs/app-server/src/bespoke_event_handling.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- `codex-rs/protocol/src/protocol.rs`

本地实现复用统一 Tool Runtime、Server Request Broker 和 canonical rollout，不调用、链接或分发上游 Codex 二进制。

R26 的 MultiAgentV2 工具、Agent Path、控制图、输入邮箱、状态观察和 App Server Item 投影参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/core/src/agent`
- `codex-rs/core/src/agent_communication.rs`
- `codex-rs/core/src/tools/handlers/multi_agents_spec.rs`
- `codex-rs/core/src/tools/handlers/multi_agents_v2`
- `codex-rs/protocol/src/agent_path.rs`
- `codex-rs/protocol/src/items.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `codex-rs/app-server/src/bespoke_event_handling.rs`

本地实现位于 `crates/agent-collab`，通过 `agent-core` ThreadManager 和桌面 Responses Tool Runtime 执行，不调用、链接或分发上游 Codex 二进制。

R27 的 Review 与 Guardian 生命周期、提示、结构化结果和自动审批规则参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/prompts/templates/review/rubric.md`
- `codex-rs/core/src/guardian/policy.md`
- `codex-rs/core/src/session/review.rs`
- `codex-rs/core/src/tasks/review.rs`
- `codex-rs/core/src/review_prompts.rs`
- `codex-rs/core/src/guardian`
- `codex-rs/core/src/tools/approvals.rs`
- `codex-rs/core/src/tools/network_approval.rs`
- `codex-rs/core/src/mcp_tool_call.rs`
- `codex-rs/app-server/src/request_processors/turn_processor.rs`
- `codex-rs/app-server/src/request_processors/thread_processor.rs`
- `codex-rs/app-server/src/bespoke_event_handling.rs`

固定版本的 Review rubric 和 Guardian policy 以文本资产保存在 `crates/agent-review/assets`；本地实现不调用、链接或分发上游 Codex 二进制。

R28 的 Chronicle 长期记忆、两阶段生成、作业租约、受管文件、引用和读取工具行为参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/memories/read/src`
- `codex-rs/memories/write/src`
- `codex-rs/ext/memories/src`
- `codex-rs/state/src/runtime/memories.rs`
- `codex-rs/protocol/src/memory_citation.rs`
- `codex-rs/core/src/session/session.rs`
- `codex-rs/app-server/src/request_processors/thread_processor.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`

以下固定提示词文件从上述 Apache-2.0 版本逐字保留：

- `crates/agent-memory/assets/read_path.md`
- `crates/agent-memory/assets/stage_one_system.md`
- `crates/agent-memory/assets/stage_one_input.md`
- `crates/agent-memory/assets/consolidation.md`

本地实现位于 `crates/agent-memory`，通过 `agent-core` canonical rollout 和桌面 Responses Provider 执行，不调用、链接或分发上游 Codex 二进制。

R29 的 Git 基线、分支校验、状态读取与桌面 Worktree 行为参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/git-utils/src/baseline.rs`
- `codex-rs/git-utils/src/branch.rs`
- `codex-rs/git-utils/src/info.rs`
- `codex-rs/git-utils/src/operations.rs`
- `codex-rs/core/src/git_info.rs`
- `codex-rs/core/src/git_info_tests.rs`

本地实现位于 `crates/agent-git`，增加 `.worktreeinclude`、alternate-index Snapshot、Restore、Handoff 和旧任务接管；只调用系统 Git，不调用、链接或分发上游 Codex 二进制。

R30 的集成终端复用 R13 已登记的 Apache-2.0 PTY、Unified Exec 和 App Server command exec 源码映射。新增 Thread 会话目录与 React 文本终端位于 `desktop/src-tauri/src/commands/terminal.rs` 和 `desktop/src/features/chat/integrated-terminal-panel.tsx`，不包含或分发上游二进制。

R31 的强类型时间线、文件服务和模糊搜索行为参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/notification.rs`
- `codex-rs/tui/src/chatwidget/replay.rs`
- `codex-rs/tui/src/app/thread_events.rs`
- `codex-rs/exec-server-protocol/src/protocol.rs`
- `codex-rs/file-search/src`
- `codex-rs/utils/fuzzy-match/src`

本地实现位于 `desktop/src-tauri/src/commands/codex_fs.rs`、`desktop/src/stores/codex-timeline.ts` 和 `desktop/src/features/chat/codex-timeline.tsx`，不调用、链接或分发上游 Codex 二进制。

R32 的 Diff 与 Git UI 复用 R29 已登记的 Apache-2.0 Git 基线，并参考 `codex-rs/tui/src/chatwidget/replay.rs` 的 FileChange/Diff 展示行为。本地 Git 操作位于 `crates/agent-git`，React 界面位于 `desktop/src/features/chat/workspace-git-panel.tsx`；只调用系统 Git，不调用、链接或分发上游 Codex 二进制。

R33 的 Apps 目录、已安装连接器投影和 Dynamic Tool 生命周期参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/app-server/src/request_processors/apps_processor.rs`
- `codex-rs/app-server/src/request_processors/apps_processor/installed.rs`
- `codex-rs/app-server/src/dynamic_tools.rs`
- `codex-rs/app-server/src/app_info.rs`
- `codex-rs/connectors/src`
- `codex-rs/app-server-protocol/src/protocol/v2/apps.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`

本地实现位于 `crates/agent-apps` 和桌面 Dynamic Tool 宿主；设备能力调用使用 Tietiezhi 自有 Device Fabric，不调用、链接或分发上游 Codex 二进制。

R34 的 Automation Thread 来源、无人值守 Turn 和生命周期行为参考以下 Apache-2.0 上游源码：

- `codex-rs/protocol/src/protocol.rs`
- `codex-rs/core/src/session`
- `codex-rs/app-server/src/request_processors/turn_processor.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/turn.rs`

调度器、发布快照、运行记录和桌面编排器是 Tietiezhi 自有实现，并复用本仓库的 Thread、Turn、Worktree、Sandbox 和 Approval Runtime；不调用、链接或分发上游 Codex 二进制。

R35 的 Remote Control 与 Realtime 协议、请求处理、事件映射和传输行为参考以下 Apache-2.0 上游源码重新实现：

- `codex-rs/app-server/src/request_processors/remote_control_processor.rs`
- `codex-rs/app-server/src/request_processors/turn_processor.rs`
- `codex-rs/app-server/src/bespoke_event_handling.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/remote_control.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/realtime.rs`
- `codex-rs/codex-api/src/endpoint/realtime_call.rs`
- `codex-rs/codex-api/src/endpoint/realtime_websocket`
- `codex-rs/core/src/realtime_conversation.rs`

本地实现在 `crates/agent-remote` 与 `crates/agent-realtime`。OpenAI 专有远程控制服务未被复制；服务传输映射到 Tietiezhi 自有 Device Fabric，同时保留 App Server 生命周期与强类型通知。不调用、链接或分发上游 Codex 二进制。
