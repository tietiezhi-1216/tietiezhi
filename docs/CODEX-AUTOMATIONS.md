# Codex Automations Runtime

## 执行模型

R34 不建立第二套 Agent。每次 Automation 运行都使用同一套 Codex Runtime：

- 发布时把当前草稿写成不可变 `published.json` 快照并递增 revision。
- 运行时创建正式 `Thread` 和 `Turn`，`threadSource` 为 `automation`。
- Turn 固定使用 `approvalPolicy=never`、`workspace-write` 和关闭命令网络的 Sandbox Policy。
- Responses、工具、Hooks、Guardian、MCP、Apps、Item、Rollout 和 Token Usage 都复用普通 Thread 路径。
- 运行记录保存 Thread ID、Turn ID、发布 revision、输入、Worktree、终态、输出和错误。
- 草稿后续修改不会影响已经开始或排队的发布版本。

无人值守运行不能等待审批或 `request_user_input`。发布校验拒绝人工审批节点；运行中遇到必须审批的副作用时，Runtime 返回明确阻塞结果，不会扩大权限或绕过沙箱。

## 工作区

- 配置 Git 项目目录时，发布前必须验证为 Git 工作树。
- 每个 Run 使用 Run ID 创建 detached 独立 Worktree，多个运行不会共享可写目录。
- 未配置项目时，每个 Run 使用独立的受管空白 Local 工作区。
- 删除 Automation 时先停止活动 Turn、保存必要的最终 Snapshot、注销 Git Worktree，再删除草稿、发布快照和运行记录。

## 调度与恢复

- Schedule Trigger 使用五段 Cron 和 IANA 时区。
- 支持 `*`、列表、范围、步长以及星期日 `0/7`。
- 日期和星期字段同时受限时遵循标准 Cron 的 OR 语义。
- Scheduler 在触发前原子推进下一次运行时间，避免同一次调度重复启动。
- `skip` 跳过超过宽限期的任务；`runLatest` 补跑最近一次。
- 发布后可暂停或恢复定时运行；手动运行不受暂停状态影响。
- 并发数按 Automation 的 queued/running 记录限制。
- Run 在创建 Worktree 前先写 queued 记录；任何启动失败都会形成正式 failed 记录。
- 应用重启时，未完成 Run 会被标为 failed，遗留 Turn 会中断；Thread、Turn 和 canonical Rollout 仍可审计。
- 最大运行时间到达后中断同一 Turn，并清理其工具和进程树。

## 桌面

Automation 控制面支持：

- 编辑运行项目、时区、最大时长、最大并发和错过调度策略。
- 发布并启用、暂停、恢复和手动运行。
- 每两秒刷新活动运行，显示 queued/running/completed/failed/cancelled。
- 取消活动 Run。
- 查看输出、错误、Thread ID、Turn ID、Worktree 路径和运行耗时。

## 验证

- `cargo test --manifest-path desktop/src-tauri/Cargo.toml automation::`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml commands::codex::tests::automation_requests_are_unattended_v2_turns`
- `pnpm test:codex-automations-ui`
- `pnpm typecheck`
- `pnpm build`
