# Codex Collaboration

## 范围

R26 以固定 `rust-v0.145.0` 为行为基线，实现 MultiAgentV2 的子 Thread 图、六个模型工具、消息邮箱、等待/转向、打断、完成通知和父子取消。运行时不调用或嵌入 Codex 二进制。

## Agent 图

- 每个会话树使用 `/root` 作为 canonical root；子任务名只允许小写字母、数字和下划线。
- 相对目标从当前 Agent Path 解析，绝对目标必须位于 `/root`。
- 默认最大并发 Thread 数为 6、最大子代深度为 1；`agents.max_concurrent_threads_per_session` 与 `agents.max_depth` 可按 R21 分层配置覆盖。
- 图、状态和待投递邮箱原子保存到 `agent-runtime/collaboration/collaboration.json`。
- Core Thread 同时保存 `parentThreadId`、SubAgent Session Source、`agentNickname` 和 `agentRole`；SQLite 索引丢失后可从 rollout 的身份事件重建。

## 工具行为

- `spawn_agent` 支持 `fork_turns=none|all|N`。`all` 复制 canonical Responses 历史，`N` 只注入最近 N 个 Turn 的 Responses 历史，`none` 使用空历史。
- `send_message` 把消息加入目标输入队列但不主动开启 Turn。
- `followup_task` 在目标空闲时开启新 Turn，运行中则在采样边界接收 Steer；根 Agent 不能作为 follow-up 目标。
- `wait_agent` 的范围为 10 秒至 1 小时，默认 30 秒；邮箱、终态通知或同 Turn 用户 Steer 都能提前结束等待。
- `interrupt_agent` 只中断目标当前 Turn，不删除 Agent；不能中断 root 或自身。
- `list_agents` 只列出当前 root tree 内的 live Agent，并支持 canonical path 前缀。
- 子 Agent 不允许直接调用 `request_user_input`，必须把问题发回 root。

## Item 与生命周期

- 工具调用投影为正式 `collabAgentToolCall`，公开工具名保持 `spawnAgent`、`sendInput`、`resumeAgent`、`wait` 和 `closeAgent`。
- 启动、交互和中断分别产生 `subAgentActivity.started`、`interacted` 和 `interrupted`。
- 子 Turn 的完成、失败和中断更新 Agent 状态，并将终态消息投递给父 Thread。
- 父 Thread 的 archive、delete 或 Turn 取消会递归取消仍在运行的后代进程和模型流。
- `SubagentStart`、`SubagentStop` Hook 使用统一 Hook Runtime；工具本身继续经过 PreToolUse/PostToolUse。

## 执行环境

Sub Agent 继承当前 Turn 的模型、Provider、审批、沙箱、cwd 和服务等级；模型与推理覆盖仅在工具参数显式指定时应用。它们共享所选执行环境，这与固定 Codex 基线一致。R29 在用户选择 Worktree 模式时为 Thread 树提供 Git Worktree 边界，不在 Collaboration 层复制目录。

## 验证

- `agent-collab` 覆盖 canonical path、并发/深度限制、`fork_turns`、原子恢复、邮箱等待和六个工具 Schema。
- `agent-core` 覆盖 SubAgent 身份持久化、恢复、Thread 投影和最近 Turn Responses 历史。
- 桌面 Rust 测试验证 Collaboration Item 与固定 App Server V2 `ThreadItem` 双向兼容。
- CI 执行上述测试、全量桌面 Rust、协议快照、旧记录迁移、TypeScript 和生产构建。
