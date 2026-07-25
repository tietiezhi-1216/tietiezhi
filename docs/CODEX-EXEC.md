# Codex Unified Exec

## 范围

R13 在 Tauri Rust 进程内实现 Codex Unified Exec，不运行或嵌入上游二进制。

- 模型工具：`exec_command`、`write_stdin`。
- App Server V2：`command/exec`、`command/exec/write`、`command/exec/resize`、`command/exec/terminate`。
- 线程命令：`thread/shellCommand`。
- 强类型时间线：`commandExecution` Item、输出增量、终端交互和完成状态。
- 反向审批：`item/commandExecution/requestApproval`。

## 进程与终端

`crates/agent-exec` 源码级移植固定 Codex 版本的 `utils/pty`，并在其上实现连接和 Turn 作用域会话管理。

- 非交互执行使用独立 stdin/stdout/stderr 管道。
- 交互执行使用 macOS/Linux PTY 与 Windows ConPTY。
- 支持 stdin 写入、关闭 stdin、PTY resize、后台轮询和显式终止。
- Unix 子进程作为独立进程组运行，终止会清理整棵后代进程树；Windows 使用 ConPTY/进程终止路径。
- Manager 最后一个引用释放时会终止仍存活的会话，不遗留孤儿进程。
- 默认单流输出上限为 1 MiB；模型响应另按 `max_output_tokens` 保留头尾并报告截断前估算 Token 数。
- 模型调用等待范围与 Codex 一致：初始和非空写入为 250–30,000 ms，Windows 初始执行至少 2,000 ms，空轮询至少 5,000 ms。

## V2 路由

- `command/exec` 使用客户端连接与 `processId` 组成隔离键；PTY 或任一流式能力都要求客户端提供 `processId`。
- stdout/stderr 流以 Base64 发送 `command/exec/outputDelta`，流式内容不在最终响应中重复。
- `command/exec/write` 支持 Base64 stdin 和关闭输入；`resize` 只允许 PTY；`terminate` 杀死会话进程树。
- `thread/shellCommand` 是用户显式触发的本地主机 shell 逃生口，与 Codex 一样不继承 Turn 沙箱。它立即返回，后续通过 `process/outputDelta` 和 `process/exited` 通知线程订阅者。
- 大量输出导致广播接收者滞后时，连接执行器从会话的有序 chunk 日志补发，不静默丢字节。

## 模型工具生命周期

1. Core 先创建 `commandExecution` Item，状态为 `inProgress`。
2. R14 Policy Stage 返回 `NeedsApproval` 时发送 `item/commandExecution/requestApproval`，精确会话键命中时直接复用，等待期间 Thread 标记 `waitingOnApproval`。
3. 执行输出持续发送 `item/commandExecution/outputDelta` 并累积到 Item。
4. 非空 stdin 或仍存活的空轮询发送 `item/commandExecution/terminalInteraction`。
5. 进程退出后，同一 Item 记录 `processId`、聚合输出、退出码、耗时与 `completed/failed` 状态并持久化到 canonical rollout。
6. 快速命令直接返回退出码；超过 yield 时间返回数字 `session_id`，后续由 `write_stdin` 继续同一会话。
7. Turn 中断通过 CancellationToken 终止进程组；后台完成不会生成第二个 Item。

## 阶段边界

R13 负责可靠进程与协议生命周期，不冒充安全隔离：

- R14 实现完整 Approval Policy、会话缓存和精确授权作用域。
- R15 已为 macOS Pipe 与 PTY 命令提供 Seatbelt；R16 继续提供 Windows Restricted Token/ACL/Job Object 沙箱。
- R17 提供命令网络策略和代理归因。
- R18 使用解析后的 ExecPolicy 替代临时的统一询问策略。
- R30 在桌面 UI 暴露每个 Thread 的多个集成终端。

## 验证

- Pipe stdout/stderr 分流、stdin 往返、后台 poll、超时、输出上限。
- PTY 初始尺寸和运行中 resize。
- Unix 进程组后代清理。
- 模型工具快速完成、后台 stdin、审批拒绝零执行。
- CommandExecution Item、输出 Delta、Terminal Interaction 与 rollout 往返。
- App Server V2 Schema、TypeScript、桌面全量 Rust 与生产构建继续作为阶段门禁。
