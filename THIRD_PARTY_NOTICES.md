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
