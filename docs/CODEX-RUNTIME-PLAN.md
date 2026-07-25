# Codex Runtime 源码级实施计划

## 最终目标

在 Tietiezhi Rust/Tauri 工程内源码级实现 Codex Runtime，不依赖或打包 `codex` 二进制。最终由统一的 Thread、Turn、Item 状态机承载 Agent、工具、审批、沙箱、MCP、Skills、Hooks、Plugins、Subagents、Automations 和桌面工作流。

核心可用门禁为 R0-R19，完整本地体验门禁为 R0-R32，全功能门禁为 R0-R39。

## 执行规则

- 每个 R 阶段独立提交。
- 不在一个提交内混合多个高风险子系统。
- 每个阶段运行 Rust 测试、TypeScript 类型检查、相关 UI 验证和旧数据读取或迁移回归。
- 每完成一个阶段更新 `docs/CODEX-PARITY.md`、`docs/CODEX-UPSTREAM.md`、实现证据和剩余风险。
- Windows 沙箱、macOS 沙箱、MCP OAuth、崩溃恢复必须在真实平台验证。
- 上游只跟随固定稳定 Tag。
- 迁移期允许新旧 Runtime 并存，但 R38 后必须删除旧实现。
- 官方 V2 方法不得以“永久不支持”结束，只能实现或映射到 Tietiezhi 服务。

## 阶段

| 阶段 | 交付目标 | 关键门禁 |
| --- | --- | --- |
| R0 | 固定上游版本、机器 ledger、源码映射、许可证和 CI 校验 | 89 Client Request、1 Client Notification、10 Server Request、70 Server Notification 全部入账 |
| R1 | 修复旧运行时审批作用域、拒绝语义、网络审批和硬终止 | 不再按整个工具名放行 Bash；没有固定重复次数硬停 |
| R2 | App Server V2 Rust 类型、JSON Schema 和 TypeScript 类型生成 | 与固定上游 fixture 双向兼容 |
| R3 | Thread、Turn、Item 事件总线和旧 ChatEvent 迁移适配 | 所有增量事件有 threadId、turnId、itemId |
| R4 | SQLite 元数据、JSONL rollout、原子写入和崩溃恢复 | 强杀后可恢复历史和未完成状态 |
| R5 | Thread start/list/read/resume/archive/delete/fork/rollback/compact/goal | 生命周期操作有完整集成测试 |
| R6 | Turn start/steer/interrupt/injectItems 和幂等消息 | 运行中输入和取消不会产生重复执行 |
| R7 | Responses API、SSE、reasoning summary、usage、重试和模型目录 | Agent 路径不再调用 Chat Completions |
| R8 | Tietiezhi Gateway `/v1/responses` 和账号服务映射 | 内置 Gateway 可完整运行新 Runtime |
| R9 | World State、真实 Token 预算、历史规范化和压缩 Item | 压缩保留工具因果链 |
| R10 | Tool Registry、Router、Orchestrator、Lifecycle 和并行调度 | 只读并行、冲突写入串行 |
| R11 | 官方基础工具 Schema 和 Dynamic Tool | 错误、取消和输出均为结构化结果 |
| R12 | Apply Patch、原子文件修改和 Turn Diff | 失败不留下部分修改 |
| R13 | PTY、process ID、stdin、resize、后台轮询和进程树清理 | 长期进程可继续读取和主动终止 |
| R14 | Sandbox 与 Approval 分离、精确授权和决策语义 | Approval 不再代替技术隔离 |
| R15 | macOS Seatbelt | 真实 macOS 逃逸测试通过 |
| R16 | Windows Restricted Token、ACL、Job、ConPTY | 真实 Windows 沙箱测试通过 |
| R17 | 网络代理、域名规则、连接审批和归因 | 网络关闭时子进程不能绕过 |
| R18 | ExecPolicy、命令解析和规则修订 | 不再依赖危险字符串包含判断 |
| R19 | MCP OAuth、resources、elicitation、progress、annotations 和多媒体结果 | 官方 MCP 测试服务互操作通过 |
| R20 | AGENTS、override、项目根和 World State 更新 | 嵌套指令优先级一致 |
| R21 | 分层配置、Profiles、Requirements 和警告 | 安全约束不能被低优先级覆盖 |
| R22 | Skills 分层发现、延迟加载、启停和监听 | 只暴露真实可用技能 |
| R23 | Session、Prompt、Tool、Permission、Compact、Stop Hooks | Hook 可补充、阻断和审计 |
| R24 | Plugins、Marketplace、安装、升级和卸载 | 插件工具统一走审批 |
| R25 | Plan Mode、request_user_input、Goal | 用户回答回到同一 Turn |
| R26 | Subagent spawn/message/wait/interrupt 和工作区隔离 | 父子任务状态可恢复 |
| R27 | Guardian 自动审批和 Review 模式 | 自动审查不改变沙箱边界 |
| R28 | Chronicle、长期记忆、引用和隐私边界 | 关闭后不再注入记忆 |
| R29 | Local、Worktree、`.worktreeinclude`、快照和 Handoff | 替换当前 Work/Code 双空间模型 |
| R30 | 每 Thread 集成终端和 Local Environment Actions | Agent 与用户共享终端状态 |
| R31 | 强类型 Desktop 时间线和 Needs Input 状态 | 重启后 UI 与 Runtime 一致 |
| R32 | Diff、评论、stage、revert、commit、push 和 PR | 不覆盖无关用户修改 |
| R33 | Apps、Connectors、Dynamic Tool 和设备能力 | 产品能力不再绕过 Runtime |
| R34 | Automations 复用 Thread Runtime 和独立 Worktree | 不再维护第二套自动化执行器 |
| R35 | Remote Control、远程审批、Realtime 和音频 Item | 断线恢复不重复调用 |
| R36 | OTel、日志、Doctor、Feedback 和诊断 | 默认日志不泄露密钥 |
| R37 | Fuzz、故障注入、断网、磁盘满和长期 soak | 100+ 工具调用无固定次数终止 |
| R38 | Shadow 对照、旧任务迁移、切换和旧代码删除 | 仓库不再存在旧 Agent 执行路径 |
| R39 | 安全审计、文档、回滚和 Windows/macOS 发布验证 | 完整升级与回滚演练通过 |

## 发布列车

| 发布列车 | 阶段 | 结果 |
| --- | --- | --- |
| Foundation | R0-R4 | 协议、事件和可恢复持久化基础 |
| Core Alpha | R5-R13 | 可执行的 Responses Agent、工具、Patch 和终端 |
| Security Beta | R14-R19 | 审批、双平台沙箱、网络、ExecPolicy 和 MCP |
| Local Experience RC | R20-R32 | Codex 本地定制、协作、Worktree、终端和 Diff 体验 |
| Full Runtime GA | R33-R39 | 产品扩展、自动化、远程、运维、迁移和正式发布 |

## 估算

单线工程量约 32 到 52 个工程周。Responses API、Windows 沙箱、MCP OAuth、崩溃恢复和跨平台长期稳定性是主要关键路径。估算只用于排序，不替代阶段门禁。
