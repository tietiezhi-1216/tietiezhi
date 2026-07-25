# Codex Review 与 Guardian

## 基线

R27 对齐固定上游 `rust-v0.145.0` 的 Review Task 和 Guardian 自动审批。实现位于：

- `crates/agent-review`
- `crates/agent-core`
- `desktop/src-tauri/src/commands/codex.rs`
- `desktop/src-tauri/src/mcp/mod.rs`

运行时不启动或嵌入 Codex 二进制。

## Review

- `review/start` 支持 `uncommittedChanges`、`baseBranch`、`commit` 和 `custom` target。
- `inline` 在原 Thread 创建 Review Turn；`detached` 创建 `subagentReview` Thread，并按 canonical ordinal 复制 Responses 历史。
- Review Turn 不接受 `turn/steer`。
- Review 使用固定 Rubric、严格 JSON Schema 和当前模型的 Responses API。
- Review 禁用 Web Search、View Image、Goal/Plan 和 MultiAgentV2 工具；审批策略固定为 `never`。
- Reviewer 的原始结构化 assistant message 不进入公开时间线。解析完成后发布 `exitedReviewMode` 和最终 Agent Message。
- 中断、归档、删除或模型失败时，先发布 Review 中断出口，再结束 Turn。

## Guardian

Guardian 仅在 Thread 的 `approvalsReviewer` 为 `auto_review` 或兼容值 `guardian_subagent` 时接管审批。用户审批模式不受影响。

- 覆盖 Unified Exec、Apply Patch、Request Permissions、网络访问和破坏性 MCP 工具。
- 使用独立 Responses 请求、固定 Guardian Policy、严格结构化输出和 90 秒上限。
- 发布 `item/autoApprovalReview/started` 与 `item/autoApprovalReview/completed`，并将完整审计事件追加到 rollout。
- 网络审查不错误绑定 Command Item；其 `targetItemId` 为 `null`。
- `thread/approveGuardianDeniedAction` 只覆盖与原 action 精确匹配的一次拒绝。
- 三次连续拒绝，或最近 50 次中的十次拒绝，会发布 `guardianWarning` 并中断当前 Turn。
- 审查超时、输出错误和传输失败均 fail closed；不会自动扩大权限。
- Guardian 只决定一次审批结果，不能修改 OS Sandbox、ExecPolicy、网络代理或持久授权规则。

## 验证

- `crates/agent-review` 覆盖 target 校验、输出渲染、V2 通知和熔断阈值。
- `crates/agent-core` 覆盖 inline/detached 生命周期、恢复和 Review steer 拒绝。
- 桌面 Rust 测试覆盖 Review 输出抑制、结构化结果捕获和工具约束。
- CI 在 macOS 与 Windows 分别执行 Review、Core、Desktop 和协议测试。
