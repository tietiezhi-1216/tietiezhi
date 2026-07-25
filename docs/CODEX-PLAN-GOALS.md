# Codex Plan、用户输入与 Goal

## 范围

R25 以固定 `rust-v0.145.0` 为行为基线，实现 `update_plan`、`request_user_input`、Thread Goal 以及对应 App Server V2 请求和通知。运行时不调用或嵌入 Codex 二进制。

## Plan

- `update_plan` 使用严格 Function Tool Schema，只接受非空步骤和 `pending`、`in_progress`、`completed` 三种工具状态。
- 同一计划最多一个 `in_progress` 步骤。
- 工具结果通过 `turn/plan/updated` 发布，V2 状态转换为 `pending`、`inProgress`、`completed`。
- `item/plan/delta` 使用独立流式通知入口，不把 TODO/checklist 工具错误模拟成 Plan Mode 消息。
- Plan 更新写入 canonical rollout event，重启后保留审计顺序。

## 用户输入

- `request_user_input` 只接受 1 至 3 个问题、唯一 snake_case ID、最多 12 字符标题和 2 至 3 个完整选项。
- Runtime 通过 `item/tool/requestUserInput` 反向 JSON-RPC 请求当前 Thread 订阅者，并将 Thread 标记为 `waitingOnUserInput`。
- 客户端回答使用官方 `{answers:{id:{answers:string[]}}}` 结构；响应经过固定 Schema 校验后返回同一工具调用。
- `autoResolutionMs` 限制为 60 至 240 秒；超时返回空答案，用户中断会取消 Broker 请求和工具调用。
- 桌面 SSR 测试验证正式选择、自由填写和响应结构；R31 再把该组件并入统一 Item 时间线。

## Goal

- `thread/goal/set|get|clear` 使用 App Server V2 的完整响应和通知。
- Objective 去除首尾空白、不能为空且最多 4000 字符；Token Budget 必须为正，显式 `null` 清除预算，省略字段保持原值。
- Goal 状态支持 `active`、`paused`、`blocked`、`usageLimited`、`budgetLimited` 和 `complete`。
- Token 与活动时间在模型 Usage 到达时累积，达到预算后由 `active` 转为 `budgetLimited`。
- Goal 同时写入 canonical Thread metadata 和 `thread_goal_updated` rollout event；SQLite 索引丢失后可从 rollout 重建。
- Fork 复制 Goal 快照并替换目标 `threadId`；临时 Thread 不支持 Goal；归档 Thread 仍可读取、更新和清除 Goal。

## 验证

- `agent-core` 覆盖 Goal 创建、恢复、Fork、清除、Plan 更新和 Plan Delta。
- `agent-tools` 覆盖 Plan 约束、问题规范化、自动超时范围和答案回传。
- `agent-approval` 覆盖反向请求、V2 Schema 和答案路由。
- CI 执行上述 Rust 测试、桌面 Rust 全量测试、协议快照、SSR、TypeScript 和生产构建。
