# Codex 集成终端

## 范围

R30 在 R13 Unified Exec 的 PTY/ConPTY 和进程树内核之上增加 Thread 级集成终端。用户终端、App Server `command/exec` 和模型命令共用同一个 `ExecManager`，不创建第二套子进程实现。

## 会话模型

- 每个任务最多 8 个独立终端，会话 owner 固定为 `thread-terminal/{taskId}`。
- 首次创建时解析 R29 的唯一 Local/Worktree 根，Work 与 Code 不会得到不同 cwd。
- macOS/Linux 使用用户登录 Shell，Windows 优先 `COMSPEC` 并回退 PowerShell。
- 会话在应用进程内存中存活，切换聊天不会终止；应用退出后 OS 进程组/Job Object 统一回收，重启不伪造已恢复的 shell。

## 交互与输出

- 创建、列举、长轮询、stdin、resize、terminate 和 close 都由 Rust Tauri command 执行。
- 输出保留 stdout/stderr 顺序游标，前端按会话增量读取，最多渲染最近 160,000 字符。
- 每个进程最多捕获 8 MB，达到上限仍等待真实退出，不把截断误报为成功或终止。
- 前端提供多标签、运行状态、退出码、命令输入、Ctrl+C、停止和关闭；终端只在 Code 工作方式显示。
- ANSI/OSC/CSI 控制序列在轻量文本视图中移除，CR 与退格被确定性规范化，不向 DOM 注入终端输出 HTML。

## 生命周期

- `terminal_close` 先请求终止再从进程表和 Thread 会话目录移除。
- 永久删除任务时调用 `terminate_owner`，与 R29 最终 Snapshot/Worktree 注销处于同一清理路径。
- 常驻服务保持 running 状态并可持续轮询，不会伪装成仍在等待的模型工具调用。
- 终端会话本身不进入 rollout；可恢复的任务历史只记录模型和工具 Item，重启后 UI 明确显示没有活动终端。

## 验证

- `agent-exec` 已覆盖 stdin roundtrip、后台 poll、PTY resize、输出 cap、超时和整棵进程树终止。
- 桌面 Rust 覆盖 Thread owner/key 隔离、显式登录 Shell 和命令编译接线。
- SSR 门禁覆盖 Terminal 入口、创建、输入、Ctrl+C、resize、terminate、close 与控制序列净化。
- macOS/Windows CI 运行 Unified Exec、桌面 Rust、TypeScript 和生产构建。
