# Codex Hooks Runtime

R23 固定对齐 OpenAI Codex `rust-v0.145.0` 的 Hook 配置、命令执行、结构化输出和 App Server V2 生命周期。实现位于 `crates/agent-hooks`，不调用或嵌入上游二进制。

## 发现与信任

- system Hook 从平台 Codex 管理目录的 `hooks.json` 读取。
- user Hook 从应用配置目录 `codex/hooks.json` 读取。
- project Hook 从 Git 项目根到当前目录逐层发现 `.codex/hooks.json`。
- project Hook 默认不执行；用户信任的是配置文件内容的 SHA-256，而不是目录或命令名称。文件变更后必须重新信任。
- managed-only 要求关闭 user、project 和 plugin 来源，只保留系统管理 Hook。
- R24 通过 `set_extra_sources` 注入插件 Hook，并保留 `plugin` provenance。

## Handler 与输出

- Command Handler 在 macOS/Linux 使用 `/bin/sh -lc`，Windows 使用非交互 PowerShell。
- 输入通过 stdin 传递 JSON，同时设置 `CODEX_HOOK_EVENT`；工作目录固定为当前 Thread cwd。
- 默认超时 10 秒，配置范围 1 到 300 秒；stdout/stderr 分别限制为 1 MiB，进程随 Future 取消清理。
- 支持 `continue`、`stopReason`、`systemMessage`、`hookSpecificOutput.additionalContext`。
- PreToolUse 支持 allow/deny、`updatedInput` 和 additional context。
- PermissionRequest 支持结构化 allow/deny，并在客户端审批请求之前执行。
- PostToolUse、UserPromptSubmit 和 Stop 支持 block/reason；显式阻断作为结构化工具失败或同 Turn 反馈返回模型。
- 无效 JSON、非零退出和超时生成 `failed` HookRun，默认 fail-continue；只有有效的 block/stop 会阻断操作。

## 生命周期

已接入以下事件：

- `SessionStart`、`SessionEnd`
- `UserPromptSubmit`
- `PreToolUse`、`PostToolUse`
- `PermissionRequest`
- `PreCompact`、`PostCompact`
- `Stop`

R26 接入子智能体时复用同一 Runtime 发布 `SubagentStart` 和 `SubagentStop`。Prompt/Agent Handler 的配置和类型已保留，在 R26 的模型支持完成前会产生明确的 failed run，不会伪装成 Command Handler。

每个执行生成 UUIDv7 HookRun，先后发布：

- `hook/started`
- `hook/completed`

上下文输出同时成为正式 `hookPrompt` Thread Item，并以 Codex 的 `<hook_prompt hook_run_id="...">` user Responses Item 写入 rollout。恢复、fork 和 compaction 因此保留 Hook 因果链。

## 验证

- `cargo test --manifest-path crates/agent-hooks/Cargo.toml`
- `cargo clippy --manifest-path crates/agent-hooks/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path crates/agent-core/Cargo.toml`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`
- `pnpm check:codex-parity`
- `pnpm typecheck`
- `pnpm build`
