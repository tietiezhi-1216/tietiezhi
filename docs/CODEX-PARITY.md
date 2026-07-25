# Codex V2 功能对齐

> 本文件由 `desktop/scripts/check-codex-parity.mjs --write` 根据机器可读 ledger 生成。状态更新应先修改 `shared/codex/v2/upstream-baseline.json`，再重新生成本文档。

## 固定基线

- Codex 版本：`0.145.0`
- Git Tag：`rust-v0.145.0`
- Git Commit：`25af12f7e61572b0bc18ddb1008be543b91519b0`
- 协议：`app-server-v2`
- 上游源码：https://github.com/openai/codex/tree/rust-v0.145.0/codex-rs
- 许可证：`Apache-2.0`
- 捕获日期：`2026-07-25`
- 客户端请求：89
- 客户端通知：1
- 服务端请求：10
- 服务端通知：70
- Thread Item 类型：18
- User Input 类型：7

## 状态规则

- `pending`：尚未实现，但已分配目标阶段。
- `in_progress`：当前阶段正在实现，不能作为发布完成状态。
- `implemented`：已实现且必须在备注中给出源码与测试证据。
- `service_mapped`：Codex 依赖专有服务时映射到 Tietiezhi 服务，并在备注中给出证据。
- Ledger 不允许使用“永久不支持”作为终态。
- 每完成一个 R 阶段必须更新阶段状态、方法状态、证据和剩余风险。

| 方法状态 | 数量 |
| --- | ---: |
| 待实现 | 170 |
| 实现中 | 0 |
| 已实现 | 0 |
| 服务映射 | 0 |

## 阶段进度

| 阶段 | 名称 | 状态 | 证据 | 剩余风险 |
| --- | --- | --- | --- | --- |
| R0 | 基线治理 | 已完成 | shared/codex/v2/upstream-baseline.json；desktop/scripts/check-codex-parity.mjs；pnpm check:codex-parity；pnpm typecheck；pnpm build；cargo test（130 项） | 官方 V2 方法仍全部待实现；R1 起逐项推进 |
| R1 | 旧运行时止血 | 已完成 | desktop/src-tauri/src/permission/mod.rs；desktop/src-tauri/src/agent/loop_.rs；commands::conversations 旧决策迁移测试；scripts/check-permission-prompt.mjs；pnpm test:permission-ui；pnpm typecheck；pnpm build；cargo test | 尚未具备 Codex OS 沙箱、ExecPolicy 和独立 Approval 状态机；这些能力由 R14-R18 实现 |
| R2 | 协议层 | 待开始 |  |  |
| R3 | 事件模型 | 待开始 |  |  |
| R4 | 持久化 | 待开始 |  |  |
| R5 | Thread 生命周期 | 待开始 |  |  |
| R6 | Turn 生命周期 | 待开始 |  |  |
| R7 | Responses 模型层 | 待开始 |  |  |
| R8 | Gateway 对齐 | 待开始 |  |  |
| R9 | 上下文系统 | 待开始 |  |  |
| R10 | 工具内核 | 待开始 |  |  |
| R11 | 基础工具 | 待开始 |  |  |
| R12 | Patch 与 Diff | 待开始 |  |  |
| R13 | Unified Exec | 待开始 |  |  |
| R14 | 审批策略 | 待开始 |  |  |
| R15 | macOS 沙箱 | 待开始 |  |  |
| R16 | Windows 沙箱 | 待开始 |  |  |
| R17 | 网络策略 | 待开始 |  |  |
| R18 | ExecPolicy | 待开始 |  |  |
| R19 | MCP 完整实现 | 待开始 |  |  |
| R20 | 指令层 | 待开始 |  |  |
| R21 | 配置体系 | 待开始 |  |  |
| R22 | Skills | 待开始 |  |  |
| R23 | Hooks | 待开始 |  |  |
| R24 | Plugins | 待开始 |  |  |
| R25 | Plan 与用户输入 | 待开始 |  |  |
| R26 | Collaboration | 待开始 |  |  |
| R27 | Guardian 与 Review | 待开始 |  |  |
| R28 | Memory | 待开始 |  |  |
| R29 | Git 与 Worktree | 待开始 |  |  |
| R30 | 集成终端 | 待开始 |  |  |
| R31 | Desktop 时间线 | 待开始 |  |  |
| R32 | Diff 与 Git UI | 待开始 |  |  |
| R33 | Apps 与连接器 | 待开始 |  |  |
| R34 | Automations | 待开始 |  |  |
| R35 | 远程与实时 | 待开始 |  |  |
| R36 | 运维能力 | 待开始 |  |  |
| R37 | 稳定性工程 | 待开始 |  |  |
| R38 | 迁移切换 | 待开始 |  |  |
| R39 | 正式发布 | 待开始 |  |  |

## Client Requests

| 方法 | 状态 | 目标阶段 | 证据或备注 |
| --- | --- | --- | --- |
| `account/login/cancel` | 待实现 | R8 |  |
| `account/login/start` | 待实现 | R8 |  |
| `account/logout` | 待实现 | R8 |  |
| `account/rateLimitResetCredit/consume` | 待实现 | R8 |  |
| `account/rateLimits/read` | 待实现 | R8 |  |
| `account/read` | 待实现 | R8 |  |
| `account/sendAddCreditsNudgeEmail` | 待实现 | R8 |  |
| `account/usage/read` | 待实现 | R8 |  |
| `account/workspaceMessages/read` | 待实现 | R8 |  |
| `app/installed` | 待实现 | R33 |  |
| `app/list` | 待实现 | R33 |  |
| `app/read` | 待实现 | R33 |  |
| `command/exec` | 待实现 | R13 |  |
| `command/exec/resize` | 待实现 | R13 |  |
| `command/exec/terminate` | 待实现 | R13 |  |
| `command/exec/write` | 待实现 | R13 |  |
| `config/batchWrite` | 待实现 | R21 |  |
| `config/mcpServer/reload` | 待实现 | R21 |  |
| `config/read` | 待实现 | R21 |  |
| `config/value/write` | 待实现 | R21 |  |
| `configRequirements/read` | 待实现 | R21 |  |
| `experimentalFeature/enablement/set` | 待实现 | R21 |  |
| `experimentalFeature/list` | 待实现 | R21 |  |
| `externalAgentConfig/detect` | 待实现 | R38 |  |
| `externalAgentConfig/import` | 待实现 | R38 |  |
| `externalAgentConfig/import/readHistories` | 待实现 | R38 |  |
| `feedback/upload` | 待实现 | R36 |  |
| `fs/copy` | 待实现 | R31 |  |
| `fs/createDirectory` | 待实现 | R31 |  |
| `fs/getMetadata` | 待实现 | R31 |  |
| `fs/readDirectory` | 待实现 | R31 |  |
| `fs/readFile` | 待实现 | R31 |  |
| `fs/remove` | 待实现 | R31 |  |
| `fs/unwatch` | 待实现 | R31 |  |
| `fs/watch` | 待实现 | R31 |  |
| `fs/writeFile` | 待实现 | R31 |  |
| `fuzzyFileSearch` | 待实现 | R31 |  |
| `hooks/list` | 待实现 | R36 |  |
| `initialize` | 待实现 | R2 |  |
| `marketplace/add` | 待实现 | R24 |  |
| `marketplace/remove` | 待实现 | R24 |  |
| `marketplace/upgrade` | 待实现 | R24 |  |
| `mcpServer/oauth/login` | 待实现 | R19 |  |
| `mcpServer/resource/read` | 待实现 | R19 |  |
| `mcpServer/tool/call` | 待实现 | R19 |  |
| `mcpServerStatus/list` | 待实现 | R19 |  |
| `model/list` | 待实现 | R7 |  |
| `modelProvider/capabilities/read` | 待实现 | R36 |  |
| `permissionProfile/list` | 待实现 | R14 |  |
| `plugin/install` | 待实现 | R24 |  |
| `plugin/installed` | 待实现 | R24 |  |
| `plugin/list` | 待实现 | R24 |  |
| `plugin/read` | 待实现 | R24 |  |
| `plugin/share/checkout` | 待实现 | R24 |  |
| `plugin/share/delete` | 待实现 | R24 |  |
| `plugin/share/list` | 待实现 | R24 |  |
| `plugin/share/save` | 待实现 | R24 |  |
| `plugin/share/updateTargets` | 待实现 | R24 |  |
| `plugin/skill/read` | 待实现 | R24 |  |
| `plugin/uninstall` | 待实现 | R24 |  |
| `review/start` | 待实现 | R27 |  |
| `skills/config/write` | 待实现 | R22 |  |
| `skills/extraRoots/set` | 待实现 | R22 |  |
| `skills/list` | 待实现 | R22 |  |
| `thread/approveGuardianDeniedAction` | 待实现 | R5 |  |
| `thread/archive` | 待实现 | R5 |  |
| `thread/compact/start` | 待实现 | R9 |  |
| `thread/delete` | 待实现 | R5 |  |
| `thread/fork` | 待实现 | R5 |  |
| `thread/goal/clear` | 待实现 | R25 |  |
| `thread/goal/get` | 待实现 | R25 |  |
| `thread/goal/set` | 待实现 | R25 |  |
| `thread/inject_items` | 待实现 | R5 |  |
| `thread/list` | 待实现 | R5 |  |
| `thread/loaded/list` | 待实现 | R5 |  |
| `thread/metadata/update` | 待实现 | R5 |  |
| `thread/name/set` | 待实现 | R5 |  |
| `thread/read` | 待实现 | R5 |  |
| `thread/resume` | 待实现 | R5 |  |
| `thread/rollback` | 待实现 | R5 |  |
| `thread/shellCommand` | 待实现 | R13 |  |
| `thread/start` | 待实现 | R5 |  |
| `thread/unarchive` | 待实现 | R5 |  |
| `thread/unsubscribe` | 待实现 | R5 |  |
| `turn/interrupt` | 待实现 | R6 |  |
| `turn/start` | 待实现 | R6 |  |
| `turn/steer` | 待实现 | R6 |  |
| `windowsSandbox/readiness` | 待实现 | R16 |  |
| `windowsSandbox/setupStart` | 待实现 | R16 |  |

## Client Notifications

| 方法 | 状态 | 目标阶段 | 证据或备注 |
| --- | --- | --- | --- |
| `initialized` | 待实现 | R2 |  |

## Server Requests

| 方法 | 状态 | 目标阶段 | 证据或备注 |
| --- | --- | --- | --- |
| `account/chatgptAuthTokens/refresh` | 待实现 | R8 |  |
| `applyPatchApproval` | 待实现 | R14 |  |
| `attestation/generate` | 待实现 | R36 |  |
| `execCommandApproval` | 待实现 | R14 |  |
| `item/commandExecution/requestApproval` | 待实现 | R13 |  |
| `item/fileChange/requestApproval` | 待实现 | R12 |  |
| `item/permissions/requestApproval` | 待实现 | R14 |  |
| `item/tool/call` | 待实现 | R10 |  |
| `item/tool/requestUserInput` | 待实现 | R25 |  |
| `mcpServer/elicitation/request` | 待实现 | R19 |  |

## Server Notifications

| 方法 | 状态 | 目标阶段 | 证据或备注 |
| --- | --- | --- | --- |
| `account/login/completed` | 待实现 | R8 |  |
| `account/rateLimits/updated` | 待实现 | R8 |  |
| `account/updated` | 待实现 | R8 |  |
| `app/list/updated` | 待实现 | R33 |  |
| `command/exec/outputDelta` | 待实现 | R13 |  |
| `configWarning` | 待实现 | R21 |  |
| `deprecationNotice` | 待实现 | R3 |  |
| `error` | 待实现 | R3 |  |
| `externalAgentConfig/import/completed` | 待实现 | R38 |  |
| `externalAgentConfig/import/progress` | 待实现 | R38 |  |
| `fs/changed` | 待实现 | R31 |  |
| `fuzzyFileSearch/sessionCompleted` | 待实现 | R31 |  |
| `fuzzyFileSearch/sessionUpdated` | 待实现 | R31 |  |
| `guardianWarning` | 待实现 | R27 |  |
| `hook/completed` | 待实现 | R23 |  |
| `hook/started` | 待实现 | R23 |  |
| `item/agentMessage/delta` | 待实现 | R3 |  |
| `item/autoApprovalReview/completed` | 待实现 | R27 |  |
| `item/autoApprovalReview/started` | 待实现 | R27 |  |
| `item/commandExecution/outputDelta` | 待实现 | R13 |  |
| `item/commandExecution/terminalInteraction` | 待实现 | R13 |  |
| `item/completed` | 待实现 | R3 |  |
| `item/fileChange/outputDelta` | 待实现 | R12 |  |
| `item/fileChange/patchUpdated` | 待实现 | R12 |  |
| `item/mcpToolCall/progress` | 待实现 | R19 |  |
| `item/plan/delta` | 待实现 | R25 |  |
| `item/reasoning/summaryPartAdded` | 待实现 | R3 |  |
| `item/reasoning/summaryTextDelta` | 待实现 | R3 |  |
| `item/reasoning/textDelta` | 待实现 | R3 |  |
| `item/started` | 待实现 | R3 |  |
| `mcpServer/oauthLogin/completed` | 待实现 | R19 |  |
| `mcpServer/startupStatus/updated` | 待实现 | R19 |  |
| `model/rerouted` | 待实现 | R7 |  |
| `model/safetyBuffering/updated` | 待实现 | R7 |  |
| `model/verification` | 待实现 | R7 |  |
| `process/exited` | 待实现 | R13 |  |
| `process/outputDelta` | 待实现 | R13 |  |
| `remoteControl/status/changed` | 待实现 | R35 |  |
| `serverRequest/resolved` | 待实现 | R36 |  |
| `skills/changed` | 待实现 | R22 |  |
| `thread/archived` | 待实现 | R5 |  |
| `thread/closed` | 待实现 | R5 |  |
| `thread/compacted` | 待实现 | R9 |  |
| `thread/deleted` | 待实现 | R5 |  |
| `thread/environment/connected` | 待实现 | R5 |  |
| `thread/environment/disconnected` | 待实现 | R5 |  |
| `thread/goal/cleared` | 待实现 | R25 |  |
| `thread/goal/updated` | 待实现 | R25 |  |
| `thread/name/updated` | 待实现 | R5 |  |
| `thread/realtime/closed` | 待实现 | R35 |  |
| `thread/realtime/error` | 待实现 | R35 |  |
| `thread/realtime/itemAdded` | 待实现 | R35 |  |
| `thread/realtime/outputAudio/delta` | 待实现 | R35 |  |
| `thread/realtime/sdp` | 待实现 | R35 |  |
| `thread/realtime/started` | 待实现 | R35 |  |
| `thread/realtime/transcript/delta` | 待实现 | R35 |  |
| `thread/realtime/transcript/done` | 待实现 | R35 |  |
| `thread/settings/updated` | 待实现 | R5 |  |
| `thread/started` | 待实现 | R5 |  |
| `thread/status/changed` | 待实现 | R5 |  |
| `thread/tokenUsage/updated` | 待实现 | R5 |  |
| `thread/unarchived` | 待实现 | R5 |  |
| `turn/completed` | 待实现 | R6 |  |
| `turn/diff/updated` | 待实现 | R12 |  |
| `turn/moderationMetadata` | 待实现 | R6 |  |
| `turn/plan/updated` | 待实现 | R25 |  |
| `turn/started` | 待实现 | R6 |  |
| `warning` | 待实现 | R3 |  |
| `windows/worldWritableWarning` | 待实现 | R16 |  |
| `windowsSandbox/setupCompleted` | 待实现 | R16 |  |

## Thread Item 类型

- `agentMessage`
- `collabAgentToolCall`
- `commandExecution`
- `contextCompaction`
- `dynamicToolCall`
- `enteredReviewMode`
- `exitedReviewMode`
- `fileChange`
- `hookPrompt`
- `imageGeneration`
- `imageView`
- `mcpToolCall`
- `plan`
- `reasoning`
- `sleep`
- `subAgentActivity`
- `userMessage`
- `webSearch`

## User Input 类型

- `audio`
- `image`
- `localAudio`
- `localImage`
- `mention`
- `skill`
- `text`
